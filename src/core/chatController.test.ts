import { afterAll, describe, expect, test } from "bun:test";
import { ChatController, type ChoiceStore } from "./chatController";
import type { ChatState } from "./protocol";
import type { Provider } from "./providers";
import { vllmOpening, vllmReasoningRest } from "./vllmFixture";

const encoder = new TextEncoder();
const chunk = (content: string) => encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);

const event = (delta: Record<string, string>) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

/** One complete reply per reasoning wire shape: reasoning "Plan.", answer "Answer". */
const shapes: Record<string, string[]> = {
  reasoning: [event({ content: "", reasoning: "Plan." }), event({ content: "Answer" })],
  reasoningContent: [event({ content: "", reasoning_content: "Plan." }), event({ content: "Answer" })],
  thinkTag: [event({ content: "<think>Plan.</think>" }), event({ content: "\n\nAnswer" })],
};
/** Reply reasoning only, then an unclosed `<think>`: no answer. */
const reasoningOnly = [event({ content: "<think>Plan, never closed" })];

/** Body of each chat request, by path prefix. */
const requests = new Map<string, unknown[]>();

// Provider that lists one model. Path `/a/` and `/b/` stream "Partial ", then finish only when `finishReply` is
// called; `/shape-<name>/` streams that shape whole; `/unclosed/` streams `reasoningOnly`; `/vllm/` sends the vLLM
// opening chunk, then the rest of its reasoning reply only when `releaseVllm` is called.
let finishReply: () => void = () => {};
let releaseVllm: () => void = () => {};
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/models")) return Response.json({ data: [{ id: "m" }] });
    const prefix = path.split("/")[1]!;
    requests.set(prefix, [...(requests.get(prefix) ?? []), await request.json()]);
    const whole = prefix === "unclosed" ? reasoningOnly : shapes[prefix.replace(/^shape-/, "")];
    if (whole) return new Response(whole.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    if (prefix === "vllm") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(vllmOpening));
          releaseVllm = () => {
            for (const event of vllmReasoningRest) controller.enqueue(encoder.encode(event));
            controller.close();
          };
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk("Partial "));
        finishReply = () => {
          controller.enqueue(chunk("end"));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  },
});
afterAll(() => server.stop(true));

const ollama: Provider = { name: "Ollama", baseUrl: `http://localhost:${server.port}/a/v1` };

function memoryStore(): ChoiceStore {
  const values = new Map<string, unknown>();
  return {
    get: <T,>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => void values.set(key, value),
  };
}

async function until(state: () => ChatState, predicate: (state: ChatState) => boolean): Promise<void> {
  for (let waited = 0; !predicate(state()); waited += 5) {
    if (waited > 2000) throw new Error(`timed out; state: ${JSON.stringify(state())}`);
    await Bun.sleep(5);
  }
}

/** Controller with `provider` configured and its model listed. */
async function ready(provider: Provider = ollama) {
  const controller = new ChatController({ get: async () => undefined }, memoryStore(), () => {});
  const state = () => controller.snapshot;
  controller.setProviders({ providers: [provider], skipped: [] });
  await until(state, (s) => s.model === "m");
  return { controller, state };
}

/** Controller with `ollama` configured, model listed, and a reply streaming its first chunk. */
async function replying() {
  const { controller, state } = await ready();
  const sent = controller.send("Hi");
  await until(state, (s) => s.entries.at(-1)?.role === "assistant" && s.entries.at(-1)?.content === "Partial ");
  return { controller, state, sent };
}

describe("ChatController settings change during a reply", () => {
  test("removing the active provider stops the reply and keeps its partial text", async () => {
    const { controller, sent } = await replying();
    controller.setProviders({ providers: [], skipped: [] });
    await sent;
    expect(controller.snapshot.providers).toEqual([]);
    expect(controller.snapshot.entries.at(-1)).toEqual({ role: "assistant", reasoning: "", content: "Partial ", status: "stopped" });
  });

  test("changing the active provider's base URL stops the reply", async () => {
    const { controller, sent } = await replying();
    controller.setProviders({ providers: [{ name: "Ollama", baseUrl: `http://localhost:${server.port}/b/v1` }], skipped: [] });
    await sent;
    expect(controller.snapshot.entries.at(-1)).toMatchObject({ content: "Partial ", status: "stopped" });
  });

  test("adding another provider leaves the reply running", async () => {
    const { controller, sent } = await replying();
    controller.setProviders({ providers: [ollama, { name: "Other", baseUrl: "http://127.0.0.1:1/v1" }], skipped: [] });
    finishReply();
    await sent;
    expect(controller.snapshot.entries.at(-1)).toEqual({ role: "assistant", reasoning: "", content: "Partial end", status: "done" });
  });
});

describe("ChatController reasoning", () => {
  for (const shape of Object.keys(shapes)) {
    test(`keeps the reasoning in the entry and sends only the answer back, for ${shape}`, async () => {
      const prefix = `shape-${shape}`;
      const { controller } = await ready({ name: "Shape", baseUrl: `http://localhost:${server.port}/${prefix}/v1` });
      await controller.send("Hi");
      expect(controller.snapshot.entries.at(-1)).toEqual({ role: "assistant", reasoning: "Plan.", content: "Answer", status: "done" });

      await controller.send("And then?");
      expect(requests.get(prefix)?.[1]).toMatchObject({
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Answer" },
          { role: "user", content: "And then?" },
        ],
      });
      expect(JSON.stringify(requests.get(prefix)?.[1])).not.toContain("Plan.");
    });
  }

  test("keeps a vLLM reply waiting after its opening chunk, then holds reasoning and answer apart", async () => {
    const published: unknown[] = [];
    const controller = new ChatController({ get: async () => undefined }, memoryStore(), (s) => {
      const last = s.entries.at(-1);
      if (last?.role === "assistant") published.push(structuredClone(last));
    });
    const state = () => controller.snapshot;
    controller.setProviders({ providers: [{ name: "vLLM", baseUrl: `http://localhost:${server.port}/vllm/v1` }], skipped: [] });
    await until(state, (s) => s.model === "m");

    const sent = controller.send("Hi");
    await until(state, () => requests.get("vllm")?.length === 1);
    expect(state().entries.at(-1)).toEqual({ role: "assistant", reasoning: "", content: "", status: "waiting" });
    releaseVllm();
    await sent;
    // Every state the panel saw: the opening chunk changes nothing, the first reasoning piece ends `waiting`.
    const reply = (status: string, reasoning: string, content: string) => ({ role: "assistant", reasoning, content, status });
    expect(published).toEqual([
      reply("waiting", "", ""),
      reply("streaming", "The user greets me.", ""),
      reply("streaming", "The user greets me. Reply politely.", ""),
      reply("streaming", "The user greets me. Reply politely.", "Hello!"),
      reply("streaming", "The user greets me. Reply politely.", "Hello! How can I help?"),
      reply("done", "The user greets me. Reply politely.", "Hello! How can I help?"),
    ]);

    const next = controller.send("And then?");
    await until(state, () => requests.get("vllm")?.length === 2);
    expect(requests.get("vllm")?.[1]).toMatchObject({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello! How can I help?" },
        { role: "user", content: "And then?" },
      ],
    });
    releaseVllm();
    await next;
  });

  test("keeps a reply with reasoning and no answer in the conversation, and leaves it out of the history", async () => {
    const { controller } = await ready({ name: "Unclosed", baseUrl: `http://localhost:${server.port}/unclosed/v1` });
    await controller.send("Hi");
    expect(controller.snapshot.entries.at(-1)).toEqual({ role: "assistant", reasoning: "Plan, never closed", content: "", status: "done" });

    await controller.send("Again");
    expect(controller.snapshot.entries).toHaveLength(4);
    expect(requests.get("unclosed")?.[1]).toMatchObject({
      messages: [
        { role: "user", content: "Hi" },
        { role: "user", content: "Again" },
      ],
    });
  });
});
