/**
 * @module text
 * Localized panel text for provider errors and skipped providers.
 */
import * as l10n from "@vscode/l10n";
import type { ProviderError } from "../core/providerError";
import type { SkippedProvider } from "../core/providers";

/** `message`: localized sentence naming provider. `detail`: raw technical text from provider or runtime. */
export type ErrorText = { message: string; detail?: string };

export function describeProviderError(error: ProviderError): ErrorText {
  switch (error.kind) {
    case "unreachable":
      return { message: l10n.t("Cannot reach {0} at {1}.", error.provider, error.baseUrl), detail: error.cause };
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
  if (error.bodyReadError !== undefined) return { detail: l10n.t("The response body could not be read: {0}", error.bodyReadError) };
  return error.detail ? { detail: error.detail } : {};
}

function cutOffMessage(error: ProviderError & { kind: "cutOff" }): string {
  switch (error.reason) {
    case "ended":
      return l10n.t("The reply from {0} was cut off: the stream ended before the reply was complete.", error.provider);
    case "malformed":
      return l10n.t("The reply from {0} was cut off: the stream sent an unreadable chunk.", error.provider);
    case "dropped":
      return l10n.t("The reply from {0} was cut off: the connection dropped.", error.provider);
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
