/**
 * @module problems
 * The reserved mention `@problems`: the errors and warnings VS Code holds for the workspace files, one line each, from
 * the raw diagnostics the host reads. The filter, the order, the line format, and the caps live here.
 */
import { relative, sep } from "node:path";
import { cutToMentionCaps, type ReadMention } from "./mentions";
import { compareNames, isInside, type WorkspaceRoot } from "./workspaceFiles";

/**
 * One diagnostic as VS Code holds it: the URI scheme and file system path of its document, its 0-based start
 * position, its severity, its message, and the tool that reported it, when it says.
 */
export type Diagnostic = {
  scheme: string;
  path: string;
  line: number;
  character: number;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  source?: string;
};

/** Reads every diagnostic VS Code holds, of any document. May reject. */
export type DiagnosticsReader = { read(): Promise<readonly Diagnostic[]> };

/**
 * `@problems` read now: the errors and warnings of `file` documents inside `roots`, one line each,
 * `<path>:<line>:<column> <severity> <message>` then ` (<source>)` when it has one, sorted by path, line, and column,
 * cut to the mention caps. `noProblems` when none; `unreadable` with the cause when `diagnostics` rejects. Never
 * rejects.
 */
export async function readProblems(
  roots: readonly WorkspaceRoot[],
  diagnostics: DiagnosticsReader,
): Promise<ReadMention> {
  const base = { path: "problems", kind: "problems", content: "", omitted: 0 } as const;
  let all: readonly Diagnostic[];
  try {
    all = await diagnostics.read();
  } catch (error) {
    return { ...base, status: "unreadable", cause: error instanceof Error ? error.message : String(error) };
  }
  const problems = all.flatMap((diagnostic) => {
    const path = diagnostic.scheme === "file" ? workspacePath(roots, diagnostic.path) : undefined;
    const kept = diagnostic.severity === "error" || diagnostic.severity === "warning";
    return path !== undefined && kept ? [{ ...diagnostic, path }] : [];
  });
  if (problems.length === 0) return { ...base, status: "noProblems" };
  problems.sort((a, b) => compareNames(a.path, b.path) || a.line - b.line || a.character - b.character);
  const cut = cutToMentionCaps(problems.map(problemLine).join("\n"));
  return {
    ...base,
    status: cut.omitted > 0 ? "truncated" : "attached",
    lines: cut.lines,
    content: cut.text,
    omitted: cut.omitted,
  };
}

/** One problem's line; `path` already workspace-relative. */
function problemLine({ path, line, character, severity, message, source }: Diagnostic): string {
  const text = `${path}:${line + 1}:${character + 1} ${severity} ${message.replace(/\r\n|\r|\n/g, " ")}`;
  return source ? `${text} (${source})` : text;
}

/**
 * Absolute `path` as the file index writes it (`asRelativePath`): relative to the deepest of `roots` that holds it, as
 * written, led by that folder's name in a multi-root workspace. `undefined` outside every root, and for a root itself,
 * which is no file.
 */
function workspacePath(roots: readonly WorkspaceRoot[], path: string): string | undefined {
  const root = roots
    .filter((candidate) => isInside(candidate.path, path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const rest = root ? relative(root.path, path).split(sep).join("/") : "";
  if (!root || rest === "") return undefined;
  return roots.length > 1 ? `${root.name}/${rest}` : rest;
}
