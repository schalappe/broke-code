import { describe, expect, test } from "bun:test";
import { lastTurnActions, unrevertedEffects } from "./lastTurn";
import type { ChatEntry, HaltReason, ReplyStatus, StepApproval } from "./protocol";

const user = (content: string): ChatEntry => ({ role: "user", content, mentions: [] });
const reply = (status: ReplyStatus = "done", haltReason?: HaltReason): ChatEntry => ({
  role: "assistant",
  reasoning: "",
  content: "Answer.",
  status,
  ...(haltReason ? { haltReason } : {}),
});
const summary = (status: ReplyStatus = "done", content = "Summary."): ChatEntry => ({
  role: "assistant",
  reasoning: "",
  content,
  status,
  summary: true,
});
const step = (name: string, extra: { status?: "ok" | "error"; approval?: StepApproval; undone?: true } = {}) =>
  ({ role: "tool", name, args: { path: "a.ts" }, status: extra.status ?? "ok", text: "Done.", ...extra }) as ChatEntry;

describe("lastTurnActions", () => {
  test("offers nothing without a user entry or while a reply is in flight", () => {
    expect(lastTurnActions([])).toBeUndefined();
    expect(lastTurnActions([user("Hi"), reply("waiting")])).toBeUndefined();
    expect(lastTurnActions([user("Hi"), reply("streaming")])).toBeUndefined();
  });

  test("offers Retry under the last reply of the last turn, whatever it ended on", () => {
    for (const status of ["done", "failed", "stopped"] as const) {
      expect(lastTurnActions([user("A"), reply(), user("B"), reply(status)])).toEqual({
        user: 2,
        reply: 3,
        continues: status === "stopped",
      });
    }
  });

  test("offers Continue after a step-limit or malformed-calls halt, under the halted reply before its step", () => {
    for (const reason of ["stepLimit", "malformedCalls"] as const) {
      expect(lastTurnActions([user("A"), reply("halted", reason), step("read_file")])).toEqual({
        user: 0,
        reply: 1,
        continues: true,
      });
    }
    expect(lastTurnActions([user("A"), reply("halted", "contextFull")])?.continues).toBe(false);
  });

  test("offers nothing when a completed /compact summary follows the last user entry", () => {
    expect(lastTurnActions([user("A"), reply("stopped"), summary()])).toBeUndefined();
    expect(lastTurnActions([user("A"), reply("stopped"), summary(), summary("failed")])).toBeUndefined();
  });

  test("offers Retry but not Continue over an unsent summary after the turn", () => {
    for (const unsent of [summary("failed"), summary("stopped"), summary("done", "  ")]) {
      expect(lastTurnActions([user("A"), reply("stopped"), unsent])).toEqual({ user: 0, reply: 1, continues: false });
    }
  });

  test("counts the turn's automatic summary as part of it", () => {
    const entries = [user("A"), reply(), step("read_file"), summary(), reply("stopped")];
    expect(lastTurnActions(entries)).toEqual({ user: 0, reply: 4, continues: true });
  });

  test("places the actions under a failed automatic summary that took the turn's only reply", () => {
    expect(lastTurnActions([user("A"), summary("failed")])).toEqual({ user: 0, reply: 1, continues: false });
  });
});

describe("unrevertedEffects", () => {
  test("counts the writes that applied and are not undone, and the commands the user ran, from the index on", () => {
    const entries = [
      user("A"),
      reply(),
      step("write_file", { approval: "accepted" }),
      user("B"),
      reply(),
      step("write_file", { approval: "auto" }),
      reply(),
      step("edit_file", { approval: "accepted", undone: true }),
      reply(),
      step("edit_file", { status: "error", approval: "rejected" }),
      reply(),
      step("run_command", { approval: "accepted", status: "error" }),
      reply(),
      step("run_command", { approval: "rejected", status: "error" }),
      reply(),
      step("read_file"),
      reply(),
    ];
    expect(unrevertedEffects(entries, 3)).toEqual({ writes: 1, commands: 1 });
    expect(unrevertedEffects(entries, 0)).toEqual({ writes: 2, commands: 1 });
    expect(unrevertedEffects(entries, entries.length)).toEqual({ writes: 0, commands: 0 });
  });
});
