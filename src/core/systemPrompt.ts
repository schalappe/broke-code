/**
 * @module systemPrompt
 * The system prompt: the agent's role, the body tool call format and its rules, the tools, then the instruction
 * files. Composed from data only; the host reads the files. No `node:` or `vscode` import. Model-facing text is
 * English and never localized.
 */
import { describeTool, type ToolSpec } from "./toolCalls";

/** An instruction file, such as an `AGENTS.md`: `label` names it in the prompt, `text` goes in verbatim. */
export type InstructionFile = { label: string; text: string };

// [>]: Short plain sentences, since small open models read it. The format shows as raw lines, never in a code
// fence, which would teach the model to fence its calls, and a fenced call never runs.
const ROLE =
  "You are a coding agent working in the user's workspace. You read and change files and run commands with the tools below.";

const FORMAT = [
  "# Tool calls",
  "",
  "To use a tool, write a tool call in your reply: a tag named after the tool, holding one tag per argument. Write each value as raw text, with no escaping. Start the call at the beginning of a line. For example:",
  "",
  "<tool_name>",
  "<argument_name>value</argument_name>",
  "</tool_name>",
].join("\n");

const RULES = [
  "# Rules",
  "",
  "- Write at most one tool call per reply.",
  "- After the call, stop writing and wait for its result. It comes in the next message.",
  "- When the task is done, answer without a tool call.",
  "- Paths are relative to the workspace folder.",
  "- Never wrap a tool call in a code fence or inline code: it would not run.",
].join("\n");

/** The system prompt for `tools` and the `instructions` files, in order. Without files, it ends after the tools. */
export function composeSystemPrompt(tools: readonly ToolSpec[], instructions: readonly InstructionFile[]): string {
  const toolList = [
    "# Tools",
    ...tools.map((tool) => `## ${tool.name}\n\n${tool.description}\n\n${describeTool(tool)}`),
  ];
  const files = instructions.map((file) => `# Instructions from ${file.label}\n\n${file.text}`);
  return [ROLE, FORMAT, RULES, ...toolList, ...files].join("\n\n");
}
