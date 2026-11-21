/**
 * @module report
 * The bench report: per model and scenario, the pass count against the bar, the wall-clock time, the mean replies per
 * run, the passing runs that chained tools in one script, the failure categories with their counts, and each failed
 * run's detail. Pure: the bench prints the text and exits on `passed`.
 */
import type { Verdict } from "./scenarios";

/**
 * One run's outcome. `run`: its index, from 0. `ms`: its wall-clock time, controller setup included. `replies`: its
 * replies that ended `done` (`repliesDone`), the requests the model needed. `chained`: one `ok` `run_script` step ran
 * at least two `ok` calls (`chainedScript`), so the run used Code Mode for what it measures.
 */
export type RunResult = {
  model: string;
  scenario: string;
  run: number;
  verdict: Verdict;
  ms: number;
  replies: number;
  chained: boolean;
};

/** Passes a model needs out of `runs` on each scenario: 9 of 10, rounded up, so every run below 10. */
export function passBar(runs: number): number {
  return Math.ceil((runs * 9) / 10);
}

/** The report of `results`, grouped by model then scenario in first-seen order. `passed`: every group met the bar. */
export function formatReport(results: readonly RunResult[], runs: number): { text: string; passed: boolean } {
  const bar = passBar(runs);
  const lines: string[] = [];
  const under: string[] = [];
  for (const model of unique(results.map((result) => result.model))) {
    lines.push(model);
    const ofModel = results.filter((result) => result.model === model);
    for (const scenario of unique(ofModel.map((result) => result.scenario))) {
      const group = ofModel.filter((result) => result.scenario === scenario);
      const passes = group.filter((result) => result.verdict.pass).length;
      const ms = group.reduce((total, result) => total + result.ms, 0);
      const replies = group.reduce((total, result) => total + result.replies, 0) / group.length;
      const chained = group.filter((result) => result.verdict.pass && result.chained).length;
      lines.push(
        `  ${scenario}: ${passes}/${group.length} passed (bar ${bar}), ${formatDuration(ms)}, ${replies.toFixed(1)} replies per run, ${chained} chained`,
      );
      if (passes < bar) under.push(`${model} ${scenario} ${passes}/${group.length}`);

      const failures = group.flatMap(({ run, verdict }) => (verdict.pass ? [] : [{ run, ...verdict }]));
      const categories = unique(failures.map((failure) => failure.category)).sort();
      for (const category of categories) {
        const count = failures.filter((failure) => failure.category === category).length;
        lines.push(`    ${category}: ${count}`);
      }
      for (const { run, category, detail } of failures) {
        lines.push(`    run ${run + 1} ${category}: ${printable(detail)}`);
      }
    }
  }
  lines.push("", under.length > 0 ? `Under the bar: ${under.join(", ")}.` : "Every model met the bar.");
  return { text: lines.join("\n"), passed: under.length === 0 };
}

/**
 * `text` safe to print on a terminal: each control character (C0, DEL, C1) as a `\u` escape. A verdict's detail holds
 * what the provider wrote (tool arguments, replies, paths), which could otherwise move the cursor, recolor, or erase
 * the bench's lines. The JSON Lines dump keeps the text as it was.
 */
export function printable(text: string): string {
  let shown = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    shown += control ? `\\u${code.toString(16).padStart(4, "0")}` : char;
  }
  return shown;
}

/** `ms` as minutes and zero-padded seconds, such as `2m 05s`. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
