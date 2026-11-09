/**
 * @module toolCalls
 * Body tool calls: the one call a reply's answer holds, read from its text, and a precise message for the model when
 * it is malformed. No `node:` or `vscode` import. Model-facing text is English and never localized.
 */
import { MASK, maskCode } from "./markdownCode";

/** A tool as the model sees it. `args`: in the order the call shape and the system prompt list them. */
export type ToolSpec = {
  name: string;
  description: string;
  args: { name: string; required: boolean; description: string }[];
};

/**
 * `none`: the answer holds text but no call, so it is the final answer. `call`: the tool name and raw argument values.
 * `malformed`: a message for the model, also for an empty answer (whitespace only), which is no final answer.
 * `start`/`end`: where the block sits in the answer, `end` past its closing tag, or the answer's length when the
 * outer tag never closes; both 0 for an empty answer.
 */
export type ParsedReply =
  | { kind: "none" }
  | { kind: "call"; name: string; args: Record<string, string>; start: number; end: number }
  | { kind: "malformed"; message: string; start: number; end: number };

const OPENING_TAG = /<([a-z][a-z0-9_]*)>/g;
const CLOSING_TAG = /<\/([a-z][a-z0-9_]*)>/g;
const ARG_OPENING_TAG = /<([a-z][a-z0-9_]*)>/y;
const WHITESPACE = /\s*/y;
const EXCERPT_LENGTH = 40;
const EMPTY_REPLY = "Your reply was empty. Call a tool, or write your answer to the user.";

/** The shape of any call, with placeholder names: for the system prompt and when the tool is unknown. */
export const GENERIC_CALL_SHAPE = "<tool_name>\n<argument_name>value</argument_name>\n</tool_name>";

/**
 * The first call-shaped block of `answer`, read against `tools`. A block is call-shaped when its opening tag
 * `<name>` (snake_case, no attributes) starts a line, after nothing but spaces or tabs, outside Markdown code, and a
 * `</name>` follows it; an opening tag that never closes is call-shaped only when it names a known tool. A known
 * tool's block ends at the `</name>` that follows its last argument value (see `readArgs`), so a value may hold
 * `</name>` itself; an unknown tool's block, or a malformed one, ends at the first `</name>` after the problem found.
 * Anything after the first block is ignored.
 */
export function parseToolCall(answer: string, tools: readonly ToolSpec[]): ParsedReply {
  // [>]: Models sometimes reason, then stop with no text; ending the turn there would leave the task undone.
  if (answer.trim() === "") return { kind: "malformed", message: EMPTY_REPLY, start: 0, end: 0 };
  const masked = maskCode(answer);
  const closes = closingTags(answer);
  for (const match of answer.matchAll(OPENING_TAG)) {
    const start = match.index;
    if (!startsLine(answer, start)) continue;
    if (masked[start] === MASK) continue;
    const name = match[1]!;
    const tool = tools.find((tool) => tool.name === name);
    const bodyStart = start + match[0].length;
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
  return { kind: "none" };
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
    args[name] = trimLineBreaks(answer.slice(valueStart, valueEnd));
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
