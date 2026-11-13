import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BENCH_MODELS,
  benchTarget,
  describeSandboxFailure,
  dumpLine,
  modelsProblem,
  OLLAMA_URL,
  parseBenchArgs,
  sandboxProblem,
  startLine,
  trimIncompleteLine,
} from "./bench";
import { playScenario } from "./run";
import { ASK_SCENARIO, CREATE_SCENARIO, judge, SCENARIOS } from "./scenarios";

describe("parseBenchArgs", () => {
  test("defaults to both models, every scenario, and 10 runs", () => {
    expect(parseBenchArgs([])).toEqual({
      models: BENCH_MODELS,
      scenarios: SCENARIOS,
      runs: 10,
      dump: undefined,
      baseUrl: OLLAMA_URL,
      withoutAskUser: false,
    });
    expect(BENCH_MODELS).toEqual(["qwen3.8:27b", "gemma4:26b-a4b-it-qat"]);
  });

  test("takes repeated models, a run count, and a dump file", () => {
    expect(parseBenchArgs(["--model", "a", "--runs", "3", "--model", "b", "--dump", "/tmp/runs.jsonl"])).toEqual({
      models: ["a", "b"],
      scenarios: SCENARIOS,
      runs: 3,
      dump: "/tmp/runs.jsonl",
      baseUrl: OLLAMA_URL,
      withoutAskUser: false,
    });
  });

  test("with --no-ask-user, leaves the tool out and judges the ask scenario on the workspace alone", () => {
    const { scenarios, withoutAskUser } = parseBenchArgs(["--no-ask-user", "--scenario", "ask"]);
    expect(withoutAskUser).toBe(true);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]).toMatchObject({ name: "ask", files: ASK_SCENARIO.files, writes: ASK_SCENARIO.writes });
    expect(scenarios[0]?.check).toBeUndefined();
    expect(parseBenchArgs(["--scenario", "ask"]).scenarios).toEqual([ASK_SCENARIO]);
  });

  test("takes another server's base URL, trailing slashes dropped, and refuses anything else", () => {
    expect(parseBenchArgs(["--base-url", "https://pod-8000.proxy.runpod.net/v1/"]).baseUrl).toBe(
      "https://pod-8000.proxy.runpod.net/v1",
    );
    for (const url of ["pod:8000/v1", "ftp://pod/v1", "https://", ""]) {
      expect(() => parseBenchArgs(["--base-url", url])).toThrow("--base-url");
    }
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
      '--scenario takes one of read, edit, create, skill, command, slash, hidden, range, ask, not "reed".',
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

  test("names the server's URL and the error when the models cannot be listed", () => {
    const listing = {
      ok: false as const,
      error: { kind: "unreachable" as const, provider: "Ollama", baseUrl: url, cause: "connect ECONNREFUSED" },
    };
    const problem = modelsProblem(listing, ["a"], url);
    expect(problem).toContain(`The server at ${url}`);
    expect(problem).toContain("unreachable");
    expect(problem).toContain("connect ECONNREFUSED");
  });

  test("names each requested model the server does not list, with Ollama's pull hint only for the local Ollama", () => {
    const problem = modelsProblem({ ok: true, models: ["a", "c"] }, ["a", "b", "d"], url);
    expect(problem).toBe(`Not served at ${url}: b, d. Pull with \`ollama pull <name>\`.`);
    const remote = "https://pod-8000.proxy.runpod.net/v1";
    expect(modelsProblem({ ok: true, models: [] }, ["b"], remote)).toBe(`Not served at ${remote}: b.`);
  });

  test("finds no problem when Ollama lists every requested model", () => {
    expect(modelsProblem({ ok: true, models: ["b", "a"] }, ["a", "b"], url)).toBeUndefined();
  });
});

describe("sandboxProblem", () => {
  test("finds no problem where sandbox-exec applies the bench's profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "broke-code-sandbox-"));
    try {
      expect(await sandboxProblem(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("names sandbox-exec, says no run started, and keeps the probe's result as the cause", () => {
    const result = "exit code 71\nstdout: (empty)\nstderr:\nsandbox-exec: sandbox_apply: Operation not permitted";
    expect(describeSandboxFailure(result)).toBe(
      `Bench commands run under /usr/bin/sandbox-exec, which could not run one here, so no run started:\n${result}`,
    );
  });

  test("bun run eval exits 1 before asking the server anything when the sandbox cannot be applied", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests += 1;
        return Response.json({ data: [] });
      },
    });
    try {
      // [>]: A sandbox cannot be applied inside another one (exit 71), so running the bench in one makes its probe fail.
      const bench = Bun.spawn(
        [
          "/usr/bin/sandbox-exec",
          "-p",
          "(version 1)(allow default)",
          process.execPath,
          join(import.meta.dir, "bench.ts"),
          "--base-url",
          `http://127.0.0.1:${server.port}/v1`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [code, stderr] = await Promise.all([bench.exited, new Response(bench.stderr).text()]);
      expect(code).toBe(1);
      expect(stderr).toContain("Bench commands run under /usr/bin/sandbox-exec");
      expect(stderr).toContain("sandbox_apply");
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
    }
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

describe("the --no-ask-user flag, from the command line to the run", () => {
  type ChatRequest = { messages: { role: string; content: string }[] };
  const systemPrompts: string[] = [];
  let replies: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "m" }] });
      const body: ChatRequest = await request.json();
      systemPrompts.push(body.messages[0]?.content ?? "");
      const content = replies.shift() ?? "script exhausted";
      const event = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
      return new Response(`${event}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  afterAll(() => server.stop(true));
  const edit =
    "<edit_file>\n<path>src/parcels/labels.py</path>\n<old>def build_label(</old>\n<new>def make_label(</new>\n</edit_file>";

  /** Plays `ask` once as `bun run eval` would with `flags`: a rename in the answered file, without asking. */
  async function renameWithoutAsking(flags: string[]) {
    const options = parseBenchArgs(["--base-url", `http://localhost:${server.port}/v1`, "--scenario", "ask", ...flags]);
    const scenario = options.scenarios[0];
    if (scenario === undefined) throw new Error("no ask scenario");
    systemPrompts.length = 0;
    replies = [edit, "Renamed."];
    const parent = await mkdtemp(join(tmpdir(), "broke-code-bench-flag-"));
    try {
      const outcome = await playScenario(scenario, benchTarget(options, "m", undefined), parent);
      return { prompt: systemPrompts[0] ?? "", verdict: judge(scenario, outcome.entries, outcome.after) };
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }

  test("under the flag, ask_user is absent from the prompt and ask is judged on the workspace alone", async () => {
    const { prompt, verdict } = await renameWithoutAsking(["--no-ask-user"]);
    expect(prompt).not.toContain("ask_user");
    expect(verdict).toEqual({ pass: true });
    expect(startLine(parseBenchArgs(["--no-ask-user"]))).toEndWith(", ask_user not offered.");
  });

  test("without the flag, ask_user is in the prompt and a rename without asking is wrongTool", async () => {
    const { prompt, verdict } = await renameWithoutAsking([]);
    expect(prompt).toContain("## ask_user");
    expect(verdict).toMatchObject({ pass: false, category: "wrongTool" });
    expect(startLine(parseBenchArgs([]))).not.toContain("ask_user");
  });
});
