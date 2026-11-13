/**
 * @module systemPrompt
 * The system prompt: the agent's role, in Plan mode the Plan paragraph, the body tool call format and its rules, the
 * tools, the skills listed to the model, then the instruction files; the summary request's own prompt
 * (`composeSummaryPrompt`); and the tools a send offers (`offeredTools`).
 * Composed from data only; the host reads the files. No `node:` or `vscode` import. Model-facing text is English and
 * never localized.
 */
import type { Mode } from "./protocol";
import { describeTool, GENERIC_CALL_SHAPE, type ToolSpec } from "./toolCalls";

/** An instruction file, such as an `AGENTS.md`: `label` names it in the prompt, `text` goes in verbatim. */
export type InstructionFile = { label: string; text: string };

/**
 * A discovered skill. `root`: the real path of its folder. `listedToModel`: false for `disable-model-invocation: true`,
 * a skill only the user loads, kept for the `/` menu.
 */
export type Skill = { name: string; description: string; root: string; listedToModel: boolean };

// [>]: Short plain sentences, since small open models read it. The format shows as raw lines, never in a code
// fence, which would teach the model to fence its calls, and a fenced call never runs.
const ROLE =
  "You are a coding agent working in the user's workspace. You read and change files and run commands with the tools below.";

const PLAN_ROLE = "You are a coding agent working in the user's workspace. You read files with the tools below.";

const PLAN = [
  "# Plan mode",
  "",
  "You are in Plan mode. Read what you need with the tools below. Then answer with a plan of the changes: file by file, in order. Change no file and run no command.",
].join("\n");

/** The tools a Plan turn never offers: they change files or run commands. */
export const PLAN_BLOCKED_TOOLS: readonly string[] = ["write_file", "edit_file", "run_command"];

const FORMAT = [
  "# Tool calls",
  "",
  "To use a tool, write a tool call in your reply: a tag named after the tool, holding one tag per argument. Write each value as raw text, with no escaping. Start the call at the beginning of a line. For example:",
  "",
  GENERIC_CALL_SHAPE,
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

/** Rules shown only when their tool is listed. */
const TOOL_RULES: Record<string, string> = {
  edit_file:
    "- edit_file replaces an exact passage that must appear once in the file: copy it from the file, line breaks and indentation included.",
  write_file: "- write_file replaces the whole file: give its complete content.",
  run_command:
    "- run_command runs the command with the user's shell, in the workspace folder unless cwd names another, and only once the user approves it: wait for its result. For work over a whole folder tree, such as counting or finding files in every subfolder, one command takes one step where list_files takes one per folder.",
  ask_user:
    "- When the request names one thing and several match it, such as two functions with the same name, call ask_user before any write instead of changing them all or picking one yourself; otherwise do not ask.",
  load_skill:
    "- Read a loaded skill's files with read_file, list_files, or search by the absolute path the load_skill result gives. A skill folder outside the workspace is read-only.",
};

const SKILLS_INTRO =
  "A skill holds instructions for one kind of task. When a task matches a skill's description, call load_skill with the skill's name first, then follow the instructions it returns.";

/**
 * The tools of a send: `load_skill` only while a skill is listed to the model, like the Skills section of the system
 * prompt, so a workspace without skills spends no prompt on a tool that cannot load anything; in Plan mode, none of
 * `PLAN_BLOCKED_TOOLS` either. Without a mode, or in Ask or Auto-edit, every other tool.
 */
export function offeredTools(tools: readonly ToolSpec[], skills: readonly Skill[], mode?: Mode): readonly ToolSpec[] {
  const skillListed = skills.some((skill) => skill.listedToModel);
  return tools.filter(
    (tool) =>
      (skillListed || tool.name !== "load_skill") && !(mode === "plan" && PLAN_BLOCKED_TOOLS.includes(tool.name)),
  );
}

/**
 * The system prompt for `tools`, the `skills` listed to the model, and the `instructions` files, in order. The rules of
 * `write_file`, `edit_file`, `run_command`, `ask_user`, and `load_skill` follow the general rules when those tools are
 * listed. Without a listed skill or a file, it ends after the tools. In Plan mode (`mode` `plan`) the role says the
 * agent reads files, and the Plan paragraph follows it; without a mode, or in Ask or Auto-edit, the prompt is the same,
 * byte for byte. `tools` are listed as given: `offeredTools` leaves out those of the mode.
 */
export function composeSystemPrompt(
  tools: readonly ToolSpec[],
  instructions: readonly InstructionFile[],
  skills: readonly Skill[],
  mode?: Mode,
): string {
  const toolList = [
    "# Tools",
    ...tools.map((tool) => `## ${tool.name}\n\n${tool.description}\n\n${describeTool(tool)}`),
  ];
  const files = instructionSections(instructions);
  const rules = [
    RULES,
    ...tools.flatMap((tool) => (Object.hasOwn(TOOL_RULES, tool.name) ? [TOOL_RULES[tool.name]] : [])),
  ];
  const role = mode === "plan" ? [PLAN_ROLE, PLAN] : [ROLE];
  return [...role, FORMAT, rules.join("\n"), ...toolList, ...skillSection(skills), ...files].join("\n\n");
}

const SUMMARY_ROLE = "You summarize a conversation between a user and a coding agent working in the user's workspace.";

/**
 * The system prompt of the summary request (`/compact`): its role, then the instruction files, in order. No call
 * format, rules, tools, or skills: the summary runs no tool, and the size saved matters most near a full context.
 */
export function composeSummaryPrompt(instructions: readonly InstructionFile[]): string {
  return [SUMMARY_ROLE, ...instructionSections(instructions)].join("\n\n");
}

/** One section per instruction file, labelled. */
function instructionSections(instructions: readonly InstructionFile[]): string[] {
  return instructions.map((file) => `# Instructions from ${file.label}\n\n${file.text}`);
}

/** The skills section: one line per skill listed to the model, its description on one line; none without such skill. */
function skillSection(skills: readonly Skill[]): string[] {
  const listed = skills.filter((skill) => skill.listedToModel);
  if (listed.length === 0) return [];
  const lines = listed.map((skill) => `- ${skill.name}: ${skill.description.replace(/\s+/g, " ").trim()}`);
  return [`# Skills\n\n${SKILLS_INTRO}\n\n${lines.join("\n")}`];
}
