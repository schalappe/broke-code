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
 * `none`: the answer holds no call, so it is the final answer. `call`: the tool name and raw argument values.
 * `malformed`: a message for the model. `start`/`end`: where the block sits in the answer, `end` past its closing
 * tag, or the answer's length when the outer tag never closes.
 */
export type ParsedReply =
  | { kind: "none" }
  | { kind: "call"; name: string; args: Record<string, string>; start: number; end: number }
  | { kind: "malformed"; message: string; start: number; end: number };

const OPENING_TAG = /<([a-z][a-z0-9_]*)>/g;
const ARG_OPENING_TAG = /<([a-z][a-z0-9_]*)>/y;
const WHITESPACE = /\s*/y;
const EXCERPT_LENGTH = 40;

/**
 * The first call-shaped block of `answer`, read against `tools`. A block is call-shaped when its opening tag
 * `<name>` (snake_case, no attributes) starts a line, after nothing but spaces or tabs, outside Markdown code, and a
 * `</name>` follows it; an opening tag that never closes is call-shaped only when it names a known tool. The block
 * ends at the first `</name>`. Anything after the first block is ignored.
 */
export function parseToolCall(answer: string, tools: readonly ToolSpec[]): ParsedReply {
  const masked = maskCode(answer);
  for (const match of answer.matchAll(OPENING_TAG)) {
    const start = match.index;
    if (!startsLine(answer, start)) continue;
    if (masked[start] === MASK) continue;
    const name = match[1]!;
    const tool = tools.find((tool) => tool.name === name);
    const bodyStart = start + match[0].length;
    // [>]: Searched in the raw answer, not the masked one, so a value holding a code fence still closes.
    const close = answer.indexOf(`</${name}>`, bodyStart);
    if (close === -1) {
      if (!tool) continue;
      return malformed(`The <${name}> tag never closes: end the call with </${name}>.`, tool, start, answer.length);
    }
    const end = close + `</${name}>`.length;
    if (!tool) {
      const known = tools.map((tool) => tool.name).join(", ");
      return {
        kind: "malformed",
        message: `<${name}> is not a known tool. The known tools are: ${known}.`,
        start,
        end,
      };
    }
    const read = readArgs(answer.slice(bodyStart, close), tool);
    if (typeof read === "string") return malformed(read, tool, start, end);
    const missing = tool.args
      .filter((arg) => arg.required && !Object.hasOwn(read, arg.name))
      .map((arg) => `<${arg.name}>`);
    if (missing.length > 0) {
      const problem = `<${name}> is missing the required argument${missing.length > 1 ? "s" : ""} ${missing.join(", ")}.`;
      return malformed(problem, tool, start, end);
    }
    return { kind: "call", name, args: read, start, end };
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

/** Argument values by name, or the problem to report. */
type ReadArgs = Record<string, string> | string;

/** One body being read: the reads memoized by body position, and each argument's closing tag positions. */
type ArgsReader = { body: string; tool: ToolSpec; reads: Map<number, ReadArgs>; closes: Map<string, number[]> };

/**
 * The argument values in `body`, the text between the outer tags, or the problem to report. A value ends at the
 * latest closing tag of its argument that still lets the rest of the body parse, tried from last to first, so it may
 * hold angle brackets, code fences, other tools' tags, and the tags of an earlier argument. When no closing tag
 * works, the problem reported is the one found after the last.
 */
function readArgs(body: string, tool: ToolSpec): ReadArgs {
  return readArgsFrom({ body, tool, reads: new Map(), closes: new Map() }, 0);
}

/** `readArgs` from `from` on. [>]: Memoized on the position, so repeated closing tags stay polynomial. */
function readArgsFrom(reader: ArgsReader, from: number): ReadArgs {
  let read = reader.reads.get(from);
  if (read === undefined) {
    read = readArgsAt(reader, from);
    reader.reads.set(from, read);
  }
  return read;
}

function readArgsAt(reader: ArgsReader, from: number): ReadArgs {
  const { body, tool } = reader;
  WHITESPACE.lastIndex = from;
  const index = from + WHITESPACE.exec(body)![0].length;
  if (index === body.length) return {};
  ARG_OPENING_TAG.lastIndex = index;
  const opening = ARG_OPENING_TAG.exec(body);
  if (!opening) {
    const quoted = excerpt(body.slice(index, index + EXCERPT_LENGTH + 1));
    return `Unexpected text inside <${tool.name}>: "${quoted}". Put only argument tags in it.`;
  }
  const name = opening[1]!;
  if (!tool.args.some((arg) => arg.name === name)) return `<${tool.name}> has no argument <${name}>.`;
  const valueStart = index + opening[0].length;
  const candidates = closesOf(reader, name).filter((close) => close >= valueStart);
  if (candidates.length === 0) return `The <${name}> argument tag never closes: end its value with </${name}>.`;
  let problem: string | undefined;
  for (const valueEnd of candidates.reverse()) {
    const rest = readArgsFrom(reader, valueEnd + `</${name}>`.length);
    if (typeof rest === "string") problem ??= rest;
    // [>]: A rest holding the same argument fails this close: an earlier one may still read it once.
    else if (!Object.hasOwn(rest, name)) return { [name]: trimLineBreaks(body.slice(valueStart, valueEnd)), ...rest };
  }
  // [>]: Reached only when the last close failed, which set it: after that close, `<name>` cannot close again.
  return problem!;
}

/** Where each `</name>` stands in the body, in order, found once per argument name. */
function closesOf(reader: ArgsReader, name: string): number[] {
  let closes = reader.closes.get(name);
  if (closes === undefined) {
    closes = [];
    const tag = `</${name}>`;
    for (let close = reader.body.indexOf(tag); close !== -1; close = reader.body.indexOf(tag, close + tag.length)) {
      closes.push(close);
    }
    reader.closes.set(name, closes);
  }
  return closes;
}

/** True when only spaces or tabs stand between the start of its line and `index`. */
function startsLine(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, index));
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
