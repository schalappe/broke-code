import type { ChatEntry } from "../core/protocol";

/**
 * The tool steps of a fold: `steps`, all of them (malformed calls and empty replies included); `failed`, those whose
 * status is `error` or `malformed` and that the user did not reject; `rejected`, those the user rejected.
 */
export type FoldCounts = { steps: number; failed: number; rejected: number };

/**
 * One piece of the conversation as it renders: an entry on its own (`index` into the entries), or the fold of an ended
 * turn, the entries from `start` up to `end` (excluded) shown under one collapsed row.
 */
export type ConversationPart =
  | { kind: "entry"; index: number }
  | { kind: "fold"; start: number; end: number; counts: FoldCounts };

/** The fewest tool steps a fold holds; a turn with fewer renders as it is. */
const MIN_FOLDED_STEPS = 2;

/**
 * The conversation's entries grouped for rendering, every entry exactly once and in order. A turn runs from a user
 * message to the entry before the next one; it has ended unless it is the last turn and its last entry is a reply in
 * flight. An ended turn keeps its last reply and any step after it in view, and folds what lies between its user
 * message and that reply when it holds at least `MIN_FOLDED_STEPS` tool steps. Entries before the first user message,
 * and a turn without a reply, are never folded. Rendering only: the entries themselves are untouched.
 */
export function foldTurns(entries: ChatEntry[]): ConversationPart[] {
  const parts: ConversationPart[] = [];
  const single = (from: number, to: number) => {
    for (let index = from; index < to; index++) parts.push({ kind: "entry", index });
  };
  let turnStart = entries.findIndex((entry) => entry.role === "user");
  if (turnStart === -1) {
    single(0, entries.length);
    return parts;
  }
  single(0, turnStart);
  while (turnStart < entries.length) {
    const next = entries.findIndex((entry, index) => index > turnStart && entry.role === "user");
    const turnEnd = next === -1 ? entries.length : next;
    const lastReply = entries.findLastIndex(
      (entry, index) => index > turnStart && index < turnEnd && entry.role === "assistant",
    );
    const ended = next !== -1 || !inFlight(entries.at(-1));
    const counts = countSteps(lastReply === -1 ? [] : entries.slice(turnStart + 1, lastReply));
    if (ended && counts.steps >= MIN_FOLDED_STEPS) {
      single(turnStart, turnStart + 1);
      parts.push({ kind: "fold", start: turnStart + 1, end: lastReply, counts });
      single(lastReply, turnEnd);
    } else {
      single(turnStart, turnEnd);
    }
    turnStart = turnEnd;
  }
  return parts;
}

/** Whether `entry` is a reply still waiting or streaming. */
function inFlight(entry: ChatEntry | undefined): boolean {
  return entry?.role === "assistant" && (entry.status === "waiting" || entry.status === "streaming");
}

function countSteps(entries: ChatEntry[]): FoldCounts {
  const counts: FoldCounts = { steps: 0, failed: 0, rejected: 0 };
  for (const entry of entries) {
    if (entry.role !== "tool") continue;
    counts.steps++;
    if (entry.approval === "rejected") counts.rejected++;
    else if (entry.status !== "ok") counts.failed++;
  }
  return counts;
}
