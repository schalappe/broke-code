import { describe, expect, test } from "bun:test";
import { resultLineCount, toHistory } from "./history";
import { estimateTokens, fillsContext } from "./limits";
import type { ChatEntry, ToolStepStatus } from "./protocol";

const user = (content: string): ChatEntry => ({ role: "user", content, mentions: [] });
const answer = (content: string): ChatEntry => ({ role: "assistant", reasoning: "Plan.", content, status: "done" });
const step = (text: string, name = "read_file", status: ToolStepStatus = "ok"): ChatEntry => ({
  role: "tool",
  name,
  args: { path: "a.ts" },
  status,
  text,
});
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

describe("resultLineCount", () => {
  test("counts the lines a step row shows: a trailing line break dropped, 0 for an empty text", () => {
    expect(resultLineCount("")).toBe(0);
    expect(resultLineCount("one")).toBe(1);
    expect(resultLineCount("one\n")).toBe(1);
    expect(resultLineCount("one\ntwo")).toBe(2);
    expect(resultLineCount("one\n\n")).toBe(2);
  });
});
