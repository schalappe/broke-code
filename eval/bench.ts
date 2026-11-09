/**
 * @module bench
 * `bun run eval`: plays every scenario `--runs` times on each model against the local Ollama, all runs of one model
 * before the next so each model loads once, then prints the report and exits 1 when a model is under the bar. A model
 * Ollama does not list, or Ollama unreachable, exits 1 before any run. Runs locally on demand, never in CI.
 */

import { rmSync } from "node:fs";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { listModels, type ModelListing } from "../src/core/client";
import { formatDuration, formatReport, type RunResult } from "./report";
import { playScenario } from "./run";
import { describeError, judge, SCENARIOS } from "./scenarios";

export const BENCH_MODELS = ["qwen3.8:27b", "gemma4:26b-a4b-it-qat"];
const OLLAMA_URL = "http://localhost:11434/v1";
/** Small, so a model that loops ends as a step limit after a few requests, not after 50. */
const MAX_TOOL_STEPS = 6;

/**
 * `models`: `--model`, repeatable, else both bench models; a name given twice is played once, since the report scores
 * a model's runs together against the bar of one batch. `runs`: `--runs`, else 10. `dump`: `--dump <file>`, a JSON
 * Lines file each run's entries and verdict are appended to, for reading failed replies. Throws on any other flag.
 */
export function parseBenchArgs(args: string[]): { models: string[]; runs: number; dump: string | undefined } {
  const { values } = parseArgs({
    args,
    options: {
      model: { type: "string", multiple: true },
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
  return { models: [...new Set(values.model ?? BENCH_MODELS)], runs, dump: values.dump };
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

async function main(): Promise<number> {
  const { models, runs, dump } = parseBenchArgs(process.argv.slice(2));

  const listing = await listModels({ provider: { name: "Ollama", baseUrl: OLLAMA_URL }, apiKey: undefined });
  const problem = modelsProblem(listing, models, OLLAMA_URL);
  if (problem) {
    console.error(problem);
    return 1;
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
      for (const scenario of SCENARIOS) {
        for (let run = 0; run < runs; run += 1) {
          const runStarted = performance.now();
          const target = { baseUrl: OLLAMA_URL, model, maxToolSteps: MAX_TOOL_STEPS };
          const { entries, after } = await playScenario(scenario, target, tmpRoot);
          const verdict = judge(scenario, entries, after);
          const ms = performance.now() - runStarted;
          results.push({ model, scenario: scenario.name, run, verdict, ms });
          const outcome = verdict.pass ? "pass" : `${verdict.category}: ${verdict.detail}`;
          console.error(`${model} ${scenario.name} ${run + 1}/${runs} ${formatDuration(ms)} ${outcome}`);
          if (dump) {
            const line = { model, scenario: scenario.name, run: run + 1, verdict, ms: Math.round(ms), entries };
            await appendFile(dump, `${JSON.stringify(line)}\n`);
          }
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
