/**
 * @module approval
 * The editor side of a write's approval: the diff preview of a planned change, the unsaved-changes check before a
 * write, and the mode and denied commands settings. The decisions live in `core/approval.ts`; this module feeds them VS Code's tabs,
 * documents, and settings.
 */
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import * as vscode from "vscode";
import {
  CHANGE_SCHEME,
  closeChangeDiffs,
  hasUnsavedChanges as documentsHaveUnsavedChanges,
  type Preview,
  type SettingMode,
  settingMode,
} from "../core/approval";
import { deniedCommands } from "../core/fullAccess";
import { displayPath } from "../core/tools";
import type { PlannedChange } from "../core/writeTools";

/**
 * Opens each planned change in the native diff editor: the planned text on the left, the one Accept checks the file
 * against (empty for a new file), and the proposed text on the right. Both sides are served from memory by a content
 * provider, so they are read-only and never touch the file. Disposing it closes the diffs still open.
 */
export class DiffPreviews implements vscode.TextDocumentContentProvider, vscode.Disposable {
  /** Text of each side open, by URI. */
  private readonly texts = new Map<string, string>();
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(CHANGE_SCHEME, this);

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? "";
  }

  /** Open `change` beside the chat, titled with its path. Rejects when the diff editor cannot open. */
  async preview(change: PlannedChange): Promise<Preview> {
    // [>]: An id never reused, even by a later activation: a host crash leaves the old diffs and their documents open,
    // and VS Code would show a reused URI's old text, not this change. The file name ends each side's path, so the
    // diff picks the file's language.
    const id = crypto.randomUUID();
    const side = (name: string) =>
      vscode.Uri.from({ scheme: CHANGE_SCHEME, path: `/${id}/${name}/${basename(change.target)}` });
    const before = side("planned");
    const after = side("proposed");
    this.texts.set(before.toString(), change.before ?? "");
    this.texts.set(after.toString(), change.after);
    const release = () => {
      this.texts.delete(before.toString());
      this.texts.delete(after.toString());
    };
    const title = vscode.l10n.t("{0} (proposed change)", displayPath(change.path));
    // [>]: Focus stays in the chat, where Accept and Reject are. Opening the same two URIs again brings the open diff
    // to the front, or reopens it from the texts still held.
    const show = () =>
      vscode.commands.executeCommand("vscode.diff", before, after, title, { preview: false, preserveFocus: true });
    try {
      await show();
    } catch (error) {
      release();
      throw error;
    }
    return {
      show: async () => {
        await show();
      },
      close: async () => {
        try {
          await closeDiffs(after);
        } finally {
          release();
        }
      },
    };
  }

  dispose(): void {
    // [>]: Deactivation: the requests were cancelled; a diff left open would show an empty change after a reload.
    void closeDiffs().then(undefined, (error: unknown) =>
      console.error("broke-code: could not close the change previews", error),
    );
    this.texts.clear();
    this.registration.dispose();
  }
}

/** Close the change diff whose proposed side is `proposed`, or every change diff when it is absent. */
function closeDiffs(proposed?: vscode.Uri): Promise<void> {
  return closeChangeDiffs(
    vscode.window.tabGroups.all.flatMap((group) => group.tabs),
    (tab) => (tab.input instanceof vscode.TabInputTextDiff ? tab.input.modified : undefined),
    (tabs) => vscode.window.tabGroups.close(tabs),
    proposed,
  );
}

/**
 * Whether an editor holds unsaved changes to the file at `target` (see the core `hasUnsavedChanges`). A path that
 * cannot be resolved (a new file) compares as given. Never rejects.
 */
export function hasUnsavedChanges(target: string): Promise<boolean> {
  const resolve = (path: string) => realpath(path).catch(() => path);
  return documentsHaveUnsavedChanges(vscode.workspace.textDocuments, target, resolve);
}

/** `brokeCode.mode` from the user settings only (see `settingMode`). */
export function readSettingMode(): SettingMode {
  return settingMode(vscode.workspace.getConfiguration("brokeCode").inspect<unknown>("mode"));
}

/**
 * Write `mode` to the user value of `brokeCode.mode`, the mode selector's pick: a user setting, so it applies
 * to every window. Rejects when the write fails.
 */
export async function writeSettingMode(mode: SettingMode): Promise<void> {
  await vscode.workspace.getConfiguration("brokeCode").update("mode", mode, vscode.ConfigurationTarget.Global);
}

/** The denied commands of Full access: the defaults and the user's `brokeCode.deniedCommands` (see `deniedCommands`). */
export function readDeniedCommands(): string[] {
  return deniedCommands(vscode.workspace.getConfiguration("brokeCode").inspect<unknown>("deniedCommands"));
}
