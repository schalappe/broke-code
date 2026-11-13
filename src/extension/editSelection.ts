/**
 * @module editSelection
 * The host side of `broke-code.editSelection` and its presets: the active editor read when a command runs, the
 * instruction's input box of "Edit selection", the progress notification, the diff of two read-only virtual documents
 * of `EDIT_SCHEME` with its tab watched for closing, the edit applied through a `WorkspaceEdit`, and the Accept and Reject commands of the diff's
 * title bar, over the core's `SelectionEditor`.
 */
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { basename } from "node:path";
import * as vscode from "vscode";
import { type ChatModel, streamChat } from "../core/client";
import {
  EDIT_COMMANDS,
  EDIT_SCHEME,
  type EditDocument,
  type EditorState,
  editInstruction,
  isWritableDocument,
  type LiveDocument,
  requestPath,
  SelectionEditor,
  type SelectionEditPorts,
} from "../core/editSelection";
import type { ProviderSupport } from "../core/providerSupport";
import type { WorkspaceRoot } from "../core/workspaceFiles";
import { withCancellableProgress } from "./progress";

export const ACCEPT_EDIT_COMMAND = "broke-code.acceptEdit";
export const REJECT_EDIT_COMMAND = "broke-code.rejectEdit";

/**
 * Register "Edit selection" and its presets, Accept and Reject, the diffs' content provider, and the watch of their
 * tabs. `chatModel` gives the chat's provider and model; `providerSupport` is the chat's memory of each model; `roots`
 * the workspace folders, for the path the request names. The disposable aborts every request and closes the diffs.
 */
export function registerEditSelectionCommand(
  chatModel: () => Promise<ChatModel | undefined>,
  providerSupport: ProviderSupport,
  roots: () => WorkspaceRoot[],
): vscode.Disposable {
  const diffs = new EditDiffs();
  const ports: SelectionEditPorts = {
    chatModel,
    stream: streamChat,
    providerSupport,
    withProgress: (task) => withCancellableProgress(vscode.l10n.t("Editing the selection…"), task),
    showDiff: (id, document, proposed) => diffs.show(id, document, proposed),
    closeDiff: (id) => diffs.close(id),
    closeAllDiffs: () => diffs.close(),
    openDocument: liveDocument,
    showError: ({ message, detail }) => void vscode.window.showErrorMessage(detail ? `${message} ${detail}` : message),
  };
  const editor = new SelectionEditor(ports, vscode.l10n);
  // [>]: A tab moved to another group closes in one and opens in the other: only a diff no tab shows any more ended.
  const closed = (tabs: readonly vscode.Tab[]) => {
    for (const tab of tabs) {
      const id = diffIdOf(diffSide(tab));
      if (id === undefined || diffs.isOpen(id)) continue;
      diffs.release(id);
      editor.diffClosed(id);
    }
  };
  return vscode.Disposable.from(
    ...EDIT_COMMANDS.map((command) =>
      vscode.commands.registerCommand(command, () =>
        editor.run(() => readEditor(roots), editInstruction(command, askInstruction)),
      ),
    ),
    vscode.commands.registerCommand(ACCEPT_EDIT_COMMAND, (target?: unknown) => {
      const id = targetDiff(target);
      return id === undefined ? undefined : editor.accept(id);
    }),
    vscode.commands.registerCommand(REJECT_EDIT_COMMAND, (target?: unknown) => {
      const id = targetDiff(target);
      return id === undefined ? undefined : editor.reject(id);
    }),
    vscode.window.tabGroups.onDidChangeTabs((event) => closed(event.closed)),
    vscode.window.tabGroups.onDidChangeTabGroups((event) => closed(event.closed.flatMap((group) => group.tabs))),
    // [>]: Before the provider goes, so the diffs close while their content is still served.
    { dispose: () => editor.dispose() },
    diffs,
  );
}

/** The instruction for "Edit selection": an input box; Escape or an empty text ends the run with nothing sent. */
function askInstruction(document: EditDocument): Promise<string | undefined> {
  return Promise.resolve(
    vscode.window.showInputBox({
      title: vscode.l10n.t("Edit selection"),
      prompt: vscode.l10n.t("Describe the change to make to the selection in {0}.", document.name),
      placeHolder: vscode.l10n.t("For example: handle an empty list"),
      ignoreFocusOut: true,
    }),
  );
}

/**
 * The active text editor's document and primary selection, read now; `undefined` without an active text editor.
 * The text and the selection's offsets are read together before the writable check waits, so an edit meanwhile
 * cannot pair one with the other.
 */
async function readEditor(roots: () => WorkspaceRoot[]): Promise<EditorState | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const { document, selection } = editor;
  const { uri } = document;
  const read: EditDocument = {
    uri: uri.toString(),
    name: basename(uri.path),
    path: requestPath(uri.scheme, uri.fsPath, roots()),
    languageId: document.languageId,
    eol: document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n",
    text: document.getText(),
    start: document.offsetAt(selection.start),
    end: document.offsetAt(selection.end),
  };
  const writable = await isWritableDocument(uri.scheme, vscode.workspace.fs.isWritableFileSystem(uri.scheme), () =>
    access(uri.fsPath, constants.W_OK),
  );
  return { scheme: uri.scheme, writable, document: read };
}

/**
 * The edited document now: the open one, or a `file` document opened again from its URI. `undefined` when it no
 * longer exists: a closed untitled document, which opening its URI would recreate empty, or a file that cannot be
 * opened (deleted).
 */
async function liveDocument(document: EditDocument): Promise<LiveDocument | undefined> {
  let open = vscode.workspace.textDocuments.find((each) => each.uri.toString() === document.uri);
  if (!open) {
    const uri = vscode.Uri.parse(document.uri);
    if (uri.scheme !== "file") return undefined;
    try {
      open = await vscode.workspace.openTextDocument(uri);
    } catch {
      // [>]: The file is gone: the core reports the change, which is the notification this case gets.
      return undefined;
    }
  }
  const live = open;
  return {
    isClosed: () => live.isClosed,
    text: () => live.getText(),
    replace: (start, end, text) => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(live.uri, new vscode.Range(live.positionAt(start), live.positionAt(end)), text);
      return vscode.workspace.applyEdit(edit);
    },
  };
}

/**
 * The diffs of the runs: both sides served from memory under `EDIT_SCHEME`, read-only, at paths never reused
 * (`/<id>/original/<name>` and `/<id>/proposed/<name>`), so a crashed host's leftover tab never shows a later run's
 * text and the file name gives the diff its language.
 */
class EditDiffs implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly texts = new Map<string, { original: string; proposed: string }>();
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(EDIT_SCHEME, this);

  provideTextDocumentContent(uri: vscode.Uri): string {
    const id = diffIdOf(uri);
    const texts = id === undefined ? undefined : this.texts.get(id);
    if (!texts) return "";
    return uri.path.split("/")[2] === "proposed" ? texts.proposed : texts.original;
  }

  /** Open the diff `id` of `document` and `proposed`, titled with the file's name. Rejects when it cannot open. */
  async show(id: string, document: EditDocument, proposed: string): Promise<void> {
    const side = (name: string) => vscode.Uri.from({ scheme: EDIT_SCHEME, path: `/${id}/${name}/${document.name}` });
    this.texts.set(id, { original: document.text, proposed });
    try {
      const title = vscode.l10n.t("{0} (edited selection)", document.name);
      await vscode.commands.executeCommand("vscode.diff", side("original"), side("proposed"), title, {
        preview: false,
      });
    } catch (error) {
      this.release(id);
      throw error;
    }
  }

  isOpen(id: string): boolean {
    return editTabs().some((tab) => diffIdOf(diffSide(tab)) === id);
  }

  /** Close the tab of the diff `id`, or every edit diff's tab when it is absent, a crashed host's included. */
  async close(id?: string): Promise<void> {
    const tabs = editTabs().filter((tab) => id === undefined || diffIdOf(diffSide(tab)) === id);
    if (id === undefined) this.texts.clear();
    else this.release(id);
    if (tabs.length === 0) return;
    const closed = await vscode.window.tabGroups.close(tabs);
    if (!closed) throw new Error("VS Code did not close every edit diff tab.");
  }

  release(id: string): void {
    this.texts.delete(id);
  }

  dispose(): void {
    this.texts.clear();
    this.registration.dispose();
  }
}

function editTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => diffSide(tab) !== undefined);
}

function diffSide(tab: vscode.Tab): vscode.Uri | undefined {
  const { input } = tab;
  return input instanceof vscode.TabInputTextDiff && input.modified.scheme === EDIT_SCHEME ? input.modified : undefined;
}

/** The id of the edit diff a side's URI belongs to. */
function diffIdOf(uri: vscode.Uri | undefined): string | undefined {
  if (uri?.scheme !== EDIT_SCHEME) return undefined;
  const id = uri.path.split("/")[1];
  return id === "" ? undefined : id;
}

/**
 * The diff Accept or Reject acts on: from the title bar, `target` is the URI of the editor's resource, either side of
 * the diff; without one (a keybinding), the active tab's.
 */
function targetDiff(target: unknown): string | undefined {
  if (target instanceof vscode.Uri) return diffIdOf(target);
  const active = vscode.window.tabGroups.activeTabGroup.activeTab;
  return active ? diffIdOf(diffSide(active)) : undefined;
}
