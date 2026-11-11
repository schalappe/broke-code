/**
 * @module mentions
 * Mentions: `@path` tokens in a user message, read at send time, and the text the model receives for them. A token
 * that is exactly a reserved name (`reservedMentions`) is read from its source instead, by `mentionReader`.
 */
import { MASK, maskMessage } from "./markdownCode";
import {
  isNothingToAttach,
  isReservedFailure,
  type MentionKind,
  type NothingToAttach,
  type ReservedFailure,
  reservedMention,
} from "./reservedMentions";
import {
  type AccessFailure,
  bytePrefix,
  type EntryKind,
  type RaceSeam,
  readWorkspaceEntry,
  truncateLines,
  type WorkspaceRoot,
} from "./workspaceFiles";

/** Lines of a file, or entries of a folder, attached before the rest is cut. The read tools cut at the same count. */
export const MAX_MENTION_LINES = 2000;

/** UTF-8 bytes of a reserved mention's text attached before the rest is cut; a file over it is refused instead. */
export const MAX_MENTION_BYTES = 1024 * 1024;

/**
 * `attached`: content sent whole. `truncated`: content cut to its first lines. Any other status: nothing
 * attached; the model gets a notice instead, `NothingToAttach` ones saying what was absent rather than what failed.
 */
export type MentionStatus = "attached" | "truncated" | AccessFailure | NothingToAttach | ReservedFailure;

/** Where an attached selection lies: its workspace path as the file index writes it, and its 1-based lines. */
export type LineRange = { path: string; start: number; end: number };

/**
 * One mention as the chat shows and keeps it. `lines`: what was attached, counted in the unit of its kind (lines of a
 * file or a diff, entries of a folder, problems, lines of the selection). `range`: where the attached `@selection` lies.
 */
export type MentionResult = {
  path: string;
  kind: MentionKind;
  status: MentionStatus;
  lines?: number;
  range?: LineRange;
};

/**
 * A mention read at send time. `content`: attached text, empty when nothing is attached. `omitted`: lines cut
 * by truncation. `cause`: error code or message of an `unreadable` path.
 */
export type ReadMention = MentionResult & { content: string; omitted: number; cause?: string };

/** A mention of a workspace path, read: a file or folder, and no status of a reserved mention. */
export type PathMention = ReadMention & { kind: EntryKind; status: "attached" | "truncated" | AccessFailure };

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

/** The unit `lines` counts in, per kind, singular then plural. */
const COUNT_UNITS: Record<MentionKind, readonly [string, string]> = {
  file: ["line", "lines"],
  folder: ["entry", "entries"],
  problems: ["problem", "problems"],
  diff: ["line", "lines"],
  selection: ["line", "lines"],
};

/**
 * Model-facing block of one mention: header `@<path> (<kind>, <count or status>)`, the count led by the range when the
 * mention has one (`src/app.ts lines 10-12, 3 lines`), then content or notice.
 */
export function formatMention(mention: ReadMention): string {
  const { path, kind, status } = mention;
  if (status !== "attached" && status !== "truncated") {
    return `@${path} (${kind}, ${status})\n${notice({ ...mention, status })}`;
  }

  const [one, many] = COUNT_UNITS[kind];
  const count = `${mention.range ? `${describeRange(mention.range)}, ` : ""}${plural(mention.lines ?? 0, one, many)}`;
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

/** `src/app.ts lines 10-12`, or `line 10` for one line. */
function describeRange({ path, start, end }: LineRange): string {
  return start === end ? `${path} line ${start}` : `${path} lines ${start}-${end}`;
}

/** Why a reserved mention attached nothing although nothing failed. */
const NOTHING_TO_ATTACH_REASONS: Record<NothingToAttach, string> = {
  noProblems: "VS Code holds no error or warning for the workspace files",
  noChanges: "no tracked file differs from HEAD",
};

/** Why a reserved mention attached nothing: its source lacks what it asks for. */
const RESERVED_FAILURE_REASONS: Record<ReservedFailure, string> = {
  noRepository: "no workspace folder is a git repository",
  gitUnavailable: "git is not available in VS Code",
  noEditor: "no text editor is active",
  emptySelection: "the selection is empty",
};

function notice(mention: ReadMention & { status: Exclude<MentionStatus, "attached" | "truncated"> }): string {
  const { kind, status, cause } = mention;
  if (isNothingToAttach(status)) return `Not attached: ${NOTHING_TO_ATTACH_REASONS[status]}.`;
  if (isReservedFailure(status)) return `Not attached: ${RESERVED_FAILURE_REASONS[status]}.`;
  // [>]: `@selection` names no path: its document is what lies outside.
  if (status === "outsideWorkspace" && kind === "selection") {
    return "Not attached: the selected file is outside the workspace folders.";
  }
  // [>]: A reserved mention reads no path: an `unreadable` one is its source failing.
  if (status === "unreadable" && reservedMention(kind)) {
    return `Not attached: the ${kind} could not be read (${cause ?? "unknown error"}).`;
  }
  return `Not attached: ${accessFailureReason(status, cause)}.`;
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

/**
 * `text` cut to the mention caps: its first 2,000 lines, and its first 1 MiB cut between characters, for a reserved
 * mention's text, which is cut rather than refused. `lines`: whole lines kept; `omitted`: lines not shown, the line the
 * byte cap cut among them.
 */
export function cutToMentionCaps(text: string): { text: string; lines: number; omitted: number } {
  const prefix = bytePrefix([text], MAX_MENTION_BYTES);
  const cut = truncateLines(prefix, MAX_MENTION_LINES);
  if (prefix.length === text.length) return cut;
  // [>]: Under the line cap, the byte cap cut the last line kept unless the prefix ends with its line break.
  const partial = cut.omitted === 0 && !/[\r\n]$/.test(prefix) ? 1 : 0;
  const lines = cut.lines - partial;
  return { text: cut.text, lines, omitted: truncateLines(text, Number.POSITIVE_INFINITY).lines - lines };
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
): Promise<PathMention> {
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
