/**
 * @module client
 * Provider HTTP client: `GET {baseUrl}/models`, streaming `POST {baseUrl}/chat/completions`.
 * Never sends `tools`, never reads `tool_calls` (ADR 0001). Failures returned as typed values, never thrown.
 */
import type { Provider } from "./providers";
import type { CutOffReason, ProviderError } from "./providerError";
import { readSseData } from "./sse";

export type ProviderAccess = {
  provider: Provider;
  /** Absent or empty -> no `Authorization` header. */
  apiKey: string | undefined;
};

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type HttpRequest = { url: string; init: RequestInit };

export type ModelListing = { ok: true; models: string[] } | { ok: false; error: ProviderError };

export type ChatOutcome = { status: "done" } | { status: "stopped" } | { status: "failed"; error: ProviderError };

const DETAIL_LIMIT = 500;

/**
 * Build streaming chat request. Body: `model`, `messages`, `stream: true`. No `tools` key, ever.
 */
export function buildChatRequest(access: ProviderAccess, model: string, messages: ChatMessage[]): HttpRequest {
  return {
    url: `${access.provider.baseUrl}/chat/completions`,
    init: {
      method: "POST",
      headers: { ...authorization(access.apiKey), "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ model, messages: messages.map(({ role, content }) => ({ role, content })), stream: true }),
    },
  };
}

/** List model ids of provider. */
export async function listModels(access: ProviderAccess): Promise<ModelListing> {
  const { provider } = access;
  const sent = await send(access, {
    url: `${provider.baseUrl}/models`,
    init: { method: "GET", headers: { ...authorization(access.apiKey), Accept: "application/json" } },
  });
  if (!sent.ok) return { ok: false, error: sent.error };

  const body = await sent.response.text().catch(() => "");
  const models = parseModelIds(body);
  if (!models) return { ok: false, error: { kind: "invalidResponse", provider: provider.name, detail: truncate(body) } };
  return { ok: true, models };
}

export type StreamChatOptions = {
  model: string;
  messages: ChatMessage[];
  /** Abort -> outcome `stopped`, never `cutOff`. */
  signal: AbortSignal;
  /** Called with each non-empty `delta.content`, in order. */
  onContent: (text: string) => void;
};

/**
 * Stream chat reply. Only `choices[0].delta.content` read; `reasoning` and other delta fields ignored.
 * Complete when `[DONE]` arrives, or stream ends after a `finish_reason`.
 */
export async function streamChat(access: ProviderAccess, options: StreamChatOptions): Promise<ChatOutcome> {
  const { signal } = options;
  const provider = access.provider.name;
  const request = buildChatRequest(access, options.model, options.messages);
  const sent = await send(access, { url: request.url, init: { ...request.init, signal } });
  if (!sent.ok) return signal.aborted ? { status: "stopped" } : { status: "failed", error: sent.error };

  const body = sent.response.body;
  const cutOff = (reason: CutOffReason, cause?: string): ChatOutcome => ({
    status: "failed",
    error: cause === undefined ? { kind: "cutOff", provider, reason } : { kind: "cutOff", provider, reason, cause },
  });
  if (!body) return cutOff("ended");

  let finished = false;
  try {
    for await (const data of readSseData(body)) {
      if (data === "[DONE]") return { status: "done" };
      const chunk = parseChunk(data);
      if (chunk.kind === "malformed") return cutOff("malformed", truncate(data));
      if (chunk.kind === "error") return cutOff("providerError", chunk.message);
      if (chunk.content) options.onContent(chunk.content);
      if (chunk.finished) finished = true;
      if (signal.aborted) return { status: "stopped" };
    }
  } catch (error) {
    if (signal.aborted) return { status: "stopped" };
    return cutOff("dropped", describeError(error));
  } finally {
    body.cancel().catch(() => {
      // [>]: Body already closed or errored; nothing left to release.
    });
  }
  if (signal.aborted) return { status: "stopped" };
  return finished ? { status: "done" } : cutOff("ended");
}

type Sent = { ok: true; response: Response } | { ok: false; error: ProviderError };

/** Fetch and classify non-2xx. Caller checks own signal to tell stop from unreachable. */
async function send(access: ProviderAccess, request: HttpRequest): Promise<Sent> {
  const { name, baseUrl } = access.provider;
  let response: Response;
  try {
    response = await fetch(request.url, request.init);
  } catch (error) {
    return { ok: false, error: { kind: "unreachable", provider: name, baseUrl, cause: describeError(error) } };
  }
  if (response.ok) return { ok: true, response };

  const body = await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: { kind: "invalidKey", provider: name, status: response.status } };
  }
  return { ok: false, error: { kind: "rejected", provider: name, status: response.status, detail: errorDetail(body) } };
}

function authorization(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

type Chunk =
  | { kind: "delta"; content: string; finished: boolean }
  | { kind: "error"; message: string }
  | { kind: "malformed" };

function parseChunk(data: string): Chunk {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { kind: "malformed" };
  }
  if (!isRecord(value)) return { kind: "malformed" };
  if (value.error !== undefined) return { kind: "error", message: errorMessage(value.error) ?? JSON.stringify(value.error) };

  const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
  if (!isRecord(choice)) return { kind: "delta", content: "", finished: false };
  const delta = isRecord(choice.delta) ? choice.delta : {};
  return {
    kind: "delta",
    content: typeof delta.content === "string" ? delta.content : "",
    finished: typeof choice.finish_reason === "string" && choice.finish_reason !== "",
  };
}

function parseModelIds(body: string): string[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined;
  const ids = value.data.map((model: unknown) => (isRecord(model) && typeof model.id === "string" ? model.id : undefined));
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
