/**
 * @module client
 * Provider HTTP client: `GET {baseUrl}/models`, streaming `POST {baseUrl}/chat/completions`.
 * Never sends `tools`, never reads `tool_calls` (ADR 0001). Failures returned as typed values, never thrown.
 * Only module that knows the reasoning wire shapes: callers see the reasoning and the answer apart.
 * One network path for every request: `http`/`https` requests, with the provider's CA trust (see `tls`).
 */
// [>]: VS Code patches these builtins in place (proxy, OS certificates), so the `node:` form carries the patch too.
import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";
import type { Provider } from "./providers";
import type { CutOffReason, ProviderError } from "./providerError";
import { readSseData, SseEventTooLargeError } from "./sse";
import { certificateErrorCode, providerTrust } from "./tls";

export type ProviderAccess = {
  provider: Provider;
  /** Absent or empty -> no `Authorization` header. */
  apiKey: string | undefined;
};

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type HttpRequest = { url: string; method: "GET" | "POST"; headers: Record<string, string>; body?: string };

export type ModelListing = { ok: true; models: string[] } | { ok: false; error: ProviderError };

export type ChatOutcome = { status: "done" } | { status: "stopped" } | { status: "failed"; error: ProviderError };

const DETAIL_LIMIT = 500;

// Size caps on provider-controlled bodies, enforced while reading: everything lives in the shared extension host.
// Generous on purpose: a real model list or reply stays far below them.
/** `GET /models` body. Large gateways list hundreds of models with metadata, about 1 MB. */
export const MODEL_LIST_MAX_BYTES = 8 * 1024 * 1024;
/** Non-2xx body; only its first `DETAIL_LIMIT` characters are shown. */
const ERROR_BODY_MAX_BYTES = 64 * 1024;
/** Total `delta.content` plus reasoning fields of one reply, in UTF-16 code units. */
export const REPLY_MAX_LENGTH = 4 * 1024 * 1024;
/** No byte received for this long, waiting for headers or mid-body -> request ended. Matches Node `fetch` defaults. */
const IDLE_TIMEOUT_MS = 300_000;

/**
 * Build streaming chat request. Body: `model`, `messages`, `stream: true`. No `tools` key, ever.
 */
export function buildChatRequest(access: ProviderAccess, model: string, messages: ChatMessage[]): HttpRequest {
  return {
    url: `${access.provider.baseUrl}/chat/completions`,
    method: "POST",
    headers: { ...authorization(access.apiKey), "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ model, messages: messages.map(({ role, content }) => ({ role, content })), stream: true }),
  };
}

/** List model ids of provider. */
export async function listModels(access: ProviderAccess): Promise<ModelListing> {
  const { provider } = access;
  const sent = await send(access, {
    url: `${provider.baseUrl}/models`,
    method: "GET",
    headers: { ...authorization(access.apiKey), Accept: "application/json" },
  });
  if (!sent.ok) return { ok: false, error: sent.error };

  const read = await readText(sent.response.body, MODEL_LIST_MAX_BYTES);
  if (!read.ok) return { ok: false, error: { kind: "cutOff", provider: provider.name, reason: "listDropped", cause: read.cause } };
  if (!read.complete) return { ok: false, error: { kind: "cutOff", provider: provider.name, reason: "listTooLarge" } };
  const body = read.text;
  const models = parseModelIds(body);
  if (!models) return { ok: false, error: { kind: "invalidResponse", provider: provider.name, detail: truncate(body) } };
  return { ok: true, models };
}

export type StreamChatOptions = {
  model: string;
  messages: ChatMessage[];
  /** Abort -> outcome `stopped`, never `cutOff`. */
  signal: AbortSignal;
  /** Called with each non-empty piece of the answer, in order. Answer starts at its first non-blank line. */
  onContent: (text: string) => void;
  /** Called with each non-empty piece of the reasoning, in order, tags removed. */
  onReasoning: (text: string) => void;
};

/**
 * Stream chat reply, split into reasoning and answer. Reasoning: `delta.reasoning` (Ollama),
 * `delta.reasoning_content` (vLLM-style), and a `<think>…</think>` block opening the content. `<think>` later in
 * the content is answer text. Unclosed `<think>` -> whole content is reasoning, answer empty.
 * Complete when `[DONE]` arrives, or stream ends after a `finish_reason`.
 * Reply over `REPLY_MAX_LENGTH`, or one event over the SSE cap -> cut off (`tooLarge`), stream cancelled.
 * Text held back to recognize a split tag is flushed before any outcome returns.
 */
export async function streamChat(access: ProviderAccess, options: StreamChatOptions): Promise<ChatOutcome> {
  const splitter = new ReplySplitter(options.onReasoning, options.onContent);
  const outcome = await readReply(access, options, splitter);
  splitter.flush();
  return outcome;
}

async function readReply(access: ProviderAccess, options: StreamChatOptions, splitter: ReplySplitter): Promise<ChatOutcome> {
  const { signal } = options;
  const provider = access.provider.name;
  const request = buildChatRequest(access, options.model, options.messages);
  const sent = await send(access, request, signal);
  if (!sent.ok) return signal.aborted ? { status: "stopped" } : { status: "failed", error: sent.error };

  const body = sent.response.body;
  const cutOff = (reason: CutOffReason, cause?: string): ChatOutcome => ({
    status: "failed",
    error: cause === undefined ? { kind: "cutOff", provider, reason } : { kind: "cutOff", provider, reason, cause },
  });

  let finished = false;
  let length = 0;
  try {
    for await (const data of readSseData(body)) {
      // [!]: Check before each event: buffered events (even `[DONE]`) must not override a Stop.
      if (signal.aborted) return { status: "stopped" };
      if (data === "[DONE]") return { status: "done" };
      const chunk = parseChunk(data);
      if (chunk.kind === "malformed") return cutOff("malformed", truncate(data));
      if (chunk.kind === "error") return cutOff("providerError", chunk.message);
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
  return finished ? { status: "done" } : cutOff("ended");
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

/** Response as the client needs it: status, redirect target, and the body, read under its caps by the caller. */
type ProviderResponse = { status: number; location: string | undefined; body: ReadableStream<Uint8Array> };

type Sent = { ok: true; response: ProviderResponse } | { ok: false; error: ProviderError };

/**
 * Send request with the provider's CA trust and classify non-2xx. Caller checks own signal to tell stop from
 * unreachable. Redirects never followed: only the configured base URL receives requests, key, and conversation.
 */
async function send(access: ProviderAccess, request: HttpRequest, signal?: AbortSignal): Promise<Sent> {
  const { name, baseUrl } = access.provider;
  const trust = await providerTrust(access.provider);
  if (!trust.ok) return trust;

  let response: ProviderResponse;
  try {
    response = await transmit(request, trust.ca, signal);
  } catch (error) {
    const code = certificateErrorCode(error);
    if (code !== undefined) return { ok: false, error: { kind: "certificate", provider: name, baseUrl, code } };
    return { ok: false, error: { kind: "unreachable", provider: name, baseUrl, cause: describeError(error) } };
  }
  const { status } = response;
  if (status >= 200 && status < 300) return { ok: true, response };

  const redirected = status >= 300 && status < 400;
  if (redirected || status === 401 || status === 403) {
    // [>]: Neither message shows the body -> release it unread.
    response.body.cancel().catch(() => {
      // [>]: Body already closed or errored; nothing left to release.
    });
    if (redirected) {
      return { ok: false, error: { kind: "redirected", provider: name, status, location: truncate(response.location ?? "") } };
    }
    return { ok: false, error: { kind: "invalidKey", provider: name, status } };
  }
  const read = await readText(response.body, ERROR_BODY_MAX_BYTES);
  if (!read.ok) return { ok: false, error: { kind: "rejected", provider: name, status, detail: "", bodyReadError: read.cause } };
  return { ok: false, error: { kind: "rejected", provider: name, status, detail: errorDetail(read.text) } };
}

/**
 * One HTTP exchange. Resolves on response headers; the body streams after. `ca: undefined` sends no `ca` key at all,
 * so VS Code's patch adds the OS store as it does for any extension request.
 * Rejects on DNS, connect, TLS, idle timeout, and abort before headers.
 */
function transmit(request: HttpRequest, ca: string[] | undefined, signal: AbortSignal | undefined): Promise<ProviderResponse> {
  const transport = new URL(request.url).protocol === "https:" ? https : http;
  const headers = request.body === undefined ? request.headers : { ...request.headers, "Content-Length": String(Buffer.byteLength(request.body)) };
  return new Promise((resolve, reject) => {
    const outgoing = transport.request(
      request.url,
      { method: request.method, headers, ...(ca ? { ca } : {}), ...(signal ? { signal } : {}) },
      (incoming) => {
        const location = incoming.headers.location;
        // [&]: `toWeb` cancel destroys the response socket, so a cap or Stop ends the download.
        const body = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>;
        resolve({ status: incoming.statusCode ?? 0, location, body });
      },
    );
    outgoing.setTimeout(IDLE_TIMEOUT_MS, () => {
      outgoing.destroy(Object.assign(new Error(`no data from the server for ${IDLE_TIMEOUT_MS / 1000} seconds`), { code: "ETIMEDOUT" }));
    });
    // [>]: After headers, errors surface through the body stream; this rejection is then a no-op.
    outgoing.on("error", reject);
    outgoing.end(request.body);
  });
}

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
  | { kind: "delta"; reasoning: string; content: string; finished: boolean }
  | { kind: "error"; message: string }
  | { kind: "malformed" };

/**
 * Validate fields read from chunk. Absent or `null` fields fine (role-only, reasoning-only, usage-only,
 * empty `choices`); present with wrong type -> malformed, never silently dropped.
 * `reasoning` = `delta.reasoning` then `delta.reasoning_content`; a server sends one or the other.
 */
function parseChunk(data: string): Chunk {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { kind: "malformed" };
  }
  if (!isRecord(value)) return { kind: "malformed" };
  if (!isAbsent(value.error)) return { kind: "error", message: errorMessage(value.error) ?? JSON.stringify(value.error) };

  const empty: Chunk = { kind: "delta", reasoning: "", content: "", finished: false };
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
  return { kind: "delta", reasoning: reasoning! + reasoningContent!, content: content!, finished: finishReason !== "" };
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
  const ids = value.data.map((model: unknown) => (isRecord(model) && typeof model.id === "string" && model.id !== "" ? model.id : undefined));
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
