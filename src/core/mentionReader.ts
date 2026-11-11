/**
 * @module mentionReader
 * The mention reader the host gives the chat controller: a reserved name goes to its source, any other path to the
 * workspace files.
 */
import { type DiffReader, readDiff } from "./diff";
import { type MentionReader, type ReadMention, readMention } from "./mentions";
import { type DiagnosticsReader, readProblems } from "./problems";
import { type ReservedMention, reservedMention } from "./reservedMentions";
import { readSelection, type SelectionReader } from "./selection";
import type { WorkspaceRoot } from "./workspaceFiles";

/** What the mentions read: the workspace folders, read at each mention, and the host source of each reserved name. */
export type MentionSources = {
  roots: () => WorkspaceRoot[];
  diagnostics: DiagnosticsReader;
  diff: DiffReader;
  selection: SelectionReader;
};

/** How each reserved mention is read. Never rejects. */
const RESERVED_READERS: Record<ReservedMention, (sources: MentionSources) => Promise<ReadMention>> = {
  problems: (sources) => readProblems(sources.roots(), sources.diagnostics),
  diff: (sources) => readDiff(sources.roots(), sources.diff),
  selection: (sources) => readSelection(sources.roots(), sources.selection),
};

/** Reads `@<path>`: exactly a reserved name reads its source; anything else, the workspace path. */
export function mentionReader(sources: MentionSources): MentionReader {
  return {
    read: (path) => {
      const reserved = reservedMention(path);
      return reserved ? RESERVED_READERS[reserved](sources) : readMention(sources.roots(), path);
    },
  };
}
