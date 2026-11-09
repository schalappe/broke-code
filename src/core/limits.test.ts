import { describe, expect, test } from "bun:test";
import { contextOf, estimateTokens, fillsContext, parseContextSizeInput, parseLimits } from "./limits";

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
    for (const raw of [[262144], "gemma-4", 42, null]) {
      expect(contextOf(parseLimits({ maxToolSteps: undefined, contextSizes: raw }), "0")).toEqual({
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

  test("gives no model a known size", () => {
    const limits = parseLimits({ maxToolSteps: undefined, contextSizes: { m: 8192 } });
    expect(contextOf(limits, undefined)).toEqual({ size: 32768, known: false });
  });
});

describe("estimateTokens", () => {
  test("is the characters of every message divided by 4, rounded up", () => {
    expect(estimateTokens([])).toBe(0);
    expect(estimateTokens(["abc"])).toBe(1);
    expect(estimateTokens(["a".repeat(3000), "b".repeat(500)])).toBe(875);
    expect(estimateTokens(["a".repeat(3504)])).toBe(876);
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
