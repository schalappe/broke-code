/**
 * @module insertCode
 * Insert at cursor: a code block's text replacing every selection of the active text editor, as a paste does. No
 * `vscode` import: the host fills the editor port with `window.activeTextEditor`, whose shape matches.
 */
import type { Translator } from "./modelList";

/** The edit builder an editor hands to its `edit` callback: each `replace` joins that one edit. */
export type InsertEdit<Location> = { replace(location: Location, value: string): void };

/**
 * A text editor: its selections (an empty one is a caret), and `edit`, which applies every replacement its callback
 * makes as one undoable edit and settles `false` when the editor cannot apply it (a read-only document).
 */
export type InsertEditor<Location> = {
  readonly selections: readonly Location[];
  edit(callback: (edit: InsertEdit<Location>) => void): PromiseLike<boolean>;
};

/** `activeEditor`: the active text editor, or `undefined` when none is. `showError`: a native error notification. */
export type InsertPorts<Location> = {
  activeEditor(): InsertEditor<Location> | undefined;
  showError(message: string): void;
};

/**
 * `done`: every selection holds the text. `noEditor`: no text editor is active. `refused`: the editor refused the
 * edit. `failed`: the edit threw. Each but `done` changed nothing and was shown.
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
  try {
    const applied = await editor.edit((edit) => {
      for (const selection of editor.selections) edit.replace(selection, text);
    });
    if (applied) return "done";
    ports.showError(l10n.t("The editor refused the edit; its document may be read-only."));
    return "refused";
  } catch (error) {
    console.error("broke-code: could not insert the code", error);
    ports.showError(l10n.t("Could not insert the code: {0}", String(error)));
    return "failed";
  }
}
