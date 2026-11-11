import { describe, expect, test } from "bun:test";
import { DraftQueue } from "./draftQueue";
import type { DraftInsert } from "./protocol";

const draft = (text: string): DraftInsert => ({ text, mode: "caret", picked: [] });

/** A queue over a fake webview: `deliverable` says whether it is ready and visible, `sent` what reached it. */
function fixture(outcomes: (boolean | Error)[] = []) {
  const state = { deliverable: true, sent: [] as string[], attempts: 0 };
  const queue = new DraftQueue({
    canDeliver: () => state.deliverable,
    send: async (insert) => {
      state.attempts += 1;
      const outcome = outcomes.shift() ?? true;
      if (outcome instanceof Error) throw outcome;
      if (outcome) state.sent.push(insert.text);
      return outcome;
    },
  });
  return { state, queue };
}

const shown = { hasProvider: true, show: async () => {} };

describe("DraftQueue", () => {
  test("delivers a draft at once when the webview is ready and visible", async () => {
    const { state, queue } = fixture();
    expect(await queue.insert(draft("a"), shown)).toBe("queued");
    expect(state.sent).toEqual(["a"]);
  });

  test("holds drafts while the webview is not ready or hidden, then delivers them once, in order", async () => {
    const { state, queue } = fixture();
    state.deliverable = false;
    await queue.insert(draft("a"), shown);
    await queue.insert(draft("b"), shown);
    expect(state.sent).toEqual([]);
    state.deliverable = true;
    await queue.deliver();
    await queue.deliver();
    expect(state.sent).toEqual(["a", "b"]);
  });

  test("overlapping inserts keep their call order, whichever show settles first", async () => {
    const { state, queue } = fixture();
    let release = () => {};
    const slow = { hasProvider: true, show: () => new Promise<void>((resolve) => (release = resolve)) };
    const first = queue.insert(draft("first"), slow);
    const second = queue.insert(draft("second"), shown);
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(state.sent).toEqual(["first", "second"]);
  });

  test("a failed show does not hold back the inserts behind it", async () => {
    const { state, queue } = fixture();
    const failing = { hasProvider: true, show: () => Promise.reject(new Error("no view")) };
    const first = queue.insert(draft("a"), failing);
    const second = queue.insert(draft("b"), shown);
    await expect(first).rejects.toThrow("no view");
    await second;
    expect(state.sent).toEqual(["b"]);
  });

  test("a failed show queues nothing and rejects, so a retry delivers the draft once", async () => {
    const { state, queue } = fixture();
    const failing = { hasProvider: true, show: () => Promise.reject(new Error("no view")) };
    await expect(queue.insert(draft("a"), failing)).rejects.toThrow("no view");
    await queue.deliver();
    expect(state.sent).toEqual([]);
    await queue.insert(draft("a"), shown);
    expect(state.sent).toEqual(["a"]);
  });

  test("without a provider it shows the chat and drops the draft", async () => {
    const { state, queue } = fixture();
    let shows = 0;
    const result = await queue.insert(draft("a"), {
      hasProvider: false,
      show: async () => {
        shows += 1;
      },
    });
    expect(result).toBe("noProvider");
    expect(shows).toBe(1);
    await queue.deliver();
    expect(state.attempts).toBe(0);
  });

  test("keeps an undelivered draft, and those behind it, for the next ready, then delivers each once", async () => {
    for (const failure of [false, new Error("disposed")]) {
      const { state, queue } = fixture([failure]);
      state.deliverable = false;
      await queue.insert(draft("a"), shown);
      await queue.insert(draft("b"), shown);
      state.deliverable = true;
      await queue.deliver();
      expect(state.sent).toEqual([]);
      await queue.deliver();
      await queue.deliver();
      expect(state.sent).toEqual(["a", "b"]);
    }
  });

  test("two deliveries at once post each draft once", async () => {
    const { state, queue } = fixture();
    state.deliverable = false;
    await queue.insert(draft("a"), shown);
    await queue.insert(draft("b"), shown);
    state.deliverable = true;
    await Promise.all([queue.deliver(), queue.deliver()]);
    expect(state.sent).toEqual(["a", "b"]);
    expect(state.attempts).toBe(2);
  });
});
