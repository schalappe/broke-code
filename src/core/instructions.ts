/**
 * @module instructions
 * The instruction files of the system prompt: `~/.agents/AGENTS.md`, then each workspace folder's `AGENTS.md`, read
 * at each send under the mention caps (1 MiB, 2,000 lines). `CLAUDE.md` and other tools' files are never read.
 */
import { join } from "node:path";
import { MAX_MENTION_LINES, truncationNotice } from "./mentions";
import type { InstructionFile } from "./systemPrompt";
import {
  readFileOutsideWorkspace,
  readWorkspaceEntry,
  truncateLines,
  type WorkspaceEntry,
  type WorkspaceRoot,
} from "./workspaceFiles";

const FILE_NAME = "AGENTS.md";

/**
 * The instruction files that exist, in prompt order: the home file, then one per workspace folder, labelled by its
 * folder name in a multi-root workspace. The home file follows symlinks (dotfiles are often linked); a workspace file
 * is held to the workspace boundary, as mentions are: inside any of the workspace folders. A missing file is left
 * out; any other failure is logged and left out. Never rejects.
 */
export async function readInstructionFiles(home: string, roots: WorkspaceRoot[]): Promise<InstructionFile[]> {
  const sources = [
    { label: `~/.agents/${FILE_NAME}`, read: () => readFileOutsideWorkspace(join(home, ".agents", FILE_NAME)) },
    ...roots.map((root) => ({
      label: roots.length > 1 ? `${root.name}/${FILE_NAME}` : FILE_NAME,
      // [>]: The absolute path names this folder's file whatever the folder names are, and the boundary check runs
      // against every workspace folder, as for mentions: a link to a file in another open folder is accepted.
      read: () => readWorkspaceEntry(roots, join(root.path, FILE_NAME)),
    })),
  ];
  const entries = await Promise.all(sources.map((source) => source.read()));
  return sources.flatMap((source, index) => {
    const text = instructionText(source.label, entries[index]!);
    return text === undefined ? [] : [{ label: source.label, text }];
  });
}

/** The prompt text of an instruction file's entry, cut to 2,000 lines; `undefined` when there is none. */
function instructionText(label: string, entry: WorkspaceEntry): string | undefined {
  if (entry.status === "missing") return undefined;
  if (entry.status !== "ok" || entry.kind !== "file") {
    const reason =
      entry.status === "ok" ? "a folder" : entry.status === "unreadable" ? `unreadable: ${entry.cause}` : entry.status;
    console.error(`broke-code: left out the instruction file ${label} (${reason})`);
    return undefined;
  }
  const cut = truncateLines(entry.text, MAX_MENTION_LINES);
  return cut.omitted > 0 ? `${cut.text}\n${truncationNotice(cut.omitted)}` : cut.text;
}
