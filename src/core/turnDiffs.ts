/**
 * @module turnDiffs
 * The "Changed files" diffs (`TurnDiffs`, the controller's `ChangeDiffHost`): each held file's diff since before the
 * turn, its left side's text, the existence check, the open cancelled when its file leaves the held turn meanwhile, and
 * which tabs to close, over an editor port the extension glue fills with VS Code's diff editor and tabs. A diff's right
 * side is the real file, a `file:` URI shared with every other editor of it, so these diffs are found by their left
 * side.
 */
import { basename } from "node:path";
import type { EditorUri } from "./approval";
import type { ChangeDiffHost, HeldFileDiff } from "./chatController";
import type { Translator } from "./modelList";
import { displayPath } from "./tools";

/** The URI scheme of the left side of a changed file's diff: its text before the turn, served from memory. */
export const BEFORE_TURN_SCHEME = "broke-code-before-turn";

/**
 * Close the changed files' diffs among `tabs`: those whose left side is one of `originals` (their files left the held
 * turn), or every one when `originals` is absent (deactivation). `originalSide`: a tab's left side, `undefined` for a
 * tab that is not a text diff. `close` is called once with the tabs found, and not at all when none is.
 */
export async function closeTurnDiffs<Tab>(
  tabs: readonly Tab[],
  originalSide: (tab: Tab) => EditorUri | undefined,
  close: (tabs: Tab[]) => PromiseLike<unknown>,
  originals?: readonly EditorUri[],
): Promise<void> {
  const wanted = originals === undefined ? undefined : new Set(originals.map(String));
  const found = tabs.filter((tab) => {
    const side = originalSide(tab);
    if (side === undefined || side.scheme !== BEFORE_TURN_SCHEME) return false;
    return wanted === undefined || wanted.has(side.toString());
  });
  if (found.length > 0) await close(found);
}

/**
 * What `TurnDiffs` needs from the editor. `isFile`: whether a file is at `path` now; must not reject. `side`: a new
 * left side of `BEFORE_TURN_SCHEME` whose path ends with `name`, never given before, even by an earlier activation.
 * `openDiff`: opens the diff of `original` against the real file at `realPath` beside the chat, titled `title`, the
 * focus kept; rejects when it cannot open. `closeDiffs`: closes the tabs whose left side is one of `originals`, or every
 * changed file's diff when absent (see `closeTurnDiffs`). `showError`: an error notification.
 */
export type TurnDiffEditor<Uri extends EditorUri> = {
  isFile(path: string): Promise<boolean>;
  side(name: string): Uri;
  openDiff(original: Uri, realPath: string, title: string): PromiseLike<unknown>;
  closeDiffs(originals?: readonly Uri[]): PromiseLike<void>;
  showError(message: string): void;
};

/**
 * Opens a held file in the editor's diff: its text before the turn on the left, served by `text` (empty for a file the
 * turn created), the real file on the right, so it shows what the file holds now, unsaved editor changes included.
 * A file's diff closes with `close`, also one still opening: an open whose file was closed meanwhile opens nothing, or
 * closes the tab it opened once it is open. `dispose` closes them all and cancels every open still pending.
 */
export class TurnDiffs<Uri extends EditorUri> implements ChangeDiffHost {
  /** Text of each left side, by URI. */
  private readonly texts = new Map<string, string>();
  /** The left side of each file's diff, by real path, from its first open until `close`. */
  private readonly sides = new Map<string, Uri>();
  /** Closes of each file so far, by real path: an open started before the latest one is cancelled. */
  private readonly closes = new Map<string, number>();
  /** Set by `dispose`: every open still pending is cancelled. */
  private disposed = false;

  constructor(
    private readonly editor: TurnDiffEditor<Uri>,
    private readonly l10n: Translator,
  ) {}

  /** The text of the left side `uri`; empty once its diff closed. */
  text(uri: EditorUri): string {
    return this.texts.get(uri.toString()) ?? "";
  }

  /**
   * Open `file`'s diff, titled with its path. A file no longer on disk opens no diff, and a diff that fails to open is
   * shown: each as an error notification. Cancelled, without a word, when `close` names the file or `dispose` runs
   * meanwhile. Never rejects.
   */
  async open(file: HeldFileDiff): Promise<void> {
    const closes = this.closes.get(file.realPath) ?? 0;
    const cancelled = () => this.disposed || (this.closes.get(file.realPath) ?? 0) !== closes;
    const shown = displayPath(file.path);
    // [>]: The diff editor shows a missing right side as an empty file, which would read as a change of its own.
    const exists = await this.editor.isFile(file.realPath);
    if (cancelled()) return;
    if (!exists) {
      this.editor.showError(this.l10n.t("Could not open the changes of {0}: the file no longer exists.", shown));
      return;
    }
    const original = this.side(file);
    try {
      await this.editor.openDiff(original, file.realPath, this.l10n.t("{0} (changes of this turn)", shown));
    } catch (error) {
      if (cancelled()) return;
      console.error("broke-code: could not open the diff of a changed file", error);
      this.editor.showError(this.l10n.t("Could not open the changes of {0}: {1}", shown, String(error)));
      return;
    }
    // [!]: The row left while the diff opened: its tab came after `close` looked, so nothing else would close it.
    if (cancelled()) await this.closeSides([original]);
  }

  /** Close the diffs of the files at `realPaths`, which left the held turn, those still opening included. */
  close(realPaths: readonly string[]): void {
    const gone: Uri[] = [];
    for (const realPath of realPaths) {
      this.closes.set(realPath, (this.closes.get(realPath) ?? 0) + 1);
      const side = this.sides.get(realPath);
      this.sides.delete(realPath);
      if (side !== undefined) gone.push(side);
    }
    if (gone.length > 0) void this.closeSides(gone);
  }

  /** Close every changed file's diff, drop every text and cancel the opens still pending: deactivation. */
  dispose(): void {
    this.disposed = true;
    // [>]: A diff left open would come back after a reload with an empty left side.
    void Promise.resolve(this.editor.closeDiffs()).catch((error: unknown) =>
      console.error("broke-code: could not close the diffs of changed files", error),
    );
    this.texts.clear();
    this.sides.clear();
  }

  /** Close the diffs whose left side is one of `sides`, then drop their text. Never rejects. */
  private async closeSides(sides: readonly Uri[]): Promise<void> {
    try {
      await this.editor.closeDiffs(sides);
    } catch (error) {
      console.error("broke-code: could not close the diffs of changed files", error);
    } finally {
      for (const side of sides) this.texts.delete(side.toString());
    }
  }

  /**
   * The left side of `file`'s diff: the one already given while it holds the same text, so a second click shows the
   * tab already open; else a new one, its file name ending the path, so the diff picks the file's language.
   */
  private side(file: HeldFileDiff): Uri {
    const text = file.original ?? "";
    const known = this.sides.get(file.realPath);
    if (known !== undefined && this.texts.get(known.toString()) === text) return known;
    // [>]: Another text for the same file means another turn's, whose diff `close` should have closed: close it now.
    if (known !== undefined) void this.closeSides([known]);
    const side = this.editor.side(basename(file.realPath));
    this.texts.set(side.toString(), text);
    this.sides.set(file.realPath, side);
    return side;
  }
}
