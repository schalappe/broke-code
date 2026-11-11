/**
 * @module commitMessage
 * The `broke-code.generateCommitMessage` command's host side: the git port over the built-in Git extension's API
 * (`vscode.git`, version 1), looked up when the command runs, never declared as a dependency (ADR 0004), and the
 * notifications, the replace question, and the progress the core's `CommitMessageGenerator` runs under.
 */
import { basename } from "node:path";
import * as vscode from "vscode";
import { streamChat } from "../core/client";
import {
  CommitMessageGenerator,
  type CommitMessagePorts,
  type CommitRepository,
  type CommitSelection,
  type RepositoryLookup,
} from "../core/commitMessage";

export const GENERATE_COMMIT_MESSAGE_COMMAND = "broke-code.generateCommitMessage";

/** How long a run waits for the Git extension to finish opening the workspace's repositories. */
const GIT_INIT_TIMEOUT_MS = 10_000;

// [>]: The few members used, typed structurally from microsoft/vscode `extensions/git/src/api/git.d.ts` (API 1)
// instead of copying that file. The exports are checked at run time, since nothing pins the Git extension's version.
type GitState = "uninitialized" | "initialized";
type GitRepository = {
  readonly rootUri: vscode.Uri;
  readonly inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
};
type GitApi = {
  readonly state: GitState;
  readonly onDidChangeState: vscode.Event<GitState>;
  readonly repositories: readonly GitRepository[];
};
type GitExtension = { readonly enabled: boolean; getAPI(version: 1): GitApi };

/**
 * Register the command. `selection` gives the chat's provider and model; the disposable aborts every run, so
 * deactivation writes nothing.
 */
export function registerCommitMessageCommand(selection: () => Promise<CommitSelection | undefined>): vscode.Disposable {
  const ports: CommitMessagePorts = {
    selection,
    stream: streamChat,
    confirmReplace: async (repository) => {
      const replace = vscode.l10n.t("Replace");
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t("The commit message box of {0} already holds text. Replace it?", repository.name),
        { modal: true },
        replace,
      );
      return choice === replace;
    },
    withProgress: async (task) =>
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t("Generating the commit message…"),
          cancellable: true,
        },
        (_progress, token) => {
          const cancel = new AbortController();
          token.onCancellationRequested(() => cancel.abort());
          return task(cancel.signal);
        },
      ),
    showError: ({ message, detail }) => void vscode.window.showErrorMessage(detail ? `${message} ${detail}` : message),
    showWarning: (message) => void vscode.window.showWarningMessage(message),
  };
  const generator = new CommitMessageGenerator(ports, vscode.l10n);
  const command = vscode.commands.registerCommand(GENERATE_COMMIT_MESSAGE_COMMAND, (target?: unknown) =>
    generator.run(() => findRepository(target)),
  );
  return vscode.Disposable.from(command, { dispose: () => generator.dispose() });
}

/**
 * The repository a run works on. From the Source Control title, `target` is the `SourceControl` the button belongs to,
 * matched to a repository by its `rootUri`. From the Command Palette, `target` is absent: the only repository, or the
 * one picked when there are several.
 */
async function findRepository(target: unknown): Promise<RepositoryLookup> {
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

  const root = rootUriOf(target);
  if (root) {
    const match = api.repositories.find((repository) => repository.rootUri.toString() === root.toString());
    return match ? { kind: "found", repository: commitRepository(match) } : { kind: "noRepository" };
  }
  const repositories = api.repositories.map(commitRepository);
  const [only] = repositories;
  if (!only) return { kind: "noRepository" };
  if (repositories.length === 1) return { kind: "found", repository: only };
  const picked = await vscode.window.showQuickPick(
    repositories.map((repository) => ({ label: repository.name, description: repository.root, repository })),
    { placeHolder: vscode.l10n.t("Choose a repository") },
  );
  return picked ? { kind: "found", repository: picked.repository } : { kind: "dismissed" };
}

function isGitExtension(value: unknown): value is GitExtension {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<GitExtension>;
  return typeof candidate.enabled === "boolean" && typeof candidate.getAPI === "function";
}

/**
 * Wait until the Git extension has opened the workspace's repositories: until then its list is empty. Past
 * `GIT_INIT_TIMEOUT_MS` the run goes on with the repositories opened so far.
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

/** The `rootUri` of the `SourceControl` the Source Control title hands the command, if `target` is one. */
function rootUriOf(target: unknown): vscode.Uri | undefined {
  if (typeof target !== "object" || target === null || !("rootUri" in target)) return undefined;
  return target.rootUri instanceof vscode.Uri ? target.rootUri : undefined;
}

function commitRepository(repository: GitRepository): CommitRepository {
  const root = repository.rootUri.fsPath;
  return {
    root,
    name: basename(root),
    readInputBox: () => repository.inputBox.value,
    writeInputBox: (message) => {
      repository.inputBox.value = message;
    },
    stagedDiff: () => repository.diff(true),
  };
}
