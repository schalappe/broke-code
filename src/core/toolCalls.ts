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
const ARG_OPENING_TAG = /^<([a-z][a-z0-9_]*)>/;
const EXCERPT_LENGTH = 40;

/**
 * The first call-shaped block of `answer`, read against `tools`. A block is call-shaped when its opening tag
 * `<name>` (snake_case, no attributes) starts a line outside Markdown code and a `</name>` follows it; an opening
 * tag that never closes is call-shaped only when it names a known tool. Anything after the first block is ignored.
 */
export function parseToolCall(answer: string, tools: readonly ToolSpec[]): ParsedReply {
  const masked = maskCode(answer);
  for (const match of answer.matchAll(OPENING_TAG)) {
    const start = match.index;
    if (start > 0 && answer[start - 1] !== "\n") continue;
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

/**
 * The argument values in `body`, the text between the outer tags, or the first problem found. A value runs to the
 * last closing tag of its argument, so it may hold angle brackets, other tags, and code fences.
 */
function readArgs(body: string, tool: ToolSpec): Record<string, string> | string {
  const args: Record<string, string> = {};
  let index = 0;
  while (true) {
    index += /^\s*/.exec(body.slice(index))![0].length;
    if (index === body.length) return args;
    const opening = ARG_OPENING_TAG.exec(body.slice(index));
    if (!opening)
      return `Unexpected text inside <${tool.name}>: "${excerpt(body.slice(index))}". Put only argument tags in it.`;
    const name = opening[1]!;
    if (!tool.args.some((arg) => arg.name === name)) return `<${tool.name}> has no argument <${name}>.`;
    const valueStart = index + opening[0].length;
    const valueEnd = body.lastIndexOf(`</${name}>`);
    // [>]: Also catches an argument opened again after its last close, so a duplicate never reaches the result.
    if (valueEnd < valueStart) return `The <${name}> argument tag never closes: end its value with </${name}>.`;
    args[name] = trimLineBreaks(body.slice(valueStart, valueEnd));
    index = valueEnd + `</${name}>`.length;
  }
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
