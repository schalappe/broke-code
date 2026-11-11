/**
 * @module git
 * The built-in Git extension's API (`vscode.git`, version 1), looked up at each use, never declared as a dependency
 * (ADR 0004). The commit message command and the `@diff` mention share this lookup.
 */
import * as vscode from "vscode";

/** How long a lookup waits for the Git extension to finish opening the workspace's repositories. */
const GIT_INIT_TIMEOUT_MS = 10_000;

// [>]: The few members used, typed structurally from microsoft/vscode `extensions/git/src/api/git.d.ts` (API 1)
// instead of copying that file. The exports are checked at run time, since nothing pins the Git extension's version.
type GitState = "uninitialized" | "initialized";
export type GitRepository = {
  readonly rootUri: vscode.Uri;
  readonly inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
  /**
   * With a path, `git diff <ref> -- <path>` run in the repository root: staged and unstaged changes together against
   * `ref`. Never `diffWithHEAD(path)`, which runs `git diff -- <path>`, unstaged only.
   */
  diffWith(ref: string, path: string): Promise<string>;
};
export type GitApi = {
  readonly state: GitState;
  readonly onDidChangeState: vscode.Event<GitState>;
  readonly repositories: readonly GitRepository[];
  /** The open repository holding `uri`, the deepest one winning; `null` when none does. */
  getRepository(uri: vscode.Uri): GitRepository | null;
};
type GitExtension = { readonly enabled: boolean; getAPI(version: 1): GitApi };

/**
 * `found`: the API, once it has opened the workspace's repositories or `GIT_INIT_TIMEOUT_MS` passed. `gitUnavailable`:
 * no Git extension, or exports of another shape. `gitDisabled`: `git.enabled` off, or git not found.
 */
export type GitLookup = { kind: "found"; api: GitApi } | { kind: "gitUnavailable" } | { kind: "gitDisabled" };

/** Look the Git API up now. Never rejects. */
export async function lookUpGit(): Promise<GitLookup> {
  const extension = vscode.extensions.getExtension<unknown>("vscode.git");
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
  await initialized(api);
  return { kind: "found", api };
}

function isGitExtension(value: unknown): value is GitExtension {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<GitExtension>;
  return typeof candidate.enabled === "boolean" && typeof candidate.getAPI === "function";
}

/**
 * Wait until the Git extension has opened the workspace's repositories: until then its list is empty. Past
 * `GIT_INIT_TIMEOUT_MS` the caller goes on with the repositories opened so far.
 */
function initialized(api: GitApi): Promise<void> {
  if (api.state === "initialized") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      listener.dispose();
      resolve();
    };
    const timer = setTimeout(done, GIT_INIT_TIMEOUT_MS);
    const listener = api.onDidChangeState((state) => {
      if (state === "initialized") done();
    });
  });
}
