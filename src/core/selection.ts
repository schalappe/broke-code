/**
 * @module selection
 * The reserved mention `@selection`: the text of the active text editor's primary selection, with its workspace path
 * and line range, from the raw selection the host reads. The workspace check, the range, and the caps live here.
 */
import { cutToMentionCaps, type ReadMention } from "./mentions";
import { workspacePath } from "./problems";
import type { WorkspaceRoot } from "./workspaceFiles";

/** A 0-based position in a document. */
export type Position = { line: number; character: number };

/**
 * The primary selection of the active text editor as VS Code holds it: the URI scheme and file system path of its
 * document, its start and end (start never after end), and its text.
 */
export type EditorSelection = { scheme: string; path: string; start: Position; end: Position; text: string };

/** Reads the active text editor's primary selection; `undefined` when no text editor is active. May reject. */
export type SelectionReader = { read(): Promise<EditorSelection | undefined> };

/**
 * `@selection` read now: the selected text, cut to the mention caps, with the document's workspace path and the
 * 1-based lines it spans, a selection ending at column 0 of a line not counting that line. `noEditor` without an
 * active text editor; `outsideWorkspace` for a document that is not a `file` inside `roots` (an untitled document, the
 * diff preview of an approval); `emptySelection` for an empty one; `unreadable` with the cause when `selection`
 * rejects. Never rejects.
 */
export async function readSelection(roots: readonly WorkspaceRoot[], selection: SelectionReader): Promise<ReadMention> {
  const base = { path: "selection", kind: "selection", content: "", omitted: 0 } as const;
  let selected: EditorSelection | undefined;
  try {
    selected = await selection.read();
  } catch (error) {
    return { ...base, status: "unreadable", cause: error instanceof Error ? error.message : String(error) };
  }
  if (!selected) return { ...base, status: "noEditor" };
  const path = selected.scheme === "file" ? workspacePath(roots, selected.path) : undefined;
  if (path === undefined) return { ...base, status: "outsideWorkspace" };
  const { start, end, text } = selected;
  if (start.line === end.line && start.character === end.character) return { ...base, status: "emptySelection" };
  const last = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
  const cut = cutToMentionCaps(text);
  return {
    ...base,
    status: cut.omitted > 0 ? "truncated" : "attached",
    lines: cut.lines,
    range: { path, start: start.line + 1, end: last + 1 },
    content: cut.text,
    omitted: cut.omitted,
  };
}
