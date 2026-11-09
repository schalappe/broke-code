/**
 * @module mentions
 * Mentions: `@path` tokens in a user message, read at send time, and the text the model receives for them.
 */
import { MASK, maskMessage } from "./markdownCode";
import {
  type AccessFailure,
  type EntryKind,
  type RaceSeam,
  readWorkspaceEntry,
  truncateLines,
  type WorkspaceRoot,
} from "./workspaceFiles";

/** Lines of a file, or entries of a folder, attached before the rest is cut. The read tools cut at the same count. */
export const MAX_MENTION_LINES = 2000;

/**
 * `attached`: content sent whole. `truncated`: content cut to its first lines. Any other status: nothing
 * attached; the model gets a notice instead.
 */
export type MentionStatus = "attached" | "truncated" | AccessFailure;

/** One mention as the chat shows and keeps it. `lines`: lines of a file or entries of a folder attached. */
export type MentionResult = { path: string; kind: EntryKind; status: MentionStatus; lines?: number };

/**
 * A mention read at send time. `content`: attached text, empty when nothing is attached. `omitted`: lines cut
 * by truncation. `cause`: error code or message of an `unreadable` path.
 */
export type ReadMention = MentionResult & { content: string; omitted: number; cause?: string };

/** Reads a mentioned path at send time. Must not reject. */
export type MentionReader = { read(path: string): Promise<ReadMention> };

const TRAILING_PUNCTUATION = ".,;:!?)";

/**
 * `token` less its trailing `.,;:!?)`.
 *
 * [!]: A loop, not `/[.,;:!?)]+$/`: that regex backtracks quadratically over a long punctuation run that does not end
 * the token, such as one in pasted text.
 */
function withoutTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0 && TRAILING_PUNCTUATION.includes(token[end - 1]!)) end -= 1;
  return token.slice(0, end);
}

/**
 * Paths mentioned in `text`, in order of first appearance, each once. A mention is `@` at the start of the text
 * or after whitespace, then everything up to the next whitespace, less trailing `.,;:!?)`. A `picked` path (chosen
 * in the menu, so it may hold spaces or backticks) is a mention wherever `@<path>` stands as a whole token outside
 * code; its text is then not read again as typed tokens or code. Fenced code blocks and inline code spans never hold
 * mentions.
 */
export function findMentions(text: string, picked: readonly string[] = []): string[] {
  const { masked, picked: found } = maskMessage(text, picked);
  const typed = [...masked.matchAll(/(?<=^|\s)@(\S+)/g)].map((match) => ({
    path: withoutTrailingPunctuation(match[1]!.split(MASK)[0]!),
    index: match.index,
  }));
  const mentions = [...found, ...typed.filter((mention) => mention.path !== "")];
  return [...new Set(mentions.sort((a, b) => a.index - b.index).map((mention) => mention.path))];
}

/** Model-facing block of one mention: header `@<path> (<kind>, <count or status>)`, then content or notice. */
export function formatMention(mention: ReadMention): string {
  const { path, kind, status } = mention;
  if (status !== "attached" && status !== "truncated") {
    return `@${path} (${kind}, ${status})\n${notice({ ...mention, status })}`;
  }

  const count = plural(mention.lines ?? 0, kind === "file" ? "line" : "entry", kind === "file" ? "lines" : "entries");
  const header = `@${path} (${kind}, ${count}${status === "truncated" ? ", truncated" : ""})`;
  // [!]: No spread into Math.max: a 1 MiB file can hold more backtick runs than a call takes arguments.
  const longestRun = (mention.content.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const body = mention.content.endsWith("\n") || mention.content === "" ? mention.content : `${mention.content}\n`;
  const block = `${header}\n${fence}\n${body}${fence}`;
  return status === "truncated" ? `${block}\n${truncationNotice(mention.omitted)}` : block;
}

/** The line closing a cut text, for mentions and tool results alike. */
export function truncationNotice(omitted: number): string {
  return `[truncated: ${omitted} more lines not shown]`;
}

/** What the model receives for a user message: the text, then one block per mention. */
export function composeUserMessage(text: string, mentions: ReadMention[]): string {
  return [text, ...mentions.map(formatMention)].join("\n\n");
}

function notice(mention: ReadMention & { status: AccessFailure }): string {
  return `Not attached: ${accessFailureReason(mention.status, mention.cause)}.`;
}

/**
 * Why a path could not be read, as a clause without a final period: mentions say it after "Not attached: ", tool
 * errors after the path. `cause`: the error code or message of an `unreadable` path.
 */
export function accessFailureReason(failure: AccessFailure, cause?: string): string {
  switch (failure) {
    case "missing":
      return "no such file or folder in the workspace";
    case "outsideWorkspace":
      return "the path is outside the workspace folders";
    case "binary":
      return "the file is binary";
    case "tooLarge":
      return "the file is larger than 1 MiB";
    case "unreadable":
      return `the path could not be read (${cause ?? "unknown error"})`;
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Read mentioned `path` inside `roots`: whole or truncated content, or the reason nothing is attached. `seam`: for
 * tests, see `readWorkspaceEntry`. `readOnlyRoots`: for the read tools only, see `readWorkspaceEntry`; a mention never
 * gets them.
 */
export async function readMention(
  roots: WorkspaceRoot[],
  path: string,
  seam: RaceSeam = {},
  readOnlyRoots: readonly string[] = [],
): Promise<ReadMention> {
  const entry = await readWorkspaceEntry(roots, path, seam, readOnlyRoots);
  if (entry.status !== "ok") {
    const cause = entry.status === "unreadable" ? { cause: entry.cause } : {};
    return { path, kind: entry.kind, status: entry.status, content: "", omitted: 0, ...cause };
  }
  const whole = entry.kind === "file" ? entry.text : entry.entries.join("\n");
  const cut = truncateLines(whole, MAX_MENTION_LINES);
  const status = cut.omitted > 0 ? "truncated" : "attached";
  return { path, kind: entry.kind, status, lines: cut.lines, content: cut.text, omitted: cut.omitted };
}
