/**
 * @module text
 * Localized panel text for provider errors and halted agent turns (both worded in the core, translated here), skipped
 * providers and skills, mentions, tool steps, folded turns, the outcome of "Undo changes", context usage, saved
 * conversations, and what the live region announces.
 */
import * as l10n from "@vscode/l10n";
import type { ConversationSummary } from "../core/conversation";
import { resultLineCount } from "../core/history";
import type { MentionResult } from "../core/mentions";
import type {
  ChatEntry,
  ChatState,
  ContextUsage,
  HaltReason,
  ReplyCall,
  SkillWarning,
  StorageProblem,
  UndoneFile,
  UndoneStatus,
} from "../core/protocol";
import {
  describeProviderError as describeProviderErrorWith,
  type ErrorText,
  type ProviderError,
} from "../core/providerError";
import type { SkippedProvider } from "../core/providers";
import type { MentionKind } from "../core/reservedMentions";
import {
  describeEmptySummary as describeEmptySummaryWith,
  describeHalt as describeHaltWith,
} from "../core/turnEndText";
import { type FoldCounts, STEP_KINDS, type StepKind } from "./turns";

export type { ErrorText };

/** Provider error wording with the panel's translator; see `describeProviderError` in the core. */
export function describeProviderError(error: ProviderError): ErrorText {
  return describeProviderErrorWith(error, l10n);
}

export function describeSkippedProvider(skipped: SkippedProvider): string {
  switch (skipped.reason) {
    case "missingName":
      return l10n.t("Provider number {0} in the settings is skipped: it has no name.", skipped.position);
    case "invalidUrl":
      return l10n.t("Provider {0} is skipped: its base URL is not an http or https URL.", skipped.name ?? "");
    case "duplicateName":
      return l10n.t("Provider {0} is skipped: another provider already uses this name.", skipped.name ?? "");
  }
}

/** Why a skill, or a whole skills folder, was skipped, naming its file or folder. */
export function describeSkillWarning({ path, problem }: SkillWarning): string {
  switch (problem.kind) {
    case "noFrontmatter":
      return l10n.t("Skill {0} is skipped: it has no frontmatter between --- lines.", path);
    case "missingName":
      return l10n.t("Skill {0} is skipped: it lacks a name.", path);
    case "nameTooLong":
      return l10n.t("Skill {0} is skipped: its name is longer than 64 characters.", path);
    case "invalidName":
      return l10n.t(
        "Skill {0} is skipped: its name is not lowercase letters, digits, and single hyphens, with no hyphen at either end.",
        path,
      );
    case "nameMismatch":
      return l10n.t(
        "Skill {0} is skipped: its name {1} differs from its folder {2}.",
        path,
        problem.name,
        problem.directory,
      );
    case "unparsableField":
      return l10n.t(
        "Skill {0} is skipped: its {1} cannot be read; write it as plain, quoted, or > or | block text.",
        path,
        problem.field,
      );
    case "missingDescription":
      return l10n.t("Skill {0} is skipped: it lacks a description.", path);
    case "descriptionTooLong":
      return l10n.t("Skill {0} is skipped: its description is longer than 1024 characters.", path);
    case "tooLarge":
      return l10n.t("Skill {0} is skipped: the file is over 1 MiB.", path);
    case "binary":
      return l10n.t("Skill {0} is skipped: the file is not text.", path);
    case "outsideWorkspace":
      return l10n.t("Skill {0} is skipped: it links outside the workspace.", path);
    case "outsideSkillFolder":
      return l10n.t("Skill {0} is skipped: it links outside its skill folder.", path);
    case "unreadable":
      return l10n.t("Skill {0} is skipped: the file cannot be read ({1}).", path, problem.cause);
    case "folderUnreadable":
      return l10n.t("The skills in {0} are skipped: the folder cannot be read ({1}).", path, problem.cause);
    case "tooManyEntries":
      return l10n.t(
        "Some skills in {0} are skipped: the folder holds {1} entries, and only the first 200 by name are read.",
        path,
        problem.entries,
      );
  }
}

/** Short status of a mention: what was attached, or why nothing was. */
export function describeMention(mention: MentionResult): string {
  const count = mention.lines ?? 0;
  switch (mention.status) {
    case "attached":
      return withFailedFolders(mention, withRange(mention, describeCount(mention.kind, count)));
    case "truncated":
      return withFailedFolders(mention, withRange(mention, describeTruncated(mention.kind, count)));
    case "missing":
      return l10n.t("not found");
    case "outsideWorkspace":
      return l10n.t("outside the workspace");
    case "binary":
      return l10n.t("binary file, not attached");
    case "tooLarge":
      return l10n.t("over 1 MiB, not attached");
    case "unreadable":
      return l10n.t("could not be read");
    case "noProblems":
      return l10n.t("no errors or warnings");
    case "noChanges":
      return l10n.t("no changes");
    case "noRepository":
      return l10n.t("not a git repository");
    case "gitUnavailable":
      return l10n.t("git not available");
    case "noEditor":
      return l10n.t("no active text editor");
    case "emptySelection":
      return l10n.t("empty selection");
  }
}

/** `count` led by the mention's range when it has one: `src/app.ts 10-12, 3 lines`, `src/app.ts 10, 1 line`. */
function withRange({ range }: MentionResult, count: string): string {
  if (!range) return count;
  const lines = range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
  return l10n.t("{0} {1}, {2}", range.path, lines, count);
}

/** `text` followed by the folders whose part could not be read, when some failed: `9 lines, 1 folder failed`. */
function withFailedFolders({ failedFolders }: MentionResult, text: string): string {
  if (!failedFolders) return text;
  const failed = failedFolders === 1 ? l10n.t("1 folder failed") : l10n.t("{0} folders failed", failedFolders);
  return l10n.t("{0}, {1}", text, failed);
}

/** The unit a mention's count is in, per kind: one grouping for the count and the truncation wordings. */
const COUNT_UNIT: Record<MentionKind, "line" | "entry" | "problem"> = {
  file: "line",
  diff: "line",
  selection: "line",
  folder: "entry",
  problems: "problem",
};

/** What a mention of `kind` attached, `count` in the unit of its kind. */
function describeCount(kind: MentionKind, count: number): string {
  switch (COUNT_UNIT[kind]) {
    case "line":
      return count === 1 ? l10n.t("1 line") : l10n.t("{0} lines", count);
    case "entry":
      return count === 1 ? l10n.t("1 entry") : l10n.t("{0} entries", count);
    case "problem":
      return count === 1 ? l10n.t("1 problem") : l10n.t("{0} problems", count);
  }
}

/** What a cut mention of `kind` kept, `count` in the unit of its kind. */
function describeTruncated(kind: MentionKind, count: number): string {
  switch (COUNT_UNIT[kind]) {
    case "line":
      return l10n.t("truncated to {0} lines", count);
    case "entry":
      return l10n.t("truncated to {0} entries", count);
    case "problem":
      return l10n.t("truncated to {0} problems", count);
  }
}

/**
 * The argument a step row shows: a search's pattern, else the path, else the first value given. A `read_file` given a
 * line range shows it after the path as the model wrote it (`big.log 2001-4000`), its missing end left blank
 * (`big.log 2001-`) and its missing start shown as 1 (`big.log 1-50`), so two reads of one file differ. An `ask_user`
 * shows the first line of its question, never its options, whichever the model wrote first; nothing without a question.
 */
export function mainArgument(name: string, args: Record<string, string>): string | undefined {
  if (name === "ask_user") return args.question?.trim().split("\n")[0]?.trim() || undefined;
  const { start_line: start, end_line: end } = args;
  if (name === "read_file" && args.path !== undefined && (start !== undefined || end !== undefined)) {
    return `${args.path} ${start ?? 1}-${end ?? ""}`;
  }
  return args.pattern ?? args.path ?? Object.values(args)[0];
}

/**
 * Short status of a finished tool step: `ok` or `error` and its size, or the first line of a malformed call's message,
 * which says what is wrong. The size is the one the user knows the step by: a write's added and removed lines, as its
 * approval showed them (none for a record saved before they were kept); the lines of the file `read_file` returned,
 * from its result's header; the result's lines for the other tools. A call the user rejected says so, its reason in
 * the expanded result; one auto-approved says so before its status; a write "Undo changes" undid says so first.
 * Model-facing messages are English, never localized.
 */
export function describeToolStep(step: ChatEntry & { role: "tool" }): string {
  if (step.status === "malformed") return step.text.split("\n")[0] ?? "";
  if (step.approval === "rejected") return l10n.t("rejected by you");
  if (stepNote(step) !== undefined) return l10n.t("you answered");
  const ending = step.name === "run_command" ? describeCommandEnding(step.text) : undefined;
  if (ending !== undefined) return l10n.t("{0}, {1}", ending, describeLines(resultLineCount(step.text)));
  const size = stepSize(step);
  const ok = size === undefined ? l10n.t("ok") : l10n.t("ok, {0}", size);
  const status = step.status === "ok" ? ok : l10n.t("error, {0}", describeLines(resultLineCount(step.text)));
  const approved = step.approval === "auto" ? l10n.t("auto-approved, {0}", status) : status;
  return step.undone ? l10n.t("undone, {0}", approved) : approved;
}

/**
 * The words the user gave a step, shown on a line of their own under its row, so a long one never pushes the row
 * past the panel: the reason typed with a rejection (the result's second line, `rejectionText`), or the answer to an
 * `ask_user` question. `undefined` when there are none.
 */
export function stepNote(step: ChatEntry & { role: "tool" }): string | undefined {
  if (step.approval === "rejected") return step.text.split("\n")[1]?.trim() || undefined;
  if (step.name !== "ask_user" || step.status !== "ok") return undefined;
  return /^The user answered: (.*)$/m.exec(step.text)?.[1] || undefined;
}

/** The tools whose step counts the lines it changed, not the lines of its result. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["write_file", "edit_file"]);

/** The size an `ok` step shows; `undefined` for a write saved without its counts. */
function stepSize(step: ChatEntry & { role: "tool" }): string | undefined {
  if (WRITE_TOOLS.has(step.name)) return step.lines && `+${step.lines.added} \u2212${step.lines.removed}`;
  const read = step.name === "read_file" ? readLineCount(step.text) : undefined;
  return describeLines(read ?? resultLineCount(step.text));
}

function describeLines(count: number): string {
  return count === 1 ? l10n.t("1 line") : l10n.t("{0} lines", count);
}

/**
 * The lines of the file a `read_file` result holds, from its header (`formatMention`, or a ranged read's
 * "(file, lines 2-5 of 30)"); `undefined` for a result without one.
 */
function readLineCount(text: string): number | undefined {
  const header = text.split("\n", 1)[0] ?? "";
  const whole = / \(file, (\d+) lines?(?:, truncated)?\)$/.exec(header);
  if (whole) return Number(whole[1]);
  const ranged = / \(file, lines? (\d+)(?:-(\d+))? of \d+\)$/.exec(header);
  if (!ranged) return undefined;
  return Number(ranged[2] ?? ranged[1]) - Number(ranged[1]) + 1;
}

/**
 * How a command that ran ended, from the first line of its result (see `runCommand`): its exit code, the signal that
 * killed it, or its timeout; `undefined` for a result of a command that never ran, such as a refused folder.
 */
function describeCommandEnding(text: string): string | undefined {
  const first = text.split("\n", 1)[0] ?? "";
  const exit = /^exit code (-?\d+)$/.exec(first);
  if (exit) return l10n.t("exit code {0}", exit[1]!);
  const killed = /^killed by (\S+)$/.exec(first);
  if (killed) return l10n.t("killed by {0}", killed[1]!);
  const timeout = /^stopped after (\d+(?:\.\d+)?) seconds$/.exec(first);
  if (timeout) return l10n.t("stopped after {0} seconds", timeout[1]!);
  return undefined;
}

/** The most kinds a fold's row names; "N other steps" takes none of these places. */
const MAX_NAMED_KINDS = 3;

/** The kinds always named when not zero, so a fold never hides that the turn changed files or ran commands. */
const ALWAYS_NAMED: readonly StepKind[] = ["edited", "ran"];

/**
 * The row of a folded turn, in words: `done` says what the steps did, `failed` which of them failed, if any.
 * `done` names at most three kinds, "edited" and "ran" always among them when not zero and the places left to the kinds
 * with the largest number shown (a tie to the earlier kind), written in the order of `STEP_KINDS`; then the other
 * steps, which add the steps of every kind not named; then the rejected ones when there are any. A fold of other steps
 * alone says "N steps". `failed` counts the failed steps and names their tools, each once ("2 failed (run_command,
 * edit_file)"); the row shows it last, in the error color, so a failure never hides among the counts. The row may
 * wrap; it is never cut.
 */
export function describeFold(counts: FoldCounts): { done: string; failed?: string } {
  const present = STEP_KINDS.filter((kind) => counts.kinds[kind].steps > 0);
  const named = new Set(present.filter((kind) => ALWAYS_NAMED.includes(kind)));
  const byNumber = present
    .filter((kind) => !named.has(kind))
    .sort((a, b) => counts.kinds[b].shown - counts.kinds[a].shown);
  const places = MAX_NAMED_KINDS - named.size;
  for (const kind of byNumber.slice(0, places)) named.add(kind);
  const parts = present.filter((kind) => named.has(kind)).map((kind) => describeKind(kind, counts.kinds[kind].shown));
  const other = byNumber.slice(places).reduce((sum, kind) => sum + counts.kinds[kind].steps, counts.otherSteps);
  if (parts.length === 0) parts.push(l10n.t("{0} steps", counts.steps));
  else if (other > 0) parts.push(other === 1 ? l10n.t("1 other step") : l10n.t("{0} other steps", other));
  if (counts.rejected > 0) {
    parts.push(counts.rejected === 1 ? l10n.t("1 rejected") : l10n.t("{0} rejected", counts.rejected));
  }
  const text = parts.reduce((joined, part) => l10n.t("{0}, {1}", joined, part));
  const done = text.charAt(0).toUpperCase() + text.slice(1);
  if (counts.failed === 0) return { done };
  const tools = counts.failedTools.join(", ");
  const failed =
    counts.failed === 1 ? l10n.t("1 failed ({0})", tools) : l10n.t("{0} failed ({1})", counts.failed, tools);
  return { done, failed };
}

/** What the steps of `kind` did, `shown` their number in the unit of the kind. */
function describeKind(kind: StepKind, shown: number): string {
  switch (kind) {
    case "read":
      return shown === 1 ? l10n.t("read 1 file") : l10n.t("read {0} files", shown);
    case "listed":
      return shown === 1 ? l10n.t("listed 1 folder") : l10n.t("listed {0} folders", shown);
    case "searched":
      return shown === 1 ? l10n.t("searched 1 time") : l10n.t("searched {0} times", shown);
    case "loaded":
      return shown === 1 ? l10n.t("loaded 1 skill") : l10n.t("loaded {0} skills", shown);
    case "edited":
      return shown === 1 ? l10n.t("changed 1 file") : l10n.t("changed {0} files", shown);
    case "ran":
      return shown === 1 ? l10n.t("ran 1 command") : l10n.t("ran {0} commands", shown);
  }
}

/**
 * `text` cut into plain parts and inline code, a span between two backticks on one line: a question the agent asks is
 * plain text, line breaks kept, but models write paths and names in backticks there as in an answer.
 */
export function splitInlineCode(text: string): { text: string; code: boolean }[] {
  const parts: { text: string; code: boolean }[] = [];
  let from = 0;
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    if (match.index > from) parts.push({ text: text.slice(from, match.index), code: false });
    parts.push({ text: match[1]!, code: true });
    from = match.index + match[0].length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), code: false });
  return parts;
}

/** Halt wording with the panel's translator; see `describeHalt` in the core. */
export function describeHalt(reason: HaltReason, summary = false): string {
  return describeHaltWith(reason, summary, l10n);
}

/**
 * What the reply in flight waits on, in words: the approval open ("Waiting for your decision: ..."), the agent's
 * question ("The agent asks: ..."), or `undefined` when it waits on neither. The live region and the jump row say it.
 */
export function describeWaiting({ approval, question }: Pick<ChatState, "approval" | "question">): string | undefined {
  if (approval) {
    return approval.kind === "command"
      ? l10n.t("Waiting for your decision: run {0}", approval.summary)
      : l10n.t("Waiting for your decision: {0} on {1}", approval.tool, approval.summary);
  }
  return question && l10n.t("The agent asks: {0}", question.question);
}

/**
 * A new question as the live region says it: the question, then how many options it offers, since the reader hears
 * nothing of the block's buttons until they reach them.
 */
function describeQuestion({ question, options }: NonNullable<ChatState["question"]>): string {
  if (options.length === 0) return l10n.t("The agent asks: {0}", question);
  return options.length === 1
    ? l10n.t("The agent asks: {0} (1 option)", question)
    : l10n.t("The agent asks: {0} ({1} options)", question, options.length);
}

/**
 * What the panel's live region says when the host posts `next` after `previous`, or `undefined` when nothing worth a
 * word changed: a call that waits for the user's decision, a question the agent asks, a call that starts running, or
 * the end of the reply in flight.
 * The focus never moves to tell them (DESIGN.md), so a screen reader would hear none of it otherwise. A failed reply
 * says nothing here, since its error block is an alert of its own; neither does a reply that ends on a call, since its
 * step follows; nor another conversation shown, since nothing happened in it.
 */
export function describeAnnouncement(previous: ChatState, next: ChatState): string | undefined {
  if (previous.conversationId !== next.conversationId) return undefined;
  const { approval, question } = next;
  const waiting = approval ? approval.id !== previous.approval?.id : question && question.id !== previous.question?.id;
  if (waiting) return approval ? describeWaiting(next) : question && describeQuestion(question);
  const call = runningCall(next);
  if (call && !runningCall(previous)) {
    if (call.name === "run_command" && call.args.command !== undefined) return l10n.t("Running {0}", call.args.command);
    const argument = mainArgument(call.name, call.args);
    return argument === undefined
      ? l10n.t("Running {0}", call.name)
      : l10n.t("Running {0} on {1}", call.name, argument);
  }
  const index = previous.entries.length - 1;
  const before = previous.entries[index];
  const after = next.entries[index];
  if (before?.role !== "assistant" || after?.role !== "assistant") return undefined;
  if (before.status !== "waiting" && before.status !== "streaming") return undefined;
  switch (after.status) {
    case "done":
      return after.call ? undefined : l10n.t("Reply finished.");
    case "stopped":
      return l10n.t("Stopped");
    case "halted":
      return after.haltReason && describeHalt(after.haltReason, after.summary);
    default:
      return undefined;
  }
}

/**
 * The call the reply in flight runs now, as the host marks it (`ChatState.callRunning`): a call that waits on a
 * decision or an answer, or whose request was rejected, cancelled, or answered, is not running.
 */
function runningCall(state: ChatState): ReplyCall | undefined {
  const last = state.entries.at(-1);
  if (last?.role !== "assistant" || (last.status !== "waiting" && last.status !== "streaming")) return undefined;
  return state.callRunning ? last.call : undefined;
}

/** The empty summary's wording with the panel's translator; see `describeEmptySummary` in the core. */
export function describeEmptySummary(): string {
  return describeEmptySummaryWith(l10n);
}

/**
 * The line over an undo's files: every file back (`restored` or `removed`), some skipped, or none back. A skipped file
 * stays held, so the button stays and retries it.
 */
export function describeUndoOutcome(files: readonly UndoneFile[]): string {
  const skipped = files.filter((file) => file.status === "skipped").length;
  if (skipped === 0) return l10n.t("Changes undone.");
  if (skipped < files.length) {
    return l10n.t("Some changes were not undone. Undo changes again to retry the files skipped.");
  }
  return l10n.t("No change was undone. Undo changes again to retry the files skipped.");
}

/** An undo that failed unexpectedly (a bug): how to retry, and the error as detail. */
export function describeUndoFailure(error: string): ErrorText {
  return {
    message: l10n.t("Undo changes failed unexpectedly. Undo changes again to retry the files not yet undone."),
    detail: error,
  };
}

/** A piece of a sentence: prose in the UI font, or a path, which the panel sets in the editor font. */
export type TextPart = { text: string } | { path: string };

// [>]: Private-use characters stand for the paths inside a translated sentence, so a translator still orders it; the
// sentence is then cut at them. No path, status, or cause holds one.
const FILE_MARK = "\uE000";
const LEFTOVER_MARK = "\uE001";

/**
 * One file of an undo: its path, then what happened to it, and the temporary file it left behind, if any; each path a
 * part of its own.
 */
export function describeUndoneFile(file: UndoneFile): TextPart[] {
  const row = l10n.t("{0}: {1}", FILE_MARK, undoneStatus(file));
  const sentence =
    file.leftover === undefined
      ? row
      : l10n.t("{0}; its temporary file {1} could not be removed ({2})", row, LEFTOVER_MARK, file.leftover.cause);
  return sentence
    .split(/([\uE000\uE001])/)
    .filter((piece) => piece !== "")
    .map((piece) => {
      if (piece === FILE_MARK) return { path: file.path };
      if (piece === LEFTOVER_MARK) return { path: file.leftover?.name ?? "" };
      return { text: piece };
    });
}

function undoneStatus(file: UndoneStatus): string {
  if (file.status !== "skipped") {
    return file.status === "restored" ? l10n.t("restored") : l10n.t("removed, since this turn created it");
  }
  switch (file.reason) {
    case "changed":
      return l10n.t("skipped, it changed since this turn wrote it");
    case "unsaved":
      return l10n.t("skipped, it has unsaved changes in an editor");
    case "symlink":
      return l10n.t("skipped, it is now a symbolic link");
    case "outsideWorkspace":
      return l10n.t("skipped, it is no longer inside the workspace folders");
    case "failed":
      return l10n.t("skipped, it could not be restored ({0})", file.cause);
  }
}

/** The next request's estimate against the context size, as tokens and a share, numbers in `language` (BCP 47). */
export function describeContextUsage({ used, size }: ContextUsage, language: string): string {
  const percent: Intl.NumberFormatOptions = { style: "percent", maximumFractionDigits: 0 };
  return inLanguage(language, (locale) => {
    const number = new Intl.NumberFormat(locale);
    return l10n.t(
      "{0} / {1} tokens ({2})",
      number.format(used),
      number.format(size),
      new Intl.NumberFormat(locale, percent).format(used / size),
    );
  });
}

/**
 * The usage line's tooltip: what the line estimates, then the counts the last chat request reported, when it reported
 * any, numbers in `language` (BCP 47) like the line's.
 */
export function describeContextTitle({ reported }: ContextUsage, language: string): string {
  if (reported === undefined) return l10n.t("Estimated size of the next request");
  return inLanguage(language, (locale) => {
    const number = new Intl.NumberFormat(locale);
    return l10n.t(
      "Estimated size of the next request. Last reply: {0} prompt tokens, {1} completion tokens",
      number.format(reported.prompt),
      number.format(reported.completion),
    );
  });
}

/** `format` with `language`, or with the runtime's language when Intl rejects the tag (RangeError). */
function inLanguage(language: string, format: (locale: string | undefined) => string): string {
  try {
    return format(language);
  } catch {
    return format(undefined);
  }
}

/** Date and time of a saved conversation in `language` (BCP 47), or the runtime's language if it cannot be used. */
export function formatConversationDate(time: number, language: string): string {
  const options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };
  try {
    return new Intl.DateTimeFormat(language, options).format(time);
  } catch {
    // [>]: A tag Intl rejects (RangeError) still gets a readable date.
    return new Intl.DateTimeFormat(undefined, options).format(time);
  }
}

/** The line under a History row's title: its date and time, then how many messages it holds, when known. */
export function describeRowDetails({ updatedAt, messages }: ConversationSummary, language: string): string {
  const date = formatConversationDate(updatedAt, language);
  if (messages === undefined) return date;
  return messages === 1 ? l10n.t("{0} · 1 message", date) : l10n.t("{0} · {1} messages", date, messages);
}

export function describeListFailure(failure: { cause: string }): ErrorText {
  return { message: l10n.t("Could not list the past conversations."), detail: failure.cause };
}

export function describeStorageProblem(problem: StorageProblem): ErrorText {
  switch (problem.kind) {
    case "saveFailed":
      return { message: l10n.t("Could not save the conversation."), detail: problem.cause };
    case "deleteFailed":
      return { message: l10n.t("Could not delete the conversation."), detail: problem.cause };
    case "openFailed":
      return { message: l10n.t("Could not open the conversation."), detail: problem.cause };
    case "notFound":
      return { message: l10n.t("This conversation is missing or unreadable; it was removed from the list.") };
  }
}
