/**
 * @module providerError
 * Typed failures of a reply: the provider's, and `internal`, a bug in broke-code itself. Each kind gets its own
 * message in chat; none is a catch-all. The wording here imports nothing from `vscode` or `node:`, since the webview
 * loads it.
 */
import type { Translator } from "./modelList";

export type CutOffReason =
  /** Stream closed before `[DONE]` or a `finish_reason`. */
  | "ended"
  /** Chunk not valid JSON, or a recognized field with the wrong shape or type. */
  | "malformed"
  /** Network failed while reading reply stream. */
  | "dropped"
  /** Network failed while reading model list body. */
  | "listDropped"
  /** Reply, or one of its stream events, exceeded the size limit; stream cancelled. */
  | "tooLarge"
  /** Model list body exceeded the size limit; download cancelled. */
  | "listTooLarge"
  /** Provider sent `{ error }` event mid-stream. */
  | "providerError";

/** Why a provider's CA file was refused. Checked when the provider is used, before any request. */
export type CaFileProblem =
  /** Neither absolute nor `~/…`: there is no folder it could be relative to. */
  | "relative"
  /** File could not be read; `cause` = runtime error text. */
  | "unreadable"
  /** No `CERTIFICATE` PEM block, or one that does not parse; `cause` says which. */
  | "notPem";

export type ProviderError =
  /** No response: DNS, connection refused, timeout, TLS other than certificate trust. `cause` = runtime error text. */
  | { kind: "unreachable"; provider: string; baseUrl: string; cause: string }
  /** Server certificate not trusted: unknown issuer, self-signed, expired, hostname mismatch. `code` = OpenSSL or Node code. */
  | { kind: "certificate"; provider: string; baseUrl: string; code: string }
  /** CA file setting unusable; no request was sent. */
  | { kind: "caFileInvalid"; provider: string; path: string; reason: CaFileProblem; cause?: string }
  /**
   * HTTP 3xx. Redirects never followed: a 307/308 would resend the conversation, and any redirect would send a request
   * to an address the user never configured. `location` = raw `Location` header, truncated; may be empty.
   */
  | { kind: "redirected"; provider: string; status: number; location: string }
  /** HTTP 401 or 403. */
  | { kind: "invalidKey"; provider: string; status: number }
  /**
   * Other non-2xx: a 4xx refusal, or a 5xx failure of the provider. `detail` = `error.message` of JSON body, else raw body truncated; may be empty.
   * `bodyReadError` set when body download failed (then `detail` empty).
   */
  | { kind: "rejected"; provider: string; status: number; detail: string; bodyReadError?: string }
  /** Body broke after 2xx: reply stream, or model list download (`list*`). Partial reply text kept by caller. */
  | { kind: "cutOff"; provider: string; reason: CutOffReason; cause?: string }
  /**
   * 2xx model listing whose body is not `{ data: [{ id }] }` with non-empty string ids. Usually wrong base URL.
   * `encoding` set instead (any request, `detail` empty) when the body uses a `Content-Encoding` other than
   * gzip, deflate, or br.
   */
  | { kind: "invalidResponse"; provider: string; detail: string; encoding?: string }
  /**
   * Not the provider's: an unexpected exception inside the agent turn, a bug. `message` = the exception's message;
   * its stack goes to the log.
   */
  | { kind: "internal"; message: string };

/** `message`: localized sentence naming provider. `detail`: raw technical text from provider or runtime. */
export type ErrorText = { message: string; detail?: string };

/**
 * The wording of a provider error, as the chat panel and the host's notifications show it, translated by `l10n`
 * (`@vscode/l10n` in the webview, `vscode.l10n` in the host). Callers name it `l10n` so the localization test finds
 * its keys.
 */
export function describeProviderError(error: ProviderError, l10n: Translator): ErrorText {
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
      return { message: caFileMessage(error, l10n), ...(error.cause ? { detail: error.cause } : {}) };
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
        // [>]: A 5xx is the provider failing, such as a gateway down, not a refusal of what was sent.
        message:
          error.status >= 500
            ? l10n.t("{0} failed to answer the request (HTTP {1}).", error.provider, error.status)
            : l10n.t("{0} rejected the request (HTTP {1}).", error.provider, error.status),
        ...rejectedDetail(error, l10n),
      };
    case "cutOff":
      return { message: cutOffMessage(error, l10n), ...(error.cause ? { detail: error.cause } : {}) };
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

function rejectedDetail(error: ProviderError & { kind: "rejected" }, l10n: Translator): { detail?: string } {
  if (error.bodyReadError !== undefined)
    return { detail: l10n.t("The response body could not be read: {0}", error.bodyReadError) };
  return error.detail ? { detail: error.detail } : {};
}

function caFileMessage(error: ProviderError & { kind: "caFileInvalid" }, l10n: Translator): string {
  switch (error.reason) {
    case "relative":
      return l10n.t("The CA file of {0} must be an absolute path or start with ~/: {1}", error.provider, error.path);
    case "unreadable":
      return l10n.t("The CA file of {0} could not be read: {1}", error.provider, error.path);
    case "notPem":
      return l10n.t("The CA file of {0} is not a PEM certificate: {1}", error.provider, error.path);
  }
}

function cutOffMessage(error: ProviderError & { kind: "cutOff" }, l10n: Translator): string {
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
