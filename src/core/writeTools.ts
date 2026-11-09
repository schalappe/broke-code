/**
 * @module writeTools
 * The write tools of the harness, `write_file` and `edit_file`. Each turns one parsed body tool call into a planned
 * change, checked against the workspace boundary and the file as it stands, and never writes: an applier the host
 * passes writes it. `fileApplier` writes straight to disk, for the tests and the eval; the extension does not list
 * these tools until its applier asks the user first. Model-facing text is English and never localized.
 */
import { accessFailureReason } from "./mentions";
import type { ToolSpec } from "./toolCalls";
import { displayPath, excerpt, stopped, type ToolCall, type ToolResult } from "./tools";
import {
  locateWriteTarget,
  type UnwritableText,
  unwritableText,
  type WorkspaceRoot,
  type WriteFailure,
  type WriteOutcome,
  writeWorkspaceFile,
} from "./workspaceFiles";

/**
 * A change a write tool asks for. `path`: as the model wrote it, for messages. `target`: the absolute path that passed
 * the boundary check. `before`: the file's whole text when planned, `undefined` for a new file. `after`: its whole
 * text once the change is applied.
 */
export type PlannedChange = {
  tool: "write_file" | "edit_file";
  path: string;
  target: string;
  before: string | undefined;
  after: string;
};

/** Applies a planned change, or declines it, and says what happened as the tool's result. Must not reject. */
export type ChangeApplier = (change: PlannedChange) => Promise<ToolResult>;

/** The write tools as the model sees them: for the system prompt and the body tool call parser. */
export const WRITE_TOOLS: ToolSpec[] = [
  {
    name: "write_file",
    description:
      "Create a file of the workspace, or replace a whole file. Missing folders are created. The file becomes exactly the content given, followed by one line break, so give the complete new text. Binary files and files over 1 MiB are refused. To change part of a file, use edit_file.",
    args: [
      { name: "path", required: true, description: "Path of the file, relative to the workspace folder." },
      { name: "content", required: true, description: "The whole new content of the file, as raw text." },
    ],
  },
  {
    name: "edit_file",
    description:
      "Replace one exact passage of a workspace file. The passage must appear exactly once, matched character for character, spaces, indentation, and line breaks included; otherwise nothing changes and the result says why. Read the file first. Binary files and files over 1 MiB are refused.",
    args: [
      { name: "path", required: true, description: "Path of the file, relative to the workspace folder." },
      {
        name: "old",
        required: true,
        description: "The exact passage to replace, copied from the file, with enough lines around it to appear once.",
      },
      { name: "new", required: true, description: "The text that replaces the passage." },
    ],
  },
];

/**
 * Run write tool `call` inside `roots`: plan the change, then hand it to `apply`. Never rejects: an unknown tool, a
 * refused path or passage, and a failed write all come back as an `error` result for the model; the file is left as
 * it was (`fileApplier` writes atomically). `signal` (Stop) before the change is handed over gives the stopped error,
 * and nothing is written.
 */
export async function runWriteTool(
  call: ToolCall,
  roots: WorkspaceRoot[],
  apply: ChangeApplier,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!WRITE_TOOLS.some((tool) => tool.name === call.name)) {
    return { status: "error", text: `${excerpt(call.name)} is not a write tool.` };
  }
  if (signal.aborted) return stopped(call.name);
  if (roots.length === 0) return { status: "error", text: `${call.name}: no workspace folder is open.` };
  const planned = await planChange(call, roots);
  if ("status" in planned) return planned;
  if (signal.aborted) return stopped(call.name);
  return apply(planned);
}

/** The change `call` asks for, or the error result saying why it cannot be made. */
async function planChange(call: ToolCall, roots: WorkspaceRoot[]): Promise<PlannedChange | ToolResult> {
  const tool = call.name === "write_file" ? "write_file" : "edit_file";
  const path = call.args.path ?? "";
  const target = await locateWriteTarget(roots, path);
  if (target.status !== "ok") return refused(tool, path, target.status, "cause" in target ? target.cause : undefined);

  let after: string;
  if (tool === "write_file") {
    // [>]: The parser drops the line break written before the closing tag, and a text file ends with one.
    const content = call.args.content ?? "";
    after = content === "" ? "" : `${content}\n`;
  } else {
    if (target.before === undefined) return refused(tool, path, "missing");
    const replaced = replaceOnce(target.before, call.args.old ?? "", call.args.new ?? "", path);
    if (typeof replaced !== "string") return replaced;
    after = replaced;
  }
  const unwritable = unwritableText(after);
  if (unwritable !== undefined) return unwritableResult(tool, path, unwritable);
  return { tool, path, target: target.path, before: target.before, after };
}

/** `text` with the one occurrence of `old` replaced by `replacement`, compared exactly, or the error result. */
function replaceOnce(text: string, old: string, replacement: string, path: string): string | ToolResult {
  if (old === "")
    return { status: "error", text: "edit_file: the passage to replace is empty. Copy it from the file." };
  // [>]: Overlapping matches count: "aa" in "aaa" has two places to go, so it must not be guessed.
  let count = 0;
  for (let index = text.indexOf(old); index !== -1; index = text.indexOf(old, index + 1)) count++;
  if (count === 0) return { status: "error", text: `edit_file: the passage was not found in ${excerpt(path)}.` };
  if (count > 1) {
    const text = `edit_file: the passage appears ${count} times in ${excerpt(path)}; include more context so it matches once.`;
    return { status: "error", text };
  }
  const index = text.indexOf(old);
  return text.slice(0, index) + replacement + text.slice(index + old.length);
}

/**
 * The applier that writes each change to disk at once, checked again first: for the tests and the eval, which
 * approve every change. A file that no longer holds the planned text is left alone; a failed write leaves the file as
 * it was (see `writeWorkspaceFile`).
 */
export function fileApplier(roots: WorkspaceRoot[]): ChangeApplier {
  return async (change) => {
    const outcome = await writeWorkspaceFile(roots, change.target, change.before, change.after);
    const result = describeOutcome(change, outcome);
    if (outcome.leftover === undefined) return result;
    const { name, cause } = outcome.leftover;
    return { ...result, text: `${result.text} The temporary file ${excerpt(name)} could not be removed (${cause}).` };
  };
}

function describeOutcome(change: PlannedChange, outcome: WriteOutcome): ToolResult {
  const shown = displayPath(change.path);
  switch (outcome.status) {
    case "written":
      if (change.tool === "edit_file") return { status: "ok", text: `edit_file: replaced the passage in ${shown}.` };
      return { status: "ok", text: `write_file: ${change.before === undefined ? "created" : "replaced"} ${shown}.` };
    case "alreadyWritten":
      return { status: "ok", text: `${change.tool}: ${shown} already holds this change.` };
    case "changed":
      return {
        status: "error",
        text: `${change.tool}: ${excerpt(change.path)}: the file changed since this change was planned. Read it again.`,
      };
    case "notWritten":
      return {
        status: "error",
        text: `${change.tool}: ${excerpt(change.path)}: the file was not written (${outcome.cause}).`,
      };
    case "unwritable":
      return unwritableResult(change.tool, change.path, outcome.reason);
    default:
      return refused(change.tool, change.path, outcome.status, "cause" in outcome ? outcome.cause : undefined);
  }
}

/** New text the file could not read back as written; over 1 MiB keeps the read tools' wording. */
function unwritableResult(tool: string, path: string, reason: UnwritableText): ToolResult {
  if (reason === "tooLarge") return refused(tool, path, "tooLarge");
  const why =
    reason === "binary"
      ? "the new text holds a NUL character in its first 8 KiB, so the file would read as binary"
      : "the new text holds an unpaired UTF-16 surrogate, which UTF-8 cannot encode";
  return { status: "error", text: `${tool}: ${excerpt(path)}: ${why}. Nothing was written; remove that character.` };
}

/** A refused path, in the read tools' wording for the failures they share. */
function refused(tool: string, path: string, failure: WriteFailure, cause?: string): ToolResult {
  return { status: "error", text: `${tool}: ${excerpt(path)}: ${writeFailureReason(failure, cause)}.` };
}

function writeFailureReason(failure: WriteFailure, cause?: string): string {
  switch (failure) {
    case "symlink":
      return "the path is a symbolic link; write to the file it points to instead";
    case "folder":
      return "the path is a folder";
    case "notText":
      return "the file is not UTF-8 text";
    default:
      return accessFailureReason(failure, cause);
  }
}
