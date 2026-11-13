/**
 * @module client
 * Provider HTTP client: `GET {baseUrl}/models`, streaming `POST {baseUrl}/chat/completions`.
 * Never sends `tools`, never reads `tool_calls` (ADR 0001). Failures returned as typed values, never thrown.
 * Asks for usage (`stream_options`) and reads the counts a reply reports; a model that refuses the field gets one
 * resend without it, remembered in `ProviderSupport`, which a completed reply's prompt tokens also teach the model's
 * characters per token.
 * Only module that knows the reasoning wire shapes: callers see the reasoning and the answer apart.
 * One network path for every request: `http`/`https` requests, with the provider's CA trust (see `tls`).
 */
// [>]: VS Code patches these builtins in place (proxy, OS certificates), so the `node:` form carries the patch too.
import * as http from "node:http";
import * as https from "node:https";
import type { LookupFunction } from "node:net";
import { pipeline, Readable, Transform } from "node:stream";
import * as zlib from "node:zlib";
import { charactersOf } from "./limits";
import type { Translator } from "./modelList";
import { REPLY_MAX_LENGTH, type ReasoningEffort, type ReportedUsage } from "./protocol";
import { type CutOffReason, describeProviderError, type ErrorText, type ProviderError } from "./providerError";
import type { ProviderSupport } from "./providerSupport";
import type { Provider } from "./providers";
import { readSseData, SseEventTooLargeError } from "./sse";
import { certificateErrorCode, providerTrust } from "./tls";

export type ProviderAccess = {
  provider: Provider;
  /** Absent or empty -> no `Authorization` header. */
  apiKey: string | undefined;
};

/**
 * The provider and model selected in the chat, that provider's key, and the model's context size in tokens, read when
 * a command outside the chat (the commit message, "Edit selection") starts its run and kept for that run.
 */
/** The chat's provider and model as another command uses them, with the reasoning effort picked for the model. */
export type ChatModel = {
  access: ProviderAccess;
  model: string;
  contextSize: number;
  reasoningEffort?: ReasoningEffort;
};

/** `system`: the system prompt, sent first. Tool results go back as `user` messages, never as the `tool` role (ADR 0001). */
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type HttpRequest = { url: string; method: "GET" | "POST"; headers: Record<string, string>; body?: string };

export type ModelListing = { ok: true; models: string[] } | { ok: false; error: ProviderError };

/** `usage`: the counts the reply reported, when it reported valid ones. */
export type ChatOutcome =
  | { status: "done"; usage?: ReportedUsage }
  | { status: "stopped" }
  | { status: "failed"; error: ProviderError };

const DETAIL_LIMIT = 500;

// Size caps on provider-controlled bodies, enforced while reading: everything lives in the shared extension host.
// Generous on purpose: a real model list or reply stays far below them.
/** `GET /models` body. Large gateways list hundreds of models with metadata, about 1 MB. */
export const MODEL_LIST_MAX_BYTES = 8 * 1024 * 1024;
/** Non-2xx body; only its first `DETAIL_LIMIT` characters are shown. */
const ERROR_BODY_MAX_BYTES = 64 * 1024;
/** Deadline for the response headers (DNS, connect, TLS included), then for each gap between body bytes. Node `fetch` used 300 s too. */
const TIMEOUT_MS = 300_000;

/** Network tuning for tests only; production requests use the defaults. */
export type NetworkOptions = {
  /** Replaces `TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Replaces the system host name resolution. */
  lookup?: LookupFunction;
};

/**
 * Build streaming chat request. Body: `model`, `messages`, `stream: true`, `reasoning_effort` when one is picked, and,
 * when `askUsage`, `stream_options: { include_usage: true }`, which asks the provider to end the stream with the
 * reply's token counts. No `tools` key, ever.
 */
export function buildChatRequest(
  access: ProviderAccess,
  model: string,
  messages: ChatMessage[],
  askUsage: boolean,
  reasoningEffort?: ReasoningEffort,
): HttpRequest {
  const body = {
    model,
    messages: messages.map(({ role, content }) => ({ role, content })),
    stream: true,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(askUsage ? { stream_options: { include_usage: true } } : {}),
  };
  return {
    url: `${access.provider.baseUrl}/chat/completions`,
    method: "POST",
    headers: { ...authorization(access.apiKey), "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  };
}

/** List model ids of provider. */
export async function listModels(access: ProviderAccess, network: NetworkOptions = {}): Promise<ModelListing> {
  const { provider } = access;
  const request: HttpRequest = {
    url: `${provider.baseUrl}/models`,
    method: "GET",
    headers: { ...authorization(access.apiKey), Accept: "application/json" },
  };
  const sent = await send(access, request, network);
  if (!sent.ok) return { ok: false, error: sent.error };

  const read = await readText(sent.response.body, MODEL_LIST_MAX_BYTES);
  if (!read.ok)
    return { ok: false, error: { kind: "cutOff", provider: provider.name, reason: "listDropped", cause: read.cause } };
  if (!read.complete) return { ok: false, error: { kind: "cutOff", provider: provider.name, reason: "listTooLarge" } };
  const body = read.text;
  const models = parseModelIds(body);
  if (!models)
    return { ok: false, error: { kind: "invalidResponse", provider: provider.name, detail: truncate(body) } };
  return { ok: true, models };
}

export type StreamChatOptions = {
  model: string;
  messages: ChatMessage[];
  /**
   * Sent as `reasoning_effort`; absent sends no field. A provider that rejects it answers with an error the user sees,
   * never retried without it: the user picked it, and Default is one click away.
   */
  reasoningEffort?: ReasoningEffort;
  /** Abort -> outcome `stopped`, never `cutOff`. */
  signal: AbortSignal;
  /**
   * Which models take the usage field, read to build the request and taught by its answer, and each model's characters
   * per token, taught by a completed reply's prompt tokens. One per extension host.
   */
  support: ProviderSupport;
  /** Called with each non-empty piece of the answer, in order. Answer starts at its first non-blank line. */
  onContent: (text: string) => void;
  /** Called with each non-empty piece of the reasoning, in order, tags removed. */
  onReasoning: (text: string) => void;
  network?: NetworkOptions;
};

/** One reply read whole: its answer, a stop (abort or Cancel), or a provider error in the chat's wording. */
export type CollectedReply = { kind: "reply"; text: string } | { kind: "stopped" } | { kind: "error"; text: ErrorText };

/**
 * Send one request through `stream` (`streamChat`, or a test double) and collect its answer whole, for a request
 * outside the chat; the reasoning is dropped. An aborted `signal` is `stopped` whatever the outcome; a failure is
 * worded by `describeProviderError`.
 */
export async function collectReply(
  stream: (access: ProviderAccess, options: StreamChatOptions) => Promise<ChatOutcome>,
  access: ProviderAccess,
  options: Omit<StreamChatOptions, "onContent" | "onReasoning">,
  l10n: Translator,
): Promise<CollectedReply> {
  let reply = "";
  const outcome = await stream(access, {
    ...options,
    onContent: (text) => {
      reply += text;
    },
    onReasoning: () => {},
  });
  if (options.signal.aborted || outcome.status === "stopped") return { kind: "stopped" };
  if (outcome.status === "failed") return { kind: "error", text: describeProviderError(outcome.error, l10n) };
  return { kind: "reply", text: reply };
}

/**
 * Stream chat reply, split into reasoning and answer. Reasoning: `delta.reasoning` (Ollama),
 * `delta.reasoning_content` (vLLM-style), and a `<think>…</think>` block opening the content. `<think>` later in
 * the content is answer text. Unclosed `<think>` -> whole content is reasoning, answer empty.
 * Complete when `[DONE]` arrives, or stream ends after a `finish_reason`.
 * Reply over `REPLY_MAX_LENGTH`, or one event over the SSE cap -> cut off (`tooLarge`), stream cancelled.
 * Text held back to recognize a split tag is flushed before any outcome returns.
 * The request asks for usage unless the model refuses the field (see `openStream`). A completed reply's outcome carries
 * the last valid usage a chunk reported, whether or not the request asked for it: a proxy may add it by itself. Its
 * prompt tokens, against the characters of the messages sent, teach the model's ratio (`ProviderSupport.learnRatio`)
 * before the outcome returns, so every request teaches it alike: a turn's, a summary's, a commit message's. A stopped,
 * cut, or failed reply teaches nothing.
 */
export async function streamChat(access: ProviderAccess, options: StreamChatOptions): Promise<ChatOutcome> {
  const splitter = new ReplySplitter(options.onReasoning, options.onContent);
  const outcome = await readReply(access, options, splitter);
  splitter.flush();
  if (outcome.status === "done" && outcome.usage) {
    options.support.learnRatio(access.provider, options.model, charactersOf(options.messages), outcome.usage.prompt);
  }
  return outcome;
}

async function readReply(
  access: ProviderAccess,
  options: StreamChatOptions,
  splitter: ReplySplitter,
): Promise<ChatOutcome> {
  const { signal } = options;
  const provider = access.provider.name;
  const sent = await openStream(access, options);
  if (!sent.ok) return signal.aborted ? { status: "stopped" } : { status: "failed", error: sent.error };

  const body = sent.response.body;
  const cutOff = (reason: CutOffReason, cause?: string): ChatOutcome => ({
    status: "failed",
    error: cause === undefined ? { kind: "cutOff", provider, reason } : { kind: "cutOff", provider, reason, cause },
  });

  let finished = false;
  let length = 0;
  let usage: ReportedUsage | undefined;
  const done = (): ChatOutcome => (usage === undefined ? { status: "done" } : { status: "done", usage });
  try {
    for await (const data of readSseData(body)) {
      // [!]: Check before each event: buffered events (even `[DONE]`) must not override a Stop.
      if (signal.aborted) return { status: "stopped" };
      if (data === "[DONE]") return done();
      const chunk = parseChunk(data);
      if (chunk.kind === "malformed") return cutOff("malformed", truncate(data));
      if (chunk.kind === "error") return cutOff("providerError", chunk.message);
      if (chunk.usage) usage = chunk.usage;
      length += chunk.reasoning.length + chunk.content.length;
      if (length > REPLY_MAX_LENGTH) return cutOff("tooLarge");
      if (chunk.reasoning) options.onReasoning(chunk.reasoning);
      if (chunk.content) splitter.push(chunk.content);
      if (chunk.finished) finished = true;
    }
  } catch (error) {
    if (signal.aborted) return { status: "stopped" };
    if (error instanceof SseEventTooLargeError) return cutOff("tooLarge");
    return cutOff("dropped", describeError(error));
  } finally {
    body.cancel().catch(() => {
      // [>]: Body already closed or errored; nothing left to release.
    });
  }
  if (signal.aborted) return { status: "stopped" };
  return finished ? done() : cutOff("ended");
}

/** Statuses a provider may answer the usage field with when it does not take it; nothing in them says which field. */
const FIELD_REFUSAL_STATUSES = new Set([400, 422]);

/**
 * Send the chat request and return its started stream or its error. The request carries the usage field unless the
 * model refuses it. A 400 or 422 to a request with the field, while the model has not accepted the field and the user
 * has not stopped, is sent once more without it; a started stream then marks the model `refuses`. A started stream to
 * a request with the field marks it `accepts`. Any other answer is sent once, and a second failure is reported as is.
 */
async function openStream(access: ProviderAccess, options: StreamChatOptions): Promise<Sent> {
  const { model, messages, signal, support, reasoningEffort } = options;
  const { provider } = access;
  const network = options.network ?? {};
  const askUsage = support.usageField(provider, model) !== "refuses";
  const exchanged = await exchange(
    access,
    buildChatRequest(access, model, messages, askUsage, reasoningEffort),
    network,
    signal,
  );
  if (!exchanged.ok) return exchanged;
  const { response } = exchanged;
  // [!]: Recognized by its status alone, before `classify` looks at the encoding. The model's state is read again now,
  // not taken from when the request left: a stream started meanwhile for another request may have proved the field.
  const refused =
    askUsage && FIELD_REFUSAL_STATUSES.has(response.status) && support.usageField(provider, model) !== "accepts";
  if (!refused) {
    const sent = await classify(provider.name, response);
    if (sent.ok && askUsage) support.usageFieldAccepted(provider, model);
    return sent;
  }
  // [>]: Read to its end before the resend, so a Stop while it arrives sends nothing more. The model's state is read
  // once more after it: another request's stream may have proved the field meanwhile, and the 400 is then final. Its
  // text is shown only in these two cases; the resend's answer is otherwise what the user sees.
  const read = await readText(response.body, ERROR_BODY_MAX_BYTES);
  if (signal.aborted || support.usageField(provider, model) === "accepts") {
    const detail = read.ok ? errorDetail(read.text) : "";
    return { ok: false, error: { kind: "rejected", provider: provider.name, status: response.status, detail } };
  }
  const resent = await send(access, buildChatRequest(access, model, messages, false, reasoningEffort), network, signal);
  if (resent.ok) support.usageFieldRefused(provider, model);
  return resent;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * Streaming split of `delta.content` into reasoning (leading `<think>` block) and answer. Holds back only what a
 * tag split across deltas, or the blank lines opening the answer, still needs; everything else passes on at once.
 */
class ReplySplitter {
  private phase: "start" | "reasoning" | "answerStart" | "answer" = "start";
  private held = "";

  constructor(
    private readonly onReasoning: (text: string) => void,
    private readonly onAnswer: (text: string) => void,
  ) {}

  push(text: string): void {
    this.held += text;
    if (this.phase === "start") {
      const lead = this.held.trimStart();
      if (lead.length < THINK_OPEN.length && THINK_OPEN.startsWith(lead)) return;
      if (lead.startsWith(THINK_OPEN)) {
        this.phase = "reasoning";
        this.held = lead.slice(THINK_OPEN.length);
      } else {
        this.phase = "answerStart";
      }
    }
    if (this.phase === "reasoning") {
      const close = this.held.indexOf(THINK_CLOSE);
      if (close === -1) {
        const keep = partialSuffix(this.held, THINK_CLOSE);
        this.emit(this.onReasoning, this.held.slice(0, this.held.length - keep));
        this.held = this.held.slice(this.held.length - keep);
        return;
      }
      this.emit(this.onReasoning, this.held.slice(0, close));
      this.held = this.held.slice(close + THINK_CLOSE.length);
      this.phase = "answerStart";
    }
    if (this.phase === "answerStart") {
      const answer = withoutLeadingBlankLines(this.held);
      if (answer === undefined) return;
      this.held = answer;
      this.phase = "answer";
    }
    this.emit(this.onAnswer, this.held);
    this.held = "";
  }

  /** End of stream: text held for a possible tag is what it looked like; blank lines alone are no answer. */
  flush(): void {
    if (this.phase === "start") this.emit(this.onAnswer, withoutLeadingBlankLines(this.held) ?? "");
    if (this.phase === "reasoning") this.emit(this.onReasoning, this.held);
    this.held = "";
  }

  private emit(callback: (text: string) => void, text: string): void {
    if (text) callback(text);
  }
}

/**
 * The reasoning a reply streamed as content: a chat template that opens `<think>` in the prompt (Qwen 3.8 on vLLM
 * without a reasoning parser, #58) makes the model reason without the opening tag and close with a bare `</think>`. The
 * first `</think>` standing alone on its line, with no `<think>` before it, ends the reasoning: the text before it is
 * the reasoning, trimmed at its end, and the text after it, less its leading blank lines, the answer. `undefined` when
 * `content` holds no such line. Callers apply it only to a reply that has no reasoning yet, since a leading `<think>`
 * block or a reasoning field already split it.
 */
export function lateReasoning(content: string): { reasoning: string; answer: string } | undefined {
  const close = /^[ \t]*<\/think>[ \t]*$/m.exec(content);
  if (!close) return undefined;
  if (content.lastIndexOf(THINK_OPEN, close.index) !== -1) return undefined;
  const answer = withoutLeadingBlankLines(content.slice(close.index + close[0].length)) ?? "";
  return { reasoning: content.slice(0, close.index).trimEnd(), answer };
}

/**
 * `text` from its first non-blank line, that line's indentation kept (indented code block); `undefined` when
 * `text` is all whitespace.
 */
function withoutLeadingBlankLines(text: string): string | undefined {
  const visible = text.search(/\S/);
  if (visible === -1) return undefined;
  return text.slice(text.lastIndexOf("\n", visible) + 1);
}

/** Length of the longest end of `text` that starts `tag`, without being all of it. */
function partialSuffix(text: string, tag: string): number {
  for (let length = Math.min(text.length, tag.length - 1); length > 0; length--) {
    if (tag.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}

/**
 * Response as the client needs it: status, redirect target, and the decoded body, read under its caps by the caller.
 * `unsupportedEncoding` set when the body uses a `Content-Encoding` the client cannot decode; `body` is then raw.
 */
type ProviderResponse = {
  status: number;
  location: string | undefined;
  body: ReadableStream<Uint8Array>;
  unsupportedEncoding?: string;
};

/** `Accept-Encoding` sent with every request, as Node `fetch` did; one decoder per value. */
const ACCEPT_ENCODING = "gzip, deflate, br";
// [!]: A `Map`, not an object literal: `Content-Encoding: __proto__` must not find an inherited property.
const DECODERS = new Map<string, () => NodeJS.ReadWriteStream>([
  ["gzip", zlib.createGunzip],
  ["x-gzip", zlib.createGunzip],
  ["deflate", zlib.createInflate],
  ["br", zlib.createBrotliDecompress],
]);

type Sent = { ok: true; response: ProviderResponse } | { ok: false; error: ProviderError };

/**
 * Send request with the provider's CA trust and classify non-2xx. Caller checks own signal to tell stop from
 * unreachable. Redirects never followed: only the configured base URL receives requests, key, and conversation.
 */
async function send(
  access: ProviderAccess,
  request: HttpRequest,
  network: NetworkOptions,
  signal?: AbortSignal,
): Promise<Sent> {
  const exchanged = await exchange(access, request, network, signal);
  return exchanged.ok ? await classify(access.provider.name, exchanged.response) : exchanged;
}

/** Send request with the provider's CA trust; the response whatever its status, or why none came. */
async function exchange(
  access: ProviderAccess,
  request: HttpRequest,
  network: NetworkOptions,
  signal?: AbortSignal,
): Promise<Sent> {
  const { name, baseUrl } = access.provider;
  const trust = await providerTrust(access.provider);
  if (!trust.ok) return trust;
  try {
    return { ok: true, response: await transmit(request, trust.ca, network, signal) };
  } catch (error) {
    const code = certificateErrorCode(error);
    if (code !== undefined) return { ok: false, error: { kind: "certificate", provider: name, baseUrl, code } };
    return { ok: false, error: { kind: "unreachable", provider: name, baseUrl, cause: describeError(error) } };
  }
}

/** A 2xx response the client can decode, or the error its status, encoding, or body gives. */
async function classify(name: string, response: ProviderResponse): Promise<Sent> {
  const { status } = response;
  const redirected = status >= 300 && status < 400;
  if (redirected || status === 401 || status === 403) {
    // [>]: Neither message shows the body -> release it unread.
    release(response.body);
    if (redirected) {
      return {
        ok: false,
        error: { kind: "redirected", provider: name, status, location: truncate(response.location ?? "") },
      };
    }
    return { ok: false, error: { kind: "invalidKey", provider: name, status } };
  }
  if (response.unsupportedEncoding !== undefined) {
    release(response.body);
    return {
      ok: false,
      error: { kind: "invalidResponse", provider: name, detail: "", encoding: response.unsupportedEncoding },
    };
  }
  if (status >= 200 && status < 300) return { ok: true, response };
  const read = await readText(response.body, ERROR_BODY_MAX_BYTES);
  if (!read.ok)
    return { ok: false, error: { kind: "rejected", provider: name, status, detail: "", bodyReadError: read.cause } };
  return { ok: false, error: { kind: "rejected", provider: name, status, detail: errorDetail(read.text) } };
}

/**
 * One HTTP exchange. Resolves on response headers; the body streams after. `ca: undefined` sends no `ca` key at all,
 * so VS Code's patch adds the OS store as it does for any extension request.
 * Rejects on DNS, connect, TLS, abort, and no headers within the timeout. After headers, the body stream errors
 * when no byte arrives for the timeout.
 */
function transmit(
  request: HttpRequest,
  ca: string[] | undefined,
  network: NetworkOptions,
  signal: AbortSignal | undefined,
): Promise<ProviderResponse> {
  const transport = new URL(request.url).protocol === "https:" ? https : http;
  const headers = {
    ...request.headers,
    "Accept-Encoding": ACCEPT_ENCODING,
    ...(request.body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(request.body)) }),
  };
  const timeoutMs = network.timeoutMs ?? TIMEOUT_MS;
  const seconds = timeoutMs / 1000;
  return new Promise((resolve, reject) => {
    let received: http.IncomingMessage | undefined;
    // [>]: Throws synchronously on an invalid header (an API key with a newline): the promise rejects, no timer armed.
    const outgoing = transport.request(
      request.url,
      {
        method: request.method,
        headers,
        ...(ca ? { ca } : {}),
        ...(signal ? { signal } : {}),
        ...(network.lookup ? { lookup: network.lookup } : {}),
      },
      (incoming) => {
        received = incoming;
        timer.refresh();
        incoming.once("close", () => clearTimeout(timer));
        try {
          resolve(responseOf(incoming, () => timer.refresh()));
        } catch (error) {
          // [!]: Thrown here, an error would escape the client as an uncaught exception.
          incoming.destroy();
          reject(error);
        }
      },
    );
    // [!]: One timer from the start, not the socket's idle timeout: that one is armed only once connected, so a
    // stalled DNS lookup would hang forever. Re-armed by each body chunk once headers arrive.
    const timer = setTimeout(() => {
      if (received) received.destroy(timeoutError(`no data from the provider for ${seconds} s`));
      else outgoing.destroy(timeoutError(`timed out: no response from the provider within ${seconds} s`));
    }, timeoutMs);
    // [>]: After headers, errors surface through the body stream; this rejection is then a no-op.
    outgoing.on("error", (error) => {
      if (!received) clearTimeout(timer);
      reject(error);
    });
    outgoing.end(request.body);
  });
}

/**
 * Response of `incoming` with its body decoded. `onChunk` runs for each raw body chunk, to re-arm the idle timer.
 * Content codings are case-insensitive (RFC 9110 8.4.1). One coding is supported; a list of several, like any coding
 * outside `DECODERS`, is reported as unsupported.
 */
function responseOf(incoming: http.IncomingMessage, onChunk: () => void): ProviderResponse {
  const response = { status: incoming.statusCode ?? 0, location: incoming.headers.location };
  const encoding = incoming.headers["content-encoding"]?.trim().toLowerCase() || "identity";
  const decoder = DECODERS.get(encoding);
  if (encoding !== "identity" && decoder === undefined) {
    return { ...response, body: webStream(incoming), unsupportedEncoding: encoding };
  }
  const watch = new Transform({
    transform(chunk, _encoding, done) {
      onChunk();
      done(null, chunk);
    },
  });
  // [&]: `pipeline` destroys every stream when one fails or the last is cancelled, so a cap (counted on decoded
  // bytes) or a Stop ends the download too.
  const body = decoder === undefined ? pipeline(incoming, watch, noop) : pipeline(incoming, watch, decoder(), noop);
  return { ...response, body: webStream(body) };
}

function timeoutError(message: string): Error {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" });
}

/** `toWeb` cancel destroys the Node stream, so cancelling the body ends the download. */
function webStream(stream: Readable | NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream as Readable) as unknown as ReadableStream<Uint8Array>;
}

function release(body: ReadableStream<Uint8Array>): void {
  body.cancel().catch(noop);
}

/** [>]: Errors already reach the caller through the stream it reads; this callback has nothing left to do. */
function noop(): void {}

type TextRead = { ok: true; text: string; complete: boolean } | { ok: false; cause: string };

/**
 * Read body as UTF-8 text, at most `maxBytes`. Over the cap -> download cancelled, `complete: false`,
 * `text` = first `maxBytes` bytes.
 */
async function readText(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<TextRead> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { ok: true, text: text + decoder.decode(), complete: true };
      if (bytes + value.byteLength > maxBytes) {
        reader.cancel().catch(() => {
          // [>]: Body already closed or errored; nothing left to release.
        });
        return { ok: true, text: text + decoder.decode(value.subarray(0, maxBytes - bytes)), complete: false };
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    return { ok: false, cause: describeError(error) };
  }
}

function authorization(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

type Chunk =
  | { kind: "delta"; reasoning: string; content: string; finished: boolean; usage?: ReportedUsage }
  | { kind: "error"; message: string }
  | { kind: "malformed" };

/**
 * Validate fields read from chunk. Absent or `null` fields fine (role-only, reasoning-only, usage-only,
 * empty `choices`); present with wrong type -> malformed, never silently dropped.
 * `reasoning` = `delta.reasoning` then `delta.reasoning_content`; a server sends one or the other.
 * `usage` is the exception: read from any chunk, with or without choices, and ignored when it is not two counts, since
 * it is advisory and must never cut a reply off (see `reportedUsage`).
 */
function parseChunk(data: string): Chunk {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { kind: "malformed" };
  }
  if (!isRecord(value)) return { kind: "malformed" };
  if (!isAbsent(value.error))
    return { kind: "error", message: errorMessage(value.error) ?? JSON.stringify(value.error) };

  const usage = reportedUsage(value.usage);
  const empty: Chunk = { kind: "delta", reasoning: "", content: "", finished: false, ...(usage ? { usage } : {}) };
  if (isAbsent(value.choices)) return empty;
  if (!Array.isArray(value.choices)) return { kind: "malformed" };
  const choice: unknown = value.choices[0];
  if (choice === undefined) return empty;
  if (!isRecord(choice)) return { kind: "malformed" };

  const delta = isAbsent(choice.delta) ? {} : choice.delta;
  if (!isRecord(delta)) return { kind: "malformed" };
  const fields = [delta.content, delta.reasoning, delta.reasoning_content, choice.finish_reason].map((field) =>
    isAbsent(field) ? "" : field,
  );
  if (!fields.every((field) => typeof field === "string")) return { kind: "malformed" };
  const [content, reasoning, reasoningContent, finishReason] = fields as string[];
  return { ...empty, reasoning: reasoning! + reasoningContent!, content: content!, finished: finishReason !== "" };
}

/** `prompt_tokens` and `completion_tokens` of a chunk's `usage` when both are non-negative safe integers. */
function reportedUsage(usage: unknown): ReportedUsage | undefined {
  if (!isRecord(usage)) return undefined;
  const { prompt_tokens: prompt, completion_tokens: completion } = usage;
  return isCount(prompt) && isCount(completion) ? { prompt, completion } : undefined;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isAbsent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

function parseModelIds(body: string): string[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined;
  // [!]: Empty id rejected: the panel would treat "" as a chosen model while send refuses it.
  const ids = value.data.map((model: unknown) =>
    isRecord(model) && typeof model.id === "string" && model.id !== "" ? model.id : undefined,
  );
  return ids.every((id) => id !== undefined) ? ids : undefined;
}

/** `error.message` of `{ error: { message } }` (OpenAI, Ollama), else raw body truncated. */
function errorDetail(body: string): string {
  try {
    const value: unknown = JSON.parse(body);
    const message = isRecord(value) ? errorMessage(value.error) : undefined;
    if (message) return truncate(message);
  } catch {
    // [>]: Not JSON -> raw body below.
  }
  return truncate(body.trim());
}

function errorMessage(error: unknown): string | undefined {
  return isRecord(error) && typeof error.message === "string" ? error.message : undefined;
}

/** Message of error plus its `cause` chain, e.g. `fetch failed: connect ECONNREFUSED 127.0.0.1:1`. */
function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && parts.length < 5) {
    const message = current instanceof Error ? current.message : String(current);
    if (message && !parts.includes(message)) parts.push(message);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(": ");
}

function truncate(text: string): string {
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
