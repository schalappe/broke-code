import { describe, expect, test } from "bun:test";
import { formatReport, passBar, printable, type RunResult } from "./report";

const pass = (model: string, ms = 20_000): RunResult => ({
  model,
  scenario: "read",
  run: 0,
  verdict: { pass: true },
  ms,
  replies: 2,
  chained: false,
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
        replies: 2,
        chained: false,
      },
      {
        model: "qwen",
        scenario: "read",
        run: 9,
        verdict: { pass: false, category: "malformed", detail: "<read_file> is not closed." },
        ms: 10_000,
        replies: 2,
        chained: false,
      },
      ...Array.from({ length: 10 }, () => pass("gemma", 6_000)),
    ];
    expect(formatReport(results, 10)).toEqual({
      passed: false,
      text: [
        "qwen",
        "  read: 8/10 passed (bar 9), 2m 40s, 2.0 replies per run, 0 chained",
        "    malformed: 1",
        "    wrongAnswer: 1",
        "    run 9 wrongAnswer: answer: 4471",
        "    run 10 malformed: <read_file> is not closed.",
        "gemma",
        "  read: 10/10 passed (bar 9), 1m 00s, 2.0 replies per run, 0 chained",
        "",
        "Under the bar: qwen read 8/10.",
      ].join("\n"),
    });
  });

  test("counts each category's failed runs", () => {
    const fail = (run: number, category: "stepLimit" | "wrongTool"): RunResult => ({
      model: "m",
      scenario: "read",
      run,
      verdict: { pass: false, category, detail: "d" },
      ms: 1_000,
      replies: 2,
      chained: false,
    });
    const results = [fail(0, "stepLimit"), fail(1, "wrongTool"), fail(2, "stepLimit")];
    expect(formatReport(results, 3).text.split("\n").slice(2, 4)).toEqual(["    stepLimit: 2", "    wrongTool: 1"]);
  });

  test("shows the mean replies per run and the passing runs that chained tools in one script", () => {
    const chained = { ...pass("qwen"), replies: 2, chained: true };
    const failedChain: RunResult = {
      ...chained,
      replies: 5,
      verdict: { pass: false, category: "wrongEdit", detail: "d" },
    };
    const results = [chained, chained, { ...pass("qwen"), replies: 4 }, failedChain];
    expect(formatReport(results, 4).text.split("\n")[1]).toBe(
      "  read: 3/4 passed (bar 4), 1m 20s, 3.3 replies per run, 2 chained",
    );
  });

  test("prints a failed run's detail with its control characters escaped", () => {
    const detail = "answer: \u001b[2K\u001b[1Agemma read: 10/10 passed\u0007\u009b";
    const failed: RunResult = { ...pass("m"), verdict: { pass: false, category: "wrongAnswer", detail } };
    const text = formatReport([failed], 1).text;
    expect(text).toContain("    run 1 wrongAnswer: answer: \\u001b[2K\\u001b[1Agemma read: 10/10 passed\\u0007\\u009b");
  });

  test("says every model met the bar", () => {
    const results = [...Array.from({ length: 9 }, () => pass("gemma", 1_000)), pass("gemma", 400)];
    expect(formatReport(results, 10)).toEqual({
      passed: true,
      text: [
        "gemma",
        "  read: 10/10 passed (bar 9), 0m 09s, 2.0 replies per run, 0 chained",
        "",
        "Every model met the bar.",
      ].join("\n"),
    });
  });
});

describe("printable", () => {
  test("escapes every control character, line breaks included, and keeps the rest", () => {
    expect(printable("a\nb\tc\u001b[31md\u007fé…")).toBe("a\\u000ab\\u0009c\\u001b[31md\\u007fé…");
  });
});
