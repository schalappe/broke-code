/**
 * @module composer
 * Decisions of the message box, kept out of React so tests need no DOM: which menu rows to show, what a key does,
 * which picked paths to send.
 */
import { filterSuggestions, MAX_SUGGESTIONS, type Suggestion } from "../core/suggestions";

/** Host answer to a file query, with the query it answers. `failed`: the workspace files could not be listed. */
export type MenuAnswer = { query: string; items: Suggestion[]; capped: boolean; failed: boolean };

/** What the menu shows. */
export type MenuView = { items: Suggestion[]; capped: boolean; failed: boolean };

/**
 * Menu for `query` from the latest `answer`. While the answer to `query` is pending, only the earlier rows that
 * match `query` show, so a row picked always matches what is typed; with none, no menu until the answer comes.
 */
export function menuView(answer: MenuAnswer | undefined, query: string): MenuView | undefined {
  if (!answer) return undefined;
  if (answer.query === query) return { items: answer.items, capped: answer.capped, failed: answer.failed };
  const items = filterSuggestions(answer.items, query, MAX_SUGGESTIONS);
  return items.length > 0 ? { items, capped: answer.capped, failed: false } : undefined;
}

/** A key press in the message box. `composing`: an input method (IME) is composing text. */
export type ComposerKey = { key: string; shift: boolean; composing: boolean };

/** `none`: the textarea's default behavior. */
export type KeyAction =
  | { type: "move"; step: 1 | -1 }
  | { type: "pick" }
  | { type: "dismiss" }
  | { type: "send" }
  | { type: "none" };

/**
 * What `pressed` does. `rows`: rows the open menu shows, `undefined` when it is closed. With rows, the menu owns
 * the arrows, Enter, and Tab; Escape closes even a menu without rows; Enter sends otherwise, Shift+Enter never does.
 */
export function composerKeyAction(pressed: ComposerKey, rows: number | undefined): KeyAction {
  if (pressed.composing) return { type: "none" };
  if (rows !== undefined && pressed.key === "Escape") return { type: "dismiss" };
  if (rows !== undefined && rows > 0) {
    if (pressed.key === "ArrowDown") return { type: "move", step: 1 };
    if (pressed.key === "ArrowUp") return { type: "move", step: -1 };
    if (pressed.key === "Tab" || (pressed.key === "Enter" && !pressed.shift)) return { type: "pick" };
  }
  if (pressed.key === "Enter" && !pressed.shift) return { type: "send" };
  return { type: "none" };
}

/**
 * Picked paths still worth sending: those whose `@<path>` is still in `text`. The host keeps only those standing as
 * whole tokens; this drops the ones the user deleted.
 */
export function pickedInText(picked: readonly string[], text: string): string[] {
  return picked.filter((path) => text.includes(`@${path}`));
}
