/**
 * @module text
 * Localized panel text for provider errors, skipped providers and skills, mentions, tool steps, halted agent turns, context
 * usage, and saved conversations.
 */
import * as l10n from "@vscode/l10n";
import type { MentionResult } from "../core/mentions";
import type { ChatEntry, ContextUsage, HaltReason, SkillWarning, StorageProblem } from "../core/protocol";
import type { ProviderError } from "../core/providerError";
import type { SkippedProvider } from "../core/providers";

/** `message`: localized sentence naming provider. `detail`: raw technical text from provider or runtime. */
export type ErrorText = { message: string; detail?: string };

export function describeProviderError(error: ProviderError): ErrorText {
  switch (error.kind) {
    case "internal":
      return { message: l10n.t("An unexpected internal error ended the reply."), detail: error.message };
    case "unreachable":
      return { message: l10n.t("Cannot reach {0} at {1}.", error.provider, error.baseUrl), detail: error.cause };
    case "certificate":
      return {
        message: l10n.t(
          "{0} presented a certificate that is not trusted ({1}). If it uses a corporate or self-signed certificate, set its CA file in the provider settings.",
          error.provider,
          error.code,
        ),
        detail: error.baseUrl,
      };
    case "caFileInvalid":
      return { message: caFileMessage(error), ...(error.cause ? { detail: error.cause } : {}) };
    case "redirected":
      return {
        message: l10n.t(
          "{0} answered with a redirect (HTTP {1}), which broke-code does not follow. Set its base URL to the final address.",
          error.provider,
          error.status,
        ),
        ...(error.location ? { detail: error.location } : {}),
      };
    case "invalidKey":
      return { message: l10n.t("{0} refused the API key (HTTP {1}).", error.provider, error.status) };
    case "rejected":
      return {
        message: l10n.t("{0} rejected the request (HTTP {1}).", error.provider, error.status),
        ...rejectedDetail(error),
      };
    case "cutOff":
      return { message: cutOffMessage(error), ...(error.cause ? { detail: error.cause } : {}) };
    case "invalidResponse":
      if (error.encoding !== undefined) {
        return {
          message: l10n.t(
            "{0} answered with a compression that broke-code cannot read (Content-Encoding: {1}).",
            error.provider,
            error.encoding,
          ),
        };
      }
      return {
        message: l10n.t(
          "{0} did not answer with a model list. Check that its base URL is the API root, such as http://localhost:11434/v1.",
          error.provider,
        ),
        ...(error.detail ? { detail: error.detail } : {}),
      };
  }
}

function rejectedDetail(error: ProviderError & { kind: "rejected" }): { detail?: string } {
  if (error.bodyReadError !== undefined)
    return { detail: l10n.t("The response body could not be read: {0}", error.bodyReadError) };
  return error.detail ? { detail: error.detail } : {};
}

function caFileMessage(error: ProviderError & { kind: "caFileInvalid" }): string {
  switch (error.reason) {
    case "relative":
      return l10n.t("The CA file of {0} must be an absolute path or start with ~/: {1}", error.provider, error.path);
    case "unreadable":
      return l10n.t("The CA file of {0} could not be read: {1}", error.provider, error.path);
    case "notPem":
      return l10n.t("The CA file of {0} is not a PEM certificate: {1}", error.provider, error.path);
  }
}

function cutOffMessage(error: ProviderError & { kind: "cutOff" }): string {
  switch (error.reason) {
    case "ended":
      return l10n.t("The reply from {0} was cut off: the stream ended before the reply was complete.", error.provider);
    case "malformed":
      return l10n.t("The reply from {0} was cut off: the stream sent an unreadable chunk.", error.provider);
    case "dropped":
      return l10n.t("The reply from {0} was cut off: the connection dropped.", error.provider);
    case "listDropped":
      return l10n.t("The model list from {0} was cut off: the connection dropped.", error.provider);
    case "tooLarge":
      return l10n.t("The reply from {0} was cut off: it exceeded the size limit.", error.provider);
    case "listTooLarge":
      return l10n.t("The model list from {0} was cut off: it exceeded the size limit.", error.provider);
    case "providerError":
      return l10n.t("The reply from {0} was cut off: the provider reported an error.", error.provider);
  }
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
  const file = mention.kind === "file";
  switch (mention.status) {
    case "attached":
      if (file) return count === 1 ? l10n.t("1 line") : l10n.t("{0} lines", count);
      return count === 1 ? l10n.t("1 entry") : l10n.t("{0} entries", count);
    case "truncated":
      return file ? l10n.t("truncated to {0} lines", count) : l10n.t("truncated to {0} entries", count);
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
  const count = step.text === "" ? 0 : step.text.replace(/\n$/, "").split("\n").length;
  const size = count === 1 ? l10n.t("1 line") : l10n.t("{0} lines", count);
  const status = step.status === "ok" ? l10n.t("ok, {0}", size) : l10n.t("error, {0}", size);
  return step.approval === "auto" ? l10n.t("auto-approved, {0}", status) : status;
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
