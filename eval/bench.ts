/**
 * @module bench
 * `bun run eval`: plays every scenario, or those `--scenario` names, `--runs` times on each model against the local
 * Ollama, all runs of one model before the next so each model loads once, then prints the report and exits 1 when a
 * model is under the bar. A model Ollama does not list, or Ollama unreachable, exits 1 before any run. Runs locally on
 * demand, never in CI.
 */

import { rmSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { listModels, type ModelListing } from "../src/core/client";
import { formatDuration, formatReport, type RunResult } from "./report";
import { playScenario, type RunOutcome } from "./run";
import { describeError, judge, SCENARIOS, type Scenario, type Verdict, workspaceChanges } from "./scenarios";

export const BENCH_MODELS = ["qwen3.8:27b", "gemma4:26b-a4b-it-qat"];
const OLLAMA_URL = "http://localhost:11434/v1";
/**
 * Small, so a model that loops ends as a step limit after a few requests, not after 50; room for an edit's list, read,
 * edit, and search, and for empty replies, which count as steps (ADR 0001).
 */
const MAX_TOOL_STEPS = 10;

/**
 * `models`: `--model`, repeatable, else both bench models; a name given twice is played once, since the report scores
 * a model's runs together against the bar of one batch. `scenarios`: those `--scenario` names, repeatable, in the
 * order of `SCENARIOS`, each once, else every scenario. `runs`: `--runs`, else 10. `dump`: `--dump <file>`, a JSON
 * Lines file each run's `dumpLine` is appended to, for reading failed replies and writes. Throws on an unknown
 * scenario and on any other flag.
 */
export function parseBenchArgs(args: string[]): {
  models: string[];
  scenarios: readonly Scenario[];
  runs: number;
  dump: string | undefined;
} {
  const { values } = parseArgs({
    args,
    options: {
      model: { type: "string", multiple: true },
      scenario: { type: "string", multiple: true },
      runs: { type: "string" },
      dump: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const runs = values.runs === undefined ? 10 : Number(values.runs);
  if (!/^\d+$/.test(values.runs ?? "10") || !Number.isSafeInteger(runs) || runs < 1) {
    throw new Error(`--runs takes a whole number of at least 1, not ${JSON.stringify(values.runs)}.`);
  }
  const names = SCENARIOS.map((scenario) => scenario.name);
  const unknown = values.scenario?.find((name) => !names.includes(name));
  if (unknown !== undefined) {
    throw new Error(`--scenario takes one of ${names.join(", ")}, not ${JSON.stringify(unknown)}.`);
  }
  const chosen = values.scenario;
  const scenarios = chosen === undefined ? SCENARIOS : SCENARIOS.filter((scenario) => chosen.includes(scenario.name));
  return { models: [...new Set(values.model ?? BENCH_MODELS)], scenarios, runs, dump: values.dump };
}

/**
 * Why the bench cannot play `models` on the provider at `baseUrl`, given its model `listing`: the listing failed, or
 * it lacks some of them, each named. `undefined` when every model is listed.
 */
export function modelsProblem(listing: ModelListing, models: readonly string[], baseUrl: string): string | undefined {
  if (!listing.ok) return `Ollama at ${baseUrl} could not list its models: ${describeError(listing.error)}`;
  const missing = models.filter((model) => !listing.models.includes(model));
  if (missing.length === 0) return undefined;
  return `Not served by Ollama at ${baseUrl}: ${missing.join(", ")}. Pull with \`ollama pull <name>\`.`;
}

/**
 * Cuts the dump file at `path` after its last newline, so the next append starts a line of its own: an interrupted
 * append (Ctrl-C exits at once) can leave a JSON fragment that the next run's first record would otherwise join.
 * Returns how many bytes it dropped, 0 when the file is missing, empty, or ends with a newline. Safe to run twice.
 */
export async function trimIncompleteLine(path: string): Promise<number> {
  let content: Buffer;
  try {
    content = await readFile(path);
  } catch (error) {
    // [>]: A missing dump is the first run's normal state; appendFile creates it.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (content.length === 0 || content.at(-1) === 0x0a) return 0;
  const keep = content.lastIndexOf(0x0a) + 1;
  await truncate(path, keep);
  return content.length - keep;
}

/**
 * One run as a line of the dump: its model, scenario, run number from 1, verdict, and whole milliseconds, then its
 * `entries` (tool steps with the arguments of their calls), `planned` (each change handed to the applier, in call
 * order, with its status), and `changes` (the entries that differ from the fixture after the run, see `workspaceChanges`).
 */
export function dumpLine(run: {
  model: string;
  scenario: Scenario;
  run: number;
  verdict: Verdict;
  ms: number;
  outcome: RunOutcome;
}): string {
  const { model, scenario, verdict, ms, outcome } = run;
  const line = {
    model,
    scenario: scenario.name,
    run: run.run + 1,
    verdict,
    ms: Math.round(ms),
    entries: outcome.entries,
    planned: outcome.planned,
    changes: workspaceChanges(scenario.files, outcome.after),
  };
  return `${JSON.stringify(line)}\n`;
}

async function main(): Promise<number> {
  const { models, scenarios, runs, dump } = parseBenchArgs(process.argv.slice(2));

  const listing = await listModels({ provider: { name: "Ollama", baseUrl: OLLAMA_URL }, apiKey: undefined });
  const problem = modelsProblem(listing, models, OLLAMA_URL);
  if (problem) {
    console.error(problem);
    return 1;
  }

  if (dump) {
    const dropped = await trimIncompleteLine(dump);
    if (dropped > 0)
      console.error(`${dump} ended with an incomplete line (${dropped} bytes), removed before appending.`);
  }
  console.error(`broke-code eval: Ollama at ${OLLAMA_URL}, ${runs} runs per scenario, step limit ${MAX_TOOL_STEPS}.`);
  // [>]: One folder holds every run's workspace copy, so an interrupted bench can remove it too.
  const tmpRoot = await mkdtemp(join(tmpdir(), "broke-code-bench-"));
  process.once("SIGINT", () => {
    rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(130);
  });
  const started = performance.now();
  const results: RunResult[] = [];
  try {
    for (const model of models) {
      for (const scenario of scenarios) {
        for (let run = 0; run < runs; run += 1) {
          const runStarted = performance.now();
          const target = { baseUrl: OLLAMA_URL, model, maxToolSteps: MAX_TOOL_STEPS };
          const outcome = await playScenario(scenario, target, tmpRoot);
          const verdict = judge(scenario, outcome.entries, outcome.after);
          const ms = performance.now() - runStarted;
          results.push({ model, scenario: scenario.name, run, verdict, ms });
          const shown = verdict.pass ? "pass" : `${verdict.category}: ${verdict.detail}`;
          console.error(`${model} ${scenario.name} ${run + 1}/${runs} ${formatDuration(ms)} ${shown}`);
          if (dump) await appendFile(dump, dumpLine({ model, scenario, run, verdict, ms, outcome }));
        }
      }
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  const report = formatReport(results, runs);
  console.log(`${report.text}\nTotal: ${formatDuration(performance.now() - started)}.`);
  return report.passed ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
