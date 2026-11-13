import { describe, expect, test } from "bun:test";
import { type AnswerRequest, askUser, type QuestionAnswer } from "./askUser";
import type { ToolCall } from "./tools";

function answering(answer: QuestionAnswer, signal = new AbortController().signal) {
  const asked: AnswerRequest[] = [];
  return {
    asked,
    context: {
      signal,
      requestAnswer: async (request: AnswerRequest) => {
        asked.push(request);
        return answer;
      },
    },
  };
}

function call(question: string, options?: string): ToolCall {
  const args: Record<string, string> = { question };
  if (options !== undefined) args.options = options;
  return { name: "ask_user", args };
}

describe("askUser", () => {
  test("asks once, trimmed, and returns the user's answer", async () => {
    const { asked, context } = answering({ kind: "answer", text: "src/a.ts" });
    const result = await askUser(call("\n  Which file?\nBoth define it.  \n", "src/a.ts\nsrc/b.ts"), context);
    expect(result).toEqual({ status: "ok", text: "The user answered: src/a.ts" });
    expect(asked).toEqual([{ question: "Which file?\nBoth define it.", options: ["src/a.ts", "src/b.ts"] }]);
  });

  test("asks with no options when the call gives none", async () => {
    const { asked, context } = answering({ kind: "answer", text: "yes" });
    await askUser(call("Go on?"), context);
    expect(asked).toEqual([{ question: "Go on?", options: [] }]);
  });

  test("refuses an empty question, asking nothing", async () => {
    const { asked, context } = answering({ kind: "answer", text: "x" });
    expect(await askUser(call(" \n\t "), context)).toEqual({
      status: "error",
      text: "ask_user: the question is empty.",
    });
    expect(asked).toEqual([]);
  });

  test("refuses a question over 2,000 characters, asking nothing; 2,000 is accepted", async () => {
    const { asked, context } = answering({ kind: "answer", text: "x" });
    expect(await askUser(call("q".repeat(2001)), context)).toEqual({
      status: "error",
      text: "ask_user: the question is longer than 2,000 characters. Ask a shorter one.",
    });
    expect(asked).toEqual([]);
    expect((await askUser(call(` ${"q".repeat(2000)} `), context)).status).toBe("ok");
  });

  test("refuses 7 options, asking nothing", async () => {
    const { asked, context } = answering({ kind: "answer", text: "x" });
    expect(await askUser(call("Which?", "1\n2\n3\n4\n5\n6\n7"), context)).toEqual({
      status: "error",
      text: "ask_user: 7 options given; give at most 6.",
    });
    expect(asked).toEqual([]);
  });

  test("accepts 6 options with blank lines between them, dropped", async () => {
    const { asked, context } = answering({ kind: "answer", text: "x" });
    await askUser(call("Which?", "\n 1 \n\n2\n  \n3\n4\n\n5\n6\n"), context);
    expect(asked[0]?.options).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  test("accepts 7 lines of which two are equal as 6 options, the first kept", async () => {
    const { asked, context } = answering({ kind: "answer", text: "x" });
    await askUser(call("Which?", "a\nb\nc\n a \nd\ne\nf"), context);
    expect(asked[0]?.options).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("refuses an option of 201 characters, asking nothing; 200 is accepted", async () => {
    const { asked, context } = answering({ kind: "answer", text: "x" });
    expect(await askUser(call("Which?", `a\n${"o".repeat(201)}`), context)).toEqual({
      status: "error",
      text: "ask_user: an option is longer than 200 characters. Keep each option short.",
    });
    expect(asked).toEqual([]);
    expect((await askUser(call("Which?", "o".repeat(200)), context)).status).toBe("ok");
  });

  test("gives the stopped error when the turn's signal aborts while the request waits", async () => {
    const controller = new AbortController();
    let asked = 0;
    const context = {
      signal: controller.signal,
      requestAnswer: () => {
        asked++;
        return new Promise<QuestionAnswer>(() => {});
      },
    };
    const result = askUser(call("Which?"), context);
    await Promise.resolve();
    controller.abort();
    expect(await result).toEqual({ status: "error", text: "ask_user: stopped before it finished." });
    expect(asked).toBe(1);
  });

  test("gives the stopped error when the signal aborts while the request is being made", async () => {
    const controller = new AbortController();
    const context = {
      signal: controller.signal,
      requestAnswer: () => {
        controller.abort();
        return new Promise<QuestionAnswer>(() => {});
      },
    };
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("never settled"), 200));
    expect(await Promise.race([askUser(call("Which?"), context), timeout])).toEqual({
      status: "error",
      text: "ask_user: stopped before it finished.",
    });
  });

  test("asks nothing once the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { asked, context } = answering({ kind: "answer", text: "x" }, controller.signal);
    expect(await askUser(call("Which?"), context)).toEqual({
      status: "error",
      text: "ask_user: stopped before it finished.",
    });
    expect(asked).toEqual([]);
  });

  test("a cancelled request gives the stopped error", async () => {
    const { context } = answering({ kind: "cancel" });
    expect((await askUser(call("Which?"), context)).text).toBe("ask_user: stopped before it finished.");
  });

  test("a request no one can answer gives an error result saying so", async () => {
    const { context } = answering({ kind: "unanswerable" });
    expect(await askUser(call("Which?"), context)).toEqual({
      status: "error",
      text: "No one can answer a question here.",
    });
  });

  test("a request that rejects gives an error result, never a rejection", async () => {
    const context = {
      signal: new AbortController().signal,
      requestAnswer: async (): Promise<QuestionAnswer> => {
        throw new Error("boom");
      },
    };
    expect(await askUser(call("Which?"), context)).toEqual({
      status: "error",
      text: "ask_user: the question could not be asked (Error: boom).",
    });
  });
});
