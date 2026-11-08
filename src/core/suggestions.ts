/**
 * @module suggestions
 * Mention menu logic shared by host and webview: the `@` token at the caret, the file index entries, and their
 * filtering. No `node:` or `vscode` import, since the webview bundle loads it.
 */
import { MASK, maskCode } from "./markdownCode";
import type { EntryKind } from "./workspaceFiles";

/** `@` token ending at the caret. `start`: index of the `@`. `query`: text typed after it. */
export type MentionToken = { start: number; query: string };

/**
 * The `@` token the caret ends, if any: `@` at the start of the text or after whitespace, then non-space
 * characters up to the caret, with no non-space character right after the caret, and not inside Markdown code,
 * where a mention never counts.
 */
export function findMentionToken(text: string, caret: number): MentionToken | undefined {
  if (/\S/.test(text.charAt(caret))) return undefined;
  const match = /(?<=^|\s)@(\S*)$/.exec(text.slice(0, caret));
  if (!match || maskCode(text).charAt(match.index) === MASK) return undefined;
  return { start: match.index, query: match[1]! };
}

/** Files the menu offers, at most; past it the menu says the index is limited. */
export const MAX_INDEXED_FILES = 5000;

/** Rows the menu shows, at most. */
export const MAX_SUGGESTIONS = 20;

/** Folders never indexed, at any depth, on top of the user's `files.exclude`. */
const EXCLUDED_FOLDERS = ["node_modules", ".git", "dist", "out", "build"];

/** `findFiles` exclude glob for `EXCLUDED_FOLDERS`. */
export const INDEX_EXCLUDE_GLOB = `**/{${EXCLUDED_FOLDERS.join(",")}}/**`;

/** True for a relative path inside an excluded folder: what `INDEX_EXCLUDE_GLOB` drops. */
export function isExcludedFromIndex(path: string): boolean {
  return path
    .split("/")
    .slice(0, -1)
    .some((segment) => EXCLUDED_FOLDERS.includes(segment));
}

/** A workspace path offered by the menu: relative, a folder suffixed with `/`. */
export type Suggestion = { path: string; kind: EntryKind };

/** Each file of `files` (relative, `/`-separated) and each folder above one, once, folders first where met. */
export function indexEntries(files: string[]): Suggestion[] {
  const folders = new Set<string>();
  const entries: Suggestion[] = [];
  for (const file of files) {
    const segments = file.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const folder = `${segments.slice(0, depth).join("/")}/`;
      if (folders.has(folder)) continue;
      folders.add(folder);
      entries.push({ path: folder, kind: "folder" });
    }
    entries.push({ path: file, kind: "file" });
  }
  return entries;
}

/** First `limit` entries whose path contains `query`, ignoring case: shorter paths first, ties in code order. */
export function filterSuggestions(entries: Suggestion[], query: string, limit: number): Suggestion[] {
  const needle = query.toLowerCase();
  return entries
    .filter((entry) => entry.path.toLowerCase().includes(needle))
    .sort((a, b) => a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, limit);
}
