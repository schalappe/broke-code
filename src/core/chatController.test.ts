import { afterAll, describe, expect, test } from "bun:test";
import { ChatController, type ChoiceStore } from "./chatController";
import type { ChatState } from "./protocol";
import type { Provider } from "./providers";

const encoder = new TextEncoder();
const chunk = (content: string) => encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);

// Provider that lists one model and streams "Partial ", then finishes only when `finishReply` is called.
let finishReply: () => void = () => {};
const server = Bun.serve({
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "m" }] });
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

/** Controller with `ollama` configured, model listed, and a reply streaming its first chunk. */
async function replying() {
  const controller = new ChatController({ get: async () => undefined }, memoryStore(), () => {});
  const state = () => controller.snapshot;
  controller.setProviders({ providers: [ollama], skipped: [] });
  await until(state, (s) => s.model === "m");
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
    expect(controller.snapshot.entries.at(-1)).toEqual({ role: "assistant", content: "Partial ", status: "stopped" });
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
    expect(controller.snapshot.entries.at(-1)).toEqual({ role: "assistant", content: "Partial end", status: "done" });
  });
});
