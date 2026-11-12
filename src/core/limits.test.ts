import { describe, expect, test } from "bun:test";
import {
  contextOf,
  estimateTokens,
  fillsContext,
  largestFittingCharacters,
  parseCommandTimeout,
  parseContextSizeInput,
  parseLimits,
  userLimits,
  withContextSize,
} from "./limits";

describe("parseLimits", () => {
  test("reads a valid step limit and context table", () => {
    const limits = parseLimits({ maxToolSteps: 3, contextSizes: { "gemma-4": 262144, "qwen3:8b": 40960 } });
    expect(limits.maxToolSteps).toBe(3);
    expect(contextOf(limits, "gemma-4")).toEqual({ size: 262144, known: true });
    expect(contextOf(limits, "qwen3:8b")).toEqual({ size: 40960, known: true });
  });

  test("uses 50 steps and an empty table when both settings are missing", () => {
    const limits = parseLimits({ maxToolSteps: undefined, contextSizes: undefined });
    expect(limits.maxToolSteps).toBe(50);
    expect(contextOf(limits, "m")).toEqual({ size: 32768, known: false });
  });

  test("uses 50 steps for a step limit that is not an integer of at least 1", () => {
    for (const raw of ["3", 0, -2, 2.5, Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
      expect(parseLimits({ maxToolSteps: raw, contextSizes: undefined }).maxToolSteps).toBe(50);
    }
    expect(parseLimits({ maxToolSteps: 1, contextSizes: undefined }).maxToolSteps).toBe(1);
  });

  test("ignores each table entry that is not a positive integer, so that model uses 32,768", () => {
    const limits = parseLimits({
      maxToolSteps: undefined,
      contextSizes: { text: "131072", zero: 0, negative: -4096, float: 4096.5, nothing: null, good: 8192 },
    });
    for (const model of ["text", "zero", "negative", "float", "nothing"]) {
      expect(contextOf(limits, model)).toEqual({ size: 32768, known: false });
    }
    expect(contextOf(limits, "good")).toEqual({ size: 8192, known: true });
  });

  test("treats a table that is not a plain object as empty", () => {
    class Table {
      m = 8192;
    }
    for (const raw of [[262144], "gemma-4", 42, null, new Table(), new Map([["m", 8192]])]) {
      const limits = parseLimits({ maxToolSteps: undefined, contextSizes: raw });
      expect(contextOf(limits, "m")).toEqual({ size: 32768, known: false });
      expect(contextOf(limits, "0")).toEqual({
        size: 32768,
        known: false,
      });
    }
  });

  test("never reads a model name from the object prototype", () => {
    const limits = parseLimits({ maxToolSteps: undefined, contextSizes: {} });
    expect(contextOf(limits, "constructor")).toEqual({ size: 32768, known: false });
    expect(contextOf(limits, "__proto__")).toEqual({ size: 32768, known: false });
  });

  test("turns automatic compaction on only for the value true", () => {
    expect(parseLimits({ maxToolSteps: undefined, contextSizes: undefined, autoCompact: true }).autoCompact).toBe(true);
    for (const raw of [false, undefined, "true", 1, null, {}]) {
      expect(parseLimits({ maxToolSteps: undefined, contextSizes: undefined, autoCompact: raw }).autoCompact).toBe(
        false,
      );
    }
    // [>]: A source that passes no value, as the eval bench does, never compacts.
    expect(parseLimits({ maxToolSteps: undefined, contextSizes: undefined }).autoCompact).toBe(false);
  });

  test("gives no model a known size", () => {
    const limits = parseLimits({ maxToolSteps: undefined, contextSizes: { m: 8192 } });
    expect(contextOf(limits, undefined)).toEqual({ size: 32768, known: false });
  });
});

describe("userLimits", () => {
  test("reads each limit from its user value", () => {
    const limits = userLimits((name) => ({
      globalValue: { maxToolSteps: 7, contextSizes: { m: 4000 }, autoCompact: true }[name],
    }));
    expect(limits.maxToolSteps).toBe(7);
    expect(contextOf(limits, "m")).toEqual({ size: 4000, known: true });
    expect(limits.autoCompact).toBe(true);
  });

  test("ignores a value set only in a workspace or folder settings.json", () => {
    const limits = userLimits((name) => ({
      workspaceValue: { maxToolSteps: 7, contextSizes: { m: 4000 }, autoCompact: true }[name],
      workspaceFolderValue: { maxToolSteps: 7, contextSizes: { m: 4000 }, autoCompact: true }[name],
    }));
    expect(limits.maxToolSteps).toBe(50);
    expect(contextOf(limits, "m")).toEqual({ size: 32768, known: false });
    expect(limits.autoCompact).toBe(false);
  });
});

describe("estimateTokens", () => {
  const message = (content: string) => ({ content });

  test("at ratio 4, is the characters of every message divided by 4, rounded up", () => {
    expect(estimateTokens([], 4)).toBe(0);
    expect(estimateTokens([message("abc")], 4)).toBe(1);
    expect(estimateTokens([message("a".repeat(3000)), message("b".repeat(500))], 4)).toBe(875);
    expect(estimateTokens([message("a".repeat(3504))], 4)).toBe(876);
  });

  test("divides by the ratio: 40,000 characters are 10,000 tokens at 4 and 12,500 at 3.2", () => {
    expect(estimateTokens([message("a".repeat(40_000))], 4)).toBe(10_000);
    expect(estimateTokens([message("a".repeat(40_000))], 3.2)).toBe(12_500);
  });

  test("is exact in tenths: 69 characters at 2.3 are 30 tokens", () => {
    expect(estimateTokens([message("a".repeat(69))], 2.3)).toBe(30);
  });
});

describe("largestFittingCharacters", () => {
  const message = (content: string) => ({ content });

  test("a context of 32,768 tokens (a room of 28,672) fits 114,688, 100,352, 91,750, and 57,344 characters", () => {
    expect(largestFittingCharacters(32_768, 4)).toBe(114_688);
    expect(largestFittingCharacters(32_768, 3.5)).toBe(100_352);
    expect(largestFittingCharacters(32_768, 3.2)).toBe(91_750);
    expect(largestFittingCharacters(32_768, 2)).toBe(57_344);
  });

  test("is exact in tenths: a room of 175,000 tokens at 2.3 fits 402,500 characters", () => {
    expect(largestFittingCharacters(200_000, 2.3)).toBe(402_500);
  });

  test("at every ratio from 2 to 4, the largest fitting characters fit and one more fills the context", () => {
    for (let tenths = 20; tenths <= 40; tenths++) {
      const ratio = tenths / 10;
      for (const size of [32_768, 100_000, 200_000]) {
        const characters = largestFittingCharacters(size, ratio);
        expect(fillsContext(estimateTokens([message("a".repeat(characters))], ratio), size)).toBe(false);
        expect(fillsContext(estimateTokens([message("a".repeat(characters + 1))], ratio), size)).toBe(true);
      }
    }
  });
});

describe("withContextSize", () => {
  test("adds the model's size and keeps the other entries", () => {
    expect(withContextSize({ "gemma-4": 262144 }, "qwen3:8b", 40960)).toEqual({ "gemma-4": 262144, "qwen3:8b": 40960 });
  });

  test("replaces the model's earlier size", () => {
    expect(withContextSize({ m: 4096, n: 1 }, "m", 131072)).toEqual({ m: 131072, n: 1 });
  });

  test("starts a new table from a missing value or one that is not a plain object", () => {
    for (const current of [undefined, null, [1], "x", 42]) {
      expect(withContextSize(current, "m", 131072)).toEqual({ m: 131072 });
    }
  });
});

describe("fillsContext", () => {
  test("is true only past 7/8 of the context size", () => {
    expect(fillsContext(875, 1000)).toBe(false);
    expect(fillsContext(876, 1000)).toBe(true);
    expect(fillsContext(28672, 32768)).toBe(false);
    expect(fillsContext(28673, 32768)).toBe(true);
    expect(fillsContext(229376, 262144)).toBe(false);
    expect(fillsContext(229377, 262144)).toBe(true);
  });
});

describe("parseContextSizeInput", () => {
  test("accepts a positive whole number of tokens, spaces around it trimmed", () => {
    expect(parseContextSizeInput("131072")).toBe(131072);
    expect(parseContextSizeInput(" 4096 ")).toBe(4096);
  });

  test("refuses anything else", () => {
    for (const text of ["", "0", "-1", "1.5", "128k", "131,072", "1e5", "abc", "99999999999999999999"]) {
      expect(parseContextSizeInput(text)).toBeUndefined();
    }
  });
});

describe("parseCommandTimeout", () => {
  test("reads a whole number of seconds of at least 1", () => {
    expect(parseCommandTimeout(1)).toBe(1);
    expect(parseCommandTimeout(600)).toBe(600);
  });

  test("uses 120 seconds when the setting is missing or not an integer of at least 1", () => {
    for (const raw of [undefined, "30", 0, -5, 2.5, Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
      expect(parseCommandTimeout(raw)).toBe(120);
    }
  });

  test("caps the timeout at the longest delay a timer can wait, about 24 days", () => {
    expect(parseCommandTimeout(Number.MAX_SAFE_INTEGER)).toBe(2_147_483);
    expect(parseCommandTimeout(2_147_483)).toBe(2_147_483);
  });
});
