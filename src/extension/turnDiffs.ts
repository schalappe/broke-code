/**
 * @module turnDiffs
 * The editor side of "Changed files": each held file's diff since before the turn, its tab closed once the file leaves
 * the held turn and at deactivation. Which tabs to close is decided in `core/turnDiffs.ts`.
 */
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import * as vscode from "vscode";
import type { ChangeDiffHost, HeldFileDiff } from "../core/chatController";
import { displayPath } from "../core/tools";
import { BEFORE_TURN_SCHEME, closeTurnDiffs } from "../core/turnDiffs";

/**
 * Opens a held file in the native diff editor: its text before the turn on the left, served from memory by a content
 * provider, so read-only (empty for a file the turn created), and the real file on the right, so it shows what the
 * file holds now, unsaved editor changes included. Disposing it closes the diffs still open.
 */
export class TurnDiffs implements ChangeDiffHost, vscode.TextDocumentContentProvider, vscode.Disposable {
  /** Text of each left side, by URI. */
  private readonly texts = new Map<string, string>();
  /** The left side of each file's diff, by real path, from its first open until `close`. */
  private readonly sides = new Map<string, vscode.Uri>();
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(BEFORE_TURN_SCHEME, this);

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? "";
  }

  /**
   * Open `file`'s diff beside the chat, titled with its path, the focus kept in the chat. A file no longer on disk opens
   * no diff, and a diff that fails to open is shown: each as an error notification. Never rejects.
   */
  async open(file: HeldFileDiff): Promise<void> {
    const shown = displayPath(file.path);
    // [>]: The diff editor shows a missing right side as an empty file, which would read as a change of its own.
    if (!(await isFile(file.realPath))) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("Could not open the changes of {0}: the file no longer exists.", shown),
      );
      return;
    }
    try {
      const title = vscode.l10n.t("{0} (changes of this turn)", shown);
      await vscode.commands.executeCommand("vscode.diff", this.side(file), vscode.Uri.file(file.realPath), title, {
        preview: false,
        preserveFocus: true,
      });
    } catch (error) {
      console.error("broke-code: could not open the diff of a changed file", error);
      void vscode.window.showErrorMessage(
        vscode.l10n.t("Could not open the changes of {0}: {1}", shown, String(error)),
      );
    }
  }

  /** Close the diffs of the files at `realPaths`, which left the held turn, and drop their text. */
  close(realPaths: readonly string[]): void {
    const gone = realPaths.flatMap((realPath) => {
      const side = this.sides.get(realPath);
      this.sides.delete(realPath);
      return side === undefined ? [] : [side];
    });
    if (gone.length === 0) return;
    void closeDiffs(gone)
      .catch((error: unknown) => console.error("broke-code: could not close the diffs of changed files", error))
      .finally(() => {
        for (const side of gone) this.texts.delete(side.toString());
      });
  }

  dispose(): void {
    // [>]: Deactivation: a diff left open would come back after a reload with an empty left side.
    void closeDiffs().then(undefined, (error: unknown) =>
      console.error("broke-code: could not close the diffs of changed files", error),
    );
    this.texts.clear();
    this.sides.clear();
    this.registration.dispose();
  }

  /**
   * The left side of `file`'s diff: the one already given while it holds the same text, so a second click shows the
   * tab already open; else a new one.
   */
  private side(file: HeldFileDiff): vscode.Uri {
    const text = file.original ?? "";
    const known = this.sides.get(file.realPath);
    if (known !== undefined && this.texts.get(known.toString()) === text) return known;
    // [>]: An id never reused, even by a later activation, as for the approval's diff: VS Code would show a reused
    // URI's old text. The file name ends the path, so the diff picks the file's language.
    const side = vscode.Uri.from({
      scheme: BEFORE_TURN_SCHEME,
      path: `/${crypto.randomUUID()}/${basename(file.realPath)}`,
    });
    if (known !== undefined) this.texts.delete(known.toString());
    this.texts.set(side.toString(), text);
    this.sides.set(file.realPath, side);
    return side;
  }
}

/** Whether a file is at `path` now; never rejects. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Close the changed files' diffs whose left side is one of `sides`, or every one when it is absent. */
function closeDiffs(sides?: readonly vscode.Uri[]): Promise<void> {
  return closeTurnDiffs(
    vscode.window.tabGroups.all.flatMap((group) => group.tabs),
    (tab) => (tab.input instanceof vscode.TabInputTextDiff ? tab.input.original : undefined),
    (tabs) => vscode.window.tabGroups.close(tabs),
    sides,
  );
}
