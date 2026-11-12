/**
 * @module history
 * The history a request of an agent turn sends, and the results it leaves out when the request would not fit the
 * model's context. No `node:` or `vscode` import: the webview loads `resultLineCount`.
 */

import type { ChatMessage } from "./client";
import { fillsContext, tokensOfCharacters } from "./limits";
import type { ChatEntry } from "./protocol";

/** Tool steps at the end of the conversation whose results always go whole, whatever turn they belong to. */
export const KEPT_RECENT_STEPS = 3;

/** What a request is measured against: the system prompt it is sent with and the model's context size in tokens. */
export type HistoryBudget = { system: string; contextSize: number };

/** The history of a request, without its system message; `leftOut`: tool results replaced by a one-line notice. */
export type History = { messages: ChatMessage[]; leftOut: number };

type ToolStep = ChatEntry & { role: "tool" };

/** What the model is asked for in the summary request, the last user message of that request. */
export const SUMMARY_REQUEST =
  "Summarize the conversation so far, so that it can go on from your summary alone. Keep the user's goal, the decisions made and why, the files read or changed with their paths, and what remains to do. Write the summary only: call no tool.";

/** The line that leads the summary in the history sent after it. */
const SUMMARY_LEAD = "Summary of the conversation so far:";

/**
 * Where the history sent starts: the index of the last summary entry (`/compact`) that ended `done` with text, else 0.
 * The entries before it stay in the record and the chat but are no longer sent; the webview marks them so.
 */
export function historyStart(entries: readonly ChatEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (isSentSummary(entries[index]!)) return index;
  }
  return 0;
}

/**
 * Whether the summary `entry`, followed by `next`, is one an agent turn ran itself (`brokeCode.autoCompact`): the turn's
 * next reply follows it. Derived, never stored: after `/compact` only a user message or another summary can follow,
 * since a reply only ever follows a user message or a tool step. A failed or stopped automatic summary ends its turn
 * with nothing after it and reads as a `/compact` one, which changes nothing: neither is sent.
 */
export function isAutomaticSummary(entry: ChatEntry, next: ChatEntry | undefined): boolean {
  return entry.role === "assistant" && entry.summary === true && next?.role === "assistant" && next.summary !== true;
}

/**
 * The entries whose text the history sends: the turn's user message an automatic summary quotes (see `sentMessages`),
 * then the entries from `historyStart`.
 */
export function sentEntries(entries: readonly ChatEntry[]): ChatEntry[] {
  const start = historyStart(entries);
  const quoted = quotedMessage(entries, start);
  return [...(quoted ? [quoted] : []), ...entries.slice(start)];
}

/**
 * The user message of the turn the automatic summary at `index` belongs to: the nearest user message before it, since
 * a turn holds no `/compact` summary. `undefined` for any other entry.
 */
function quotedMessage(entries: readonly ChatEntry[], index: number): (ChatEntry & { role: "user" }) | undefined {
  const summary = entries[index];
  // [>]: `index` is past the end of an empty conversation, whose history starts at 0.
  if (summary === undefined || !isAutomaticSummary(summary, entries[index + 1])) return undefined;
  for (let at = index - 1; at >= 0; at--) {
    const entry = entries[at]!;
    if (entry.role === "user") return entry;
  }
  return undefined;
}

/** A summary entry the history starts at: it ended `done` with text. */
function isSentSummary(entry: ChatEntry): boolean {
  return entry.role === "assistant" && entry.summary === true && entry.status === "done" && entry.content.trim() !== "";
}

/**
 * `entries` as sent to the model, from `historyStart`: user messages as `userText` gives them (the text composed at
 * send time), assistant answers verbatim, their call blocks included (stopped and cut-off partials too), and each tool
 * step as a `user` message holding a `<tool_result>` tag, never the `tool` role, which needs native tool calling (ADR
 * 0001); an undone step's result ends with `UNDONE_LINE`. Reasoning is never sent. A reply without text is left out, unless a tool step follows it: an empty answer goes
 * back with its malformed step, so the roles keep alternating, which some chat templates (Gemma's) require. The summary
 * the history starts at goes as one user message, `Summary of the conversation so far:` then its text, joined by the
 * user message right after it, for the same reason; an automatic one (`isAutomaticSummary`) is followed by its turn's
 * user message instead, after a blank line, then by the turn's next reply. Every other summary entry (failed, stopped,
 * halted, or empty) is never sent.
 *
 * When `budget.system` plus that history fills the context (`fillsContext`), the text of the oldest tool steps is
 * replaced, one step at a time, by `[result left out to save context: N lines]`, until the request fits. Never
 * replaced: the last `KEPT_RECENT_STEPS` steps sent, every `load_skill` step (a second load answers "already loaded"
 * without the body, so the model could not get it back), every undone step, and a result no longer than its
 * replacement line. When the
 * request cannot fit even then, the history goes whole and `leftOut` is 0: nothing is sent, so nothing is left out.
 * Pure and linear in the entries, since the usage display runs it at each streamed delta.
 */
export function toHistory(
  entries: readonly ChatEntry[],
  userText: (entry: ChatEntry & { role: "user" }) => string,
  { system, contextSize }: HistoryBudget,
): History {
  const { messages, steps } = sentMessages(entries, userText);
  let characters = messages.reduce((total, message) => total + message.content.length, system.length);
  const fits = () => !fillsContext(tokensOfCharacters(characters), contextSize);
  if (fits()) return { messages, leftOut: 0 };

  const cut = [...messages];
  let leftOut = 0;
  for (const { at, step } of steps.slice(0, Math.max(0, steps.length - KEPT_RECENT_STEPS))) {
    const content = leftOutResult(step);
    if (content === undefined) continue;
    characters -= cut[at]!.content.length - content.length;
    cut[at] = { role: "user", content };
    leftOut++;
    if (fits()) return { messages: cut, leftOut };
  }
  return { messages, leftOut: 0 };
}

/**
 * The history of the summary request (`/compact`): the history `toHistory` sends, with every tool result it may leave
 * out left out, the last `KEPT_RECENT_STEPS` included, whatever the size, then `SUMMARY_REQUEST` as the last user
 * message, joined to the history's last message when that one is a user message. The caller checks the size.
 */
export function summaryHistory(
  entries: readonly ChatEntry[],
  userText: (entry: ChatEntry & { role: "user" }) => string,
): History {
  const { messages, steps } = sentMessages(entries, userText);
  let leftOut = 0;
  for (const { at, step } of steps) {
    const content = leftOutResult(step);
    if (content === undefined) continue;
    messages[at] = { role: "user", content };
    leftOut++;
  }
  appendUser(messages, SUMMARY_REQUEST);
  return { messages, leftOut };
}

/** The messages sent for `entries` from `historyStart`, and where each tool step sits among them. */
function sentMessages(
  entries: readonly ChatEntry[],
  userText: (entry: ChatEntry & { role: "user" }) => string,
): { messages: ChatMessage[]; steps: { at: number; step: ToolStep }[] } {
  const start = historyStart(entries);
  const messages: ChatMessage[] = [];
  const steps: { at: number; step: ToolStep }[] = [];
  // [>]: The summary message stays last until another message follows; a user entry then joins it.
  let summaryAt = -1;
  for (let index = start; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.role === "user") {
      if (summaryAt !== -1 && summaryAt === messages.length - 1) appendUser(messages, userText(entry));
      else messages.push({ role: "user", content: userText(entry) });
    } else if (entry.role === "tool") {
      steps.push({ at: messages.length, step: entry });
      messages.push({ role: "user", content: toolResultMessage(entry, entry.text) });
    } else if (entry.summary) {
      // [>]: Only the starting summary is sent; any other one (failed, stopped, halted, empty) changes nothing.
      if (index !== start || !isSentSummary(entry)) continue;
      summaryAt = messages.length;
      // [!]: An automatic summary quotes its turn's message as composed when sent, so the model still holds the request
      // it is working on, word for word, instead of reading the same files again and overflowing anew.
      const quoted = quotedMessage(entries, index);
      const text = `${SUMMARY_LEAD}\n\n${entry.content}`;
      messages.push({ role: "user", content: quoted ? `${text}\n\n${userText(quoted)}` : text });
    } else if (entry.content !== "" || entries[index + 1]?.role === "tool") {
      messages.push({ role: "assistant", content: entry.content });
    }
  }
  return { messages, steps };
}

/** Append `text` as a user message: after a blank line in the last message when that one is a user message. */
function appendUser(messages: ChatMessage[], text: string): void {
  const last = messages.at(-1);
  if (last?.role === "user") messages[messages.length - 1] = { role: "user", content: `${last.content}\n\n${text}` };
  else messages.push({ role: "user", content: text });
}

/**
 * `step`'s message with its result left out, or `undefined` when it must go whole: `load_skill`, an undone step (a
 * left-out line would tell the model the change stands), or a result short enough.
 */
function leftOutResult(step: ToolStep): string | undefined {
  if (step.name === "load_skill" || step.undone) return undefined;
  const line = leftOutLine(resultLineCount(step.text));
  return line.length >= step.text.length ? undefined : toolResultMessage(step, line);
}

/** Lines of a tool result as its step row counts them: a trailing line break dropped, then split; 0 when empty. */
export function resultLineCount(text: string): number {
  return text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
}

function leftOutLine(lines: number): string {
  return `[result left out to save context: ${lines === 1 ? "1 line" : `${lines} lines`}]`;
}

/** The last line of an undone step's result: the file no longer holds what the step wrote. */
const UNDONE_LINE = "The user undid this change afterwards.";

/**
 * A tool step as the model reads it, holding `text`, then `UNDONE_LINE` when the step is undone. A malformed call goes
 * back as an error.
 */
function toolResultMessage(step: ToolStep, text: string): string {
  const status = step.status === "malformed" ? "error" : step.status;
  const result = step.undone ? `${text}\n${UNDONE_LINE}` : text;
  return `<tool_result tool="${step.name}" status="${status}">\n${result}\n</tool_result>`;
}
