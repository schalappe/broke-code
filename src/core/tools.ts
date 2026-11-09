/**
 * @module tools
 * The read tools of the harness, `read_file`, `list_files`, and `search`: each runs one parsed body tool call inside
 * the workspace folders and returns a bounded text result for the model. Files and folders read as mentions do, with
 * the same limits and wording; `search` runs ripgrep. No `vscode` import: the host passes the ripgrep candidates.
 * Model-facing text is English and never localized.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import {
  accessFailureReason,
  formatMention,
  MAX_MENTION_LINES,
  type ReadMention,
  readMention,
  truncationNotice,
} from "./mentions";
import type { ToolSpec } from "./toolCalls";
import { type AccessFailure, isInside, locateWorkspacePath, truncateLines, type WorkspaceRoot } from "./workspaceFiles";

/** What a tool call gives back to the model: `ok` with its output, or `error` with what went wrong. */
export type ToolResult = { status: "ok" | "error"; text: string };

/** A parsed body tool call: the `call` variant of `ParsedReply` satisfies it. */
export type ToolCall = { name: string; args: Record<string, string> };

/**
 * What the host provides. `ripgrepCandidates`: paths where an `rg` binary may be, in order of preference (see
 * `ripgrepCandidates`). `searchTimeoutMs`: how long `search` runs before it stops, 30 seconds unless set.
 */
export type ReadToolEnv = { ripgrepCandidates: readonly string[]; searchTimeoutMs?: number };

/** The read tools as the model sees them: for the system prompt and the body tool call parser. */
export const READ_TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    description:
      "Read a text file of the workspace. Returns its content in a fenced block under a header with its line count. Binary files and files over 1 MiB are refused. A file over 2,000 lines is cut to its first 2,000, with a note saying how many lines were left out. For a folder, use list_files.",
    args: [{ name: "path", required: true, description: "Path of the file, relative to the workspace folder." }],
  },
  {
    name: "list_files",
    description:
      "List the direct children of a workspace folder, one per line, sorted by name, folders suffixed with /. Not recursive: list a subfolder to look inside it. Over 2,000 entries, the list is cut with a note. For a file, use read_file.",
    args: [
      {
        name: "path",
        required: false,
        description:
          "Path of the folder, relative to the workspace folder. Leave it out to list the workspace folder, or the folder names when the workspace has several.",
      },
    ],
  },
  {
    name: "search",
    description:
      "Search the workspace files with ripgrep for a regular expression (Rust regex syntax). Returns each matching line as path:line:text, long lines cut after 500 characters, at most 2,000 lines. Skips hidden files, files ignored by .gitignore, and symlinks. Stops after 30 seconds and returns what it found so far.",
    args: [
      {
        name: "pattern",
        required: true,
        description:
          "The regular expression to find. Escape characters such as ( . * [ with \\ to match them literally.",
      },
      {
        name: "path",
        required: false,
        description:
          "File or folder to search in, relative to the workspace folder. Leave it out to search the whole workspace.",
      },
    ],
  },
];

/**
 * Run read tool `call` inside `roots`. Never rejects: an unknown tool, a refused path, and a failed or stopped run
 * all come back as an `error` result for the model. `signal` (Stop) ends a running `search` and kills ripgrep.
 */
export async function runReadTool(
  call: ToolCall,
  roots: WorkspaceRoot[],
  env: ReadToolEnv,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (signal.aborted) return stopped(call.name);
  try {
    switch (call.name) {
      case "read_file":
        return await readFileTool(roots, call.args.path ?? "");
      case "list_files":
        return await listFilesTool(roots, call.args.path);
      case "search":
        return await searchTool(roots, call.args.pattern ?? "", call.args.path, env, signal);
      default:
        return { status: "error", text: `${call.name} is not a read tool.` };
    }
  } catch (error) {
    // [!]: The tools catch what they expect; this keeps a bug from rejecting into the agent loop.
    return { status: "error", text: `${call.name}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function readFileTool(roots: WorkspaceRoot[], path: string): Promise<ToolResult> {
  const mention = await readMention(roots, path);
  const failure = failureOf(mention);
  if (failure) return refused("read_file", path, failure, mention.cause);
  if (mention.kind === "folder") {
    return { status: "error", text: `read_file: ${path}: the path is a folder. Use list_files to see its children.` };
  }
  return { status: "ok", text: formatMention(mention) };
}

async function listFilesTool(roots: WorkspaceRoot[], path: string | undefined): Promise<ToolResult> {
  const wholeWorkspace = path === undefined || path === "" || path === ".";
  if (wholeWorkspace && roots.length > 1) return { status: "ok", text: formatMention(rootListing(roots)) };
  const shown = wholeWorkspace ? "." : path;
  const mention = await readMention(roots, shown);
  const failure = failureOf(mention);
  // [>]: A binary or oversized file is still known to be a file: the reason to give is the tool to use.
  if (mention.kind === "file" && (!failure || failure === "binary" || failure === "tooLarge")) {
    return { status: "error", text: `list_files: ${shown}: the path is a file. Use read_file to read it.` };
  }
  if (failure) return refused("list_files", shown, failure, mention.cause);
  return { status: "ok", text: formatMention(mention) };
}

/** The folder names of a multi-root workspace, as the listing of its top: what a path may start with. */
function rootListing(roots: WorkspaceRoot[]): ReadMention {
  const cut = truncateLines(roots.map((root) => `${root.name}/`).join("\n"), MAX_MENTION_LINES);
  const status = cut.omitted > 0 ? "truncated" : "attached";
  return { path: ".", kind: "folder", status, lines: cut.lines, content: cut.text, omitted: cut.omitted };
}

/** Why nothing of `mention` could be read, or `undefined` when its content is there. */
function failureOf(mention: ReadMention): AccessFailure | undefined {
  return mention.status === "attached" || mention.status === "truncated" ? undefined : mention.status;
}

/** A refused path, in the wording of a mention that attached nothing. */
function refused(tool: string, path: string, failure: AccessFailure, cause?: string): ToolResult {
  return { status: "error", text: `${tool}: ${path}: ${accessFailureReason(failure, cause)}.` };
}

const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;
/** ripgrep's error output kept for the model: enough for a few messages, never a flood. */
const MAX_STDERR_CHARS = 4096;
// [!]: No config file, which could add `--pre` and run any program. `--with-filename`: a single file searched still
// shows its path, so every line reads `path:line:text`.
const RIPGREP_ARGS = [
  "--no-config",
  "--with-filename",
  "--line-number",
  "--no-heading",
  "--color",
  "never",
  "--max-columns",
  "500",
  "--max-columns-preview",
];
const NO_MATCH =
  "No match. ripgrep skips hidden files, files ignored by .gitignore, and symlinks; read or list them directly if needed.";

/**
 * Where `rg` may be, in order: the binaries VSCodium and VS Code ship under their `appRoot` (`vscode.env.appRoot`),
 * then `rg` in each absolute folder of `pathEnv`. Relative and empty `PATH` entries are skipped: they resolve against
 * whatever folder the host runs in.
 */
export function ripgrepCandidates(
  appRoot: string | undefined,
  pathEnv: string | undefined,
  arch: string = process.arch,
): string[] {
  const bundled =
    appRoot === undefined
      ? []
      : [
          join(
            appRoot,
            "node_modules.asar.unpacked/@vscode/ripgrep-universal/bin",
            `darwin-${arch === "arm64" ? "arm64" : "x64"}`,
            "rg",
          ),
          join(appRoot, "node_modules.asar.unpacked/@vscode/ripgrep/bin/rg"),
          join(appRoot, "node_modules/@vscode/ripgrep/bin/rg"),
        ];
  const onPath = (pathEnv ?? "")
    .split(delimiter)
    .filter((folder) => isAbsolute(folder))
    .map((folder) => join(folder, "rg"));
  return [...new Set([...bundled, ...onPath])];
}

/** The first candidate that is an executable regular file. */
async function findRipgrep(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const usable = await access(candidate, constants.X_OK)
      .then(() => stat(candidate))
      .then((info) => info.isFile())
      .catch(() => false);
    if (usable) return candidate;
  }
  return undefined;
}

/**
 * What one search covers. `paths`: real paths given to ripgrep. `prefixes`: each workspace folder's real path and
 * what replaces it in the output, longest first, so a nested folder wins over the one that holds it.
 */
type SearchScope = { cwd: string; paths: string[]; prefixes: { realRoot: string; shown: string }[] };

async function searchTool(
  roots: WorkspaceRoot[],
  pattern: string,
  path: string | undefined,
  env: ReadToolEnv,
  signal: AbortSignal,
): Promise<ToolResult> {
  const scope = await searchScope(roots, path);
  if ("status" in scope) return scope;
  const ripgrep = await findRipgrep(env.ripgrepCandidates);
  if (ripgrep === undefined) {
    const tried = env.ripgrepCandidates.length > 0 ? env.ripgrepCandidates.map((c) => `\n- ${c}`).join("") : " none";
    return { status: "error", text: `search: ripgrep (rg) was not found. Paths tried:${tried}` };
  }
  return runRipgrep(ripgrep, pattern, scope, env.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS, signal);
}

/**
 * The real paths `search` may give ripgrep: the outermost workspace folders when `path` is left out, empty, or `.`,
 * otherwise `path` once it passed the check `read_file` makes. Never a path that did not pass.
 */
async function searchScope(roots: WorkspaceRoot[], path: string | undefined): Promise<SearchScope | ToolResult> {
  const resolved = await Promise.all(
    roots.map(async (root) => ({ root, realRoot: await realpath(root.path).catch(() => undefined) })),
  );
  // [>]: A folder that cannot be resolved (deleted, unmounted) holds nothing to search: it is left out.
  const usable = resolved.flatMap(({ root, realRoot }) => (realRoot === undefined ? [] : [{ root, realRoot }]));
  const prefixes = usable
    .map(({ root, realRoot }) => ({ realRoot, shown: roots.length > 1 ? `${root.name}/` : "" }))
    .sort((a, b) => b.realRoot.length - a.realRoot.length);

  if (path === undefined || path === "" || path === ".") {
    // [>]: A folder nested in another is searched through it, so its files show once, under the nested name.
    const realRoots = [...new Set(usable.map(({ realRoot }) => realRoot))];
    const outermost = realRoots.filter(
      (realRoot) => !realRoots.some((other) => other !== realRoot && isInside(other, realRoot)),
    );
    if (outermost.length === 0) return { status: "error", text: "search: no workspace folder can be searched." };
    return { cwd: outermost[0]!, paths: outermost, prefixes };
  }

  try {
    const located = await locateWorkspacePath(roots, path);
    if (located.status !== "ok") return refused("search", path, located.status);
    // [!]: A FIFO or device given to ripgrep could block until the timeout or read without end.
    const info = await stat(located.realPath);
    if (!info.isFile() && !info.isDirectory()) return refused("search", path, "unreadable", "not a file or folder");
    return { cwd: located.realRoot, paths: [located.realPath], prefixes };
  } catch (error) {
    return refused("search", path, "unreadable", errorCode(error) ?? String(error));
  }
}

/**
 * Run ripgrep over `scope`. Keeps the first 2,000 output lines and counts the rest, so memory stays bounded whatever
 * the output. Resolves once the process has exited, also when the timeout or `signal` killed it.
 */
function runRipgrep(
  ripgrep: string,
  pattern: string,
  scope: SearchScope,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    let omitted = 0;
    let partialLine = "";
    let stderr = "";
    let stderrCut = false;
    let ending: "timeout" | "stopped" | undefined;
    let settled = false;

    const keep = (line: string) => {
      if (lines.length < MAX_MENTION_LINES) lines.push(shownLine(line, scope));
      else omitted++;
    };
    const settle = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      // [!]: An argv array and no shell: the pattern and paths reach ripgrep as they are. stdin is closed, so ripgrep
      // never waits on it, and `--` keeps a path from reading as an option.
      child = spawn(ripgrep, [...RIPGREP_ARGS, "-e", pattern, "--", ...scope.paths], {
        cwd: scope.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // [>]: spawn throws, rather than emitting `error`, for an argument it refuses, such as one holding a NUL byte.
      resolve({ status: "error", text: `search: ripgrep could not run (${errorCode(error) ?? String(error)}).` });
      return;
    }

    const end = (reason: "timeout" | "stopped") => {
      ending ??= reason;
      child.kill("SIGKILL");
    };
    const onAbort = () => end("stopped");
    const timer = setTimeout(() => end("timeout"), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) end("stopped");

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      const parts = (partialLine + chunk).split("\n");
      partialLine = parts.pop()!;
      for (const line of parts) keep(line);
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      const room = MAX_STDERR_CHARS - stderr.length;
      if (chunk.length > room) stderrCut = true;
      stderr += chunk.slice(0, Math.max(0, room));
    });
    child.on("error", (error) => {
      // [>]: Without a pid the process never started (ENOENT, EACCES), so no `close` is sure to follow.
      if (child.pid === undefined) {
        settle({ status: "error", text: `search: ripgrep could not run (${errorCode(error) ?? error.message}).` });
      }
    });
    child.on("close", (code) => {
      if (partialLine !== "") keep(partialLine);
      const messages = shownMessages(stderr, scope) + (stderrCut ? "\n…" : "");
      settle(searchResult({ lines, omitted, code, ending, timeoutMs, messages }));
    });
  });
}

function searchResult(run: {
  lines: string[];
  omitted: number;
  code: number | null;
  ending: "timeout" | "stopped" | undefined;
  timeoutMs: number;
  messages: string;
}): ToolResult {
  if (run.ending === "stopped") return stopped("search");
  const found = run.lines.length > 0;
  const listing = found ? run.lines.join("\n") + (run.omitted > 0 ? `\n${truncationNotice(run.omitted)}` : "") : "";
  if (run.ending === "timeout") {
    const seconds = run.timeoutMs / 1000;
    const text = found
      ? `${listing}\n[search stopped after ${seconds} seconds: other matches may exist]`
      : `No match before the search stopped after ${seconds} seconds.`;
    return { status: "ok", text };
  }
  if (run.code === 0) return { status: "ok", text: listing };
  if (run.code === 1) return { status: "ok", text: NO_MATCH };
  // [>]: ripgrep exits 2 on any error, also after finding matches elsewhere: a partial success, not a failure.
  if (run.code === 2 && found) {
    return { status: "ok", text: `${listing}\n\nSome paths could not be searched:\n${run.messages}` };
  }
  const exit = run.code === 2 ? "" : ` (exit code ${run.code})`;
  return { status: "error", text: `search: ripgrep failed${exit}:\n${run.messages || "no message"}` };
}

/** An output line with its path shown as a mention resolves it, when it starts with a workspace folder's real path. */
function shownLine(line: string, scope: SearchScope): string {
  for (const { realRoot, shown } of scope.prefixes) {
    if (line.startsWith(`${realRoot}/`)) return shown + line.slice(realRoot.length + 1);
  }
  return line;
}

/** ripgrep's messages with workspace real paths shown as in the output lines. */
function shownMessages(stderr: string, scope: SearchScope): string {
  let shown = stderr.trimEnd();
  for (const prefix of scope.prefixes) shown = shown.replaceAll(`${prefix.realRoot}/`, prefix.shown);
  return shown;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function stopped(tool: string): ToolResult {
  return { status: "error", text: `${tool}: stopped before it finished.` };
}
