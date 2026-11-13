/**
 * @module turnEndText
 * The sentences that say how a turn ended short of an answer, as the chat panel and the host's notifications show
 * them. It imports nothing from `vscode` or `node:`, since the webview loads it.
 */
import type { Translator } from "./modelList";
import type { HaltReason } from "./protocol";

/**
 * Why an agent turn halted, translated by `l10n` (`@vscode/l10n` in the webview, `vscode.l10n` in the host); callers
 * name it `l10n` so the localization test finds its keys. `summary`: the reply is a summary (`/compact`), whose
 * request only a full context halts.
 */
export function describeHalt(reason: HaltReason, summary: boolean, l10n: Translator): string {
  if (summary && reason === "contextFull") {
    return l10n.t(
      "Not summarized: the conversation does not fit the model's context, even with its tool results left out. Start a new chat with New chat.",
    );
  }
  switch (reason) {
    case "malformedCalls":
      return l10n.t("Stopped: the model sent three malformed tool calls in a row.");
    case "stepLimit":
      return l10n.t("Stopped: the agent turn reached its tool step limit.");
    case "contextFull":
      return l10n.t(
        "Stopped: the conversation fills the model's context. Summarize it with /compact, or start a new chat with New chat.",
      );
  }
}

/** What a `/compact` that ended `done` with no text says, translated by `l10n` as `describeHalt` is. */
export function describeEmptySummary(l10n: Translator): string {
  return l10n.t("The model's reply held no summary.");
}
