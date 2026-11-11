/**
 * @module git
 * The built-in Git extension's API (`vscode.git`, version 1), looked up at each use, never declared as a dependency
 * (ADR 0004): the availability checks, the wait for its repositories, and the `@diff` port's per-folder diff. The host
 * passes the extension and builds URIs (`src/extension/git.ts`), so everything here is tested without `vscode`.
 */
import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { DiffReader, FolderDiff } from "./diff";
import type { WorkspaceRoot } from "./workspaceFiles";

/** How long a lookup waits for the Git extension to finish opening the workspace's repositories. */
export const GIT_INIT_TIMEOUT_MS = 10_000;

// [>]: The few members used, typed structurally from microsoft/vscode `extensions/git/src/api/git.d.ts` (API 1)
// instead of copying that file. The exports are checked at run time, since nothing pins the Git extension's version.
type GitState = "uninitialized" | "initialized";

/** The members of a `vscode.Uri` used here; the host's URIs have them. */
export type GitUri = { readonly fsPath: string; toString(): string };

export type GitRepository = {
  readonly rootUri: GitUri;
  readonly inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
  /**
   * With a path, `git diff <ref> -- <path>` run in the repository root: staged and unstaged changes together against
   * `ref`, a relative `path` given to git as a pathspec with each `\` turned into `/`. Never `diffWithHEAD(path)`,
   * which runs `git diff -- <path>`, unstaged only.
   */
  diffWith(ref: string, path: string): Promise<string>;
};

export type GitApi = {
  readonly state: GitState;
  onDidChangeState(listener: (state: GitState) => void): { dispose(): void };
  readonly repositories: readonly GitRepository[];
  /** The open repository holding `uri`, the deepest one winning; `null` when none does. */
  getRepository(uri: GitUri): GitRepository | null;
};

type GitExtension = { readonly enabled: boolean; getAPI(version: 1): GitApi };

/** The members of `vscode.Extension` used here: the host passes `vscode.extensions.getExtension("vscode.git")`. */
export type ExtensionHandle = {
  readonly isActive: boolean;
  readonly exports: unknown;
  activate(): PromiseLike<unknown>;
};

/**
 * `found`: the API, once it has opened the workspace's repositories or the wait timed out. `gitUnavailable`: no Git
 * extension, one that fails to activate, or exports of another shape. `gitDisabled`: `git.enabled` off, or git not
 * found.
 */
export type GitLookup = { kind: "found"; api: GitApi } | { kind: "gitUnavailable" } | { kind: "gitDisabled" };

/**
 * Look the Git API up in `extension`, the Git extension or `undefined` when it is not installed. While the API is
 * `uninitialized` its repository list is empty, so the lookup waits for `initialized`, at most `timeoutMs`, then goes
 * on with the repositories opened so far. Never rejects.
 */
export async function lookUpGit(
  extension: ExtensionHandle | undefined,
  timeoutMs: number = GIT_INIT_TIMEOUT_MS,
): Promise<GitLookup> {
  if (!extension) return { kind: "gitUnavailable" };
  let exports: unknown;
  try {
    exports = extension.isActive ? extension.exports : await extension.activate();
  } catch (error) {
    console.error("broke-code: the Git extension did not activate", error);
    return { kind: "gitUnavailable" };
  }
  if (!isGitExtension(exports)) return { kind: "gitUnavailable" };
  if (!exports.enabled) return { kind: "gitDisabled" };
  let api: GitApi;
  try {
    api = exports.getAPI(1);
  } catch {
    // [>]: `getAPI` throws when git is disabled or not found; `enabled` may have changed since the check above.
    return { kind: "gitDisabled" };
  }
  if (!isGitApi(api)) return { kind: "gitUnavailable" };
  await initialized(api, timeoutMs);
  return { kind: "found", api };
}

function isGitExtension(value: unknown): value is GitExtension {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<GitExtension>;
  return typeof candidate.enabled === "boolean" && typeof candidate.getAPI === "function";
}

function isGitApi(value: unknown): value is GitApi {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<GitApi>;
  return (
    typeof candidate.state === "string" &&
    typeof candidate.onDidChangeState === "function" &&
    Array.isArray(candidate.repositories) &&
    typeof candidate.getRepository === "function"
  );
}

/** Settles once `api` is `initialized`, or after `timeoutMs`. */
function initialized(api: GitApi, timeoutMs: number): Promise<void> {
  if (api.state === "initialized") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      listener.dispose();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const listener = api.onDidChangeState((state) => {
      if (state === "initialized") done();
    });
  });
}

/**
 * The `@diff` port over `lookUp` (the host's `lookUpGit`): for each workspace folder, the diff of its tracked files
 * against `HEAD` in the repository holding it, `toUri` turning the folder's path into the URI `getRepository` takes.
 * `gitUnavailable` for a missing or disabled Git extension, which the commit message command tells apart.
 */
export function gitDiffReader(lookUp: () => Promise<GitLookup>, toUri: (path: string) => GitUri): DiffReader {
  return {
    read: async (roots) => {
      const git = await lookUp();
      if (git.kind !== "found") return { kind: "gitUnavailable" };
      const folders = await Promise.all(roots.map((root) => folderDiff(git.api, root, toUri)));
      return { kind: "read", folders };
    },
  };
}

/**
 * `git diff HEAD -- :(literal)<folder>` in the repository holding `root`, staged and unstaged together. The folder goes
 * as a path relative to the repository's real root, `.` for the root itself: `diffWith` turns an absolute path equal to
 * the root into an empty pathspec, which git refuses.
 */
async function folderDiff(api: GitApi, root: WorkspaceRoot, toUri: (path: string) => GitUri): Promise<FolderDiff> {
  const repository = api.getRepository(toUri(root.path));
  if (!repository) return { kind: "noRepository" };
  try {
    const [repositoryRoot, folder] = await Promise.all([realpath(repository.rootUri.fsPath), realpath(root.path)]);
    const path = (relative(repositoryRoot, folder) || ".").split(sep).join("/");
    // [!]: `diffWith` hands git a relative path with each `\` turned into `/`, so a name holding one would name another
    // folder: refused rather than diff a folder outside the workspace.
    if (path.includes("\\")) {
      return {
        kind: "failed",
        cause: "its path holds a backslash, which the Git extension reads as a folder separator",
      };
    }
    // [!]: `:(literal)`: a repository can name a folder `app*`, `[x]`, `?`, or `:e`, which git would otherwise read as a
    // wildcard or pathspec magic matching paths outside the folder, such as `app-private`.
    return { kind: "diff", text: await repository.diffWith("HEAD", `:(literal)${path}`) };
  } catch (error) {
    return { kind: "failed", cause: gitErrorCause(error) };
  }
}

/**
 * Why a git call failed, on one line, since the notice that quotes it is one line: the Git extension's `GitError` says
 * "Failed to execute git" and keeps git's own message in `stderr`, such as `fatal: bad revision 'HEAD'` in a repository
 * without a commit, its line breaks becoming single spaces.
 */
function gitErrorCause(error: unknown): string {
  const stderr = typeof error === "object" && error !== null && "stderr" in error ? error.stderr : undefined;
  if (typeof stderr === "string" && stderr.trim() !== "") return stderr.trim().replace(/\s*[\r\n]+\s*/g, " ");
  return error instanceof Error ? error.message : String(error);
}
