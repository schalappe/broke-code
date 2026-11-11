/**
 * @module text
 * Localized panel text for provider errors (worded in the core, translated here), skipped providers and skills, mentions, tool steps, folded turns, halted agent turns, context
 * usage, and saved conversations.
 */
import * as l10n from "@vscode/l10n";
import { resultLineCount } from "../core/history";
import type { MentionResult } from "../core/mentions";
import type { ChatEntry, ContextUsage, HaltReason, SkillWarning, StorageProblem } from "../core/protocol";
import {
  describeProviderError as describeProviderErrorWith,
  type ErrorText,
  type ProviderError,
} from "../core/providerError";
import type { SkippedProvider } from "../core/providers";
import type { MentionKind } from "../core/reservedMentions";
import type { FoldCounts } from "./turns";

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
      return withRange(mention, describeCount(mention.kind, count));
    case "truncated":
      return withRange(mention, describeTruncated(mention.kind, count));
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

/** What a mention of `kind` attached, `count` in the unit of its kind. */
function describeCount(kind: MentionKind, count: number): string {
  switch (kind) {
    case "file":
      return count === 1 ? l10n.t("1 line") : l10n.t("{0} lines", count);
    case "folder":
      return count === 1 ? l10n.t("1 entry") : l10n.t("{0} entries", count);
    case "problems":
      return count === 1 ? l10n.t("1 problem") : l10n.t("{0} problems", count);
    case "selection":
      return count === 1 ? l10n.t("1 line") : l10n.t("{0} lines", count);
  }
}

function describeTruncated(kind: MentionKind, count: number): string {
  switch (kind) {
    case "file":
      return l10n.t("truncated to {0} lines", count);
    case "folder":
      return l10n.t("truncated to {0} entries", count);
    case "problems":
      return l10n.t("truncated to {0} problems", count);
    case "selection":
      return l10n.t("truncated to {0} lines", count);
  }
}

/** The argument a step row shows: a search's pattern, else the path, else the first value given. */
export function mainArgument(args: Record<string, string>): string | undefined {
  return args.pattern ?? args.path ?? Object.values(args)[0];
}

/**
 * Short status of a finished tool step: `ok` or `error` and the result's size in lines, or the first line of a
 * malformed call's message, which says what is wrong. A call the user rejected says so, its reason in the expanded
 * result; one auto-approved says so before its status. Model-facing messages are English, never localized.
 */
export function describeToolStep(step: ChatEntry & { role: "tool" }): string {
  if (step.status === "malformed") return step.text.split("\n")[0] ?? "";
  if (step.approval === "rejected") return l10n.t("rejected");
  const count = resultLineCount(step.text);
  const size = count === 1 ? l10n.t("1 line") : l10n.t("{0} lines", count);
  const ending = step.name === "run_command" ? describeCommandEnding(step.text) : undefined;
  if (ending !== undefined) return l10n.t("{0}, {1}", ending, size);
  const status = step.status === "ok" ? l10n.t("ok, {0}", size) : l10n.t("error, {0}", size);
  return step.approval === "auto" ? l10n.t("auto-approved, {0}", status) : status;
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

/** The row of a folded turn: its steps, then the failed and the rejected ones when there are any, in words. */
export function describeFold(counts: FoldCounts): string {
  let text = l10n.t("{0} steps", counts.steps);
  if (counts.failed > 0) {
    const failed = counts.failed === 1 ? l10n.t("1 failed") : l10n.t("{0} failed", counts.failed);
    text = l10n.t("{0}, {1}", text, failed);
  }
  if (counts.rejected > 0) {
    const rejected = counts.rejected === 1 ? l10n.t("1 rejected") : l10n.t("{0} rejected", counts.rejected);
    text = l10n.t("{0}, {1}", text, rejected);
  }
  return text;
}

/** Why an agent turn halted, shown after its last step, or on the reply whose request was not sent. */
export function describeHalt(reason: HaltReason): string {
  switch (reason) {
    case "malformedCalls":
      return l10n.t("Stopped: the model sent three malformed tool calls in a row.");
    case "stepLimit":
      return l10n.t("Stopped: the agent turn reached its tool step limit.");
    case "contextFull":
      return l10n.t("Stopped: the conversation fills the model's context. Start a new chat with New chat.");
  }
}

/** The next request's estimate against the context size, as tokens and a share, numbers in `language` (BCP 47). */
export function describeContextUsage({ used, size }: ContextUsage, language: string): string {
  const percent: Intl.NumberFormatOptions = { style: "percent", maximumFractionDigits: 0 };
  const format = (locale: string | undefined) => {
    const number = new Intl.NumberFormat(locale);
    return l10n.t(
      "{0} / {1} tokens ({2})",
      number.format(used),
      number.format(size),
      new Intl.NumberFormat(locale, percent).format(used / size),
    );
  };
  try {
    return format(language);
  } catch {
    // [>]: A tag Intl rejects (RangeError) still gets readable numbers.
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
