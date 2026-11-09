import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BENCH_MODELS, dumpLine, modelsProblem, parseBenchArgs, trimIncompleteLine } from "./bench";
import { CREATE_SCENARIO, SCENARIOS } from "./scenarios";

describe("parseBenchArgs", () => {
  test("defaults to both models, every scenario, and 10 runs", () => {
    expect(parseBenchArgs([])).toEqual({ models: BENCH_MODELS, scenarios: SCENARIOS, runs: 10, dump: undefined });
    expect(BENCH_MODELS).toEqual(["qwen3.8:27b", "gemma4:26b-a4b-it-qat"]);
  });

  test("takes repeated models, a run count, and a dump file", () => {
    expect(parseBenchArgs(["--model", "a", "--runs", "3", "--model", "b", "--dump", "/tmp/runs.jsonl"])).toEqual({
      models: ["a", "b"],
      scenarios: SCENARIOS,
      runs: 3,
      dump: "/tmp/runs.jsonl",
    });
  });

  test("plays a model named twice once, in first-seen order, so its runs are never scored together", () => {
    expect(parseBenchArgs(["--model", "b", "--model", "a", "--model", "b"]).models).toEqual(["b", "a"]);
  });

  test("plays only the scenarios named, each once and in the bench's order", () => {
    const names = parseBenchArgs(["--scenario", "skill", "--scenario", "read", "--scenario", "skill"]).scenarios.map(
      (scenario) => scenario.name,
    );
    expect(names).toEqual(["read", "skill"]);
  });

  test("refuses a scenario the bench does not hold, naming those it does", () => {
    expect(() => parseBenchArgs(["--scenario", "reed"])).toThrow(
      '--scenario takes one of read, edit, create, skill, not "reed".',
    );
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

describe("dumpLine", () => {
  test("records the run, its entries, each planned change, and the files that differ from the fixture, as one JSON line", () => {
    const entries = [{ role: "assistant" as const, reasoning: "", content: "Done.", status: "done" as const }];
    const planned = [
      { tool: "write_file" as const, path: "notes/a.txt", before: null, after: "one\n", status: "ok" as const },
      { tool: "edit_file" as const, path: "README.md", before: "# Courier\n", after: "", status: "error" as const },
    ];
    const after = { ...CREATE_SCENARIO.files, "notes/a.txt": "one\n" };
    const line = dumpLine({
      model: "m",
      scenario: CREATE_SCENARIO,
      run: 0,
      verdict: { pass: true },
      ms: 12.4,
      outcome: { entries, planned, after },
    });

    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      model: "m",
      scenario: "create",
      run: 1,
      verdict: { pass: true },
      ms: 12,
      entries,
      planned,
      changes: { "notes/a.txt": "one\n" },
    });
  });
});

describe("trimIncompleteLine", () => {
  async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "broke-code-dump-"));
    try {
      await body(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("drops a fragment left by an interrupted append, so every line parses after the next append", () =>
    inTempDir(async (dir) => {
      const dump = join(dir, "runs.jsonl");
      await writeFile(dump, '{"run":1}\n{"run":2,"entr');
      expect(await trimIncompleteLine(dump)).toBe(14);
      await writeFile(dump, '{"run":3}\n', { flag: "a" });
      const lines = (await readFile(dump, "utf8")).trimEnd().split("\n");
      expect(lines.map((line) => JSON.parse(line))).toEqual([{ run: 1 }, { run: 3 }]);
      expect(await trimIncompleteLine(dump)).toBe(0);
    }));

  test("empties a file holding only a fragment", () =>
    inTempDir(async (dir) => {
      const dump = join(dir, "runs.jsonl");
      await writeFile(dump, '{"run":1');
      expect(await trimIncompleteLine(dump)).toBe(8);
      expect(await readFile(dump, "utf8")).toBe("");
    }));

  test("leaves a missing file, an empty file, and complete lines alone", () =>
    inTempDir(async (dir) => {
      const dump = join(dir, "runs.jsonl");
      expect(await trimIncompleteLine(dump)).toBe(0);
      await writeFile(dump, "");
      expect(await trimIncompleteLine(dump)).toBe(0);
      await writeFile(dump, '{"run":1}\n');
      expect(await trimIncompleteLine(dump)).toBe(0);
      expect(await readFile(dump, "utf8")).toBe('{"run":1}\n');
    }));
});
