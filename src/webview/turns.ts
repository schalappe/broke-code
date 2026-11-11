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
  const lastEnded = !inFlight(entries.at(-1));
  // [>]: One pass: each turn's bounds come from the next user message, and its last reply from a backward scan of the
  // turn alone, so every entry is visited a bounded number of times. This runs at every render, streamed deltas included.
  let turnStart = -1;
  for (let index = 0; index <= entries.length; index++) {
    if (index < entries.length && entries[index]!.role !== "user") continue;
    if (turnStart === -1) pushEntries(parts, 0, index);
    else foldTurn(entries, turnStart, index, index < entries.length || lastEnded, parts);
    turnStart = index;
  }
  return parts;
}

/** Appends the parts of the turn from `start` (its user message) up to `end` (excluded); `ended`: it may fold. */
function foldTurn(entries: ChatEntry[], start: number, end: number, ended: boolean, parts: ConversationPart[]): void {
  let lastReply = end - 1;
  while (lastReply > start && entries[lastReply]!.role !== "assistant") lastReply--;
  const counts = lastReply > start ? countSteps(entries, start + 1, lastReply) : undefined;
  if (ended && counts && counts.steps >= MIN_FOLDED_STEPS) {
    pushEntries(parts, start, start + 1);
    parts.push({ kind: "fold", start: start + 1, end: lastReply, counts });
    pushEntries(parts, lastReply, end);
  } else {
    pushEntries(parts, start, end);
  }
}

function pushEntries(parts: ConversationPart[], from: number, to: number): void {
  for (let index = from; index < to; index++) parts.push({ kind: "entry", index });
}

/** Whether `entry` is a reply still waiting or streaming. */
function inFlight(entry: ChatEntry | undefined): boolean {
  return entry?.role === "assistant" && (entry.status === "waiting" || entry.status === "streaming");
}

/** The tool steps among `entries` from `from` up to `to` (excluded). */
function countSteps(entries: ChatEntry[], from: number, to: number): FoldCounts {
  const counts: FoldCounts = { steps: 0, failed: 0, rejected: 0 };
  for (let index = from; index < to; index++) {
    const entry = entries[index]!;
    if (entry.role !== "tool") continue;
    counts.steps++;
    if (entry.approval === "rejected") counts.rejected++;
    else if (entry.status !== "ok") counts.failed++;
  }
  return counts;
}
