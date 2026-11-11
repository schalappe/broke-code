/**
 * @module reservedMentions
 * Reserved mentions: `@<name>` tokens that name a source of the editor, never a workspace path. The table of names,
 * the mention kinds and statuses they add, and the path a menu pick inserts for a workspace entry named like one. No
 * `node:` or `vscode` import, since the webview bundle loads it.
 *
 * Adding a reserved name: append it to `RESERVED_MENTIONS`, then follow the type errors (its reader in `mentionReader`,
 * its count unit in `mentions`, its chip wording and menu description in the webview).
 */
import type { EntryKind } from "./workspaceFiles";

/** The reserved names, in the order the `@` menu lists them, before the files. */
export const RESERVED_MENTIONS = ["problems", "diff"] as const;
export type ReservedMention = (typeof RESERVED_MENTIONS)[number];

/** What a mention names: a workspace file or folder, or a reserved mention, whose kind is its name. */
export type MentionKind = EntryKind | ReservedMention;

/**
 * Statuses of a reserved mention that found nothing to attach without failing, each saying what was absent. The chip
 * is then neutral, not failed.
 */
export const NOTHING_TO_ATTACH = ["noProblems", "noChanges"] as const;
export type NothingToAttach = (typeof NOTHING_TO_ATTACH)[number];

/**
 * Statuses of a reserved mention whose source is absent or off, other than `unreadable`, which says it failed. The chip
 * shows them failed.
 */
export const SOURCE_FAILURES = ["noRepository", "gitUnavailable"] as const;
export type SourceFailure = (typeof SOURCE_FAILURES)[number];

/**
 * The reserved mention `path` names: exactly a reserved name, lowercase, as `findMentions` returns it (trailing
 * punctuation already dropped). `@Problems`, `@problems/`, and `@./problems` are paths.
 */
export function reservedMention(path: string): ReservedMention | undefined {
  return RESERVED_MENTIONS.find((name) => name === path);
}

/**
 * The path a menu pick of workspace entry `path` inserts after `@`: `./<name>` for an entry named like a reserved
 * mention, which `@<name>` would not reach; `path` otherwise.
 */
export function pickedPath(path: string): string {
  return reservedMention(path) ? `./${path}` : path;
}

/** True for a status that attached nothing without failing. */
export function isNothingToAttach(status: string): status is NothingToAttach {
  return (NOTHING_TO_ATTACH as readonly string[]).includes(status);
}

/** True for a status saying a reserved mention's source is absent or off. */
export function isSourceFailure(status: string): status is SourceFailure {
  return (SOURCE_FAILURES as readonly string[]).includes(status);
}
