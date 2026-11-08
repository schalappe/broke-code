import { describe, expect, test } from "bun:test";
import { SerialQueue } from "./serialQueue";

/** Promise plus its resolver, to finish a task when the test decides. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe("SerialQueue", () => {
  test("starts a task only after the previous one has settled", async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    const first = gate();
    const a = queue.run(async () => {
      log.push("a start");
      await first.opened;
      log.push("a end");
    });
    const b = queue.run(async () => {
      log.push("b start");
    });
    await Bun.sleep(5);
    expect(log).toEqual(["a start"]);
    first.open();
    await Promise.all([a, b]);
    expect(log).toEqual(["a start", "a end", "b start"]);
  });

  test("returns each task's value, and a failed task rejects only its own call", async () => {
    const queue = new SerialQueue();
    const failed = queue.run(async () => {
      throw new Error("boom");
    });
    const next = queue.run(async () => 42);
    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe(42);
  });
});
