import { describe, expect, test } from "bun:test";
import type { ChatEntry, ReplyStatus } from "../core/protocol";
import { type ConversationPart, foldTurns } from "./turns";

const U: ChatEntry = { role: "user", content: "Hi", mentions: [] };
const A = (status: ReplyStatus = "done", extra: Partial<ChatEntry & { role: "assistant" }> = {}): ChatEntry => ({
  role: "assistant",
  reasoning: "",
  content: "Looking.",
  status,
  ...extra,
});
const T = (status: "ok" | "error" | "malformed" = "ok", approval?: "rejected"): ChatEntry => ({
  role: "tool",
  name: "read_file",
  args: { path: "a.ts" },
  status,
  text: "x",
  ...(approval ? { approval } : {}),
});

/** Each part as a short string: an entry by index, a fold by its range and counts. */
function shape(parts: ConversationPart[]): string[] {
  return parts.map((part) =>
    part.kind === "entry"
      ? String(part.index)
      : `fold ${part.start}-${part.end} ${part.counts.steps}/${part.counts.failed}/${part.counts.rejected}`,
  );
}

/** Every entry index the parts render, in order, a fold's included. */
function rendered(parts: ConversationPart[]): number[] {
  return parts.flatMap((part) =>
    part.kind === "entry" ? [part.index] : Array.from({ length: part.end - part.start }, (_, i) => part.start + i),
  );
}

describe("foldTurns", () => {
  test("folds an ended turn's steps and intermediate replies, leaving the final reply in view", () => {
    const parts = foldTurns([U, A(), T(), A(), T(), A(), T(), A("done")]);
    expect(shape(parts)).toEqual(["0", "fold 1-7 3/0/0", "7"]);
  });

  test("counts a rejected step as rejected only and an error as failed", () => {
    const parts = foldTurns([U, A(), T(), A(), T("error"), A(), T("error", "rejected"), A("done")]);
    expect(shape(parts)).toEqual(["0", "fold 1-7 3/1/1", "7"]);
  });

  test("leaves a turn with one step unfolded", () => {
    expect(shape(foldTurns([U, A(), T(), A("done")]))).toEqual(["0", "1", "2", "3"]);
  });

  test("never folds the turn in flight", () => {
    const parts = foldTurns([
      U,
      A(),
      T(),
      A(),
      T(),
      A("streaming", { call: { name: "write_file", args: {}, start: 0, end: 1 } }),
    ]);
    expect(shape(parts)).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(shape(foldTurns([U, A(), T(), A(), T(), A("waiting")]))).toEqual(["0", "1", "2", "3", "4", "5"]);
  });

  test("folds a stopped turn, its stopped reply in view", () => {
    const parts = foldTurns([
      U,
      A(),
      T(),
      A(),
      T(),
      A("stopped", { call: { name: "read_file", args: {}, start: 0, end: 1 } }),
    ]);
    expect(shape(parts)).toEqual(["0", "fold 1-5 2/0/0", "5"]);
  });

  test("keeps a halted reply and the step after it in view", () => {
    const halted = A("halted", { haltReason: "stepLimit" });
    expect(shape(foldTurns([U, A(), T(), A(), T(), halted, T()]))).toEqual(["0", "fold 1-5 2/0/0", "5", "6"]);
    expect(shape(foldTurns([U, A(), T(), halted, T()]))).toEqual(["0", "1", "2", "3", "4"]);
  });

  test("counts malformed calls as failed, the third one in view after the halt", () => {
    const parts = foldTurns([
      U,
      A(),
      T("malformed"),
      A(),
      T("malformed"),
      A("halted", { haltReason: "malformedCalls" }),
      T("malformed"),
    ]);
    expect(shape(parts)).toEqual(["0", "fold 1-5 2/2/0", "5", "6"]);
  });

  test("folds an ended turn before a turn in flight, never the one in flight", () => {
    const parts = foldTurns([U, A(), T(), A(), T(), A("done"), U, A(), T(), A(), T(), A("streaming")]);
    expect(shape(parts)).toEqual(["0", "fold 1-5 2/0/0", "5", "6", "7", "8", "9", "10", "11"]);
  });

  test("renders each entry once for a step right after the user message and entries before the first one", () => {
    const entries = [A(), T(), U, T(), A(), T(), A("done")];
    const parts = foldTurns(entries);
    expect(rendered(parts)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(shape(parts)).toEqual(["0", "1", "2", "fold 3-6 2/0/0", "6"]);
    expect(rendered(foldTurns([U, T(), T()]))).toEqual([0, 1, 2]);
    expect(rendered(foldTurns([T(), T(), T()]))).toEqual([0, 1, 2]);
    expect(foldTurns([])).toEqual([]);
  });
});
