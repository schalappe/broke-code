/**
 * @module turnDiffs
 * The decisions of the "Changed files" diffs, which the extension glue feeds with VS Code's tabs: their left side's URI
 * scheme, and which of their tabs to close. A diff's right side is the real file, a `file:` URI shared with every
 * other editor of it, so these diffs are found by their left side.
 */
import type { EditorUri } from "./approval";

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
