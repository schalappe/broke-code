/**
 * @module insertCode
 * Insert at cursor: a code block's text replacing every selection of the active text editor, as a paste does. No
 * `vscode` import: the host fills the editor port with `window.activeTextEditor`, whose shape matches.
 * [>]: VS Code's `TextEditor.edit` settles `true` on a read-only document although nothing applied (its main thread
 * ignores what the editor did), and `false` only on a version mismatch or a closed editor. So the document's version
 * is read before and after: an edit that left it unchanged is refused, unless every selection already held the text.
 * Accepted gap: VS Code checks the version itself when it applies, so a change before that refuses the edit; only a
 * change from elsewhere landing between a read-only no-op and its answer would pass that no-op as `done`.
 */
import type { Translator } from "./modelList";

/** The edit builder an editor hands to its `edit` callback: each `replace` joins that one edit. */
export type InsertEdit<Location> = { replace(location: Location, value: string): void };

/**
 * A text editor: its selections (an empty one is a caret), its document (`version` grows with each change, `getText`
 * reads a selection's text), and `edit`, which applies every replacement its callback makes as one undoable edit and
 * settles `false` when the editor cannot apply it (but see the module comment).
 */
export type InsertEditor<Location> = {
  readonly selections: readonly Location[];
  readonly document: { readonly version: number; getText(location: Location): string };
  edit(callback: (edit: InsertEdit<Location>) => void): PromiseLike<boolean>;
};

/** `activeEditor`: the active text editor, or `undefined` when none is. `showError`: a native error notification. */
export type InsertPorts<Location> = {
  activeEditor(): InsertEditor<Location> | undefined;
  showError(message: string): void;
};

/**
 * `done`: every selection holds the text. `noEditor`: no text editor is active. `refused`: the editor refused the
 * edit, or settled `true` and changed nothing. `failed`: the edit threw. Each but `done` changed nothing and was shown.
 */
export type InsertOutcome = "done" | "noEditor" | "refused" | "failed";

/**
 * Replace every selection of the active text editor with `text` in one edit, so one Undo restores it. A success shows
 * nothing and moves no focus; a failure is shown, never rejected, since the webview's message started it.
 */
export async function insertCode<Location>(
  text: string,
  ports: InsertPorts<Location>,
  l10n: Translator,
): Promise<InsertOutcome> {
  const editor = ports.activeEditor();
  if (!editor) {
    ports.showError(l10n.t("No text editor is active: open a file to insert the code."));
    return "noEditor";
  }
  // [>]: The selections as they were, which an edit that applied nothing leaves where they are.
  const selections = [...editor.selections];
  const version = editor.document.version;
  try {
    const applied = await editor.edit((edit) => {
      for (const selection of selections) edit.replace(selection, text);
    });
    const changed = editor.document.version !== version;
    if (applied && (changed || selections.every((selection) => editor.document.getText(selection) === text))) {
      return "done";
    }
    ports.showError(l10n.t("The editor refused the edit; its document may be read-only."));
    return "refused";
  } catch (error) {
    console.error("broke-code: could not insert the code", error);
    ports.showError(l10n.t("Could not insert the code: {0}", String(error)));
    return "failed";
  }
}
