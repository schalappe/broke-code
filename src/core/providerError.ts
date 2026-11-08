/**
 * @module providerError
 * Typed provider failures. Each kind gets its own message in chat; none is a catch-all.
 */

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
   * Other non-2xx. `detail` = `error.message` of JSON body, else raw body truncated; may be empty.
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
  | { kind: "invalidResponse"; provider: string; detail: string; encoding?: string };
