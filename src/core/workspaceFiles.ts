/**
 * @module workspaceFiles
 * Access to the workspace folders: the inside-workspace check, file reads under a size cap, one-level folder
 * listings, line truncation, and the write boundary with in-place writes. Mentions and the read tools (`tools.ts`)
 * read through it; the write tools (`writeTools.ts`) check and write through it.
 * Plain `node:fs`: v1 runs on local macOS folders only, and real files keep the boundary rules testable.
 */
import { constants, type Dirent, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

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

/** Test seam: `beforeOpen` runs after the boundary check, where a concurrent rename could swap the path. */
export type RaceSeam = { beforeOpen?: () => Promise<void> };

const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);
/** A link whose target is gone, loops, or sits behind a folder we may not search: its kind cannot be known. */
const UNRESOLVED_LINK_CODES = new Set(["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"]);

/**
 * Read `path` inside `roots`. With several roots, a path starting with a root's name and `/` resolves against that
 * root only; any other relative path resolves against each root in turn, the first that holds it winning. Never
 * rejects. The kind of a path that could not be inspected is a guess: `folder` when it ends with `/`.
 */
export function readWorkspaceEntry(roots: WorkspaceRoot[], path: string, seam: RaceSeam = {}): Promise<WorkspaceEntry> {
  return readEntryAmong(roots, candidatePaths(roots, path), path.endsWith("/") ? "folder" : "file", seam);
}

/**
 * Read the file or folder at `absolutePath`, held to the same boundary as `readWorkspaceEntry`: inside any of
 * `roots`, symlinks resolved. No folder name selects a root, so a custom name that prefixes the path (`/var`) never
 * reroutes it. For a file path the host builds itself, such as a folder's `AGENTS.md`, so the kind of a path that
 * could not be inspected is `file`. Never rejects.
 */
export function readWorkspaceEntryAt(roots: WorkspaceRoot[], absolutePath: string): Promise<WorkspaceEntry> {
  return readEntryAmong(roots, [resolve(absolutePath)], "file", {});
}

/** `readWorkspaceEntry` over absolute `candidates`, the first that exists winning. */
async function readEntryAmong(
  roots: WorkspaceRoot[],
  candidates: string[],
  guessedKind: EntryKind,
  seam: RaceSeam,
): Promise<WorkspaceEntry> {
  try {
    const located = await locateCandidates(roots, candidates);
    if (located.status !== "ok") return { status: located.status, kind: guessedKind };
    // [!]: Opening a FIFO or device could block forever or read without end.
    if (!isFileOrFolder(await stat(located.realPath))) return notFileOrFolder;
    await seam.beforeOpen?.();
    // [>]: Non-blocking, so a FIFO swapped in after the `stat` cannot hang the open.
    const handle = await open(located.realPath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!(await isInsideFile(located.realRoots, located.realPath, opened))) {
        return { status: "outsideWorkspace", kind: guessedKind };
      }
      if (opened.isDirectory()) return { status: "ok", kind: "folder", entries: await listFolder(located.realPath) };
      if (!opened.isFile()) return notFileOrFolder;
      return await readFile(handle);
    } finally {
      await handle.close();
    }
  } catch (error) {
    // [>]: Deleted between the boundary check and the read.
    if (MISSING_CODES.has(errorCode(error) ?? "")) return { status: "missing", kind: guessedKind };
    return { status: "unreadable", kind: guessedKind, cause: errorCode(error) ?? String(error) };
  }
}

const notFileOrFolder: WorkspaceEntry = { status: "unreadable", kind: "file", cause: "not a file or folder" };

/**
 * Read the file at absolute `path`, symlinks followed, under the same size cap and binary probe as
 * `readWorkspaceEntry`, with no workspace boundary: for a file the user keeps outside the workspace, such as
 * `~/.agents/AGENTS.md`. Anything but a regular file is `unreadable`. Never rejects.
 */
export async function readFileOutsideWorkspace(path: string): Promise<WorkspaceEntry> {
  const notFile: WorkspaceEntry = { status: "unreadable", kind: "file", cause: "not a file" };
  try {
    // [!]: Opening a FIFO or device could block forever or read without end.
    if (!(await stat(path)).isFile()) return notFile;
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) return notFile;
      return await readFile(handle);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (MISSING_CODES.has(errorCode(error) ?? "")) return { status: "missing", kind: "file" };
    return { status: "unreadable", kind: "file", cause: errorCode(error) ?? String(error) };
  }
}

function isFileOrFolder(info: Stats): boolean {
  return info.isFile() || info.isDirectory();
}

/**
 * True when the handle described by `opened` is the file at `path`, symlinks resolved again, inside a root. The open
 * goes by name, so any component may have been swapped for a symlink since the boundary check: only the same
 * device and inode as a path still inside proves the handle holds workspace bytes.
 *
 * [!]: This refuses a committed symlink out (a malicious repository) and a swap made before the open, but not a writer
 * that swaps again between the `realpath` and the `stat`: each check goes by name, and Node offers no check by handle.
 * Accepted: a process that can swap workspace files during a read already runs with the user's rights and can read
 * the outside file itself.
 */
async function isInsideFile(realRoots: string[], path: string, opened: Stats): Promise<boolean> {
  const again = await realpath(path);
  if (!realRoots.some((root) => isInside(root, again))) return false;
  const named = await stat(again);
  return named.dev === opened.dev && named.ino === opened.ino;
}

/** `text` cut to its first `max` lines. `lines`: lines kept; a final newline ends the last line, not a new one. */
export function truncateLines(text: string, max: number): { text: string; lines: number; omitted: number } {
  if (text === "") return { text, lines: 0, omitted: 0 };
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length <= max) return { text, lines: lines.length, omitted: 0 };
  return { text: lines.slice(0, max).join("\n"), lines: max, omitted: lines.length - max };
}

/** A path that passed the boundary check: its real path, the real paths of all roots, and the first that holds it. */
export type LocatedPath = { status: "ok"; realPath: string; realRoots: string[]; realRoot: string };

/**
 * Real path of `path`, resolved as `readWorkspaceEntry` resolves it and checked twice: lexically first, so a path
 * outside is refused without touching the disk (and without telling whether it exists), then after resolving
 * symlinks. Rejects on a disk error other than a missing path, such as `EACCES`.
 */
export function locateWorkspacePath(
  roots: WorkspaceRoot[],
  path: string,
): Promise<LocatedPath | { status: "missing" | "outsideWorkspace" }> {
  return locateCandidates(roots, candidatePaths(roots, path));
}

/** `locateWorkspacePath` over absolute `candidates`, the first that exists winning. */
async function locateCandidates(
  roots: WorkspaceRoot[],
  candidates: string[],
): Promise<LocatedPath | { status: "missing" | "outsideWorkspace" }> {
  const inside = candidates.filter((candidate) => roots.some((root) => isInside(resolve(root.path), candidate)));
  if (inside.length === 0) return { status: "outsideWorkspace" };

  // [>]: A path under a root that cannot be resolved fails its own `realpath`, so it reads as missing or unreadable.
  const realRoots = (await resolveWorkspaceRoots(roots)).resolved.map((entry) => entry.realRoot);
  for (const candidate of inside) {
    const realPath = await realpath(candidate).catch((error: unknown) => {
      if (MISSING_CODES.has(errorCode(error) ?? "")) return undefined;
      throw error;
    });
    if (realPath === undefined) continue;
    const realRoot = realRoots.find((root) => isInside(root, realPath));
    return realRoot === undefined ? { status: "outsideWorkspace" } : { status: "ok", realPath, realRoots, realRoot };
  }
  return { status: "missing" };
}

/**
 * The roots that resolve, in order, each with its real path, and those that do not (deleted, unmounted, a parent
 * denying access), each with the error code. A caller that covers every root must report the unresolved ones.
 */
export async function resolveWorkspaceRoots(roots: WorkspaceRoot[]): Promise<{
  resolved: { root: WorkspaceRoot; realRoot: string }[];
  unresolved: { root: WorkspaceRoot; cause: string }[];
}> {
  const outcomes = await Promise.all(
    roots.map((root) =>
      realpath(root.path).then(
        (realRoot) => ({ root, realRoot }),
        (error: unknown) => ({ root, cause: errorCode(error) ?? String(error) }),
      ),
    ),
  );
  const resolved: { root: WorkspaceRoot; realRoot: string }[] = [];
  const unresolved: { root: WorkspaceRoot; cause: string }[] = [];
  for (const outcome of outcomes) {
    if ("realRoot" in outcome) resolved.push(outcome);
    else unresolved.push(outcome);
  }
  return { resolved, unresolved };
}

/** A custom folder name may hold `/` (`libs/core`): the longest name that prefixes the path wins. */
function candidatePaths(roots: WorkspaceRoot[], path: string): string[] {
  const named =
    roots.length > 1
      ? roots
          .filter((root) => path === root.name || path.startsWith(`${root.name}/`))
          .sort((a, b) => b.name.length - a.name.length)[0]
      : undefined;
  if (named) return [resolve(named.path, path.slice(named.name.length + 1))];
  return roots.map((root) => resolve(root.path, path));
}

/** True when absolute `path` is `root` or inside it, compared as written: resolve symlinks first where they matter. */
export function isInside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith("../") && !isAbsolute(rest));
}

async function readFile(handle: FileHandle): Promise<WorkspaceEntry> {
  const bytes = await readTextBytes(handle);
  if (typeof bytes === "string") return { status: bytes, kind: "file" };
  return { status: "ok", kind: "file", text: new TextDecoder().decode(bytes) };
}

/** The bytes of a text file under the size cap, or why it is not one. */
async function readTextBytes(handle: FileHandle): Promise<Buffer | "tooLarge" | "binary"> {
  // [>]: Read one byte past the cap rather than trust `stat`: the file may grow after it.
  const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
  let size = 0;
  while (size < buffer.length) {
    const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
    if (bytesRead === 0) break;
    size += bytesRead;
  }
  if (size > MAX_FILE_BYTES) return "tooLarge";
  const bytes = buffer.subarray(0, size);
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return "binary";
  return bytes;
}

/**
 * Why a write cannot go ahead, beyond the read failures. `symlink`: the path is a symbolic link that stays inside the
 * workspace. `folder`: the path is a folder. `notText`: the file is not valid UTF-8, so its text would not round-trip.
 */
export type WriteFailure = AccessFailure | "symlink" | "folder" | "notText";

/**
 * Where a write to a path lands. `path`: the absolute path that passed the check, symlinks unresolved, to give back to
 * `writeWorkspaceFile`. `before`: the file's whole text, `undefined` when it does not exist yet.
 */
export type WriteTarget =
  | { status: "ok"; path: string; before: string | undefined }
  | { status: Exclude<WriteFailure, "unreadable"> }
  | { status: "unreadable"; cause: string };

/** A target that passed the check, with what the write needs: its real path, the folders to create, in order. */
type CheckedTarget = {
  status: "ok";
  path: string;
  before: string | undefined;
  realPath: string;
  realRoots: string[];
  newFolders: string[];
};

/** Larger content is refused: a file over it could not be read back. */
export const MAX_WRITE_BYTES = MAX_FILE_BYTES;

/**
 * Check a write to `path` inside `roots` and read what the file holds now. The path resolves as `readWorkspaceEntry`
 * resolves it; a path that exists nowhere goes to the first folder that may hold it. The deepest existing folder
 * above the file must resolve inside a workspace folder, the file itself must not be a symlink, and an existing file
 * is read as `readWorkspaceEntry` reads it, its handle checked to be the file at that path. Never writes; never
 * rejects.
 */
export async function locateWriteTarget(roots: WorkspaceRoot[], path: string): Promise<WriteTarget> {
  const checked = await checkWriteTarget(roots, candidatePaths(roots, path));
  return checked.status === "ok" ? { status: "ok", path: checked.path, before: checked.before } : checked;
}

/**
 * Write `after` to the file at `path`, a path `locateWriteTarget` returned, once checked again: missing folders are
 * created, then the file is created, or truncated and written in place through a handle that never follows a
 * symlink. `alreadyWritten`: the file already holds `after`, so running twice changes nothing. `changed`: it no longer
 * holds `before`, so nothing is written. Never rejects.
 *
 * [!]: The check goes by name before the open, as for reads. A component swapped for a symlink out after it is caught
 * by the handle check before any byte is written, but a new file is created empty by then: accepted, as for reads, since
 * such a writer already runs with the user's rights.
 */
export async function writeWorkspaceFile(
  roots: WorkspaceRoot[],
  path: string,
  before: string | undefined,
  after: string,
): Promise<{ status: "written" | "alreadyWritten" | "changed" } | Exclude<WriteTarget, { status: "ok" }>> {
  try {
    const checked = await checkWriteTarget(roots, [resolve(path)]);
    if (checked.status !== "ok") return checked;
    if (checked.before === after) return { status: "alreadyWritten" };
    if (checked.before !== before) return { status: "changed" };
    for (const folder of checked.newFolders) {
      await mkdir(folder).catch((error: unknown) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
    }
    const flags =
      before === undefined
        ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
        : constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const handle = await open(checked.realPath, flags).catch((error: unknown) => {
      // [>]: Created or swapped for a symlink since the check.
      if (errorCode(error) === "EEXIST" || errorCode(error) === "ELOOP") return undefined;
      throw error;
    });
    if (handle === undefined) return { status: "changed" };
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return { status: "changed" };
      if (!(await isInsideFile(checked.realRoots, checked.realPath, opened))) return { status: "outsideWorkspace" };
      const bytes = Buffer.from(after);
      await handle.truncate(0);
      let written = 0;
      while (written < bytes.length) {
        written += (await handle.write(bytes, written, bytes.length - written, written)).bytesWritten;
      }
      await handle.sync();
      return { status: "written" };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { status: "unreadable", cause: errorCode(error) ?? String(error) };
  }
}

/** `locateWriteTarget` over absolute `candidates`, the first that exists winning. Never rejects. */
async function checkWriteTarget(
  roots: WorkspaceRoot[],
  candidates: string[],
): Promise<CheckedTarget | Exclude<WriteTarget, { status: "ok" }>> {
  try {
    const inside = candidates.filter((candidate) => roots.some((root) => isInside(resolve(root.path), candidate)));
    if (inside.length === 0) return { status: "outsideWorkspace" };
    const path = (await firstExisting(inside)) ?? inside[0]!;
    if (roots.some((root) => resolve(root.path) === path)) return { status: "folder" };

    const realRoots = (await resolveWorkspaceRoots(roots)).resolved.map((entry) => entry.realRoot);
    const ancestor = await deepestFolder(dirname(path));
    if (!realRoots.some((root) => isInside(root, ancestor.realPath))) return { status: "outsideWorkspace" };
    if (!(await stat(ancestor.realPath)).isDirectory()) return { status: "unreadable", cause: "ENOTDIR" };
    const newFolders = ancestor.missing.map((_, index) =>
      join(ancestor.realPath, ...ancestor.missing.slice(0, index + 1)),
    );
    const realPath = join(ancestor.realPath, ...ancestor.missing, basename(path));
    const target = { status: "ok" as const, path, realPath, realRoots, newFolders };
    if (newFolders.length > 0) return { ...target, before: undefined };

    const info = await lstat(realPath).catch((error: unknown) => {
      if (MISSING_CODES.has(errorCode(error) ?? "")) return undefined;
      throw error;
    });
    if (info === undefined) return { ...target, before: undefined };
    if (info.isSymbolicLink()) {
      const linked = await realpath(realPath).catch(() => undefined);
      const stays = linked !== undefined && realRoots.some((root) => isInside(root, linked));
      return { status: stays ? "symlink" : "outsideWorkspace" };
    }
    if (info.isDirectory()) return { status: "folder" };
    if (!info.isFile()) return { status: "unreadable", cause: "not a file" };
    const before = await readWriteTarget(realPath, realRoots);
    return typeof before === "string" ? { ...target, before } : before;
  } catch (error) {
    if (MISSING_CODES.has(errorCode(error) ?? "")) return { status: "missing" };
    return { status: "unreadable", cause: errorCode(error) ?? String(error) };
  }
}

/** The text of the regular file at `realPath`, every byte kept, a byte order mark included. */
async function readWriteTarget(
  realPath: string,
  realRoots: string[],
): Promise<string | Exclude<WriteTarget, { status: "ok" }>> {
  const handle = await open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!(await isInsideFile(realRoots, realPath, opened))) return { status: "outsideWorkspace" };
    if (!opened.isFile()) return { status: "unreadable", cause: "not a file" };
    const bytes = await readTextBytes(handle);
    if (typeof bytes === "string") return { status: bytes };
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return { status: "notText" };
    }
  } finally {
    await handle.close();
  }
}

/** The first of `paths` that exists, symlinks not followed at its last component. */
async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    const found = await lstat(path).then(
      () => true,
      (error: unknown) => {
        if (MISSING_CODES.has(errorCode(error) ?? "")) return false;
        throw error;
      },
    );
    if (found) return path;
  }
  return undefined;
}

/** The real path of the deepest existing ancestor of absolute `folder`, itself included, and the names below it. */
async function deepestFolder(folder: string): Promise<{ realPath: string; missing: string[] }> {
  const missing: string[] = [];
  let current = folder;
  for (;;) {
    try {
      return { realPath: await realpath(current), missing };
    } catch (error) {
      const parent = dirname(current);
      if (!MISSING_CODES.has(errorCode(error) ?? "") || parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Children of the folder at `realPath`, checked by the caller through its open handle. Node lists by name only, so
 * a swap between that check and `readdir` could list another folder; it leaks names, never file contents.
 */
async function listFolder(realPath: string): Promise<string[]> {
  const children = await readdir(realPath, { withFileTypes: true });
  const listed = await Promise.all(
    children.map(async (child) => ({
      name: child.name,
      folder: child.isDirectory() || (await isFolderLink(realPath, child)),
    })),
  );
  return listed
    .sort((a, b) => compareNames(a.name, b.name))
    .map((child) => (child.folder ? `${child.name}/` : child.name));
}

/** The order of a folder listing: by UTF-16 code unit, so it never depends on the locale. */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True for a symlink whose target is a folder; a link whose target cannot be checked is listed as a plain name. */
async function isFolderLink(folder: string, child: Dirent): Promise<boolean> {
  if (!child.isSymbolicLink()) return false;
  const target = await stat(join(folder, child.name)).catch((error: unknown) => {
    if (UNRESOLVED_LINK_CODES.has(errorCode(error) ?? "")) return undefined;
    throw error;
  });
  return target?.isDirectory() ?? false;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
