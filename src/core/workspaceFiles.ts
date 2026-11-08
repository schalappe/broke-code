/**
 * @module workspaceFiles
 * Read access to the workspace folders: the inside-workspace check, file reads under a size cap, one-level folder
 * listings, and line truncation. Mentions use it; `read_file` and `list_files` (#6) are meant to.
 * Plain `node:fs`: v1 runs on local macOS folders only, and real files keep the boundary rules testable.
 */
import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** A workspace folder: its name in a multi-root workspace and its absolute path. */
export type WorkspaceRoot = { name: string; path: string };

export type EntryKind = "file" | "folder";

/**
 * `missing`: no such path. `outsideWorkspace`: the path, symlinks resolved, is in no workspace folder.
 * `binary`: NUL byte in the first 8 KiB. `tooLarge`: over 1 MiB. `unreadable`: any other failure.
 */
export type AccessFailure = "missing" | "outsideWorkspace" | "binary" | "tooLarge" | "unreadable";

/** A file's whole text, a folder's direct children (folders suffixed with `/`), or why neither could be read. */
export type WorkspaceEntry =
  | { status: "ok"; kind: "file"; text: string }
  | { status: "ok"; kind: "folder"; entries: string[] }
  | { status: Exclude<AccessFailure, "unreadable">; kind: EntryKind }
  | { status: "unreadable"; kind: EntryKind; cause: string };

const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);

/**
 * Read `path` inside `roots`. With several roots, a first segment naming a root resolves against that root only;
 * any other relative path resolves against each root in turn, the first that holds it winning. Never rejects. The kind of
 * a path that could not be inspected is a guess: `folder` when it ends with `/`.
 */
export async function readWorkspaceEntry(roots: WorkspaceRoot[], path: string): Promise<WorkspaceEntry> {
  const guessedKind: EntryKind = path.endsWith("/") ? "folder" : "file";
  try {
    const located = await locate(roots, path);
    if (located.status !== "ok") return { status: located.status, kind: guessedKind };
    const info = await stat(located.realPath);
    if (info.isDirectory()) return { status: "ok", kind: "folder", entries: await listFolder(located.realPath) };
    // [!]: Opening a FIFO or device could block forever or read without end.
    if (!info.isFile()) return { status: "unreadable", kind: "file", cause: "not a file or folder" };
    return await readFile(located.realPath);
  } catch (error) {
    // [>]: Deleted between the boundary check and the read.
    if (MISSING_CODES.has(errorCode(error) ?? "")) return { status: "missing", kind: guessedKind };
    return { status: "unreadable", kind: guessedKind, cause: errorCode(error) ?? String(error) };
  }
}

/** `text` cut to its first `max` lines. `lines`: lines kept; a final newline ends the last line, not a new one. */
export function truncateLines(text: string, max: number): { text: string; lines: number; omitted: number } {
  if (text === "") return { text, lines: 0, omitted: 0 };
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length <= max) return { text, lines: lines.length, omitted: 0 };
  return { text: lines.slice(0, max).join("\n"), lines: max, omitted: lines.length - max };
}

/**
 * Real path of `path`, checked twice: lexically first, so a path outside is refused without touching the disk
 * (and without telling whether it exists), then after resolving symlinks.
 */
async function locate(
  roots: WorkspaceRoot[],
  path: string,
): Promise<{ status: "ok"; realPath: string } | { status: "missing" | "outsideWorkspace" }> {
  const candidates = candidatePaths(roots, path).filter((candidate) =>
    roots.some((root) => isInside(resolve(root.path), candidate)),
  );
  if (candidates.length === 0) return { status: "outsideWorkspace" };

  const realRoots = await Promise.all(roots.map((root) => realpath(root.path).catch(() => undefined)));
  for (const candidate of candidates) {
    const realPath = await realpath(candidate).catch((error: unknown) => {
      if (MISSING_CODES.has(errorCode(error) ?? "")) return undefined;
      throw error;
    });
    if (realPath === undefined) continue;
    const inside = realRoots.some((root) => root !== undefined && isInside(root, realPath));
    return inside ? { status: "ok", realPath } : { status: "outsideWorkspace" };
  }
  return { status: "missing" };
}

function candidatePaths(roots: WorkspaceRoot[], path: string): string[] {
  const [first, ...rest] = path.split("/");
  const named = roots.length > 1 ? roots.find((root) => root.name === first) : undefined;
  if (named) return [resolve(named.path, rest.join("/"))];
  return roots.map((root) => resolve(root.path, path));
}

function isInside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith("../") && !isAbsolute(rest));
}

async function readFile(realPath: string): Promise<WorkspaceEntry> {
  const handle = await open(realPath, "r");
  try {
    // [>]: Read one byte past the cap rather than trust `stat`: the file may grow after it.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_FILE_BYTES) return { status: "tooLarge", kind: "file" };
    const bytes = buffer.subarray(0, size);
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { status: "binary", kind: "file" };
    return { status: "ok", kind: "file", text: new TextDecoder().decode(bytes) };
  } finally {
    await handle.close();
  }
}

async function listFolder(realPath: string): Promise<string[]> {
  const children = await readdir(realPath, { withFileTypes: true });
  return children
    .map((child) => ({ name: child.name, folder: child.isDirectory() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((child) => (child.folder ? `${child.name}/` : child.name));
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
