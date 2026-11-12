/**
 * @module composer
 * Decisions of the message box, kept out of React so tests need no DOM: which token opens a menu (`@` mentions, `/`
 * commands), which menu rows to show, what a key does, which picked paths to send, and how a draft (an editor entry
 * point, queued texts returned, or the last message put back by Edit) edits the message box.
 */
import { type ChatEntry, type DraftInsert, MAX_QUERY_LENGTH } from "../core/protocol";
import { type MentionKind, pickedPath, RESERVED_MENTIONS, reservedMention } from "../core/reservedMentions";
import {
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

/** A row of the `@` menu: a reserved mention, its kind being its name, or a workspace entry of the file index. */
export type MentionRow = { path: string; kind: MentionKind };

/** What the menu shows. */
export type MenuView = { items: MentionRow[]; capped: boolean; failed: boolean };

/**
 * Menu for `query`: the reserved mentions whose name starts with `query`, ignoring case, as the `/` menu filters, then
 * the rows of the latest `answer`, 20 rows in all. The reserved rows need no answer, so they show before the files do
 * and when they cannot be listed. While the answer to `query` is pending, only the earlier rows that match `query`
 * show, so a row picked always matches what is typed; with no row at all, no menu until the answer comes.
 */
export function menuView(answer: MenuAnswer | undefined, query: string): MenuView | undefined {
  const prefix = query.toLowerCase();
  const reserved = RESERVED_MENTIONS.filter((name) => name.startsWith(prefix)).map((name) => ({
    path: name,
    kind: name,
  }));
  const rows = (files: Suggestion[]) => [...reserved, ...files].slice(0, MAX_SUGGESTIONS);
  if (answer?.query === query) return { items: rows(answer.items), capped: answer.capped, failed: answer.failed };
  const items = rows(answer ? filterSuggestions(answer.items, query, MAX_SUGGESTIONS) : []);
  return items.length > 0 ? { items, capped: answer?.capped ?? false, failed: false } : undefined;
}

/**
 * What picking `row` inserts in place of the `@` token, and the path it records as picked: `@<name> ` for a reserved
 * row, which records nothing; for a workspace entry `@<path> `, `@./<name> ` when the entry is named like a reserved
 * mention, which `@<name>` would not reach.
 */
export function mentionPick(row: MentionRow): { text: string; picked?: string } {
  if (reservedMention(row.kind)) return { text: `@${row.path} ` };
  const path = pickedPath(row.path);
  return { text: `@${path} `, picked: path };
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

/**
 * What Edit on the last user message puts in the message box, through `applyDraft` like a returned queued text: its
 * text as typed, and the paths of its file and folder mentions as picked paths, so a path with spaces stays one
 * mention. The entry keeps no record of which paths were picked; a picked path counts only while its `@<path>` stands
 * in the text, so offering every one is safe. A reserved mention stays typed text, read again at send.
 */
export function editDraft(entry: ChatEntry & { role: "user" }): DraftInsert {
  const paths = entry.mentions.flatMap((mention) => (reservedMention(mention.kind) ? [] : [mention.path]));
  return { text: entry.content, mode: "paragraph", picked: paths };
}

/** The message box's content: its text, its caret, and the paths picked in it. */
export type Draft = { text: string; caret: number; picked: readonly string[] };

/**
 * `draft` with `insert` applied (see `DraftInsert`). At the caret, a space goes before the text unless the text before
 * the caret is empty or ends with whitespace, and one after it unless whitespace already follows, which the caret then
 * passes: the caret always follows whitespace, so no menu opens on the inserted token. Filled or appended (after one
 * line break, or a blank line for a `paragraph`), the caret goes to the end. `insert.picked` joins the draft's picked paths, each once.
 */
export function applyDraft(draft: Draft, insert: DraftInsert): Draft {
  const unique = [...new Set([...draft.picked, ...insert.picked])];
  if (insert.mode !== "caret") {
    const separator = insert.mode === "paragraph" ? "\n\n" : "\n";
    const text = draft.text.trim() === "" ? insert.text : `${draft.text}${separator}${insert.text}`;
    return { text, caret: text.length, picked: unique };
  }
  const before = draft.text.slice(0, draft.caret);
  const after = draft.text.slice(draft.caret);
  const lead = before === "" || /\s$/.test(before) ? "" : " ";
  const head = `${before}${lead}${insert.text}${/^\s/.test(after) ? after[0] : " "}`;
  return { text: head + (/^\s/.test(after) ? after.slice(1) : after), caret: head.length, picked: unique };
}
