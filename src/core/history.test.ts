import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "./client";
import {
  historyStart,
  isAutomaticSummary,
  resultLineCount,
  SUMMARY_REQUEST,
  sentEntries,
  summaryHistory,
  toHistory,
} from "./history";
import { estimateTokens, fillsContext } from "./limits";
import type { ChatEntry, ReplyStatus, ToolStepStatus } from "./protocol";

const user = (content: string): ChatEntry => ({ role: "user", content, mentions: [] });
const answer = (content: string): ChatEntry => ({ role: "assistant", reasoning: "Plan.", content, status: "done" });
const summary = (content: string, status: ReplyStatus = "done"): ChatEntry => ({
  role: "assistant",
  reasoning: "Thinking.",
  content,
  status,
  summary: true,
  ...(status === "halted" ? { haltReason: "contextFull" as const } : {}),
});
const step = (text: string, name = "read_file", status: ToolStepStatus = "ok"): ChatEntry => ({
  role: "tool",
  name,
  args: { path: "a.ts" },
  status,
  text,
});
/** A reply that ended without text: `status` failed, stopped, or halted (on a full context). */
const empty = (status: ReplyStatus): ChatEntry => ({
  role: "assistant",
  reasoning: "",
  content: "",
  status,
  ...(status === "halted" ? { haltReason: "contextFull" as const } : {}),
});
const undoneStep = (text: string, name: string): ChatEntry => ({ ...step(text, name), undone: true }) as ChatEntry;
/** `count` lines of about 100 characters each, no final line break. */
const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i} ${"x".repeat(90)}`).join("\n");
const typed = (entry: ChatEntry & { role: "user" }) => entry.content;
const wrapped = (text: string, tool = "read_file", status = "ok") =>
  `<tool_result tool="${tool}" status="${status}">\n${text}\n</tool_result>`;

const SYSTEM = "You are an agent.";
const roomy = { system: SYSTEM, contextSize: 1_000_000 };

/** A user message, then five calls whose results are 100 lines each (about 50,000 characters in all). */
const fiveBigSteps: ChatEntry[] = [
  user("go"),
  ...[0, 1, 2, 3, 4].flatMap((index) => [answer(`call ${index}`), step(lines(100))]),
];

/** True when `system` plus `messages` stays within the threshold of `contextSize`. */
const fits = (messages: { content: string }[], contextSize: number) =>
  !fillsContext(estimateTokens([{ content: SYSTEM }, ...messages]), contextSize);

describe("toHistory", () => {
  test("under the threshold, sends every entry as before: answers verbatim, results whole, no reasoning", () => {
    const entries: ChatEntry[] = [
      user("typed"),
      answer("<read_file>\n<path>a.ts</path>\n</read_file>"),
      step("one\ntwo"),
      answer(""),
      step("Your reply was empty.", "unknown", "malformed"),
      answer(""),
      answer("Done."),
    ];
    const history = toHistory(entries, () => "composed", roomy);
    expect(history).toEqual({
      leftOut: 0,
      messages: [
        { role: "user", content: "composed" },
        { role: "assistant", content: "<read_file>\n<path>a.ts</path>\n</read_file>" },
        { role: "user", content: wrapped("one\ntwo") },
        { role: "assistant", content: "" },
        { role: "user", content: wrapped("Your reply was empty.", "unknown", "error") },
        { role: "assistant", content: "Done." },
      ],
    });
  });

  test("over the threshold, replaces the oldest result only, when that one is enough", () => {
    // [>]: Threshold 11,000 tokens (44,000 characters): the whole history is about 50,000, less one result about 40,000.
    const contextSize = 12_572;
    const { messages, leftOut } = toHistory(fiveBigSteps, typed, { system: SYSTEM, contextSize });
    expect(leftOut).toBe(1);
    expect(messages[2]).toEqual({ role: "user", content: wrapped("[result left out to save context: 100 lines]") });
    expect(messages[4]).toEqual({ role: "user", content: wrapped(lines(100)) });
    expect(messages.slice(5)).toEqual(toHistory(fiveBigSteps, typed, roomy).messages.slice(5));
    expect(fits(messages, contextSize)).toBe(true);
  });

  test("replaces as many of the oldest results as the request needs to fit, and no more", () => {
    // [>]: Threshold 8,000 tokens (32,000 characters): two results out bring it to about 30,000.
    const contextSize = 9_143;
    const { messages, leftOut } = toHistory(fiveBigSteps, typed, { system: SYSTEM, contextSize });
    expect(leftOut).toBe(2);
    expect(messages[2]?.content).toBe(wrapped("[result left out to save context: 100 lines]"));
    expect(messages[4]?.content).toBe(wrapped("[result left out to save context: 100 lines]"));
    expect(fits(messages, contextSize)).toBe(true);
  });

  test("never replaces the last 3 steps of the conversation: still too large, the history goes whole", () => {
    const { messages, leftOut } = toHistory(fiveBigSteps, typed, { system: SYSTEM, contextSize: 1_000 });
    expect(leftOut).toBe(0);
    expect(messages).toEqual(toHistory(fiveBigSteps, typed, roomy).messages);
  });

  test("the last 3 steps count over the whole conversation, earlier turns included", () => {
    const entries: ChatEntry[] = [
      user("first"),
      answer("call"),
      step(lines(100)),
      answer("Done."),
      user("second"),
      ...[0, 1, 2].flatMap(() => [answer("call"), step(lines(100))]),
    ];
    // [>]: Four results of about 10,000 characters against 32,000: one out is enough, and only the first may go.
    const { messages, leftOut } = toHistory(entries, typed, { system: SYSTEM, contextSize: 9_143 });
    expect(leftOut).toBe(1);
    expect(messages[2]?.content).toBe(wrapped("[result left out to save context: 100 lines]"));
    expect(messages.filter((message) => message.content.includes("left out"))).toHaveLength(1);
  });

  test("keeps a result no longer than its replacement line and replaces the next oldest instead", () => {
    const entries: ChatEntry[] = [
      user("go"),
      answer("call"),
      step("ok"),
      answer("call"),
      step("a.ts: not found"),
      ...fiveBigSteps.slice(1),
    ];
    const { messages, leftOut } = toHistory(entries, typed, { system: SYSTEM, contextSize: 12_572 });
    expect(leftOut).toBe(1);
    expect(messages[2]?.content).toBe(wrapped("ok"));
    expect(messages[4]?.content).toBe(wrapped("a.ts: not found"));
    expect(messages[6]?.content).toBe(wrapped("[result left out to save context: 100 lines]"));
  });

  test("never replaces a load_skill step, ok or error, nor user messages and answers", () => {
    const body = lines(100);
    const entries: ChatEntry[] = [
      user(body),
      answer(body),
      step(body, "load_skill", "ok"),
      answer("call"),
      step(body, "load_skill", "error"),
      ...fiveBigSteps.slice(1),
    ];
    // [>]: About 90,000 characters against 75,000: the two results that may go are both needed.
    const { messages, leftOut } = toHistory(entries, typed, { system: SYSTEM, contextSize: 21_429 });
    expect(leftOut).toBe(2);
    expect(messages[0]?.content).toBe(body);
    expect(messages[1]?.content).toBe(body);
    expect(messages[2]?.content).toBe(wrapped(body, "load_skill", "ok"));
    expect(messages[4]?.content).toBe(wrapped(body, "load_skill", "error"));
    expect(messages[6]?.content).toBe(wrapped("[result left out to save context: 100 lines]"));
    expect(messages[8]?.content).toBe(wrapped("[result left out to save context: 100 lines]"));
  });

  test("an undone write step's result ends with the line saying the user undid it; other steps get none", () => {
    const entries: ChatEntry[] = [
      user("edit"),
      answer("call"),
      undoneStep("edit_file: replaced the passage in a.ts.", "edit_file"),
      answer("call"),
      step("edit_file: replaced the passage in b.ts.", "edit_file"),
      answer("Done."),
    ];
    const { messages } = toHistory(entries, typed, roomy);
    expect(messages[2]?.content).toBe(
      '<tool_result tool="edit_file" status="ok">\nedit_file: replaced the passage in a.ts.\nThe user undid this change afterwards.\n</tool_result>',
    );
    expect(messages[4]?.content).toBe(wrapped("edit_file: replaced the passage in b.ts.", "edit_file"));
  });

  test("never replaces an undone step: it keeps its text while older eligible steps are left out", () => {
    const entries: ChatEntry[] = [
      user("go"),
      answer("call"),
      undoneStep(lines(100), "write_file"),
      ...fiveBigSteps.slice(1),
    ];
    // [>]: Six results of about 10,000 characters against 42,000: the undone one stays, the next two oldest go.
    const { messages, leftOut } = toHistory(entries, typed, { system: SYSTEM, contextSize: 12_000 });
    expect(messages[2]?.content).toBe(wrapped(`${lines(100)}\nThe user undid this change afterwards.`, "write_file"));
    expect(messages[4]?.content).toBe(wrapped("[result left out to save context: 100 lines]"));
    expect(messages[6]?.content).toBe(wrapped("[result left out to save context: 100 lines]"));
    expect(messages[8]?.content).toBe(wrapped(lines(100)));
    expect(leftOut).toBe(2);
    expect(fits(messages, 12_000)).toBe(true);
  });

  test("the undone line is part of what is sent, so the estimate counts it", () => {
    const base: ChatEntry[] = [user("go"), answer("call"), step("x".repeat(400), "write_file"), answer("Done.")];
    const undone: ChatEntry[] = base.map((entry, index) =>
      index === 2 ? undoneStep("x".repeat(400), "write_file") : entry,
    );
    const length = (history: { messages: { content: string }[] }) =>
      history.messages.reduce((total, message) => total + message.content.length, 0);
    expect(length(toHistory(undone, typed, roomy)) - length(toHistory(base, typed, roomy))).toBe(
      "\nThe user undid this change afterwards.".length,
    );
  });

  test("replaces a malformed-call step of several lines like another, as an error of its tag", () => {
    const entries: ChatEntry[] = [
      user("go"),
      answer("<read_file>"),
      step(lines(100), "read_file", "malformed"),
      ...fiveBigSteps.slice(3),
    ];
    const { messages, leftOut } = toHistory(entries, typed, { system: SYSTEM, contextSize: 12_572 });
    expect(leftOut).toBe(1);
    expect(messages[2]?.content).toBe(wrapped("[result left out to save context: 100 lines]", "read_file", "error"));
  });

  test("says 1 line for a result of one line", () => {
    const entries: ChatEntry[] = [user("go"), answer("call"), step("y".repeat(60_000)), ...fiveBigSteps.slice(1, 7)];
    const { messages } = toHistory(entries, typed, { system: SYSTEM, contextSize: 12_572 });
    expect(messages[2]?.content).toBe(wrapped("[result left out to save context: 1 line]"));
  });
});

describe("history after a summary", () => {
  const before: ChatEntry[] = [user("first"), answer("call"), step("one\ntwo"), answer("Done.")];

  test("starts at the last summary that ended done with text: the summary and the next user message as one", () => {
    const entries: ChatEntry[] = [
      ...before,
      summary("Old summary."),
      user("second"),
      answer("Fine."),
      summary("The goal is x."),
      user("third"),
      answer("call"),
      step("three"),
    ];
    expect(historyStart(entries)).toBe(7);
    expect(toHistory(entries, typed, roomy)).toEqual({
      leftOut: 0,
      messages: [
        { role: "user", content: "Summary of the conversation so far:\n\nThe goal is x.\n\nthird" },
        { role: "assistant", content: "call" },
        { role: "user", content: wrapped("three") },
      ],
    });
  });

  test("a summary followed by no user message goes alone", () => {
    const entries: ChatEntry[] = [...before, summary("The goal is x.")];
    expect(toHistory(entries, typed, roomy).messages).toEqual([
      { role: "user", content: "Summary of the conversation so far:\n\nThe goal is x." },
    ]);
  });

  test("a failed, stopped, halted, or empty summary changes nothing and is never sent", () => {
    const whole = toHistory([...before, user("second")], typed, roomy);
    for (const skipped of [
      summary("partial", "failed"),
      summary("partial", "stopped"),
      summary("", "halted"),
      summary(" \n "),
    ]) {
      const entries = [...before, skipped, user("second")];
      expect(historyStart(entries)).toBe(0);
      expect(toHistory(entries, typed, roomy)).toEqual(whole);
    }
  });

  test("a failed summary as the first entry is not sent either", () => {
    expect(toHistory([summary("x", "failed"), user("go")], typed, roomy).messages).toEqual([
      { role: "user", content: "go" },
    ]);
  });

  test("a summary that failed after a done one is skipped, the done one still starts the history", () => {
    const entries: ChatEntry[] = [...before, summary("The goal is x."), summary("", "failed"), user("second")];
    expect(toHistory(entries, typed, roomy).messages).toEqual([
      { role: "user", content: "Summary of the conversation so far:\n\nThe goal is x.\n\nsecond" },
    ]);
  });

  test("leaves out and keeps the last 3 counting only the steps after the summary", () => {
    const entries: ChatEntry[] = [...fiveBigSteps, summary("S."), ...fiveBigSteps];
    const { messages, leftOut } = toHistory(entries, typed, { system: SYSTEM, contextSize: 12_572 });
    expect(leftOut).toBe(1);
    expect(messages[2]?.content).toBe(wrapped("[result left out to save context: 100 lines]"));
    expect(messages[4]?.content).toBe(wrapped(lines(100)));
  });
});

describe("undone steps a summary replaces", () => {
  const undoneLine = (tool: string, path: string) =>
    `The user undid this change, which the summary above may still describe: ${tool} ${path}`;
  const write = (path: string, tool = "write_file"): ChatEntry =>
    ({ ...step(`${tool}: wrote ${path}.`, tool), args: { path }, undone: true }) as ChatEntry;

  test("after a /compact summary: one line per undone step before it, after the summary's text", () => {
    const entries: ChatEntry[] = [
      user("change a"),
      answer("call"),
      write("a.txt"),
      answer("call"),
      step("read", "read_file"),
      answer("call"),
      write("./a.txt", "edit_file"),
      answer("Done."),
      summary("a.txt now says new."),
      user("next"),
    ];
    expect(toHistory(entries, typed, roomy).messages).toEqual([
      {
        role: "user",
        content: `Summary of the conversation so far:\n\na.txt now says new.\n\n${undoneLine("write_file", "a.txt")}\n${undoneLine("edit_file", "./a.txt")}\n\nnext`,
      },
    ]);
  });

  test("after an automatic summary: the lines come before the turn's quoted message", () => {
    const entries: ChatEntry[] = [
      user("go"),
      answer("call 0"),
      write("a.txt"),
      summary("The goal is x."),
      answer("call 1"),
    ];
    expect(toHistory(entries, typed, roomy).messages).toEqual([
      {
        role: "user",
        content: `Summary of the conversation so far:\n\nThe goal is x.\n\n${undoneLine("write_file", "a.txt")}\n\ngo`,
      },
      { role: "assistant", content: "call 1" },
    ]);
  });

  test("a step still sent keeps its own line only, and the summary gets none for it", () => {
    const entries: ChatEntry[] = [
      user("first"),
      answer("Ok."),
      summary("S."),
      user("go"),
      answer("call"),
      write("a.txt"),
    ];
    expect(toHistory(entries, typed, roomy).messages).toEqual([
      { role: "user", content: "Summary of the conversation so far:\n\nS.\n\ngo" },
      { role: "assistant", content: "call" },
      {
        role: "user",
        content: wrapped("write_file: wrote a.txt.\nThe user undid this change afterwards.", "write_file"),
      },
    ]);
  });

  test("the summary request after an earlier summary carries the lines too", () => {
    const entries: ChatEntry[] = [user("go"), answer("call"), write("a.txt"), summary("S."), user("next")];
    const { messages } = summaryHistory(entries, typed);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toStartWith(
      `Summary of the conversation so far:\n\nS.\n\n${undoneLine("write_file", "a.txt")}\n\nnext\n\n`,
    );
  });
});

describe("history after an automatic summary", () => {
  const composed = (entry: ChatEntry & { role: "user" }) => `${entry.content}\n\n@a.ts (file, 3 lines)`;
  /** A turn that compacted before its third request: the summary is followed by the turn's next reply. */
  const turn: ChatEntry[] = [
    user("first"),
    answer("Ok."),
    user("go"),
    answer("call 0"),
    step(lines(3)),
    summary("The goal is x."),
    answer("call 1"),
    step("small"),
  ];

  test("is told from a /compact summary by the reply that follows it", () => {
    expect(isAutomaticSummary(turn[5]!, turn[6])).toBe(true);
    expect(isAutomaticSummary(summary("S."), user("next"))).toBe(false);
    expect(isAutomaticSummary(summary("S."), undefined)).toBe(false);
    expect(isAutomaticSummary(summary("S."), summary("T."))).toBe(false);
    expect(isAutomaticSummary(answer("A."), answer("B."))).toBe(false);
  });

  test("quotes the turn's message as composed when sent after the summary, then the entries after it", () => {
    expect(toHistory(turn, composed, roomy).messages).toEqual([
      { role: "user", content: "Summary of the conversation so far:\n\nThe goal is x.\n\ngo\n\n@a.ts (file, 3 lines)" },
      { role: "assistant", content: "call 1" },
      { role: "user", content: wrapped("small") },
    ]);
  });

  test("a second automatic summary of the same turn quotes the same message", () => {
    const again: ChatEntry[] = [...turn, summary("Still x."), answer("call 2")];
    expect(toHistory(again, typed, roomy).messages).toEqual([
      { role: "user", content: "Summary of the conversation so far:\n\nStill x.\n\ngo" },
      { role: "assistant", content: "call 2" },
    ]);
  });

  test("the entries sent hold the quoted message, then the entries from the summary on", () => {
    expect(sentEntries(turn)).toEqual([turn[2]!, ...turn.slice(5)]);
    const manual: ChatEntry[] = [user("first"), answer("Ok."), summary("S."), user("next")];
    expect(sentEntries(manual)).toEqual(manual.slice(2));
  });

  test("an empty conversation sends no entry", () => {
    expect(sentEntries([])).toEqual([]);
  });
});

describe("summaryHistory", () => {
  test("leaves out every eligible result, the last 3 included, keeps load_skill and short results, and asks last", () => {
    const entries: ChatEntry[] = [
      user("go"),
      answer("call"),
      step(lines(2), "load_skill"),
      answer("call"),
      step("ok"),
      answer("call"),
      step(lines(3)),
      answer("Done."),
    ];
    const { messages, leftOut } = summaryHistory(entries, typed);
    expect(leftOut).toBe(1);
    expect(messages.slice(0, -1)).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "call" },
      { role: "user", content: wrapped(lines(2), "load_skill") },
      { role: "assistant", content: "call" },
      { role: "user", content: wrapped("ok") },
      { role: "assistant", content: "call" },
      { role: "user", content: wrapped("[result left out to save context: 3 lines]") },
      { role: "assistant", content: "Done." },
    ]);
    const last = messages.at(-1);
    expect(last?.role).toBe("user");
    for (const kept of ["goal", "decisions", "files", "remains to do"]) expect(last?.content).toContain(kept);
  });

  test("keeps an undone step whole, with its undone line", () => {
    const entries: ChatEntry[] = [user("go"), answer("call"), undoneStep(lines(3), "write_file")];
    const { messages, leftOut } = summaryHistory(entries, typed);
    expect(leftOut).toBe(0);
    expect(messages[2]?.content).toStartWith(
      wrapped(`${lines(3)}\nThe user undid this change afterwards.`, "write_file"),
    );
  });

  test("joins the request for a summary to a history that ends with a user message", () => {
    const { messages } = summaryHistory([user("go"), answer("call"), step(lines(3))], typed);
    expect(messages).toHaveLength(3);
    expect(messages[2]?.content.startsWith(`${wrapped("[result left out to save context: 3 lines]")}\n\n`)).toBe(true);
  });

  test("starts at the last done summary, like the history of a request", () => {
    const { messages } = summaryHistory([...fiveBigSteps, summary("S."), user("next"), answer("Ok.")], typed);
    expect(messages.slice(0, 2)).toEqual([
      { role: "user", content: "Summary of the conversation so far:\n\nS.\n\nnext" },
      { role: "assistant", content: "Ok." },
    ]);
    expect(messages).toHaveLength(3);
  });
});

describe("user messages in a row", () => {
  const afterStep = wrapped("r");
  const joined: ChatMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: "call" },
    { role: "user", content: `${afterStep}\n\nnext` },
  ];
  /** True when no two messages in a row have the role `user`. */
  const alternates = (messages: { role: string }[]) =>
    messages.every((message, index) => index === 0 || message.role !== "user" || messages[index - 1]?.role !== "user");

  test("a user message after a tool step joins the result after a blank line", () => {
    const { messages } = toHistory([user("go"), answer("call"), step("r"), user("next")], typed, roomy);
    expect(messages).toEqual(joined);
  });

  test("a user message after a reply left out joins the user message or tool result before it", () => {
    expect(toHistory([user("A"), empty("stopped"), user("B")], typed, roomy).messages).toEqual([
      { role: "user", content: "A\n\nB" },
    ]);
    const afterFailed = [user("go"), answer("call"), step("r"), empty("failed"), user("next")];
    expect(toHistory(afterFailed, typed, roomy).messages).toEqual(joined);
  });

  test("a left-out result replaces only the result inside its wrapper, never the user text joined to it", () => {
    const entries: ChatEntry[] = [user("go"), answer("call"), step(lines(100)), user("next"), ...fiveBigSteps.slice(1)];
    // [>]: Threshold 13,125 tokens (52,500 characters): about 60,000 in all, one result out brings it to about 50,000.
    const { messages, leftOut } = toHistory(entries, typed, { system: SYSTEM, contextSize: 15_000 });
    expect(leftOut).toBe(1);
    expect(messages[2]).toEqual({
      role: "user",
      content: `${wrapped("[result left out to save context: 100 lines]")}\n\nnext`,
    });
    expect(messages[4]?.content).toBe(wrapped(lines(100)));
    expect(fits(messages, 15_000)).toBe(true);
  });

  test("the estimate counts the blank line of a join", () => {
    const entries: ChatEntry[] = [
      user("go"),
      answer("call"),
      step(lines(100)),
      user("next"),
      ...[0, 1, 2].flatMap(() => [answer("call"), step("ok")]),
      answer("Done."),
    ];
    // [>]: 10,171 characters without the join's 2 (2,543 tokens), 10,173 with them (2,544); the threshold of 2,907 is
    // 2,543 tokens, so the request fits only when the join is not counted.
    const { messages, leftOut } = toHistory(entries, typed, { system: SYSTEM, contextSize: 2_907 });
    expect(leftOut).toBe(1);
    expect(messages[2]?.content).toBe(`${wrapped("[result left out to save context: 100 lines]")}\n\nnext`);
  });

  test("summaryHistory joins the user message and the request for a summary to the left-out result", () => {
    const { messages, leftOut } = summaryHistory([user("go"), answer("call"), step(lines(3)), user("next")], typed);
    expect(leftOut).toBe(1);
    expect(messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "call" },
      {
        role: "user",
        content: `${wrapped("[result left out to save context: 3 lines]")}\n\nnext\n\n${SUMMARY_REQUEST}`,
      },
    ]);
  });

  const halted = (reason: "stepLimit" | "malformedCalls"): ChatEntry[] => [
    user("go"),
    answer("call"),
    step("r", "read_file", reason === "stepLimit" ? "ok" : "malformed"),
    user("next"),
  ];
  const shapes: [string, ChatEntry[]][] = [
    ["after a stepLimit halt", halted("stepLimit")],
    ["after a malformedCalls halt", halted("malformedCalls")],
    ["after an empty failed reply", [user("go"), empty("failed"), user("next")]],
    [
      "after a failed automatic summary that followed a tool step",
      [user("go"), answer("call"), step("r"), summary("", "failed"), user("next")],
    ],
    [
      "after a /compact summary and a turn that ended on a tool step",
      [...fiveBigSteps, summary("S."), user("then"), answer("call"), step("r"), user("next")],
    ],
  ];
  for (const [name, entries] of shapes) {
    test(`no two user messages in a row ${name}`, () => {
      expect(alternates(toHistory(entries, typed, roomy).messages)).toBe(true);
      expect(alternates(summaryHistory(entries, typed).messages)).toBe(true);
    });
  }
});

describe("resultLineCount", () => {
  test("counts the lines a step row shows: a trailing line break dropped, 0 for an empty text", () => {
    expect(resultLineCount("")).toBe(0);
    expect(resultLineCount("one")).toBe(1);
    expect(resultLineCount("one\n")).toBe(1);
    expect(resultLineCount("one\ntwo")).toBe(2);
    expect(resultLineCount("one\n\n")).toBe(2);
  });
});
