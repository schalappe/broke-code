/**
 * @module lastTurn
 * Retry and Continue on the last turn of a conversation: whether the entries offer them, where they show, and what
 * removing a turn's entries would leave behind on disk. Also whether the conversation ends on a final answer, which
 * "Implement in ... mode" needs. No `node:` or `vscode` import: the webview loads it, so the
 * panel and the controller decide from the same entries.
 */

import { historyStart, isAutomaticSummary } from "./history";
import type { ChatEntry } from "./protocol";

/** What Continue sends the model, in English whatever the display language: the entry shows the button's label. */
export const CONTINUE_TEXT = "Continue from where you stopped.";

/**
 * The actions the last turn offers. `user`: the index of its user entry, where Retry starts again (every entry after
 * it is removed). `reply`: the index of the reply the actions render under. `continues`: Continue is offered too.
 */
export type LastTurnActions = { user: number; reply: number; continues: boolean };

/**
 * Whether the last turn (the last user entry and every entry after it) offers Retry and Continue, from the entries
 * alone; whether Send would act is the caller's check. Nothing while a reply is in flight, without a user entry or an
 * entry after it, or when a completed `/compact` summary follows the user entry, since Retry would delete it: the turn's
 * own automatic summary and an unsent summary (failed, stopped, halted, empty) do not count. Retry shows under the
 * turn's last reply that is not a summary (a summary that took the turn's only reply otherwise), whatever it ended on;
 * Continue also needs the last entry not to be a summary and that reply to have ended `stopped`, or `halted` on the
 * step limit or on malformed calls. A `contextFull` halt would only halt again.
 */
export function lastTurnActions(entries: readonly ChatEntry[]): LastTurnActions | undefined {
  const user = entries.findLastIndex((entry) => entry.role === "user");
  const last = entries.at(-1);
  if (user === -1 || last === undefined || last === entries[user]) return undefined;
  if (last.role === "assistant" && (last.status === "waiting" || last.status === "streaming")) return undefined;
  const start = historyStart(entries);
  if (start > user && !isAutomaticSummary(entries[start]!, entries[start + 1])) return undefined;
  const isReply = (index: number) => entries[index]?.role === "assistant";
  const isAnswer = (index: number) => isReply(index) && (entries[index] as Assistant).summary !== true;
  const after = Array.from({ length: entries.length - user - 1 }, (_, offset) => user + 1 + offset);
  const answer = after.findLast(isAnswer);
  const reply = answer ?? after.findLast(isReply);
  if (reply === undefined) return undefined;
  const ended = answer === undefined ? undefined : (entries[answer] as Assistant);
  const stopped =
    ended?.status === "stopped" ||
    (ended?.status === "halted" && (ended.haltReason === "stepLimit" || ended.haltReason === "malformedCalls"));
  const endsOnSummary = last.role === "assistant" && last.summary === true;
  return { user, reply, continues: stopped && !endsOnSummary };
}

type Assistant = ChatEntry & { role: "assistant" };

/** What "Implement in ... mode" sends the model, in English whatever the display language, as Continue does. */
export const IMPLEMENT_PLAN_TEXT = "Implement the plan above.";

/**
 * Whether the conversation ends on its final answer: its last entry is a reply that is not a summary, ended `done`,
 * and holds text. False during a reply, after a turn that failed, was stopped, or halted, and right after `/compact`,
 * whose summary is then the last entry. The one check of the panel's "Implement in ... mode" button and of
 * `ChatController.implementPlan`; whether Plan is on and Send would act are the caller's checks.
 */
export function hasFinalAnswer(entries: readonly ChatEntry[]): boolean {
  const last = entries.at(-1);
  return last?.role === "assistant" && last.summary !== true && last.status === "done" && last.content.trim() !== "";
}

/**
 * What removing the entries from index `from` on leaves on disk, since a removal reverts nothing: `writes`, the write
 * steps that applied and were not undone since; `commands`, the commands the user ran. A command whose step Stop
 * dropped is not counted, since nothing records it.
 */
export function unrevertedEffects(entries: readonly ChatEntry[], from: number): { writes: number; commands: number } {
  let writes = 0;
  let commands = 0;
  for (const entry of entries.slice(from)) {
    if (entry.role !== "tool") continue;
    const write = entry.name === "write_file" || entry.name === "edit_file";
    if (write && entry.status === "ok" && entry.undone !== true) writes += 1;
    if (entry.name === "run_command" && entry.approval === "accepted") commands += 1;
  }
  return { writes, commands };
}
