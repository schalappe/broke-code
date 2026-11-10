/**
 * @module suggestions
 * Menu logic shared by host and webview: the `@` token at the caret, the file index entries, and their filtering; the
 * `/` token at the start of the message and the slash command rows. No `node:` or `vscode` import, since the webview
 * bundle loads it.
 */
import { MASK, maskMessage } from "./markdownCode";
import type { EntryKind } from "./workspaceFiles";

/** `@` token ending at the caret. `start`: index of the `@`. `query`: text typed after it. */
export type MentionToken = { start: number; query: string };

/**
 * The `@` token the caret ends, if any: `@` at the start of the text or after whitespace, then non-space
 * characters up to the caret, with no non-space character right after the caret, and not inside Markdown code,
 * where a mention never counts. Code is read with the `picked` paths set aside, as `findMentions` reads it.
 */
export function findMentionToken(
  text: string,
  caret: number,
  picked: readonly string[] = [],
): MentionToken | undefined {
  if (/\S/.test(text.charAt(caret))) return undefined;
  const match = /(?<=^|\s)@(\S*)$/.exec(text.slice(0, caret));
  if (!match || maskMessage(text, picked).masked.charAt(match.index) === MASK) return undefined;
  return { start: match.index, query: match[1]! };
}

/** `/` token ending at the caret, always at the start of the message. `query`: text typed after the `/`. */
export type SlashToken = { query: string };

/**
 * The `/` token the caret ends, if any: `/` at the very start of the text, then non-space characters up to the caret,
 * with no non-space character right after the caret. A `/` anywhere else is never a slash command, since paths hold
 * them. No code masking: a message starting with `/` starts with no code.
 */
export function findSlashToken(text: string, caret: number): SlashToken | undefined {
  if (caret < 1 || !text.startsWith("/") || /\S/.test(text.charAt(caret))) return undefined;
  const query = text.slice(1, caret);
  return /\s/.test(query) ? undefined : { query };
}

/** The slash commands the webview runs itself, in the order the menu lists them, before the skills. */
export const BUILT_IN_COMMANDS = ["new", "model"] as const;
export type BuiltInCommand = (typeof BUILT_IN_COMMANDS)[number];

/** A row of the `/` menu: a built-in command or a discovered skill, its name without the `/`. */
export type SlashCommand = { name: string; description: string };

/**
 * First `limit` of `commands` whose name starts with `query`, ignoring case, in the order given: commands are typed
 * from their first letter, unlike paths, which the `@` menu matches anywhere.
 */
export function filterSlashCommands<T extends SlashCommand>(commands: T[], query: string, limit: number): T[] {
  const prefix = query.toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().startsWith(prefix)).slice(0, limit);
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

/**
 * Each file of `files` (relative, `/`-separated) and each folder above one, once, folders first where met. A path
 * starting with one of `rootNames` (a folder name, which may hold `/`) gets no folder inside that name.
 */
export function indexEntries(files: string[], rootNames: readonly string[] = []): Suggestion[] {
  const folders = new Set<string>();
  const entries: Suggestion[] = [];
  for (const file of files) {
    const segments = file.split("/");
    const rootName = rootNames.filter((name) => file.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0];
    for (let depth = rootName ? rootName.split("/").length : 1; depth < segments.length; depth++) {
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
