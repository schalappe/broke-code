/**
 * @module tools
 * The read tools of the harness, `read_file`, `list_files`, and `search`: each runs one parsed body tool call inside
 * the workspace folders and returns a bounded text result for the model. Files and folders read as mentions do, with
 * the same limits and wording; `search` runs ripgrep. No `vscode` import: the host passes the ripgrep candidates.
 * Model-facing text is English and never localized.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, posix } from "node:path";
import {
  accessFailureReason,
  formatMention,
  MAX_MENTION_LINES,
  type ReadMention,
  readMention,
  truncationNotice,
} from "./mentions";
import type { ToolSpec } from "./toolCalls";
import {
  type AccessFailure,
  compareNames,
  isInside,
  locateWorkspacePath,
  type RaceSeam,
  resolveWorkspaceRoots,
  truncateLines,
  type WorkspaceRoot,
} from "./workspaceFiles";

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
          "The regular expression to find; it must not be empty. Escape characters such as ( . * [ with \\ to match them literally.",
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
 * all come back as an `error` result for the model. `signal` (Stop) gives the stopped error at once, even while a
 * disk step that cannot be aborted still runs, and its late outcome is dropped; a running ripgrep is killed first,
 * and the result waits for its exit, which SIGKILL bounds. `seam`: for tests, see `readWorkspaceEntry`.
 */
export async function runReadTool(
  call: ToolCall,
  roots: WorkspaceRoot[],
  env: ReadToolEnv,
  signal: AbortSignal,
  seam: RaceSeam = {},
): Promise<ToolResult> {
  if (!READ_TOOLS.some((tool) => tool.name === call.name)) {
    return { status: "error", text: `${excerpt(call.name)} is not a read tool.` };
  }
  if (signal.aborted) return stopped(call.name);
  if (roots.length === 0) return { status: "error", text: `${call.name}: no workspace folder is open.` };

  const ripgrepRuns: Promise<unknown>[] = [];
  let onAbort = () => {};
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
  });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    // [>]: The race subscribes to the tool's promise, so an outcome dropped after Stop never rejects unhandled.
    const result = await Promise.race([runTool(call, roots, env, signal, seam, ripgrepRuns), aborted]);
    if (result !== "aborted" && !signal.aborted) return result;
    await Promise.all(ripgrepRuns);
    return stopped(call.name);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Never rejects. `ripgrepRuns`: gets each ripgrep run `search` starts, settled once its process has exited. */
async function runTool(
  call: ToolCall,
  roots: WorkspaceRoot[],
  env: ReadToolEnv,
  signal: AbortSignal,
  seam: RaceSeam,
  ripgrepRuns: Promise<unknown>[],
): Promise<ToolResult> {
  try {
    if (call.name === "read_file") return await readFileTool(roots, call.args.path ?? "", seam);
    if (call.name === "list_files") return await listFilesTool(roots, call.args.path, seam);
    return await searchTool(roots, call.args.pattern ?? "", call.args.path, env, signal, ripgrepRuns);
  } catch (error) {
    // [!]: The tools catch what they expect; this keeps a bug from rejecting into the agent loop.
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", text: `${call.name}: ${excerpt(message)}` };
  }
}

async function readFileTool(roots: WorkspaceRoot[], path: string, seam: RaceSeam): Promise<ToolResult> {
  const mention = await readMention(roots, path, seam);
  const failure = failureOf(mention);
  if (failure) return refused("read_file", path, failure, mention.cause);
  if (mention.kind === "folder") {
    const text = `read_file: ${excerpt(path)}: the path is a folder. Use list_files to see its children.`;
    return { status: "error", text };
  }
  return { status: "ok", text: formatMention({ ...mention, path: displayPath(path) }) };
}

async function listFilesTool(roots: WorkspaceRoot[], path: string | undefined, seam: RaceSeam): Promise<ToolResult> {
  const wholeWorkspace = path === undefined || path === "" || path === ".";
  if (wholeWorkspace && roots.length > 1) return { status: "ok", text: formatMention(rootListing(roots)) };
  const shown = wholeWorkspace ? "." : path;
  const mention = await readMention(roots, shown, seam);
  const failure = failureOf(mention);
  // [>]: A binary or oversized file is still known to be a file: the reason to give is the tool to use.
  if (mention.kind === "file" && (!failure || failure === "binary" || failure === "tooLarge")) {
    return { status: "error", text: `list_files: ${excerpt(shown)}: the path is a file. Use read_file to read it.` };
  }
  if (failure) return refused("list_files", shown, failure, mention.cause);
  return { status: "ok", text: formatMention({ ...mention, path: displayPath(shown) }) };
}

/**
 * A model-given path as a successful header shows it: normalized, so `a/../b` reads `b`, then cut to its first line.
 * Resolution uses the path as given; only the header is bounded, since a long path can normalize to a short one.
 */
function displayPath(path: string): string {
  return excerpt(posix.normalize(path));
}

/** The folder names of a multi-root workspace, as the listing of its top: what a path may start with. */
function rootListing(roots: WorkspaceRoot[]): ReadMention {
  const names = roots.map((root) => root.name).sort(compareNames);
  const cut = truncateLines(names.map((name) => `${name}/`).join("\n"), MAX_MENTION_LINES);
  const status = cut.omitted > 0 ? "truncated" : "attached";
  return { path: ".", kind: "folder", status, lines: cut.lines, content: cut.text, omitted: cut.omitted };
}

/** Why nothing of `mention` could be read, or `undefined` when its content is there. */
function failureOf(mention: ReadMention): AccessFailure | undefined {
  return mention.status === "attached" || mention.status === "truncated" ? undefined : mention.status;
}

/** A refused path, in the wording of a mention that attached nothing. */
function refused(tool: string, path: string, failure: AccessFailure, cause?: string): ToolResult {
  return { status: "error", text: `${tool}: ${excerpt(path)}: ${accessFailureReason(failure, cause)}.` };
}

/** Characters of a model-given value or an error message an error result shows. */
const MAX_EXCERPT_CHARS = 200;

/**
 * `text` as an error result shows it: its first line, cut at 200 characters, with `…` when anything was left out.
 * A value comes from the model and an error message from anywhere: neither may make the result unbounded.
 */
function excerpt(text: string): string {
  const lineEnd = text.indexOf("\n");
  const line = lineEnd === -1 ? text : text.slice(0, lineEnd);
  const shown = line.slice(0, MAX_EXCERPT_CHARS);
  return shown === text ? text : `${shown}…`;
}

const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;
/** ripgrep's error output kept for the model: enough for a few messages, never a flood. */
const MAX_STDERR_CHARS = 4096;
// [!]: No config file, which could add `--pre` and run any program. `--with-filename`: a single file searched still
// shows its path, so every line reads `path:line:text`. `--no-require-git`: ripgrep otherwise reads `.gitignore` only
// inside a Git repository, and the tool promises ignored files are skipped in any workspace folder.
const RIPGREP_ARGS = [
  "--no-config",
  "--no-require-git",
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
 * What one search covers. `paths`: real paths given to ripgrep. `excluded`: real paths of workspace folders nested in
 * another, left out of the outer folder's walk since each is searched on its own. `prefixes`: each workspace folder's
 * real path and what replaces it in the output, longest first, so a nested folder wins over the one that holds it.
 * `skipped`: the workspace folders a whole-workspace search could not resolve, one `- name (cause)` line each.
 */
type SearchScope = {
  cwd: string;
  paths: string[];
  excluded: string[];
  prefixes: { realRoot: string; shown: string }[];
  skipped: string[];
};

async function searchTool(
  roots: WorkspaceRoot[],
  pattern: string,
  path: string | undefined,
  env: ReadToolEnv,
  signal: AbortSignal,
  ripgrepRuns: Promise<unknown>[],
): Promise<ToolResult> {
  if (pattern === "") return { status: "error", text: "search: the pattern is empty." };
  const scope = await searchScope(roots, path);
  if ("status" in scope) return scope;
  const ripgrep = await findRipgrep(env.ripgrepCandidates);
  if (ripgrep === undefined) {
    const tried = env.ripgrepCandidates.length > 0 ? env.ripgrepCandidates.map((c) => `\n- ${c}`).join("") : " none";
    return { status: "error", text: `search: ripgrep (rg) was not found. Paths tried:${tried}` };
  }
  const run = runRipgrep(ripgrep, pattern, scope, env.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS, signal);
  ripgrepRuns.push(run);
  return run;
}

/**
 * The real paths `search` may give ripgrep: every workspace folder when `path` is left out, empty, or `.`, otherwise
 * `path` once it passed the check `read_file` makes. Never a path that did not pass.
 *
 * [!]: ripgrep opens the path by name after the check, so a folder swapped for a symlink out between the two, or a
 * subfolder swapped during the walk, is searched. Accepted, as for mentions: a process that can swap workspace files
 * already runs with the user's rights and can read the outside files itself.
 */
async function searchScope(roots: WorkspaceRoot[], path: string | undefined): Promise<SearchScope | ToolResult> {
  const { resolved: usable, unresolved } = await resolveWorkspaceRoots(roots);
  const prefixes = usable
    .map(({ root, realRoot }) => ({ realRoot, shown: roots.length > 1 ? `${root.name}/` : "" }))
    .sort((a, b) => b.realRoot.length - a.realRoot.length);

  if (path === undefined || path === "" || path === ".") {
    const realRoots = [...new Set(usable.map(({ realRoot }) => realRoot))];
    const skipped = unresolved.map(({ root, cause }) => `- ${root.name} (${cause})`);
    if (realRoots.length === 0) {
      return { status: "error", text: `search: no workspace folder can be searched.\n\n${skippedNotice(skipped)}` };
    }
    // [>]: A nested folder is searched on its own, even when the outer walk would skip it (hidden, ignored), and is
    // left out of that walk, so its files show once, under its name. An absolute exclude glob holds only with the
    // working folder at `/`.
    const excluded = realRoots.filter((realRoot) =>
      realRoots.some((other) => other !== realRoot && isInside(other, realRoot)),
    );
    return { cwd: "/", paths: realRoots, excluded, prefixes, skipped };
  }

  try {
    const located = await locateWorkspacePath(roots, path);
    if (located.status !== "ok") return refused("search", path, located.status);
    // [!]: A FIFO or device given to ripgrep could block until the timeout or read without end.
    const info = await stat(located.realPath);
    if (!info.isFile() && !info.isDirectory()) return refused("search", path, "unreadable", "not a file or folder");
    return { cwd: located.realRoot, paths: [located.realPath], excluded: [], prefixes, skipped: [] };
  } catch (error) {
    return refused("search", path, "unreadable", errorCode(error) ?? String(error));
  }
}

/**
 * A ripgrep glob matching exactly `path`: its glob characters escaped. [!]: ripgrep trims trailing whitespace from a
 * glob, an escaping backslash included, so each whitespace character goes in a class of its own instead.
 */
function literalGlob(path: string): string {
  return path.replace(/[\\*?[\]{}!]/g, "\\$&").replace(/\s/g, "[$&]");
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

    // [>]: Stop came while the scope or the binary was being checked: nothing is started.
    if (signal.aborted) {
      resolve(stopped("search"));
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      // [!]: An argv array and no shell: the pattern and paths reach ripgrep as they are. stdin is closed, so ripgrep
      // never waits on it, and `--` keeps a path from reading as an option.
      const excludes = scope.excluded.flatMap((path) => ["--glob", `!${literalGlob(path)}`]);
      child = spawn(ripgrep, [...RIPGREP_ARGS, ...excludes, "-e", pattern, "--", ...scope.paths], {
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
      settle(withSkipped(searchResult({ lines, omitted, code, ending, timeoutMs, messages }), code, ending, scope));
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
    const note = found
      ? `${listing}\n[search stopped after ${seconds} seconds: other matches may exist]`
      : `No match before the search stopped after ${seconds} seconds.`;
    // [>]: ripgrep may have reported a read error before the cap: the model must not lose it.
    const text = run.messages ? `${note}\n\nSome paths could not be searched:\n${run.messages}` : note;
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

/**
 * `result` with the workspace folders left out of the search listed after it. A run that found nothing while some
 * folders were not searched is an error, as ripgrep's exit 2 without a match is: "No match" would claim too much.
 */
function withSkipped(
  result: ToolResult,
  code: number | null,
  ending: "timeout" | "stopped" | undefined,
  scope: SearchScope,
): ToolResult {
  if (scope.skipped.length === 0 || ending === "stopped") return result;
  const notice = skippedNotice(scope.skipped);
  if (ending === undefined && code === 1) {
    return { status: "error", text: `search: no match in the folders searched.\n\n${notice}` };
  }
  return { status: result.status, text: `${result.text}\n\n${notice}` };
}

function skippedNotice(skipped: string[]): string {
  return `Workspace folders not searched, since they could not be resolved:\n${skipped.join("\n")}`;
}

/** An output line with its path shown as a mention resolves it, when it starts with a workspace folder's real path. */
function shownLine(line: string, scope: SearchScope): string {
  for (const { realRoot, shown } of scope.prefixes) {
    const prefix = withSeparator(realRoot);
    if (line.startsWith(prefix)) return shown + line.slice(prefix.length);
  }
  return line;
}

/** ripgrep's messages with workspace real paths shown as in the output lines. */
function shownMessages(stderr: string, scope: SearchScope): string {
  let shown = stderr.trimEnd();
  for (const { realRoot, shown: replacement } of scope.prefixes) {
    // [!]: Only where a path starts: with the root `/`, its prefix is a single `/` that every path holds inside.
    const start = new RegExp(`(?<=^|[\\s:"'(])${withSeparator(realRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gm");
    shown = shown.replace(start, () => replacement);
  }
  return shown;
}

/** `root` with exactly one trailing separator: the real root `/` already has it. */
function withSeparator(root: string): string {
  return root.endsWith("/") ? root : `${root}/`;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function stopped(tool: string): ToolResult {
  return { status: "error", text: `${tool}: stopped before it finished.` };
}
