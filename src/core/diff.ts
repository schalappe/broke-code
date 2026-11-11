/**
 * @module diff
 * The reserved mention `@diff`: the uncommitted changes of tracked files against `HEAD`, staged and unstaged together,
 * of each workspace folder inside a git repository, from the raw diffs the host reads. The status, the multi-root
 * layout, and the caps live here.
 */
import { cutToMentionCaps, type ReadMention } from "./mentions";
import type { WorkspaceRoot } from "./workspaceFiles";

/**
 * One workspace folder's raw result. `diff`: the output of `git diff HEAD -- <folder>`, empty without changes.
 * `noRepository`: no repository holds the folder. `failed`: the diff could not be read, `cause` saying why.
 */
export type FolderDiff = { kind: "diff"; text: string } | { kind: "noRepository" } | { kind: "failed"; cause: string };

/**
 * `read`: one result per folder asked, in the same order. `gitUnavailable`: the Git extension is missing or disabled.
 */
export type DiffRead = { kind: "read"; folders: readonly FolderDiff[] } | { kind: "gitUnavailable" };

/** Reads the diff of each of `roots`. May reject. */
export type DiffReader = { read(roots: readonly WorkspaceRoot[]): Promise<DiffRead> };

/**
 * `@diff` read now: each folder's diff, led by a `# <folder name>` line in a multi-root workspace, folders with no
 * repository or no change left out, cut to the mention caps. Failing that: `unreadable` with the cause when a folder's
 * diff failed (led by its folder name in a multi-root workspace) or the reader rejects, `gitUnavailable`, `noChanges`
 * when some folder is in a repository, else `noRepository`. Never rejects.
 */
export async function readDiff(roots: readonly WorkspaceRoot[], reader: DiffReader): Promise<ReadMention> {
  const base = { path: "diff", kind: "diff", content: "", omitted: 0 } as const;
  let read: DiffRead;
  try {
    read = await reader.read(roots);
  } catch (error) {
    return { ...base, status: "unreadable", cause: error instanceof Error ? error.message : String(error) };
  }
  if (read.kind === "gitUnavailable") return { ...base, status: "gitUnavailable" };

  const multiRoot = roots.length > 1;
  const folders = roots.map((root, index) => ({ name: root.name, result: read.folders[index] }));
  // [!]: A failed folder fails the mention, even beside folders with a diff: leaving it out would pass it silently.
  const failed = folders.find((folder) => folder.result?.kind === "failed");
  if (failed?.result?.kind === "failed") {
    const cause = multiRoot ? `${failed.name}: ${failed.result.cause}` : failed.result.cause;
    return { ...base, status: "unreadable", cause };
  }
  const sections = folders.flatMap(({ name, result }) => {
    if (result?.kind !== "diff" || result.text === "") return [];
    const text = result.text.endsWith("\n") ? result.text : `${result.text}\n`;
    return [multiRoot ? `# ${name}\n${text}` : text];
  });
  if (sections.length === 0) {
    const inRepository = folders.some(({ result }) => result?.kind === "diff");
    return { ...base, status: inRepository ? "noChanges" : "noRepository" };
  }
  const cut = cutToMentionCaps(sections.join(""));
  return {
    ...base,
    status: cut.omitted > 0 ? "truncated" : "attached",
    lines: cut.lines,
    content: cut.text,
    omitted: cut.omitted,
  };
}
