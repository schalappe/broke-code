/**
 * @module commitMessage
 * The `broke-code.generateCommitMessage` command's host side: the git port over the built-in Git extension's API,
 * looked up when the command runs (`lookUpGit`, ADR 0004), and the notifications, the replace question, and the
 * progress the core's `CommitMessageGenerator` runs under.
 */
import { basename } from "node:path";
import * as vscode from "vscode";
import { type ChatModel, streamChat } from "../core/client";
import {
  CommitMessageGenerator,
  type CommitMessagePorts,
  type CommitRepository,
  type RepositoryLookup,
} from "../core/commitMessage";
import type { ProviderSupport } from "../core/providerSupport";
import { type GitRepository, lookUpGit } from "./git";

export const GENERATE_COMMIT_MESSAGE_COMMAND = "broke-code.generateCommitMessage";

/**
 * Register the command. `selection` gives the chat's provider and model; `providerSupport` is the chat's memory of
 * each model. The disposable aborts every run, so deactivation writes nothing.
 */
export function registerCommitMessageCommand(
  selection: () => Promise<ChatModel | undefined>,
  providerSupport: ProviderSupport,
): vscode.Disposable {
  const ports: CommitMessagePorts = {
    selection,
    stream: streamChat,
    providerSupport,
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
  const git = await lookUpGit();
  if (git.kind !== "found") return git;
  const { api } = git;

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
