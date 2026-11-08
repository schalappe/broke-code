import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { buildChatRequest, listModels, MODEL_LIST_MAX_BYTES, REPLY_MAX_LENGTH, streamChat, type ProviderAccess } from "./client";
import { vllmOpening, vllmPlainStream, vllmReasoningRest } from "./vllmFixture";

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

/** Raw TCP server: writes `head` + one chunk of a chunked body, then closes without the final chunk. */
function truncatedServer(head: string, chunk: string) {
  return Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        socket.write(`${head}\r\nTransfer-Encoding: chunked\r\n\r\n${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n`);
        setTimeout(() => socket.end(), 20);
      },
    },
  });
}

/** Body that never ends: `first`, then `filler` forever. Proves caps are enforced while reading, not after. */
function endless(first: string, filler: string, init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const head = encoder.encode(first);
  const rest = encoder.encode(filler);
  let sentHead = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(sentHead ? rest : head);
      sentHead = true;
    },
  });
  return new Response(body, init);
}

function event(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function delta(content: string, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`;
}

/** Reasoning delta as Ollama (`reasoning`) or vLLM-style servers (`reasoning_content`) send it. */
function reasoningDelta(text: string, field: "reasoning" | "reasoning_content" = "reasoning"): string {
  return event({ choices: [{ index: 0, delta: { content: "", [field]: text }, finish_reason: null }] });
}

describe("buildChatRequest", () => {
  const access: ProviderAccess = { provider: { name: "Ollama", baseUrl: "http://localhost:11434/v1" }, apiKey: undefined };
  const messages = [{ role: "user" as const, content: "Hi" }];

  test("posts to /chat/completions with stream true, the model, the messages, and no tools key", () => {
    const request = buildChatRequest(access, "qwen3.8:27b", messages);
    expect(request.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(request.method).toBe("POST");
    const body = JSON.parse(String(request.body));
    expect(body).toEqual({ model: "qwen3.8:27b", messages: [{ role: "user", content: "Hi" }], stream: true });
    expect("tools" in body).toBe(false);
  });

  test("sends no Authorization header without a key, and a bearer header with one", () => {
    const withoutKey = new Headers(buildChatRequest(access, "m", messages).headers);
    expect(withoutKey.has("authorization")).toBe(false);
    const withEmptyKey = new Headers(buildChatRequest({ ...access, apiKey: "" }, "m", messages).headers);
    expect(withEmptyKey.has("authorization")).toBe(false);
    const withKey = new Headers(buildChatRequest({ ...access, apiKey: "sk-1" }, "m", messages).headers);
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

  test("reports a model list whose body download fails as cut off with the cause, not as an invalid response", async () => {
    const listener = truncatedServer("HTTP/1.1 200 OK\r\nContent-Type: application/json", '{"data":[{"id":"qw');
    try {
      const result = await listModels({ provider: { name: "Half", baseUrl: `http://127.0.0.1:${listener.port}/v1` }, apiKey: undefined });
      if (result.ok || result.error.kind !== "cutOff") throw new Error(`expected cutOff, got ${JSON.stringify(result)}`);
      expect(result.error).toMatchObject({ provider: "Half", reason: "listDropped" });
      expect(result.error.cause?.length).toBeGreaterThan(0);
    } finally {
      listener.stop(true);
    }
  });

  test("keeps the HTTP classification when an error body cannot be read, and says so with the cause", async () => {
    const rejected = truncatedServer("HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain", "Internal err");
    const unauthorized = truncatedServer("HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain", "Unauth");
    try {
      const result = await listModels({ provider: { name: "Half", baseUrl: `http://127.0.0.1:${rejected.port}/v1` }, apiKey: undefined });
      if (result.ok || result.error.kind !== "rejected") throw new Error(`expected rejected, got ${JSON.stringify(result)}`);
      expect(result.error).toMatchObject({ provider: "Half", status: 500, detail: "" });
      expect(result.error.bodyReadError?.length).toBeGreaterThan(0);

      expect(await listModels({ provider: { name: "Key", baseUrl: `http://127.0.0.1:${unauthorized.port}/v1` }, apiKey: "k" })).toEqual({
        ok: false,
        error: { kind: "invalidKey", provider: "Key", status: 401 },
      });
    } finally {
      rejected.stop(true);
      unauthorized.stop(true);
    }
  });

  test("reports a model list with an empty id as an invalid response", async () => {
    const access = routed("models-empty-id", () => Response.json({ data: [{ id: "qwen3.8:27b" }, { id: "" }] }));
    expect(await listModels(access)).toMatchObject({ ok: false, error: { kind: "invalidResponse", provider: "P-models-empty-id" } });
  });

  test("does not follow a redirect, and reports it with its target", async () => {
    const target = routed("models-redirect-target", () => Response.json({ data: [{ id: "m" }] }));
    received.delete("models-redirect-target");
    const access = routed("models-redirect", () => Response.redirect(`${target.provider.baseUrl}/models`, 302), "sk-secret");
    expect(await listModels(access)).toEqual({
      ok: false,
      error: { kind: "redirected", provider: "P-models-redirect", status: 302, location: `${target.provider.baseUrl}/models` },
    });
    expect(received.has("models-redirect-target")).toBe(false);
  });

  test("cancels a model list larger than the cap and reports it as too large", async () => {
    const access = routed("models-endless", () => endless('{"data":[', '{"id":"m"},'.repeat(10_000)));
    expect(await listModels(access)).toEqual({ ok: false, error: { kind: "cutOff", provider: "P-models-endless", reason: "listTooLarge" } });
    expect(MODEL_LIST_MAX_BYTES).toBeGreaterThan(1024 * 1024);
  });

  test("reads only the start of an endless error body, and keeps the HTTP classification", async () => {
    const access = routed("models-500-endless", () => endless("Internal error ", "x".repeat(64 * 1024), { status: 500 }));
    const result = await listModels(access);
    if (result.ok || result.error.kind !== "rejected") throw new Error(`expected rejected, got ${JSON.stringify(result)}`);
    expect(result.error.status).toBe(500);
    expect(result.error.detail.startsWith("Internal error xxx")).toBe(true);
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
    const reasoningParts: string[] = [];
    const outcome = await streamChat(access, {
      model: "m",
      messages,
      signal: signal ?? new AbortController().signal,
      onContent: (text) => parts.push(text),
      onReasoning: (text) => reasoningParts.push(text),
    });
    return { outcome, text: parts.join(""), reasoning: reasoningParts.join("") };
  }

  test("streams delta.content as the answer and delta.reasoning as the reasoning, until [DONE]", async () => {
    const access = routed("chat-ok", () =>
      sse([
        `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "", reasoning: "Plan." } }] })}\n\n`,
        delta("Hel"),
        delta("lo **world**"),
        delta("", "stop"),
        "data: [DONE]\n\n",
      ]),
    );
    expect(await run(access)).toEqual({ outcome: { status: "done" }, text: "Hello **world**", reasoning: "Plan." });
    const body = JSON.parse(received.get("chat-ok")!.body);
    expect(body.stream).toBe(true);
    expect("tools" in body).toBe(false);
  });

  test("splits delta.reasoning, delta.reasoning_content, and a leading <think> block into the same reasoning and answer", async () => {
    const shapes: Record<string, string[]> = {
      reasoning: [reasoningDelta("Plan "), reasoningDelta("the reply."), delta("Hello"), delta(" **world**")],
      reasoningContent: [reasoningDelta("Plan ", "reasoning_content"), reasoningDelta("the reply.", "reasoning_content"), delta("\n\nHello **world**")],
      thinkTag: [delta("<think>Plan "), delta("the reply.</think>\n\nHello"), delta(" **world**")],
    };
    for (const [shape, chunks] of Object.entries(shapes)) {
      const access = routed(`chat-shape-${shape}`, () => sse([...chunks, delta("", "stop"), "data: [DONE]\n\n"]));
      expect({ shape, ...(await run(access)) }).toEqual({
        shape,
        outcome: { status: "done" },
        reasoning: "Plan the reply.",
        text: "Hello **world**",
      });
    }
  });

  test("recognizes <think> and </think> split across deltas, after leading whitespace", async () => {
    const access = routed("chat-split-tag", () =>
      sse([delta("\n <thi"), delta("nk>\nPlan"), delta(" the reply.\n</th"), delta("ink>"), delta("\n\nHel"), delta("lo"), delta("", "stop")]),
    );
    expect(await run(access)).toEqual({ outcome: { status: "done" }, reasoning: "\nPlan the reply.\n", text: "Hello" });
  });

  test("starts the answer at its first non-blank line, keeping that line's indentation", async () => {
    const access = routed("chat-blank-lines", () => sse([delta("<think>Plan</think>\n \n"), delta("    indented code\nnext"), delta("", "stop")]));
    expect(await run(access)).toEqual({ outcome: { status: "done" }, reasoning: "Plan", text: "    indented code\nnext" });
    const plain = routed("chat-blank-lines-plain", () => sse([delta("\n\n"), delta("Hi"), delta("", "stop")]));
    expect(await run(plain)).toEqual({ outcome: { status: "done" }, reasoning: "", text: "Hi" });
    const blank = routed("chat-blank-only", () => sse([delta("\n\n "), delta("", "stop")]));
    expect(await run(blank)).toEqual({ outcome: { status: "done" }, reasoning: "", text: "" });
  });

  test("keeps a <think> tag that comes after answer text in the answer", async () => {
    const access = routed("chat-late-tag", () =>
      sse([delta("Use the "), delta("<think>"), delta(" tag.</think> Done"), delta("", "stop")]),
    );
    expect(await run(access)).toEqual({ outcome: { status: "done" }, reasoning: "", text: "Use the <think> tag.</think> Done" });
  });

  test("keeps text that only starts like <think> in the answer", async () => {
    const access = routed("chat-not-tag", () => sse([delta("<thi"), delta("nking> is not a tag"), delta("", "stop")]));
    expect(await run(access)).toEqual({ outcome: { status: "done" }, reasoning: "", text: "<thinking> is not a tag" });
    const short = routed("chat-short-tag", () => sse([delta("<th"), delta("", "stop")]));
    expect(await run(short)).toEqual({ outcome: { status: "done" }, reasoning: "", text: "<th" });
  });

  test("passes answer text on as soon as it cannot start a <think> tag", async () => {
    // [>]: The stream sends its end only after the first answer text reaches onContent; holding it back would hang.
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const access = routed("chat-no-holdback", () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(stream) {
          stream.enqueue(encoder.encode(delta("Hi")));
          await released;
          stream.enqueue(encoder.encode(delta(" there", "stop")));
          stream.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const parts: string[] = [];
    const outcome = await streamChat(access, {
      model: "m",
      messages,
      signal: new AbortController().signal,
      onContent: (text) => {
        parts.push(text);
        release();
      },
      onReasoning: () => {},
    });
    expect(outcome).toEqual({ status: "done" });
    expect(parts).toEqual(["Hi", " there"]);
  });

  test("passes reasoning on as each delta arrives, holding back only a possible </think> start", async () => {
    const access = routed("chat-reasoning-pieces", () =>
      sse([delta("<think>Plan"), delta(" more <"), delta("/thi"), delta("nk>Done"), delta("", "stop")]),
    );
    const reasoning: string[] = [];
    const answer: string[] = [];
    const outcome = await streamChat(access, {
      model: "m",
      messages,
      signal: new AbortController().signal,
      onContent: (text) => answer.push(text),
      onReasoning: (text) => reasoning.push(text),
    });
    expect({ outcome, reasoning, answer }).toEqual({ outcome: { status: "done" }, reasoning: ["Plan", " more "], answer: ["Done"] });
  });

  test("leaves a <think> block that never closes in the reasoning, with an empty answer", async () => {
    const access = routed("chat-unclosed", () => sse([delta("<think>Plan the"), delta(" reply</thi")]));
    expect(await run(access)).toEqual({
      outcome: { status: "failed", error: { kind: "cutOff", provider: "P-chat-unclosed", reason: "ended" } },
      reasoning: "Plan the reply</thi",
      text: "",
    });
  });

  test("puts both a reasoning field and a leading <think> block into the reasoning", async () => {
    const access = routed("chat-both", () =>
      sse([reasoningDelta("First. "), delta("<think>Second.</think>Answer"), delta("", "stop")]),
    );
    expect(await run(access)).toEqual({ outcome: { status: "done" }, reasoning: "First. Second.", text: "Answer" });
  });

  /** Each callback's pieces, in order, for a stream of `events`. */
  async function pieces(prefix: string, events: string[]) {
    const access = routed(prefix, () => sse(events));
    const reasoning: string[] = [];
    const answer: string[] = [];
    const outcome = await streamChat(access, {
      model: "m",
      messages,
      signal: new AbortController().signal,
      onContent: (text) => answer.push(text),
      onReasoning: (text) => reasoning.push(text),
    });
    return { outcome, reasoning, answer };
  }

  test("replays a vLLM reasoning stream: reasoning_content without content, extra keys, usage details", async () => {
    expect(await pieces("chat-vllm-reasoning", [vllmOpening, ...vllmReasoningRest])).toEqual({
      outcome: { status: "done" },
      reasoning: ["The user greets me.", " Reply politely."],
      answer: ["Hello!", " How can I help?"],
    });
  });

  test("replays a vLLM stream without reasoning: onReasoning never called, whole answer kept", async () => {
    expect(await pieces("chat-vllm-plain", vllmPlainStream)).toEqual({
      outcome: { status: "done" },
      reasoning: [],
      answer: ["Hello!", " How can I help?"],
    });
  });

  test("accepts a stream that ends after a finish_reason without [DONE]", async () => {
    const access = routed("chat-finish", () => sse([delta("Hi"), delta("", "stop")]));
    expect(await run(access)).toEqual({ outcome: { status: "done" }, text: "Hi", reasoning: "" });
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
    const listener = truncatedServer("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream", delta("Partial "));
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

  test("classifies a delta.content of the wrong type as a malformed chunk, not success", async () => {
    const access = routed("chat-content-number", () =>
      sse([delta("Partial "), event({ choices: [{ delta: { content: 42 } }] }), "data: [DONE]\n\n"]),
    );
    const { outcome, text } = await run(access);
    expect(text).toBe("Partial ");
    expect(outcome).toMatchObject({ status: "failed", error: { kind: "cutOff", reason: "malformed" } });
  });

  test("classifies wrong types in choices, delta, or finish_reason as malformed", async () => {
    const malformed = [
      { choices: "nope" },
      { choices: [42] },
      { choices: [{ delta: "text" }] },
      { choices: [{ delta: {}, finish_reason: 1 }] },
      { choices: [{ delta: { reasoning: 42 } }] },
      { choices: [{ delta: { reasoning_content: {} } }] },
    ];
    for (const [index, payload] of malformed.entries()) {
      const access = routed(`chat-malformed-${index}`, () => sse([event(payload), "data: [DONE]\n\n"]));
      expect((await run(access)).outcome).toMatchObject({ status: "failed", error: { kind: "cutOff", reason: "malformed" } });
    }
  });

  test("accepts null content, role-only, usage-only, and empty-choices chunks, and routes a reasoning-only chunk", async () => {
    const access = routed("chat-metadata", () =>
      sse([
        event({ choices: [{ delta: { role: "assistant" } }] }),
        event({ choices: [{ delta: { content: null, reasoning: "hmm" } }] }),
        event({ choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] }),
        event({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        event({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
        event({ id: "chatcmpl-1", object: "chat.completion.chunk", error: null }),
        "data: [DONE]\n\n",
      ]),
    );
    expect(await run(access)).toEqual({ outcome: { status: "done" }, text: "Hi", reasoning: "hmm" });
  });

  test("reports stop as stopped even when [DONE] is already buffered behind the content", async () => {
    const controller = new AbortController();
    const access = routed("chat-stop-done", () => sse([delta("partial") + "data: [DONE]\n\n"]));
    const outcome = await streamChat(access, {
      model: "m",
      messages,
      signal: controller.signal,
      // Stop lands after this content is handled, while [DONE] waits in the same buffer.
      onContent: () => queueMicrotask(() => controller.abort()),
      onReasoning: () => {},
    });
    expect(outcome).toEqual({ status: "stopped" });
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
      onReasoning: () => {},
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
    expect(await run(access, controller.signal)).toEqual({ outcome: { status: "stopped" }, text: "", reasoning: "" });
  });

  test("does not follow a redirect, so the conversation is never resent elsewhere", async () => {
    const target = routed("chat-redirect-target", () => sse([delta("Hi", "stop")]));
    received.delete("chat-redirect-target");
    const access = routed("chat-redirect", () => Response.redirect(`${target.provider.baseUrl}/chat/completions`, 307));
    expect((await run(access)).outcome).toMatchObject({ status: "failed", error: { kind: "redirected", status: 307 } });
    expect(received.has("chat-redirect-target")).toBe(false);
  });

  test("cancels a stream whose line never ends and reports it as too large", async () => {
    const access = routed("chat-endless-line", () => endless(delta("Partial ") + "data: ", "x".repeat(64 * 1024)));
    const { outcome, text } = await run(access);
    expect(text).toBe("Partial ");
    expect(outcome).toEqual({ status: "failed", error: { kind: "cutOff", provider: "P-chat-endless-line", reason: "tooLarge" } });
  });

  test("stops a reply longer than the cap, keeping the text received under it", async () => {
    const piece = "x".repeat(512 * 1024);
    const access = routed("chat-endless-reply", () => endless("", delta(piece)));
    const { outcome, text } = await run(access);
    expect(outcome).toEqual({ status: "failed", error: { kind: "cutOff", provider: "P-chat-endless-reply", reason: "tooLarge" } });
    expect(text.length).toBeLessThanOrEqual(REPLY_MAX_LENGTH);
    expect(text.length).toBeGreaterThan(REPLY_MAX_LENGTH - piece.length);
  });

  test("counts reasoning toward the reply cap, with the answer", async () => {
    const piece = "x".repeat(512 * 1024);
    const access = routed("chat-endless-reasoning", () => endless(delta("Answer"), reasoningDelta(piece)));
    const { outcome, text, reasoning } = await run(access);
    expect(outcome).toEqual({ status: "failed", error: { kind: "cutOff", provider: "P-chat-endless-reasoning", reason: "tooLarge" } });
    expect(text).toBe("Answer");
    expect(text.length + reasoning.length).toBeLessThanOrEqual(REPLY_MAX_LENGTH);
    expect(text.length + reasoning.length).toBeGreaterThan(REPLY_MAX_LENGTH - piece.length);
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

describe("compressed responses", () => {
  const modelList = '{"data":[{"id":"m"}]}';
  const reply = [event({ choices: [{ delta: { content: "Hel" } }] }), event({ choices: [{ delta: { content: "lo" } }] }), "data: [DONE]\n\n"].join("");

  function encoded(body: Uint8Array, encoding: string, init?: ResponseInit): Response {
    return new Response(new Uint8Array(body), { ...init, headers: { ...init?.headers, "content-encoding": encoding } });
  }

  async function chat(access: ProviderAccess) {
    const parts: string[] = [];
    const outcome = await streamChat(access, {
      model: "m",
      messages: [{ role: "user", content: "Hi" }],
      signal: new AbortController().signal,
      onContent: (text) => parts.push(text),
      onReasoning: () => {},
    });
    return { outcome, text: parts.join("") };
  }

  test("asks for gzip, deflate, and br", async () => {
    const access = routed("enc-accept", () => Response.json({ data: [] }));
    await listModels(access);
    expect(received.get("enc-accept")?.headers.get("accept-encoding")).toBe("gzip, deflate, br");
  });

  test("decodes a gzip model list", async () => {
    const access = routed("enc-gzip-models", () => encoded(gzipSync(modelList), "gzip"));
    expect(await listModels(access)).toEqual({ ok: true, models: ["m"] });
  });

  test("decodes a gzip reply stream", async () => {
    const access = routed("enc-gzip-chat", () => encoded(gzipSync(reply), "gzip", { headers: { "content-type": "text/event-stream" } }));
    expect(await chat(access)).toEqual({ outcome: { status: "done" }, text: "Hello" });
  });

  test("decodes br and deflate", async () => {
    const br = routed("enc-br", () => encoded(brotliCompressSync(modelList), "br"));
    expect(await listModels(br)).toEqual({ ok: true, models: ["m"] });
    const deflate = routed("enc-deflate", () => encoded(deflateSync(reply), "deflate"));
    expect(await chat(deflate)).toEqual({ outcome: { status: "done" }, text: "Hello" });
  });

  test("decodes a compressed error body", async () => {
    const access = routed("enc-500", () => encoded(gzipSync('{"error":{"message":"overloaded"}}'), "gzip", { status: 500 }));
    expect(await listModels(access)).toEqual({
      ok: false,
      error: { kind: "rejected", provider: "P-enc-500", status: 500, detail: "overloaded" },
    });
  });

  test("applies the size cap to decoded bytes, so a small compressed body cannot expand past it", async () => {
    const bomb = gzipSync(`{"data":[${'{"id":"m"},'.repeat(MODEL_LIST_MAX_BYTES / 10)}{"id":"m"}]}`);
    expect(bomb.byteLength).toBeLessThan(MODEL_LIST_MAX_BYTES / 100);
    const access = routed("enc-bomb", () => encoded(bomb, "gzip"));
    expect(await listModels(access)).toEqual({ ok: false, error: { kind: "cutOff", provider: "P-enc-bomb", reason: "listTooLarge" } });
  });

  test("ends the download of an endless compressed model list once its decoded size passes the cap", async () => {
    let cancelled!: () => void;
    const downloadEnded = new Promise<void>((resolve) => (cancelled = resolve));
    const head = gzipSync('{"data":[');
    const filler = gzipSync('{"id":"m"},'.repeat(10_000));
    let sentHead = false;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        stream.enqueue(new Uint8Array(sentHead ? filler : head));
        sentHead = true;
      },
      cancel: () => cancelled(),
    });
    const access = routed("enc-endless", () => new Response(body, { headers: { "content-encoding": "gzip" } }));
    expect(await listModels(access)).toEqual({ ok: false, error: { kind: "cutOff", provider: "P-enc-endless", reason: "listTooLarge" } });
    expect(await Promise.race([downloadEnded.then(() => "ended"), Bun.sleep(2000).then(() => "still downloading")])).toBe("ended");
  });

  test("reports a body that does not decode as cut off, with the decoder's cause", async () => {
    const access = routed("enc-corrupt", () => encoded(new TextEncoder().encode(modelList), "gzip"));
    const result = await listModels(access);
    expect(result).toMatchObject({ ok: false, error: { kind: "cutOff", reason: "listDropped" } });
  });

  test("stops a compressed endless stream and ends its download", async () => {
    const controller = new AbortController();
    let cancelled!: () => void;
    const downloadEnded = new Promise<void>((resolve) => (cancelled = resolve));
    // [>]: Concatenated gzip members: each chunk decodes on its own, like a server flushing per event.
    const piece = gzipSync(event({ choices: [{ delta: { content: "x" } }] }));
    const body = new ReadableStream<Uint8Array>({ pull: (stream) => stream.enqueue(new Uint8Array(piece)), cancel: () => cancelled() });
    const access = routed("enc-stop", () => new Response(body, { headers: { "content-type": "text/event-stream", "content-encoding": "gzip" } }));
    const outcome = await streamChat(access, {
      model: "m",
      messages: [{ role: "user", content: "Hi" }],
      signal: controller.signal,
      onContent: () => controller.abort(),
      onReasoning: () => {},
    });
    expect(outcome).toEqual({ status: "stopped" });
    expect(await Promise.race([downloadEnded.then(() => "ended"), Bun.sleep(2000).then(() => "still downloading")])).toBe("ended");
  });

  test("reads coding names case-insensitively, as RFC 9110 defines them", async () => {
    const access = routed("enc-upper", () => encoded(gzipSync(modelList), " GZIP "));
    expect(await listModels(access)).toEqual({ ok: true, models: ["m"] });
  });

  test.each(["__proto__", "constructor", "toString", "gzip, br", "gzip,gzip"])(
    "reports Content-Encoding %p as an invalid response, never a crash",
    async (value) => {
      const access = routed(`enc-odd-${encodeURIComponent(value)}`, () => encoded(new TextEncoder().encode(modelList), value));
      expect(await listModels(access)).toMatchObject({ ok: false, error: { kind: "invalidResponse", detail: "", encoding: value.toLowerCase() } });
    },
  );

  test("reports an unknown encoding as an invalid response naming it, for listing and chat", async () => {
    const listing = routed("enc-zstd", () => encoded(new TextEncoder().encode(modelList), "zstd"));
    expect(await listModels(listing)).toEqual({
      ok: false,
      error: { kind: "invalidResponse", provider: "P-enc-zstd", detail: "", encoding: "zstd" },
    });
    const chatting = routed("enc-zstd-chat", () => encoded(new TextEncoder().encode(reply), "zstd"));
    expect(await chat(chatting)).toEqual({
      outcome: { status: "failed", error: { kind: "invalidResponse", provider: "P-enc-zstd-chat", detail: "", encoding: "zstd" } },
      text: "",
    });
  });
});

describe("timeouts", () => {
  const network = { timeoutMs: 50 };

  /** Raw TCP server: `reply` (or nothing) per request, then the connection stays open and silent. */
  function silentServer(reply?: string) {
    return Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          if (reply !== undefined) socket.write(reply);
        },
      },
    });
  }

  function at(port: number, name: string): ProviderAccess {
    return { provider: { name, baseUrl: `http://127.0.0.1:${port}/v1` }, apiKey: undefined };
  }

  /**
   * Runs `run` with the global timers watched, then waits past `delay` and returns how many timers of `delay` ms
   * fired after `run` settled. The client's deadline is the only timer with that delay.
   */
  async function timersFiredAfter(delay: number, run: () => Promise<unknown>): Promise<number> {
    const realSetTimeout = globalThis.setTimeout;
    let settled = false;
    let firedAfter = 0;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      realSetTimeout(
        (...callArgs: unknown[]) => {
          if (ms === delay && settled) firedAfter++;
          callback(...callArgs);
        },
        ms,
        ...args,
      )) as typeof setTimeout;
    try {
      await run();
      settled = true;
      await Bun.sleep(delay * 3);
      return firedAfter;
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  }

  test("reports a key that cannot go in a header without leaving its deadline behind", async () => {
    const listener = silentServer();
    try {
      for (const apiKey of ["k€y", "line\nbreak"]) {
        const access: ProviderAccess = { provider: { name: "Bad key", baseUrl: `http://127.0.0.1:${listener.port}/v1` }, apiKey };
        const fired = await timersFiredAfter(41, async () => {
          expect(await listModels(access, { timeoutMs: 41 })).toMatchObject({ ok: false, error: { kind: "unreachable" } });
        });
        expect(fired).toBe(0);
      }
    } finally {
      listener.stop(true);
    }
  });

  test("reports a provider that accepts the connection but never answers as unreachable, saying it timed out", async () => {
    const listener = silentServer();
    try {
      const result = await listModels(at(listener.port, "Mute"), network);
      expect(result).toMatchObject({ ok: false, error: { kind: "unreachable", provider: "Mute" } });
      if (!result.ok && result.error.kind === "unreachable") expect(result.error.cause).toContain("timed out");
    } finally {
      listener.stop(true);
    }
  });

  test("reports a host name that never resolves as unreachable, saying it timed out", async () => {
    const stalledLookup = () => {
      // [>]: Never calls back, like a DNS server that does not answer.
    };
    const access: ProviderAccess = { provider: { name: "Nowhere", baseUrl: "http://stalled.example.test/v1" }, apiKey: undefined };
    const result = await listModels(access, { ...network, lookup: stalledLookup });
    expect(result).toMatchObject({ ok: false, error: { kind: "unreachable", provider: "Nowhere" } });
    if (!result.ok && result.error.kind === "unreachable") expect(result.error.cause).toContain("timed out");
  });

  test("reports silence after the headers as a dropped reply that says how long nothing came", async () => {
    const head = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n";
    const models = silentServer(`${head}Content-Type: application/json\r\n\r\n2\r\n{"\r\n`);
    const chat = silentServer(`${head}Content-Type: text/event-stream\r\n\r\n${chunk(delta("Partial "))}`);
    try {
      expect(await listModels(at(models.port, "Stall"), network)).toEqual({
        ok: false,
        error: { kind: "cutOff", provider: "Stall", reason: "listDropped", cause: "no data from the provider for 0.05 s" },
      });
      const parts: string[] = [];
      const outcome = await streamChat(at(chat.port, "Stall"), {
        model: "m",
        messages: [{ role: "user", content: "Hi" }],
        signal: new AbortController().signal,
        onContent: (text) => parts.push(text),
        onReasoning: () => {},
        network,
      });
      expect(outcome).toEqual({
        status: "failed",
        error: { kind: "cutOff", provider: "Stall", reason: "dropped", cause: "no data from the provider for 0.05 s" },
      });
      expect(parts.join("")).toBe("Partial ");
    } finally {
      models.stop(true);
      chat.stop(true);
    }
  });

  function chunk(text: string): string {
    return `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;
  }
});
