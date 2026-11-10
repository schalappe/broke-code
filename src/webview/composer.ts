/**
 * @module composer
 * Decisions of the message box, kept out of React so tests need no DOM: which token opens a menu (`@` mentions, `/`
 * commands), which menu rows to show, what a key does, which picked paths to send, which built-in command a message
 * runs.
 */
import { MAX_QUERY_LENGTH } from "../core/protocol";
import {
  BUILT_IN_COMMANDS,
  type BuiltInCommand,
  filterSlashCommands,
  filterSuggestions,
  findMentionToken,
  findSlashToken,
  MAX_SUGGESTIONS,
  type SlashCommand,
  type Suggestion,
} from "../core/suggestions";

/** Host answer to a file query, with the query it answers. `failed`: the workspace files could not be listed. */
export type MenuAnswer = { query: string; items: Suggestion[]; capped: boolean; failed: boolean };

/** A token that opens a menu: `trigger` and the query typed after it, `start` being the trigger's index. */
export type MenuToken = { trigger: "@" | "/"; start: number; query: string };

/**
 * The token at the caret: the `/` token at the start of the message, else the `@` token that may query the host,
 * none when its query is longer than the host accepts. They never overlap: a `/` token holds no whitespace.
 */
export function menuToken(text: string, caret: number, picked: readonly string[]): MenuToken | undefined {
  const slash = findSlashToken(text, caret);
  if (slash) return { trigger: "/", start: 0, query: slash.query };
  const found = findMentionToken(text, caret, picked);
  return found && found.query.length <= MAX_QUERY_LENGTH ? { trigger: "@", ...found } : undefined;
}

/**
 * `token` when its menu shows: the message box has focus and `token` is not the one closed with Escape. Typing on
 * changes the query and reopens the menu; a token with the same query at another place is another token.
 */
export function openMenuToken(
  token: MenuToken | undefined,
  focused: boolean,
  dismissed: MenuToken | undefined,
): MenuToken | undefined {
  if (!focused || !token) return undefined;
  const same =
    dismissed?.trigger === token.trigger && dismissed.start === token.start && dismissed.query === token.query;
  return same ? undefined : token;
}

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

/** Host answer to the skill query of the open `/` menu. `failed`: the skills could not be listed. */
export type SkillAnswer = { items: SlashCommand[]; failed: boolean };

/** A row of the `/` menu. `builtIn`: the command a built-in row runs; absent on a skill row, whatever its name. */
export type SlashRow = SlashCommand & { builtIn?: BuiltInCommand };

/** What the `/` menu shows. */
export type SlashMenuView = { items: SlashRow[]; failed: boolean };

/**
 * `/` menu for `query`: the `builtIns`, then the skills of `answer`, those whose name starts with `query`. While the
 * skills are pending, only the built-ins show; with none matching, no menu until the answer comes, so "No match"
 * never shows for a skill still to come.
 */
export function slashMenuView(
  builtIns: SlashRow[],
  answer: SkillAnswer | undefined,
  query: string,
): SlashMenuView | undefined {
  const items = filterSlashCommands([...builtIns, ...(answer?.items ?? [])], query, MAX_SUGGESTIONS);
  if (answer) return { items, failed: answer.failed };
  return items.length > 0 ? { items, failed: false } : undefined;
}

/**
 * The built-in command `text` runs: its trimmed text is exactly `/<name>`. With words after it, it is an ordinary
 * message.
 */
export function builtInCommand(text: string): BuiltInCommand | undefined {
  const trimmed = text.trim();
  return BUILT_IN_COMMANDS.find((name) => trimmed === `/${name}`);
}

/** What picking a `/` menu row does: `run` its built-in command, or `insert` text in place of the token. */
export type SlashPick = { type: "run"; command: BuiltInCommand } | { type: "insert"; text: string };

/**
 * Picking `row`: a built-in row runs its command at once when Send would act (`canRun`) and only whitespace follows
 * the token (`after`, the text after the caret), as sending the box would then; otherwise, and for a skill row, which
 * takes arguments, it inserts `/<name> `, so no draft is cleared.
 */
export function slashPick(row: SlashRow, canRun: boolean, after: string): SlashPick {
  if (row.builtIn && canRun && after.trim() === "") return { type: "run", command: row.builtIn };
  return { type: "insert", text: `/${row.name} ` };
}

/** `text` with the token at `start` replaced, up to the caret, by `inserted`; the caret goes after it. */
export function replaceToken(
  text: string,
  token: { start: number },
  caret: number,
  inserted: string,
): { text: string; caret: number } {
  return { text: text.slice(0, token.start) + inserted + text.slice(caret), caret: token.start + inserted.length };
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
