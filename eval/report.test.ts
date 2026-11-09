import { describe, expect, test } from "bun:test";
import { formatReport, passBar, type RunResult } from "./report";

const pass = (model: string, ms = 20_000): RunResult => ({
  model,
  scenario: "read",
  run: 0,
  verdict: { pass: true },
  ms,
});

describe("passBar", () => {
  test("is 9 of 10 runs, and every run below 10", () => {
    expect(passBar(10)).toBe(9);
    expect(passBar(20)).toBe(18);
    expect(passBar(3)).toBe(3);
    expect(passBar(1)).toBe(1);
  });
});

describe("formatReport", () => {
  test("prints pass counts, categories with counts and failed runs, and time, per model and scenario", () => {
    const results: RunResult[] = [
      ...Array.from({ length: 8 }, () => pass("qwen", 15_000)),
      {
        model: "qwen",
        scenario: "read",
        run: 8,
        verdict: { pass: false, category: "wrongAnswer", detail: "answer: 4471" },
        ms: 30_000,
      },
      {
        model: "qwen",
        scenario: "read",
        run: 9,
        verdict: { pass: false, category: "malformed", detail: "<read_file> is not closed." },
        ms: 10_000,
      },
      ...Array.from({ length: 10 }, () => pass("gemma", 6_000)),
    ];
    expect(formatReport(results, 10)).toEqual({
      passed: false,
      text: [
        "qwen",
        "  read: 8/10 passed (bar 9), 2m 40s",
        "    malformed: 1",
        "    wrongAnswer: 1",
        "    run 9 wrongAnswer: answer: 4471",
        "    run 10 malformed: <read_file> is not closed.",
        "gemma",
        "  read: 10/10 passed (bar 9), 1m 00s",
        "",
        "Under the bar: qwen read 8/10.",
      ].join("\n"),
    });
  });

  test("says every model met the bar", () => {
    const results = [...Array.from({ length: 9 }, () => pass("gemma", 1_000)), pass("gemma", 400)];
    expect(formatReport(results, 10)).toEqual({
      passed: true,
      text: ["gemma", "  read: 10/10 passed (bar 9), 0m 09s", "", "Every model met the bar."].join("\n"),
    });
  });
});
