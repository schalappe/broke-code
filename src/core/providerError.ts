/**
 * @module providerError
 * Typed provider failures. Each kind gets its own message in chat; none is a catch-all.
 */

export type CutOffReason =
  /** Stream closed before `[DONE]` or a `finish_reason`. */
  | "ended"
  /** Chunk not valid JSON. */
  | "malformed"
  /** Network failed while reading body. */
  | "dropped"
  /** Provider sent `{ error }` event mid-stream. */
  | "providerError";

export type ProviderError =
  /** No response: DNS, connection refused, timeout, TLS. `cause` = runtime error text. */
  | { kind: "unreachable"; provider: string; baseUrl: string; cause: string }
  /** HTTP 401 or 403. */
  | { kind: "invalidKey"; provider: string; status: number }
  /**
   * Other non-2xx. `detail` = `error.message` of JSON body, else raw body truncated; may be empty.
   * `bodyReadError` set when body download failed (then `detail` empty).
   */
  | { kind: "rejected"; provider: string; status: number; detail: string; bodyReadError?: string }
  /** Body broke after 2xx: reply stream, or model list download (`dropped`). Partial reply text kept by caller. */
  | { kind: "cutOff"; provider: string; reason: CutOffReason; cause?: string }
  /** 2xx model listing whose body is not `{ data: [{ id }] }`. Usually wrong base URL. */
  | { kind: "invalidResponse"; provider: string; detail: string };
