/**
 * @module composer
 * Decisions of the message box, kept out of React so tests need no DOM: which menu rows to show.
 */
import { filterSuggestions, MAX_SUGGESTIONS, type Suggestion } from "../core/suggestions";

/** Host answer to a file query, with the query it answers. */
export type MenuAnswer = { query: string; items: Suggestion[]; capped: boolean };

/** What the menu shows. */
export type MenuView = { items: Suggestion[]; capped: boolean };

/**
 * Menu for `query` from the latest `answer`. While the answer to `query` is pending, only the earlier rows that
 * match `query` show, so a row picked always matches what is typed; with none, no menu until the answer comes.
 */
export function menuView(answer: MenuAnswer | undefined, query: string): MenuView | undefined {
  if (!answer) return undefined;
  if (answer.query === query) return { items: answer.items, capped: answer.capped };
  const items = filterSuggestions(answer.items, query, MAX_SUGGESTIONS);
  return items.length > 0 ? { items, capped: answer.capped } : undefined;
}
