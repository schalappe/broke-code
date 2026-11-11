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

/**
 * `entries` as sent to the model: user messages as `userText` gives them (the text composed at send time), assistant
 * answers verbatim, their call blocks included (stopped and cut-off partials too), and each tool step as a `user`
 * message holding a `<tool_result>` tag, never the `tool` role, which needs native tool calling (ADR 0001). Reasoning
 * is never sent. A reply without text is left out, unless a tool step follows it: an empty answer goes back with its
 * malformed step, so the roles keep alternating, which some chat templates (Gemma's) require.
 *
 * When `budget.system` plus that history fills the context (`fillsContext`), the text of the oldest tool steps is
 * replaced, one step at a time, by `[result left out to save context: N lines]`, until the request fits. Never
 * replaced: the last `KEPT_RECENT_STEPS` steps of the conversation, every `load_skill` step (a second load answers
 * "already loaded" without the body, so the model could not get it back), and a result no longer than its
 * replacement line. When the request cannot fit even then, the history goes whole and `leftOut` is 0: nothing is sent,
 * so nothing is left out. Pure and linear in the entries, since the usage display runs it at each streamed delta.
 */
export function toHistory(
  entries: readonly ChatEntry[],
  userText: (entry: ChatEntry & { role: "user" }) => string,
  { system, contextSize }: HistoryBudget,
): History {
  const messages: ChatMessage[] = [];
  const steps: { at: number; step: ToolStep }[] = [];
  entries.forEach((entry, index) => {
    if (entry.role === "user") messages.push({ role: "user", content: userText(entry) });
    else if (entry.role === "tool") {
      steps.push({ at: messages.length, step: entry });
      messages.push({ role: "user", content: toolResultMessage(entry, entry.text) });
    } else if (entry.content !== "" || entries[index + 1]?.role === "tool") {
      messages.push({ role: "assistant", content: entry.content });
    }
  });

  let characters = messages.reduce((total, message) => total + message.content.length, system.length);
  const fits = () => !fillsContext(tokensOfCharacters(characters), contextSize);
  if (fits()) return { messages, leftOut: 0 };

  const cut = [...messages];
  let leftOut = 0;
  for (const { at, step } of steps.slice(0, Math.max(0, steps.length - KEPT_RECENT_STEPS))) {
    if (step.name === "load_skill") continue;
    const line = leftOutLine(resultLineCount(step.text));
    if (line.length >= step.text.length) continue;
    const content = toolResultMessage(step, line);
    characters -= cut[at]!.content.length - content.length;
    cut[at] = { role: "user", content };
    leftOut++;
    if (fits()) return { messages: cut, leftOut };
  }
  return { messages, leftOut: 0 };
}

/** Lines of a tool result as its step row counts them: a trailing line break dropped, then split; 0 when empty. */
export function resultLineCount(text: string): number {
  return text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
}

function leftOutLine(lines: number): string {
  return `[result left out to save context: ${lines === 1 ? "1 line" : `${lines} lines`}]`;
}

/** A tool step as the model reads it, holding `text`. A malformed call goes back as an error. */
function toolResultMessage(step: ToolStep, text: string): string {
  const status = step.status === "malformed" ? "error" : step.status;
  return `<tool_result tool="${step.name}" status="${status}">\n${text}\n</tool_result>`;
}
