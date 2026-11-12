/**
 * @module turnDiffs
 * The editor side of "Changed files": the core `TurnDiffs` over VS Code's diff editor, tabs, and notifications, and the
 * content provider of its left sides. The decisions live in `core/turnDiffs.ts`.
 */
import { stat } from "node:fs/promises";
import * as vscode from "vscode";
import { BEFORE_TURN_SCHEME, closeTurnDiffs, TurnDiffs } from "../core/turnDiffs";

/**
 * The changed files' diffs, and the registration of the content provider that serves their left side. Disposing it
 * closes the diffs still open (see `TurnDiffs.dispose`).
 */
export function registerTurnDiffs(): { diffs: TurnDiffs<vscode.Uri>; registration: vscode.Disposable } {
  const diffs = new TurnDiffs<vscode.Uri>(
    {
      isFile: (path) =>
        stat(path).then(
          (info) => info.isFile(),
          () => false,
        ),
      // [>]: An id never reused, even by a later activation, as for the approval's diff: VS Code would show a reused
      // URI's old text.
      side: (name) => vscode.Uri.from({ scheme: BEFORE_TURN_SCHEME, path: `/${crypto.randomUUID()}/${name}` }),
      openDiff: (original, realPath, title) =>
        vscode.commands.executeCommand("vscode.diff", original, vscode.Uri.file(realPath), title, {
          preview: false,
          preserveFocus: true,
        }),
      closeDiffs: (originals) =>
        closeTurnDiffs(
          vscode.window.tabGroups.all.flatMap((group) => group.tabs),
          (tab) => (tab.input instanceof vscode.TabInputTextDiff ? tab.input.original : undefined),
          (tabs) => vscode.window.tabGroups.close(tabs),
          originals,
        ),
      showError: (message) => void vscode.window.showErrorMessage(message),
    },
    vscode.l10n,
  );
  const provider = vscode.workspace.registerTextDocumentContentProvider(BEFORE_TURN_SCHEME, {
    provideTextDocumentContent: (uri) => diffs.text(uri),
  });
  return {
    diffs,
    registration: {
      dispose: () => {
        diffs.dispose();
        provider.dispose();
      },
    },
  };
}
