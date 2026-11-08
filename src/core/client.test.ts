import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildChatRequest, listModels, streamChat, type ProviderAccess } from "./client";

type Handler = (request: Request) => Response | Promise<Response>;

// One local server; each test routes by its own path prefix.
const routes = new Map<string, Handler>();
// [&]: Bun invalidates a Request after its response is sent -> snapshot what tests inspect.
type Received = { path: string; headers: Headers; body: string };
const received = new Map<string, Received>();
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const prefix = path.split("/")[1] ?? "";
      received.set(prefix, { path, headers: new Headers(request.headers), body: await request.text() });
      const handler = routes.get(prefix);
      return handler ? handler(request) : new Response("no route", { status: 599 });
    },
  });
});

afterAll(() => server.stop(true));

function routed(prefix: string, handler: Handler, apiKey?: string): ProviderAccess {
  routes.set(prefix, handler);
  return { provider: { name: `P-${prefix}`, baseUrl: `http://localhost:${server.port}/${prefix}/v1` }, apiKey };
}

// Port 1 on loopback: nothing listens -> connection refused.
const refused: ProviderAccess = { provider: { name: "Down", baseUrl: "http://127.0.0.1:1/v1" }, apiKey: undefined };

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function delta(content: string, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`;
}

describe("buildChatRequest", () => {
  const access: ProviderAccess = { provider: { name: "Ollama", baseUrl: "http://localhost:11434/v1" }, apiKey: undefined };
  const messages = [{ role: "user" as const, content: "Hi" }];

  test("posts to /chat/completions with stream true, the model, the messages, and no tools key", () => {
    const request = buildChatRequest(access, "qwen3.8:27b", messages);
    expect(request.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(request.init.method).toBe("POST");
    const body = JSON.parse(String(request.init.body));
    expect(body).toEqual({ model: "qwen3.8:27b", messages: [{ role: "user", content: "Hi" }], stream: true });
    expect("tools" in body).toBe(false);
  });

  test("sends no Authorization header without a key, and a bearer header with one", () => {
    const withoutKey = new Headers(buildChatRequest(access, "m", messages).init.headers);
    expect(withoutKey.has("authorization")).toBe(false);
    const withEmptyKey = new Headers(buildChatRequest({ ...access, apiKey: "" }, "m", messages).init.headers);
    expect(withEmptyKey.has("authorization")).toBe(false);
    const withKey = new Headers(buildChatRequest({ ...access, apiKey: "sk-1" }, "m", messages).init.headers);
    expect(withKey.get("authorization")).toBe("Bearer sk-1");
  });
});

describe("listModels", () => {
  test("returns the model ids of GET /models", async () => {
    const access = routed("models-ok", () =>
      Response.json({ object: "list", data: [{ id: "qwen3.8:27b" }, { id: "gemma4:26b-a4b-it-qat" }] }),
    );
    expect(await listModels(access)).toEqual({ ok: true, models: ["qwen3.8:27b", "gemma4:26b-a4b-it-qat"] });
    expect(received.get("models-ok")!.path).toBe("/models-ok/v1/models");
    expect(received.get("models-ok")!.headers.has("authorization")).toBe(false);
  });

  test("sends the stored key as a bearer token", async () => {
    const access = routed("models-key", () => Response.json({ data: [] }), "sk-secret");
    await listModels(access);
    expect(received.get("models-key")!.headers.get("authorization")).toBe("Bearer sk-secret");
  });

  test("classifies connection refused as unreachable, with the base URL and the cause", async () => {
    const result = await listModels(refused);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: "unreachable", provider: "Down", baseUrl: "http://127.0.0.1:1/v1" });
    if (result.error.kind === "unreachable") expect(result.error.cause.length).toBeGreaterThan(0);
  });

  test("classifies 401 and 403 as an invalid key", async () => {
    const unauthorized = routed("models-401", () => new Response("nope", { status: 401 }));
    expect(await listModels(unauthorized)).toEqual({
      ok: false,
      error: { kind: "invalidKey", provider: "P-models-401", status: 401 },
    });
    const forbidden = routed("models-403", () => new Response("nope", { status: 403 }));
    expect(await listModels(forbidden)).toEqual({
      ok: false,
      error: { kind: "invalidKey", provider: "P-models-403", status: 403 },
    });
  });

  test("classifies a 500 with an OpenAI error body as rejected, with error.message", async () => {
    const access = routed("models-500json", () =>
      Response.json({ error: { message: "model 'nope' not found", type: "not_found_error" } }, { status: 500 }),
    );
    expect(await listModels(access)).toEqual({
      ok: false,
      error: { kind: "rejected", provider: "P-models-500json", status: 500, detail: "model 'nope' not found" },
    });
  });

  test("classifies a 500 with a text body as rejected, with the body truncated", async () => {
    const access = routed("models-500text", () => new Response(`Internal error ${"x".repeat(2000)}`, { status: 500 }));
    const result = await listModels(access);
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== "rejected") throw new Error("expected rejected");
    expect(result.error.status).toBe(500);
    expect(result.error.detail.startsWith("Internal error xxx")).toBe(true);
    expect(result.error.detail.length).toBeLessThanOrEqual(501);
    expect(result.error.detail.endsWith("…")).toBe(true);
  });

  test("reports a 2xx body that is not a model list as an invalid response", async () => {
    const access = routed("models-html", () => new Response("<html>Ollama is running</html>", { status: 200 }));
    const result = await listModels(access);
    expect(result).toMatchObject({ ok: false, error: { kind: "invalidResponse", provider: "P-models-html" } });
  });
});

describe("streamChat", () => {
  const messages = [{ role: "user" as const, content: "Hi" }];

  async function run(access: ProviderAccess, signal?: AbortSignal) {
    const parts: string[] = [];
    const outcome = await streamChat(access, {
      model: "m",
      messages,
      signal: signal ?? new AbortController().signal,
      onContent: (text) => parts.push(text),
    });
    return { outcome, text: parts.join("") };
  }

  test("streams delta.content until [DONE] and ignores reasoning", async () => {
    const access = routed("chat-ok", () =>
      sse([
        `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "", reasoning: "thinking" } }] })}\n\n`,
        delta("Hel"),
        delta("lo **world**"),
        delta("", "stop"),
        "data: [DONE]\n\n",
      ]),
    );
    expect(await run(access)).toEqual({ outcome: { status: "done" }, text: "Hello **world**" });
    const body = JSON.parse(received.get("chat-ok")!.body);
    expect(body.stream).toBe(true);
    expect("tools" in body).toBe(false);
  });

  test("accepts a stream that ends after a finish_reason without [DONE]", async () => {
    const access = routed("chat-finish", () => sse([delta("Hi"), delta("", "stop")]));
    expect(await run(access)).toEqual({ outcome: { status: "done" }, text: "Hi" });
  });

  test("classifies a stream that ends before completion as cut off, keeping the partial text", async () => {
    const access = routed("chat-eof", () => sse([delta("Partial ")]));
    const { outcome, text } = await run(access);
    expect(text).toBe("Partial ");
    expect(outcome).toEqual({ status: "failed", error: { kind: "cutOff", provider: "P-chat-eof", reason: "ended" } });
  });

  test("classifies a malformed chunk mid-reply as cut off", async () => {
    const access = routed("chat-malformed", () => sse([delta("Partial "), "data: {not json\n\n", delta("never")]));
    const { outcome, text } = await run(access);
    expect(text).toBe("Partial ");
    expect(outcome).toMatchObject({ status: "failed", error: { kind: "cutOff", reason: "malformed" } });
  });

  test("classifies an error event mid-reply as cut off, with the provider's message", async () => {
    const access = routed("chat-error-event", () =>
      sse([delta("Partial "), `data: ${JSON.stringify({ error: { message: "out of memory" } })}\n\n`]),
    );
    const { outcome } = await run(access);
    expect(outcome).toEqual({
      status: "failed",
      error: { kind: "cutOff", provider: "P-chat-error-event", reason: "providerError", cause: "out of memory" },
    });
  });

  test("classifies a dropped connection mid-reply as cut off", async () => {
    // Raw TCP: one chunk of a chunked body, then the socket closes without the final chunk.
    const event = delta("Partial ");
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.write(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n" +
              `${Buffer.byteLength(event).toString(16)}\r\n${event}\r\n`,
          );
          setTimeout(() => socket.end(), 20);
        },
      },
    });
    try {
      const access: ProviderAccess = {
        provider: { name: "Dropper", baseUrl: `http://127.0.0.1:${listener.port}/v1` },
        apiKey: undefined,
      };
      const { outcome, text } = await run(access);
      expect(text).toBe("Partial ");
      expect(outcome).toMatchObject({ status: "failed", error: { kind: "cutOff", provider: "Dropper", reason: "dropped" } });
    } finally {
      listener.stop(true);
    }
  });

  test("reports stop as stopped, not cut off, and keeps the partial text", async () => {
    const controller = new AbortController();
    const access = routed("chat-stop", () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(encoder.encode(delta("Partial ")));
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const parts: string[] = [];
    const outcome = await streamChat(access, {
      model: "m",
      messages,
      signal: controller.signal,
      onContent: (text) => {
        parts.push(text);
        controller.abort();
      },
    });
    expect(outcome).toEqual({ status: "stopped" });
    expect(parts.join("")).toBe("Partial ");
  });

  test("reports stop before the response arrives as stopped", async () => {
    const controller = new AbortController();
    const access = routed("chat-stop-early", async () => {
      await Bun.sleep(5000);
      return sse([delta("late")]);
    });
    setTimeout(() => controller.abort(), 20);
    expect(await run(access, controller.signal)).toEqual({ outcome: { status: "stopped" }, text: "" });
  });

  test("classifies connection refused, 401, and a 500 the same way as model listing", async () => {
    expect((await run(refused)).outcome).toMatchObject({ status: "failed", error: { kind: "unreachable" } });
    const unauthorized = routed("chat-401", () => new Response("", { status: 401 }));
    expect((await run(unauthorized)).outcome).toEqual({
      status: "failed",
      error: { kind: "invalidKey", provider: "P-chat-401", status: 401 },
    });
    const rejected = routed("chat-404", () =>
      Response.json({ error: { message: "model 'nope' not found" } }, { status: 404 }),
    );
    expect((await run(rejected)).outcome).toEqual({
      status: "failed",
      error: { kind: "rejected", provider: "P-chat-404", status: 404, detail: "model 'nope' not found" },
    });
  });
});
