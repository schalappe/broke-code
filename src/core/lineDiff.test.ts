import { describe, expect, test } from "bun:test";
import { LINE_DIFF_WORK_LIMIT, lineDiffCount } from "./lineDiff";

describe("lineDiffCount", () => {
  test("a changed line and an appended one", () => {
    expect(lineDiffCount("one\ntwo\nthree\n", "one\nTWO\nthree\nfour\n")).toEqual({ added: 2, removed: 1 });
  });

  test("a created file counts each of its lines added", () => {
    expect(lineDiffCount(undefined, "x\ny\n")).toEqual({ added: 2, removed: 0 });
    expect(lineDiffCount(undefined, "x\ny")).toEqual({ added: 2, removed: 0 });
  });

  test("an empty created file and equal texts count nothing", () => {
    expect(lineDiffCount(undefined, "")).toEqual({ added: 0, removed: 0 });
    expect(lineDiffCount("a\nb\n", "a\nb\n")).toEqual({ added: 0, removed: 0 });
  });

  test("an emptied file counts each line removed", () => {
    expect(lineDiffCount("a\nb\n", "")).toEqual({ added: 0, removed: 2 });
  });

  test("a final line break and a changed line ending each count as one line removed and one added", () => {
    expect(lineDiffCount("a", "a\n")).toEqual({ added: 1, removed: 1 });
    expect(lineDiffCount("a\n", "a\r\n")).toEqual({ added: 1, removed: 1 });
  });

  test("the counts are those of a minimal diff, not of the common first and last lines", () => {
    // [>]: A line moved from the end to the start: the smallest diff adds it once and removes it once.
    expect(lineDiffCount("a\nb\nc\nd\n", "d\na\nb\nc\n")).toEqual({ added: 1, removed: 1 });
    expect(lineDiffCount("a\nx\nb\ny\nc\n", "a\nb\nz\nc\n")).toEqual({ added: 1, removed: 2 });
  });

  test("past the work limit, the lines left after the common first and last lines count all removed and all added", () => {
    // [>]: Each changed line sits between two unchanged ones: the smallest diff is +k −k, far over the limit to find.
    const k = 4000;
    const before = ["first", ...Array.from({ length: k }, (_, i) => `old ${i}\nsame`), "last", ""].join("\n");
    const after = ["first", ...Array.from({ length: k }, (_, i) => `new ${i}\nsame`), "last", ""].join("\n");
    expect(k * k).toBeGreaterThan(LINE_DIFF_WORK_LIMIT);
    // [>]: Left after the common lines: `old 0` to the last `same` before `last`, 2k - 1 lines each side.
    expect(lineDiffCount(before, after)).toEqual({ added: 2 * k - 1, removed: 2 * k - 1 });
  });

  test("two 1 MiB texts of one-byte lines return in bounded time", () => {
    const lines = 512 * 1024;
    const before = "a\n".repeat(lines);
    const after = "b\n".repeat(lines);
    const started = performance.now();
    expect(lineDiffCount(before, after)).toEqual({ added: lines, removed: lines });
    // [>]: Smallest is +L/2 −L/2; past the limit, all but the common last line `a` count, still a true diff.
    expect(lineDiffCount(before, "b\na\n".repeat(lines / 2))).toEqual({ added: lines - 1, removed: lines - 1 });
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
