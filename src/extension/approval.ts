/**
 * @module approval
 * The editor side of a write's approval: the diff preview of a planned change, the unsaved-changes check before a
 * write, and the auto-approve setting.
 */
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import * as vscode from "vscode";
import type { Preview } from "../core/approval";
import { displayPath } from "../core/tools";
import type { PlannedChange } from "../core/writeTools";

const SCHEME = "broke-code-change";

/**
 * Opens each planned change in the native diff editor: the planned text on the left, the one Accept checks the file
 * against (empty for a new file), and the proposed text on the right. Both sides are served from memory by a content
 * provider, so they are read-only and never touch the file. Disposing it closes the diffs still open.
 */
export class DiffPreviews implements vscode.TextDocumentContentProvider, vscode.Disposable {
  /** Text of each side open, by URI. */
  private readonly texts = new Map<string, string>();
  private lastId = 0;
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? "";
  }

  /** Open `change` beside the chat, titled with its path. Rejects when the diff editor cannot open. */
  async preview(change: PlannedChange): Promise<Preview> {
    const id = ++this.lastId;
    // [>]: The file name ends each side's path, so the diff picks the file's language.
    const side = (name: string) =>
      vscode.Uri.from({ scheme: SCHEME, path: `/${id}/${name}/${basename(change.target)}` });
    const before = side("planned");
    const after = side("proposed");
    this.texts.set(before.toString(), change.before ?? "");
    this.texts.set(after.toString(), change.after);
    const release = () => {
      this.texts.delete(before.toString());
      this.texts.delete(after.toString());
    };
    try {
      const title = vscode.l10n.t("{0} (proposed change)", displayPath(change.path));
      // [>]: Focus stays in the chat, where Accept and Reject are.
      await vscode.commands.executeCommand("vscode.diff", before, after, title, {
        preview: false,
        preserveFocus: true,
      });
    } catch (error) {
      release();
      throw error;
    }
    return {
      close: async () => {
        try {
          await closeDiffs((uri) => uri.toString() === after.toString());
        } finally {
          release();
        }
      },
    };
  }

  dispose(): void {
    // [>]: Deactivation: the requests were cancelled; a diff left open would show an empty change after a reload.
    void closeDiffs((uri) => uri.scheme === SCHEME).then(undefined, (error: unknown) =>
      console.error("broke-code: could not close the change previews", error),
    );
    this.texts.clear();
    this.registration.dispose();
  }
}

/** Close every diff tab whose proposed side matches `matches`. */
async function closeDiffs(matches: (uri: vscode.Uri) => boolean): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputTextDiff && matches(tab.input.modified));
  if (tabs.length > 0) await vscode.window.tabGroups.close(tabs);
}

/**
 * Whether an editor holds unsaved changes to the file at `target`, which a write would race. Paths compare once
 * resolved, symlinks and letter case included; a path that cannot be resolved (a new file) compares as given. Never
 * rejects.
 */
export async function hasUnsavedChanges(target: string): Promise<boolean> {
  const dirty = vscode.workspace.textDocuments.filter((document) => document.isDirty && document.uri.scheme === "file");
  if (dirty.length === 0) return false;
  const resolved = (path: string) => realpath(path).catch(() => path);
  const file = await resolved(target);
  for (const document of dirty) {
    if ((await resolved(document.uri.fsPath)) === file) return true;
  }
  return false;
}

/**
 * `brokeCode.autoApproveWrites` from the user settings. [!]: User settings only, like the providers: a repository must
 * not turn approval off. The manifest's `application` scope already makes VS Code ignore a workspace value; reading
 * `globalValue` keeps that explicit here.
 */
export function readAutoApproveWrites(): boolean {
  return vscode.workspace.getConfiguration("brokeCode").inspect<unknown>("autoApproveWrites")?.globalValue === true;
}
