/**
 * @module history
 * The history a request of an agent turn sends, and the results it leaves out when the request would not fit the
 * model's context, and the trace the conversation keeps of an inner call's step, which the model never reads. No
 * `node:` or `vscode` import: the webview loads `resultLineCount` and `stepResultLines`.
 */

import type { ChatMessage } from "./client";
import { fillsContext, tokensOfCharacters } from "./limits";
import type { ChatEntry } from "./protocol";

/** Tool steps at the end of the conversation whose results always go whole, whatever turn they belong to. */
export const KEPT_RECENT_STEPS = 3;

/**
 * The block the count of left-out tool results is rounded up to: the count changes about once every this many new
 * steps, so the requests in between only add to the prompt of the one before and the provider's prompt cache holds.
 */
export const LEFT_OUT_BLOCK = 4;

/**
 * What a request is measured against: the system prompt it is sent with, the model's context size in tokens, and the
 * model's characters per token (`ProviderSupport.ratio`).
 */
export type HistoryBudget = { system: string; contextSize: number; ratio: number };

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
 * 0001); an undone step's result ends with `UNDONE_LINE`. A script's group (`toolGroup`) goes as one step: the steps
 * its calls made (`fromScript`) are never sent themselves; its `run_script` result goes with one `SCRIPT_UNDONE_LEAD`
 * line per inner write since undone, in order, inside its wrapper; a script with no step of its own (stopped, or cut
 * by a reload) goes as one `run_script` error result the history writes (`stoppedScript`): it was stopped, then
 * one line per call it completed, never their result text, then the same undo lines; a reply whose `run_script` call
 * has no step after it at all (stopped before any call completed) gets the same result, with no call line. Reasoning is never sent. A reply
 * without text is left out, unless a tool step follows it: an empty answer goes back with its malformed step. The summary the history starts at
 * goes as a user message, `Summary of the conversation so far:` then its text; an automatic one (`isAutomaticSummary`)
 * is followed by its turn's user message, then by the turn's next reply. Undone steps before the summary, no longer
 * sent, each get a line after the summary's text (see `replacedUndoneLines`), before that user message. Every other
 * summary entry (failed, stopped, halted, or empty) is never sent.
 *
 * The roles alternate, which some chat templates (Gemma's) require: a `user` message that would follow another `user`
 * message (a tool result, a user message whose reply was left out, the summary's message) joins it after a blank line,
 * its text unchanged. `summaryHistory` joins `SUMMARY_REQUEST` the same way.
 *
 * When `budget.system` plus that history fills the context (`fillsContext`, estimated at `budget.ratio`), the text of the oldest tool steps is
 * replaced by `[result left out to save context: N lines]`, inside the step's `<tool_result>` wrapper only, so a user
 * message joined to it stays whole: the fewest steps that make the request fit, rounded up to a multiple of
 * `LEFT_OUT_BLOCK` and capped at the steps that may be replaced. The estimate counts the request as sent, joins
 * included. A script's group counts as one step there, in the kept recent steps and the summary request alike. Never
 * replaced: the last `KEPT_RECENT_STEPS` steps sent, every `load_skill` step (a second
 * load answers "already loaded" without the body, so the model could not get it back), every `ask_user` step (the
 * user's decision must stay in front of the model), every undone step, a script's group with an undone write, and a result
 * no longer than its replacement line. When the request cannot fit even then, the history goes whole and `leftOut` is
 * 0: nothing is sent, so nothing is left out. Pure and linear in the entries, since the usage display runs it at each
 * streamed delta: the same entries, system prompt, context size, and ratio always leave the same results out. A lower
 * ratio leaves as many or more out, never fewer.
 */
export function toHistory(
  entries: readonly ChatEntry[],
  userText: (entry: ChatEntry & { role: "user" }) => string,
  { system, contextSize, ratio }: HistoryBudget,
): History {
  const { messages, steps } = sentMessages(entries, userText);
  const whole = joined(messages);
  let characters = whole.reduce((total, message) => total + message.content.length, system.length);
  const fits = () => !fillsContext(tokensOfCharacters(characters, ratio), contextSize);
  if (fits()) return { messages: whole, leftOut: 0 };

  let leftOut = 0;
  for (const { at, part, step, whole: keep } of steps.slice(0, Math.max(0, steps.length - KEPT_RECENT_STEPS))) {
    const content = keep ? undefined : leftOutResult(step);
    if (content === undefined) continue;
    const parts = messages[at]!.parts;
    characters -= parts[part]!.length - content.length;
    parts[part] = content;
    leftOut++;
    if (leftOut % LEFT_OUT_BLOCK === 0 && fits()) return { messages: joined(messages), leftOut };
  }
  // [>]: The block is capped at the eligible results: a replacement is shorter than its result, so more out still fits.
  return fits() ? { messages: joined(messages), leftOut } : { messages: whole, leftOut: 0 };
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
  for (const { at, part, step, whole: keep } of steps) {
    const content = keep ? undefined : leftOutResult(step);
    if (content === undefined) continue;
    messages[at]!.parts[part] = content;
    leftOut++;
  }
  push(messages, "user", SUMMARY_REQUEST);
  return { messages: joined(messages), leftOut };
}

/** A message being built: the texts it joins, so a tool result can be left out without touching the text joined to it. */
type SentMessage = { role: ChatMessage["role"]; parts: string[] };

/**
 * Where a tool step's text sits among the messages being built: `step`, the step as sent (a script's group as its
 * `run_script` step, or the one the history writes for it); `whole`: it must never be left out (a group with an undone
 * write, which a left-out line would hide).
 */
type SentStep = { at: number; part: number; step: ToolStep; whole: boolean };

/** The messages sent for `entries` from `historyStart`, not yet joined, and where each tool step sits among them. */
function sentMessages(
  entries: readonly ChatEntry[],
  userText: (entry: ChatEntry & { role: "user" }) => string,
): { messages: SentMessage[]; steps: SentStep[] } {
  const start = historyStart(entries);
  const messages: SentMessage[] = [];
  const steps: SentStep[] = [];
  for (let index = start; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.role === "user") {
      push(messages, "user", userText(entry));
    } else if (entry.role === "tool") {
      if (!entry.fromScript) {
        steps.push({ ...push(messages, "user", toolResultMessage(entry, entry.text)), step: entry, whole: false });
        continue;
      }
      // [>]: The calls a script made are never sent: the model reads the script's own step, its output, only.
      const group = toolGroup(entries, index - 1);
      const undone = scriptUndoneLines(group.inner);
      const own = group.result ?? stoppedScript(group.inner);
      const text = undone === "" ? own.text : `${own.text}\n${undone}`;
      steps.push({ ...push(messages, "user", toolResultMessage(own, text)), step: own, whole: undone !== "" });
      index = group.end - 1;
    } else if (entry.summary) {
      // [>]: Only the starting summary is sent; any other one (failed, stopped, halted, empty) changes nothing.
      if (index !== start || !isSentSummary(entry)) continue;
      const undone = replacedUndoneLines(entries, start);
      push(messages, "user", [`${SUMMARY_LEAD}\n\n${entry.content}`, ...(undone ? [undone] : [])].join("\n\n"));
      // [!]: An automatic summary quotes its turn's message as composed when sent, so the model still holds the request
      // it is working on, word for word, instead of reading the same files again and overflowing anew.
      const quoted = quotedMessage(entries, index);
      if (quoted) push(messages, "user", userText(quoted));
    } else if (entry.content !== "" || entries[index + 1]?.role === "tool") {
      push(messages, "assistant", entry.content);
      // [!]: A script stopped before any call completed leaves no step at all, yet its call still needs a result.
      if (entry.call?.name === "run_script" && entry.status !== "streaming" && entries[index + 1]?.role !== "tool") {
        const own = stoppedScript([]);
        steps.push({ ...push(messages, "user", toolResultMessage(own, own.text)), step: own, whole: false });
      }
    }
  }
  return { messages, steps };
}

/** Add `text` as a `role` message: a user text after a user message joins it. Returns where the text sits. */
function push(messages: SentMessage[], role: ChatMessage["role"], text: string): { at: number; part: number } {
  const last = messages.at(-1);
  if (role === "user" && last?.role === "user") return { at: messages.length - 1, part: last.parts.push(text) - 1 };
  messages.push({ role, parts: [text] });
  return { at: messages.length - 1, part: 0 };
}

/** The messages as sent: each one's texts joined by a blank line. */
function joined(messages: readonly SentMessage[]): ChatMessage[] {
  return messages.map(({ role, parts }) => ({ role, content: parts.join("\n\n") }));
}

/**
 * One `SUMMARY_UNDONE_LEAD` line per undone step before `start`, the steps the summary replaces, in order, joined by
 * line breaks; `""` when none. Such a step is no longer sent, so its own `UNDONE_LINE` never reaches the model, and the
 * summary may have been written before the undo. The path is the step's `path` argument, as the model wrote it.
 */
function replacedUndoneLines(entries: readonly ChatEntry[], start: number): string {
  const lines: string[] = [];
  for (const entry of entries.slice(0, start)) {
    if (entry.role !== "tool" || !entry.undone) continue;
    lines.push(`${SUMMARY_UNDONE_LEAD} ${changeName(entry)}`);
  }
  return lines.join("\n");
}

/** A write step as an undo line names it: its tool, then its `path` argument as the model or the script gave it. */
function changeName(step: ToolStep): string {
  const path = step.args.path;
  return `${step.name}${path === undefined ? "" : ` ${path}`}`;
}

/**
 * A reply's tool group, the entries its call left: the steps of the calls its script made (`fromScript`), in order,
 * then `result`, the first tool step after them that a script did not make, its own step (absent when the script
 * stopped before it, or the call was not a script's and no step came); `end`: the index after the group. A direct
 * call's group is its one step. The history sends a group as one step, and the panel renders it under its reply.
 */
export function toolGroup(
  entries: readonly ChatEntry[],
  reply: number,
): { inner: ToolStep[]; result: ToolStep | undefined; end: number } {
  const inner: ToolStep[] = [];
  let index = reply + 1;
  for (let entry = entries[index]; entry?.role === "tool" && entry.fromScript; entry = entries[++index])
    inner.push(entry);
  const after = entries[index];
  const result = after?.role === "tool" ? after : undefined;
  return { inner, result, end: result ? index + 1 : index };
}

/**
 * The reply whose tool group (`toolGroup`) holds the tool step at `index`, or `undefined` for a step no reply owns (an
 * older record's, or a second step after one): the entry before the steps a script made just before it.
 */
export function groupOwner(entries: readonly ChatEntry[], index: number): number | undefined {
  let at = index - 1;
  while (at >= 0 && entries[at]!.role === "tool" && (entries[at] as ToolStep).fromScript) at--;
  return at >= 0 && entries[at]!.role === "assistant" ? at : undefined;
}

/** Leads each undo line of a script's group: an inner write the user undid after the script ran. */
const SCRIPT_UNDONE_LEAD = "The user undid this change afterwards:";

/** One `SCRIPT_UNDONE_LEAD` line per undone step of `inner`, in order, joined by line breaks; `""` when none. */
function scriptUndoneLines(inner: readonly ToolStep[]): string {
  return inner
    .filter((step) => step.undone)
    .map((step) => `${SCRIPT_UNDONE_LEAD} ${changeName(step)}`)
    .join("\n");
}

/**
 * The `run_script` result the history writes for a script that has no step of its own (Stop, or a reload while it
 * ran): an error saying so, then one line per call it completed (`<tool> <first line of its path or command>: ok` or
 * `error`), never their result text; with no call completed, a line saying so.
 */
function stoppedScript(inner: readonly ToolStep[]): ToolStep {
  const calls = inner.map((step) => {
    // [>]: The first line only: a trace's cut line follows its value on a line of its own.
    const target = (step.name === "run_command" ? step.args.command : step.args.path)?.split("\n")[0];
    return `${step.name}${target === undefined ? "" : ` ${target}`}: ${step.status === "ok" ? "ok" : "error"}`;
  });
  const text =
    calls.length === 0
      ? "run_script: the script was stopped before it finished, before any of its tool calls completed."
      : ["run_script: the script was stopped before it finished, after these tool calls:", ...calls].join("\n");
  return { role: "tool", name: "run_script", args: {}, status: "error", text };
}

/** Leads each undone step a summary replaces, after the summary's text. */
const SUMMARY_UNDONE_LEAD = "The user undid this change, which the summary above may still describe:";

/** The tools whose results always go whole: a skill's instructions, and the user's answer to a question. */
const NEVER_LEFT_OUT: readonly string[] = ["load_skill", "ask_user"];

/**
 * `step`'s message with its result left out, or `undefined` when it must go whole: `load_skill` and `ask_user` (the
 * model could not get them back), an undone step (a left-out line would tell the model the change stands), or a
 * result short enough.
 */
function leftOutResult(step: ToolStep): string | undefined {
  if (NEVER_LEFT_OUT.includes(step.name) || step.undone) return undefined;
  const line = leftOutLine(resultLineCount(step.text));
  return line.length >= step.text.length ? undefined : toolResultMessage(step, line);
}

/** Lines of a tool result as its step row counts them: a trailing line break dropped, then split; 0 when empty. */
export function resultLineCount(text: string): number {
  return text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
}

function leftOutLine(lines: number): string {
  return `[result left out to save context: ${describeLineCount(lines)}]`;
}

function describeLineCount(lines: number): string {
  return lines === 1 ? "1 line" : `${lines} lines`;
}

/**
 * Characters the step of an inner call keeps across its cut values, its result text and the arguments that are not a
 * name (`innerStepTrace`): about thirty lines of the panel's expanded result, enough to see what the call did and how
 * it began, and a bound of a few kilobytes per call however much the script read or wrote.
 */
export const INNER_STEP_CHARS = 2000;

/**
 * The arguments that name what a call acted on, which an inner step's trace keeps whole up to `NAME_ARGUMENT_CHARS`
 * each: the undo lines and the stopped-script line name a step by its `path` (a command by its first line), the folded
 * turn counts the files by `path`, and the step row shows the `pattern`, the `path` with its `start_line` and
 * `end_line`, and the `command` with its `cwd`, the text the user approved. The file text (`content`, `old`, `new`)
 * and the result share `INNER_STEP_CHARS`.
 */
const NAME_ARGUMENTS: readonly string[] = ["path", "pattern", "start_line", "end_line", "command", "cwd"];

/**
 * Characters each name argument keeps whole in a trace, past which it is cut as the other values are. Four times the
 * macOS path limit: the tools set no length of their own, and the system refuses a resolved path over `PATH_MAX`, 1,024
 * bytes (never fewer characters), so a path a tool can open is never cut unless it is padded with redundant `./`
 * segments. A command or a pattern that long is a payload, not a name; past the cap the trace keeps its start.
 */
export const NAME_ARGUMENT_CHARS = 4096;

/**
 * The step the conversation keeps of an inner call (`fromScript`): `step` itself when each of its `NAME_ARGUMENTS` fits
 * `NAME_ARGUMENT_CHARS` and its other argument values and result text fit `INNER_STEP_CHARS` together, else its trace.
 * The model never reads an inner step, so the context budget never bounds it; the tool ran with the whole arguments
 * and the script got the whole result, so only the panel and the saved record hold the trace. A trace keeps each name
 * argument whole up to `NAME_ARGUMENT_CHARS` and shares `INNER_STEP_CHARS` evenly among the other values: one shorter
 * than its share keeps whole and leaves the rest to the others. A longer value keeps its start, then its `cutLine` on
 * a line of its own, within its cap or its share. Everything else of the step is kept, so a trace holds at most
 * 6 × 4,096 + 2,000 = 26,576 characters of values. A trace fits the bound (a tool takes at most a few arguments, each
 * share far above a cut line), so it comes back unchanged: bounding twice is bounding once.
 */
export function innerStepTrace(step: ToolStep): ToolStep {
  const names = Object.keys(step.args).filter((name) => NAME_ARGUMENTS.includes(name));
  const shared = Object.keys(step.args).filter((name) => !NAME_ARGUMENTS.includes(name));
  const lengths = [...shared.map((name) => step.args[name]!.length), step.text.length];
  const namesFit = names.every((name) => step.args[name]!.length <= NAME_ARGUMENT_CHARS);
  if (namesFit && lengths.reduce((total, length) => total + length, 0) <= INNER_STEP_CHARS) return step;
  const shares = evenShares(lengths, INNER_STEP_CHARS);
  const args = { ...step.args };
  for (const name of names) args[name] = cutTo(step.args[name]!, NAME_ARGUMENT_CHARS);
  shared.forEach((name, index) => {
    args[name] = cutTo(step.args[name]!, shares[index]!);
  });
  return { ...step, args, text: cutTo(step.text, shares.at(-1)!) };
}

/** `total` shared among `lengths`, shortest first: each gets its length, or an even part of what is left if less. */
function evenShares(lengths: readonly number[], total: number): number[] {
  const shares = lengths.map(() => 0);
  const order = lengths.map((_, index) => index).sort((a, b) => lengths[a]! - lengths[b]!);
  let left = total;
  order.forEach((index, rank) => {
    shares[index] = Math.min(lengths[index]!, Math.floor(left / (order.length - rank)));
    left -= shares[index]!;
  });
  return shares;
}

/** `value` within `share` characters: whole when it fits, else its start, then its `cutLine` on a line of its own. */
function cutTo(value: string, share: number): string {
  if (value.length <= share) return value;
  const marker = `\n${cutLine(value)}`;
  let keep = Math.max(0, share - marker.length);
  // [>]: Never half a surrogate pair at the cut.
  if (keep > 0 && /[\uD800-\uDBFF]/.test(value[keep - 1]!)) keep--;
  return `${value.slice(0, keep)}${marker}`;
}

/** The line that ends a value `innerStepTrace` cut: the lines and characters the value had whole. */
function cutLine(value: string): string {
  return `[cut to save memory: ${describeLineCount(resultLineCount(value))}, ${value.length} characters in all]`;
}

const CUT_LINE = /\n\[cut to save memory: (\d+) lines?, \d+ characters in all\]$/;

/**
 * Lines of `step`'s result as its row counts them (`resultLineCount`); for an inner step whose result its trace cut,
 * the lines the result had whole, read from its `cutLine`.
 */
export function stepResultLines(step: ToolStep): number {
  const cut = step.fromScript ? CUT_LINE.exec(step.text) : null;
  return cut ? Number(cut[1]) : resultLineCount(step.text);
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
