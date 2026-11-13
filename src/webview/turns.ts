import type { ChatEntry } from "../core/protocol";

/**
 * What a tool step did, for the row of a fold, in the order the row names them: `read` (`read_file`), `listed`
 * (`list_files`), `searched` (`search`), `loaded` (`load_skill`), `edited` (`write_file`, `edit_file`), `ran`
 * (`run_command`). A step of none of them is an other step (see `stepKind`).
 */
export const STEP_KINDS = ["read", "listed", "searched", "loaded", "edited", "ran"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** A kind's count: `shown`, the number its row shows (distinct paths for read, listed, and edited, else steps). */
export type KindCount = { shown: number; steps: number };

/**
 * The tool steps of a fold: `steps`, all of them (malformed calls and empty replies included); `failed`, those whose
 * status is `error` or `malformed` and that the user did not reject; `rejected`, those the user rejected; `kinds`, each
 * kind's count; `otherSteps`, the steps of no kind. Every step is in exactly one kind or in `otherSteps`.
 */
export type FoldCounts = {
  steps: number;
  failed: number;
  rejected: number;
  kinds: Record<StepKind, KindCount>;
  otherSteps: number;
};

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
 * message to the entry before the next one or the next summary (`/compact`), which is a boundary of its own: never
 * folded and never a turn's final reply; it has ended unless it is the last turn and its last entry is a reply in
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
    if (index < entries.length && !startsTurn(entries[index]!)) continue;
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

/** A user message, or a summary, which renders alone and is followed by nothing it could fold. */
function startsTurn(entry: ChatEntry): boolean {
  return entry.role === "user" || (entry.role === "assistant" && entry.summary === true);
}

function pushEntries(parts: ConversationPart[], from: number, to: number): void {
  for (let index = from; index < to; index++) parts.push({ kind: "entry", index });
}

/** Whether `entry` is a reply still waiting or streaming. */
function inFlight(entry: ChatEntry | undefined): boolean {
  return entry?.role === "assistant" && (entry.status === "waiting" || entry.status === "streaming");
}

/** The tool steps among `entries` from `from` up to `to` (excluded), in one pass. */
function countSteps(entries: ChatEntry[], from: number, to: number): FoldCounts {
  const counts: FoldCounts = { steps: 0, failed: 0, rejected: 0, kinds: emptyKinds(), otherSteps: 0 };
  const paths = { read: new Set<string>(), listed: new Set<string>(), edited: new Set<string>() };
  for (let index = from; index < to; index++) {
    const entry = entries[index]!;
    if (entry.role !== "tool") continue;
    counts.steps++;
    if (entry.approval === "rejected") counts.rejected++;
    else if (entry.status !== "ok") counts.failed++;
    const kind = stepKind(entry);
    if (kind === undefined) {
      counts.otherSteps++;
      continue;
    }
    const count = counts.kinds[kind];
    count.steps++;
    if (kind === "read" || kind === "listed" || kind === "edited") {
      paths[kind].add(cleanPath(entry.args.path ?? ""));
      count.shown = paths[kind].size;
    } else {
      count.shown = count.steps;
    }
  }
  return counts;
}

function emptyKinds(): Record<StepKind, KindCount> {
  const kinds = {} as Record<StepKind, KindCount>;
  for (const kind of STEP_KINDS) kinds[kind] = { shown: 0, steps: 0 };
  return kinds;
}

/**
 * The kind of a tool step, judged by its status and arguments before its name, or `undefined` for an other step: a
 * malformed call (it often carries a real tool name), a read or a write whose path is empty once cleaned, a command
 * without its command (a call refused by Plan is recorded without arguments), or a tool of no kind (an old record, a
 * future tool). A `list_files` without a path lists the workspace root.
 */
function stepKind(step: ChatEntry & { role: "tool" }): StepKind | undefined {
  if (step.status === "malformed") return undefined;
  switch (step.name) {
    case "read_file":
      return cleanPath(step.args.path ?? "") === "" ? undefined : "read";
    case "write_file":
    case "edit_file":
      return cleanPath(step.args.path ?? "") === "" ? undefined : "edited";
    case "run_command":
      return step.args.command === undefined ? undefined : "ran";
    case "list_files":
      return "listed";
    case "search":
      return "searched";
    case "load_skill":
      return "loaded";
    default:
      return undefined;
  }
}

/**
 * `path` as the model wrote it, cleaned lexically so two spellings of one path match: empty and `.` segments dropped,
 * and `..` resolved against the segment before it; a `..` with nothing before it stays, and a leading `/` is kept.
 * Nothing more: the record holds no workspace, so letter case and an absolute against a relative spelling still differ.
 * The workspace root cleans to `""`.
 */
function cleanPath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") segments.pop();
    else segments.push(segment);
  }
  return (path.startsWith("/") ? "/" : "") + segments.join("/");
}
