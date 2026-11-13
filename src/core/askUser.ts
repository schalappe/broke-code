/**
 * @module askUser
 * The `ask_user` tool: one question to the user inside a turn, and the answer back to the model. The tool checks the
 * call, then asks through the run context's question request (`ToolContext.requestAnswer`), beside the approval
 * request; who answers is the caller's business. It changes nothing, so every mode may offer it. No `node:` or
 * `vscode` import. Model-facing text is English and never localized.
 */
import type { ToolSpec } from "./toolCalls";
import { excerpt, stopped, type ToolCall, type ToolResult } from "./tools";

const TOOL = "ask_user";
const MAX_QUESTION_LENGTH = 2000;
const MAX_OPTIONS = 6;
const MAX_OPTION_LENGTH = 200;

/** The tool as the model sees it: for the system prompt and the body tool call parser. */
export const ASK_USER_TOOL: ToolSpec = {
  name: TOOL,
  description:
    "Ask the user one question and wait for the answer. Put the choices in options when there are a few. The result holds the user's answer.",
  args: [
    {
      name: "question",
      required: true,
      description: "The question, as raw text, at most 2,000 characters; it may span several lines.",
    },
    {
      name: "options",
      required: false,
      description:
        "The possible answers, one per line, at most 6 of up to 200 characters each. Leave it out for an open question.",
    },
  ],
};

/** A question as the user sees it: `question` trimmed, `options` trimmed, without blanks or repeats, maybe none. */
export type AnswerRequest = { question: string; options: string[] };

/**
 * The answer to a question request. `answer`: the text the user gave. `unanswerable`: no one can answer where the turn
 * runs. `cancel`: Stop, navigation, or deactivation ended the request.
 */
export type QuestionAnswer = { kind: "answer"; text: string } | { kind: "unanswerable" } | { kind: "cancel" };

/**
 * Run the model's `ask_user` `call`: check the question and the options, then ask once through
 * `context.requestAnswer`. Never rejects. A refused call asks nothing. An abort of `context.signal`, also while the
 * request waits, gives the stopped error without waiting for the request.
 */
export async function askUser(
  call: ToolCall,
  context: { signal: AbortSignal; requestAnswer: (request: AnswerRequest) => Promise<QuestionAnswer> },
): Promise<ToolResult> {
  if (context.signal.aborted) return stopped(TOOL);
  const request = answerRequest(call);
  if ("status" in request) return request;

  let answer: QuestionAnswer;
  try {
    answer = await untilAborted(() => context.requestAnswer(request), context.signal);
  } catch (error) {
    console.error("broke-code: could not ask a question", error);
    return { status: "error", text: `${TOOL}: the question could not be asked (${excerpt(String(error))}).` };
  }
  switch (answer.kind) {
    case "cancel":
      return stopped(TOOL);
    case "unanswerable":
      return { status: "error", text: "No one can answer a question here." };
    case "answer":
      return { status: "ok", text: `The user answered: ${answer.text}` };
  }
}

/** Checked before anything is asked, so a refused call never reaches the user. */
function answerRequest(call: ToolCall): AnswerRequest | ToolResult {
  const question = (call.args.question ?? "").trim();
  if (question === "") return { status: "error", text: `${TOOL}: the question is empty.` };
  if (question.length > MAX_QUESTION_LENGTH) {
    return { status: "error", text: `${TOOL}: the question is longer than 2,000 characters. Ask a shorter one.` };
  }
  const lines = (call.args.options ?? "").split("\n").map((line) => line.trim());
  const options = [...new Set(lines.filter((line) => line !== ""))];
  if (options.length > MAX_OPTIONS) {
    return { status: "error", text: `${TOOL}: ${options.length} options given; give at most 6.` };
  }
  if (options.some((option) => option.length > MAX_OPTION_LENGTH)) {
    return { status: "error", text: `${TOOL}: an option is longer than 200 characters. Keep each option short.` };
  }
  return { question, options };
}

/**
 * The answer of the request `start` makes, or a cancellation once `signal` aborts: a request that ignores the signal
 * never holds the turn. [!]: The listener is in place before `start` runs, so an abort fired while the request is being
 * made still cancels it.
 */
function untilAborted(start: () => Promise<QuestionAnswer>, signal: AbortSignal): Promise<QuestionAnswer> {
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ kind: "cancel" });
    signal.addEventListener("abort", onAbort, { once: true });
    let work: Promise<QuestionAnswer>;
    try {
      work = start();
    } catch (error) {
      work = Promise.reject(error);
    }
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
