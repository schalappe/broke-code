import { describe, expect, test } from "bun:test";
import { BENCH_MODELS, modelsProblem, parseBenchArgs } from "./bench";

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

  test("plays a model named twice once, in first-seen order, so its runs are never scored together", () => {
    expect(parseBenchArgs(["--model", "b", "--model", "a", "--model", "b"]).models).toEqual(["b", "a"]);
  });

  test("refuses a run count that is not a positive integer, and unknown flags", () => {
    for (const runs of ["0", "-1", "2.5", "ten", ""]) {
      expect(() => parseBenchArgs(["--runs", runs])).toThrow("--runs");
    }
    expect(() => parseBenchArgs(["--model"])).toThrow();
    expect(() => parseBenchArgs(["--verbose"])).toThrow();
  });
});

describe("modelsProblem", () => {
  const url = "http://localhost:11434/v1";

  test("names Ollama's URL and the error when the models cannot be listed", () => {
    const listing = {
      ok: false as const,
      error: { kind: "unreachable" as const, provider: "Ollama", baseUrl: url, cause: "connect ECONNREFUSED" },
    };
    const problem = modelsProblem(listing, ["a"], url);
    expect(problem).toContain(`Ollama at ${url}`);
    expect(problem).toContain("unreachable");
    expect(problem).toContain("connect ECONNREFUSED");
  });

  test("names each requested model Ollama does not list", () => {
    const problem = modelsProblem({ ok: true, models: ["a", "c"] }, ["a", "b", "d"], url);
    expect(problem).toBe(`Not served by Ollama at ${url}: b, d. Pull with \`ollama pull <name>\`.`);
  });

  test("finds no problem when Ollama lists every requested model", () => {
    expect(modelsProblem({ ok: true, models: ["b", "a"] }, ["a", "b"], url)).toBeUndefined();
  });
});
