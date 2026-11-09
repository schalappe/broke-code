import { describe, expect, test } from "bun:test";
import { BENCH_MODELS, parseBenchArgs } from "./bench";

describe("parseBenchArgs", () => {
  test("defaults to both models and 10 runs", () => {
    expect(parseBenchArgs([])).toEqual({ models: BENCH_MODELS, runs: 10, dump: undefined });
    expect(BENCH_MODELS).toEqual(["qwen3.8:27b", "gemma4:26b-a4b-it-qat"]);
  });

  test("takes repeated models, a run count, and a dump file", () => {
    expect(parseBenchArgs(["--model", "a", "--runs", "3", "--model", "b", "--dump", "/tmp/runs.jsonl"])).toEqual({
      models: ["a", "b"],
      runs: 3,
      dump: "/tmp/runs.jsonl",
    });
  });

  test("refuses a run count that is not a positive integer, and unknown flags", () => {
    for (const runs of ["0", "-1", "2.5", "ten", ""]) {
      expect(() => parseBenchArgs(["--runs", runs])).toThrow("--runs");
    }
    expect(() => parseBenchArgs(["--model"])).toThrow();
    expect(() => parseBenchArgs(["--verbose"])).toThrow();
  });
});
