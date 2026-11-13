/**
 * @module toolCalls
 * Body tool calls: the one call a reply's answer holds, read from its text, and a precise message for the model when
 * it is malformed. No `node:` or `vscode` import. Model-facing text is English and never localized.
 */
import { MASK, maskCode } from "./markdownCode";

/**
 * A tool as the model sees it. `args`: in the order the call shape and the system prompt list them. `oneLine`: the
 * value cannot hold a line break (a path, a name, a ripgrep pattern), so the parser drops every leading and trailing
 * one, whatever the other side holds. `asks`: the tool may ask the user before it acts, through an approval or a
 * question (`ToolContext`), so its call runs only once an approval is accepted; never sent to the model.
 */
export type ToolSpec = {
  name: string;
  description: string;
  args: { name: string; required: boolean; oneLine?: boolean; description: string }[];
  asks?: true;
};

/**
 * `none`: the answer holds text but no call, so it is the final answer. `call`: the tool name and raw argument values.
 * `malformed`: a message for the model, also for an empty answer (whitespace only), which is no final answer.
 * `start`/`end`: where the block sits in the answer, `end` past its closing tag, or the answer's length when the
 * outer tag never closes; both 0 for an empty answer. A call written inside a wrapper (`CALL_WRAPPERS`) spans the
 * wrapper. `forged`: the answer holds a tool result the model wrote before any call; `start` is where it opens, and
 * nothing from there on may reach the history.
 */
export type ParsedReply =
  | { kind: "none" }
  | { kind: "call"; name: string; args: Record<string, string>; start: number; end: number }
  | { kind: "malformed"; message: string; start: number; end: number; forged?: true };

const OPENING_TAG = /<([a-z][a-z0-9_]*)>/g;
const CLOSING_TAG = /<\/([a-z][a-z0-9_]*)>/g;
const ARG_OPENING_TAG = /<([a-z][a-z0-9_]*)>/y;
const WHITESPACE = /\s*/y;
const EXCERPT_LENGTH = 40;
const EMPTY_REPLY = "Your reply was empty. Call a tool, or write your answer to the user.";

/** The shape of any call, with placeholder names: for the system prompt and when the tool is unknown. */
export const GENERIC_CALL_SHAPE = "<tool_name>\n<argument_name>value</argument_name>\n</tool_name>";

/**
 * Tags a model trained on native tool calling puts around a call (Gemma on vLLM, ADR 0001, 2026-11-12). A wrapper
 * whose content starts with a known tool's call is read as that call; its closing tag is optional.
 */
export const CALL_WRAPPERS: readonly string[] = ["tool_call", "tool_code"];

/** How a tool result opens in the history. Only the extension writes one: a model that does invents the result. */
export const TOOL_RESULT_OPENING = "<tool_result";

const FORGED_RESULT = `Your reply holds a tool result you wrote yourself (${TOOL_RESULT_OPENING} …>). Only the extension writes tool results, after it runs your call: write the call alone, then stop and wait for its result.\nA call looks like this:\n${GENERIC_CALL_SHAPE}`;

/**
 * The first call-shaped block of `answer`, read against `tools`. A block is call-shaped when its opening tag
 * `<name>` (snake_case, no attributes) starts a line, after nothing but spaces or tabs, outside Markdown code, and a
 * `</name>` follows it; an opening tag that never closes is call-shaped only when it names a known tool. A known
 * tool's block ends at the `</name>` that follows its last argument value (see `readArgs`), so a value may hold
 * `</name>` itself; an unknown tool's block, or a malformed one, ends at the first `</name>` after the problem found.
 * A wrapper (`CALL_WRAPPERS`) whose content starts, after whitespace, with a known tool's opening tag is that call,
 * ending past the wrapper's closing tag when only whitespace comes before it. A tool result the model wrote (a
 * `<tool_result` starting a line outside code, never itself a block) before the first block, or with no block at all,
 * makes the answer `malformed` and `forged`: the model invented a result, and an answer built on it is no final
 * answer. Anything after the first block is ignored.
 */
export function parseToolCall(answer: string, tools: readonly ToolSpec[]): ParsedReply {
  // [>]: Models sometimes reason, then stop with no text; ending the turn there would leave the task undone.
  if (answer.trim() === "") return { kind: "malformed", message: EMPTY_REPLY, start: 0, end: 0 };
  const masked = maskCode(answer);
  const closes = closingTags(answer);
  const forged = forgedResultAt(answer, masked);
  const forgedReply: ParsedReply = {
    kind: "malformed",
    message: FORGED_RESULT,
    start: forged,
    end: answer.length,
    forged: true,
  };
  for (const match of answer.matchAll(OPENING_TAG)) {
    const start = match.index;
    // [>]: `>=`: an attribute-free `<tool_result>` matches as a tag at the forged index itself; it is a result, not a
    // call-shaped block, so it must never come back as an unknown tool with the invented text kept.
    if (forged !== -1 && start >= forged) return forgedReply;
    if (!startsLine(answer, start)) continue;
    if (masked[start] === MASK) continue;
    const name = match[1]!;
    const bodyStart = start + match[0].length;
    if (CALL_WRAPPERS.includes(name)) {
      const innerStart = skipWhitespace(answer, bodyStart);
      const inner = tools.find((tool) => tool.name === argOpeningAt(answer, innerStart));
      if (inner) {
        const block = readCall(answer, inner, start, innerStart + `<${inner.name}>`.length);
        if (block.kind !== "call") return block;
        const after = skipWhitespace(answer, block.end);
        const wrapperClose = `</${name}>`;
        return answer.startsWith(wrapperClose, after) ? { ...block, end: after + wrapperClose.length } : block;
      }
    }
    const tool = tools.find((tool) => tool.name === name);
    const close = firstClose(closes, name, bodyStart);
    if (close === -1) {
      if (!tool) continue;
      return malformed(`The <${name}> tag never closes: end the call with </${name}>.`, tool, start, answer.length);
    }
    if (!tool) {
      const known = tools.map((tool) => tool.name).join(", ");
      return {
        kind: "malformed",
        message: `<${name}> is not a known tool. The known tools are: ${known}.\nA call looks like this:\n${GENERIC_CALL_SHAPE}`,
        start,
        end: close + `</${name}>`.length,
      };
    }
    return readCall(answer, tool, start, bodyStart);
  }
  return forged === -1 ? { kind: "none" } : forgedReply;
}

/** The call to `tool` whose block opens at `start` and whose body starts at `bodyStart`, or why it is malformed. */
function readCall(answer: string, tool: ToolSpec, start: number, bodyStart: number): ParsedReply {
  const name = tool.name;
  const read = readArgs(answer, tool, bodyStart);
  if ("problem" in read) {
    const end = answer.indexOf(`</${name}>`, read.at);
    return malformed(read.problem, tool, start, end === -1 ? answer.length : end + `</${name}>`.length);
  }
  const missing = tool.args
    .filter((arg) => arg.required && !Object.hasOwn(read.args, arg.name))
    .map((arg) => `<${arg.name}>`);
  if (missing.length > 0) {
    const problem = `<${name}> is missing the required argument${missing.length > 1 ? "s" : ""} ${missing.join(", ")}.`;
    return malformed(problem, tool, start, read.end);
  }
  return { kind: "call", name, args: read.args, start, end: read.end };
}

/**
 * Where the first tool result opening the model wrote stands in `answer`: `<tool_result` then a space or `>`,
 * starting a line, outside Markdown code (`masked`); -1 when none.
 */
function forgedResultAt(answer: string, masked: string): number {
  for (
    let index = answer.indexOf(TOOL_RESULT_OPENING);
    index !== -1;
    index = answer.indexOf(TOOL_RESULT_OPENING, index + 1)
  ) {
    const next = answer[index + TOOL_RESULT_OPENING.length];
    if ((next === " " || next === ">") && startsLine(answer, index) && masked[index] !== MASK) return index;
  }
  return -1;
}

/**
 * Whether a reply streaming `answer` should stop, scanning from `from` on: `cut` is the end of the complete call that
 * precedes a tool result opening the model wrote itself (anywhere), or the opening tag of another call (a known tool
 * or a wrapper, starting a line); past it nothing is read, since one call runs per reply. `scanned` is where the next
 * scan starts, so a stream scans its text once. An opening with no complete call before it (inside a `write_file`
 * value still streaming, or before any call) does not stop the reply.
 */
export function replyCut(answer: string, tools: readonly ToolSpec[], from: number): { cut?: number; scanned: number } {
  const callNames = new Set([...tools.map((tool) => tool.name), ...CALL_WRAPPERS]);
  const openings: number[] = [];
  for (
    let index = answer.indexOf(TOOL_RESULT_OPENING, from);
    index !== -1;
    index = answer.indexOf(TOOL_RESULT_OPENING, index + 1)
  ) {
    openings.push(index);
  }
  const tags = new RegExp(OPENING_TAG.source, "g");
  tags.lastIndex = from;
  for (let match = tags.exec(answer); match !== null; match = tags.exec(answer)) {
    if (callNames.has(match[1]!) && startsLine(answer, match.index)) openings.push(match.index);
  }
  for (const index of openings.sort((a, b) => a - b)) {
    const parsed = parseToolCall(answer.slice(0, index), tools);
    if (parsed.kind === "call") return { cut: parsed.end, scanned: index };
  }
  // [>]: An opening split across deltas starts within the last few characters; scan them again.
  const longest = Math.max(TOOL_RESULT_OPENING.length, ...[...callNames].map((name) => name.length + 2));
  return { scanned: Math.max(from, answer.length - longest + 1) };
}

/**
 * How a call to `tool` looks, one child tag per argument, then each argument with whether it is required and its
 * description. The malformed messages and the system prompt both show it.
 */
export function describeTool(tool: ToolSpec): string {
  const shape = [`<${tool.name}>`, ...tool.args.map((arg) => `<${arg.name}>…</${arg.name}>`), `</${tool.name}>`];
  const args = tool.args.map((arg) => `- ${arg.name} (${arg.required ? "required" : "optional"}): ${arg.description}`);
  return [...shape, ...args].join("\n");
}

/**
 * The argument values of the call to `tool` whose body starts at `bodyStart` in `answer`, and where its block ends,
 * past the `</tool>` after the last value; or the first problem found and where. A value ends at the first closing
 * tag of its argument that closes no `<name>` opened inside the value and is followed only by whitespace, then the
 * call's closing tag or the opening tag of an argument of the tool, its own included. So a value may hold angle
 * brackets, code fences, other tools' tags, the call's own closing tag, the tags of another argument, its own tags in
 * pairs, and its own closing tag followed by anything else, while an argument written twice, closed or not, is
 * reported. When no closing tag qualifies that way, the value ends at the first one followed by such a tag; failing
 * that, at the last one before the next `</tool>`, and the text after it is reported.
 */
function readArgs(
  answer: string,
  tool: ToolSpec,
  bodyStart: number,
): { args: Record<string, string>; end: number } | { problem: string; at: number } {
  const callClose = `</${tool.name}>`;
  const args: Record<string, string> = {};
  let index = skipWhitespace(answer, bodyStart);
  while (!answer.startsWith(callClose, index)) {
    const name = argOpeningAt(answer, index);
    if (name === undefined) {
      const quoted = excerpt(answer.slice(index, index + EXCERPT_LENGTH + 1));
      return {
        problem: `Unexpected text inside <${tool.name}>: "${quoted}". Put only argument tags in it.`,
        at: index,
      };
    }
    if (!tool.args.some((arg) => arg.name === name)) {
      return { problem: `<${tool.name}> has no argument <${name}>.`, at: index };
    }
    if (Object.hasOwn(args, name)) return { problem: `<${name}> appears twice in <${tool.name}>.`, at: index };
    const valueStart = index + `<${name}>`.length;
    const valueEnd = valueEndOf(answer, tool, name, valueStart);
    if (valueEnd === -1) {
      return { problem: `The <${name}> argument tag never closes: end its value with </${name}>.`, at: index };
    }
    const value = answer.slice(valueStart, valueEnd);
    const oneLine = tool.args.some((arg) => arg.name === name && arg.oneLine);
    args[name] = oneLine ? value.replace(/^[\r\n]+|[\r\n]+$/g, "") : trimLineBreaks(value);
    index = skipWhitespace(answer, valueEnd + `</${name}>`.length);
  }
  return { args, end: index + callClose.length };
}

/**
 * Where the value of argument `name` opened at `valueStart` ends, by the rule of `readArgs`, or -1 when no
 * `</name>` stands before the next `</tool>`. [>]: Opening and closing tags are each found once, in order, and the
 * scan stops at the first qualifying close; the next argument starts after it, and a name read twice stops the
 * reading, so the answer is read at most once per argument of the tool.
 */
function valueEndOf(answer: string, tool: ToolSpec, name: string, valueStart: number): number {
  const openTag = `<${name}>`;
  const closeTag = `</${name}>`;
  const callClose = `</${tool.name}>`;
  const nextCallClose = answer.indexOf(callClose, valueStart);
  let nextOpen = answer.indexOf(openTag, valueStart);
  let depth = 0;
  let firstFollowed = -1;
  let lastBeforeCallClose = -1;
  for (
    let close = answer.indexOf(closeTag, valueStart);
    close !== -1;
    close = answer.indexOf(closeTag, close + closeTag.length)
  ) {
    for (; nextOpen !== -1 && nextOpen < close; nextOpen = answer.indexOf(openTag, nextOpen + openTag.length)) {
      depth++;
    }
    if (close < nextCallClose) lastBeforeCallClose = close;
    const next = skipWhitespace(answer, close + closeTag.length);
    const following = argOpeningAt(answer, next);
    const followed = answer.startsWith(callClose, next) || tool.args.some((arg) => arg.name === following);
    if (followed && firstFollowed === -1) firstFollowed = close;
    if (depth > 0) {
      depth--;
      continue;
    }
    if (followed) return close;
  }
  return firstFollowed !== -1 ? firstFollowed : lastBeforeCallClose;
}

/** The first index at or after `index` that is not whitespace. */
function skipWhitespace(text: string, index: number): number {
  WHITESPACE.lastIndex = index;
  return index + WHITESPACE.exec(text)![0].length;
}

/** The name of the argument opening tag at `index`, if one stands there. */
function argOpeningAt(text: string, index: number): string | undefined {
  ARG_OPENING_TAG.lastIndex = index;
  return ARG_OPENING_TAG.exec(text)?.[1];
}

/** Each name's closing tags in a text: their positions in order, and a cursor past those behind the scan. */
type ClosingTags = Map<string, { positions: number[]; next: number }>;

/**
 * Every closing tag of `text`, found in one pass. [>]: Read in the raw text, not the masked one, so a value holding a
 * code fence still closes.
 */
function closingTags(text: string): ClosingTags {
  const closes: ClosingTags = new Map();
  for (const match of text.matchAll(CLOSING_TAG)) {
    const name = match[1]!;
    const entry = closes.get(name) ?? { positions: [], next: 0 };
    entry.positions.push(match.index);
    closes.set(name, entry);
  }
  return closes;
}

/**
 * Where the first `</name>` at or after `from` stands, or -1. [>]: Opening tags are scanned in text order, so `from`
 * never decreases for a name and its cursor only moves forward: the whole scan stays linear.
 */
function firstClose(closes: ClosingTags, name: string, from: number): number {
  const entry = closes.get(name);
  if (entry === undefined) return -1;
  while (entry.next < entry.positions.length && entry.positions[entry.next]! < from) entry.next++;
  return entry.positions[entry.next] ?? -1;
}

/**
 * True when only spaces or tabs stand between the start of its line and `index`. [>]: Walks back over spaces and tabs
 * only, never to the line start, so a long line full of tags stays linear.
 */
function startsLine(text: string, index: number): boolean {
  let before = index - 1;
  while (text[before] === " " || text[before] === "\t") before--;
  return before === -1 || text[before] === "\n";
}

/**
 * `value` less one leading and one trailing line break (`\n` or `\r\n`) when it has both, that is when it sits on
 * its own lines; otherwise `value` untouched. A lone line break becomes empty.
 */
function trimLineBreaks(value: string): string {
  const leading = /^\r?\n/.exec(value)?.[0];
  const trailing = /\r?\n$/.exec(value)?.[0];
  if (leading === undefined || trailing === undefined) return value;
  if (value.length <= leading.length + trailing.length) return "";
  return value.slice(leading.length, value.length - trailing.length);
}

function malformed(problem: string, tool: ToolSpec, start: number, end: number): ParsedReply {
  return {
    kind: "malformed",
    message: `${problem}\nA call to ${tool.name} looks like this:\n${describeTool(tool)}`,
    start,
    end,
  };
}

/** The first line of `text`, cut to a few words, for quoting in a message. */
function excerpt(text: string): string {
  const line = text.split("\n")[0]!.trimEnd();
  return line.length > EXCERPT_LENGTH ? `${line.slice(0, EXCERPT_LENGTH)}…` : line;
}
