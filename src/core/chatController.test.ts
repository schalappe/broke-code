import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { ChatController, type ChoiceStore } from "./chatController";
import type { MentionReader, ReadMention } from "./mentions";
import { type ChatState, isReplying } from "./protocol";
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
/** Number of model listings, by path prefix. */
const listings = new Map<string, number>();

// Provider that lists one model. Path `/a/` and `/b/` stream "Partial ", then finish only when `finishReply` is
// called; `/shape-<name>/` streams that shape whole; `/unclosed/` streams `reasoningOnly`; `/vllm/` sends the vLLM
// opening chunk, then the rest of its reasoning reply only when `releaseVllm` is called; `/mentions/` streams the
// `reasoning` shape whole.
let finishReply: () => void = () => {};
let releaseVllm: () => void = () => {};
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const prefix = path.split("/")[1]!;
    if (path.endsWith("/models")) {
      listings.set(prefix, (listings.get(prefix) ?? 0) + 1);
      return Response.json({ data: [{ id: "m" }] });
    }
    requests.set(prefix, [...(requests.get(prefix) ?? []), await request.json()]);
    const whole =
      prefix === "unclosed"
        ? reasoningOnly
        : prefix === "mentions"
          ? shapes.reasoning
          : shapes[prefix.replace(/^shape-/, "")];
    if (whole)
      return new Response(`${whole.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
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
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => void values.set(key, value),
  };
}

async function until(state: () => ChatState, predicate: (state: ChatState) => boolean): Promise<void> {
  for (let waited = 0; !predicate(state()); waited += 5) {
    if (waited > 2000) throw new Error(`timed out; state: ${JSON.stringify(state())}`);
    await Bun.sleep(5);
  }
}

/** Reader for conversations that mention nothing: any read fails the test. */
const noMentions: MentionReader = {
  read: async (path) => {
    throw new Error(`unexpected mention ${path}`);
  },
};

/** Controller with `provider` configured and its model listed. */
async function ready(
  provider: Provider = ollama,
  mentions: MentionReader = noMentions,
  publish: (state: ChatState) => void = () => {},
) {
  const controller = new ChatController({ get: async () => undefined }, memoryStore(), publish, mentions);
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
    expect(controller.snapshot.entries.at(-1)).toEqual({
      role: "assistant",
      reasoning: "",
      content: "Partial ",
      status: "stopped",
    });
  });

  test("changing the active provider's base URL stops the reply", async () => {
    const { controller, sent } = await replying();
    controller.setProviders({
      providers: [{ name: "Ollama", baseUrl: `http://localhost:${server.port}/b/v1` }],
      skipped: [],
    });
    await sent;
    expect(controller.snapshot.entries.at(-1)).toMatchObject({ content: "Partial ", status: "stopped" });
  });

  test("adding another provider leaves the reply running", async () => {
    const { controller, sent } = await replying();
    controller.setProviders({ providers: [ollama, { name: "Other", baseUrl: "http://127.0.0.1:1/v1" }], skipped: [] });
    finishReply();
    await sent;
    expect(controller.snapshot.entries.at(-1)).toEqual({
      role: "assistant",
      reasoning: "",
      content: "Partial end",
      status: "done",
    });
  });
});

describe("ChatController settings reapplied", () => {
  const at = (prefix: string): Provider => ({ name: prefix, baseUrl: `http://localhost:${server.port}/${prefix}/v1` });

  test("keeps the model list when the active provider's settings did not change", async () => {
    const provider = at("same");
    const { controller } = await ready(provider);
    controller.setProviders({ providers: [{ ...provider }, at("extra")], skipped: [] });
    await Bun.sleep(50);
    expect(listings.get("same")).toBe(1);
    expect(controller.snapshot).toMatchObject({ provider: "same", model: "m" });
  });

  test("relists when the active provider is renamed", async () => {
    const provider = at("renamed");
    const { controller, state } = await ready(provider);
    controller.setProviders({ providers: [{ ...provider, name: "New name" }], skipped: [] });
    await until(state, (s) => s.provider === "New name" && s.model === "m");
    expect(listings.get("renamed")).toBe(2);
  });

  test("relists when the active provider gets another base URL", async () => {
    const { controller, state } = await ready(at("moved-from"));
    controller.setProviders({ providers: [{ ...at("moved-to"), name: "moved-from" }], skipped: [] });
    await until(state, (s) => listings.get("moved-to") === 1 && s.model === "m");
    expect(listings.get("moved-from")).toBe(1);
  });
});

describe("ChatController CA file change", () => {
  test("relists the models when the active provider's CA file changes, without a retry", async () => {
    const controller = new ChatController({ get: async () => undefined }, memoryStore(), () => {}, noMentions);
    const state = () => controller.snapshot;
    controller.setProviders({ providers: [{ ...ollama, caFile: "relative.pem" }], skipped: [] });
    await until(state, (s) => s.models.status === "failed");
    expect(state().models).toMatchObject({ status: "failed", error: { kind: "caFileInvalid", path: "relative.pem" } });

    controller.setProviders({ providers: [ollama], skipped: [] });
    await until(state, (s) => s.model === "m");
  });
});

describe("ChatController reasoning", () => {
  for (const shape of Object.keys(shapes)) {
    test(`keeps the reasoning in the entry and sends only the answer back, for ${shape}`, async () => {
      const prefix = `shape-${shape}`;
      const { controller } = await ready({ name: "Shape", baseUrl: `http://localhost:${server.port}/${prefix}/v1` });
      await controller.send("Hi");
      expect(controller.snapshot.entries.at(-1)).toEqual({
        role: "assistant",
        reasoning: "Plan.",
        content: "Answer",
        status: "done",
      });

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
    const controller = new ChatController(
      { get: async () => undefined },
      memoryStore(),
      (s) => {
        const last = s.entries.at(-1);
        if (last?.role === "assistant") published.push(structuredClone(last));
      },
      noMentions,
    );
    const state = () => controller.snapshot;
    controller.setProviders({
      providers: [{ name: "vLLM", baseUrl: `http://localhost:${server.port}/vllm/v1` }],
      skipped: [],
    });
    await until(state, (s) => s.model === "m");

    const sent = controller.send("Hi");
    await until(state, () => requests.get("vllm")?.length === 1);
    expect(state().entries.at(-1)).toEqual({ role: "assistant", reasoning: "", content: "", status: "waiting" });
    releaseVllm();
    await sent;
    // Every state the panel saw: the opening chunk changes nothing, the first reasoning piece ends `waiting`.
    const reply = (status: string, reasoning: string, content: string) => ({
      role: "assistant",
      reasoning,
      content,
      status,
    });
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
    expect(controller.snapshot.entries.at(-1)).toEqual({
      role: "assistant",
      reasoning: "Plan, never closed",
      content: "",
      status: "done",
    });

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

describe("ChatController mentions", () => {
  const mentionsProvider: Provider = { name: "Mentions", baseUrl: `http://localhost:${server.port}/mentions/v1` };
  const lastRequest = () => requests.get("mentions")?.at(-1) as { messages: { role: string; content: string }[] };

  /** Reader with one attached file, `src/a.ts`; every other path is missing. Counts its reads. */
  function fakeReader() {
    const reads: string[] = [];
    const reader: MentionReader = {
      read: async (path): Promise<ReadMention> => {
        reads.push(path);
        return path === "src/a.ts"
          ? { path, kind: "file", status: "attached", lines: 1, content: "export const a = 1;\n", omitted: 0 }
          : { path, kind: "file", status: "missing", content: "", omitted: 0 };
      },
    };
    return { reader, reads };
  }

  test("sends the text followed by each mention's block, and shows the typed text with each mention's status", async () => {
    const { reader } = fakeReader();
    const { controller } = await ready(mentionsProvider, reader);
    await controller.send("explain @src/a.ts and @gone.txt");

    expect(lastRequest().messages.at(-1)).toEqual({
      role: "user",
      content: [
        "explain @src/a.ts and @gone.txt",
        "",
        "@src/a.ts (file, 1 line)",
        "```",
        "export const a = 1;",
        "```",
        "",
        "@gone.txt (file, missing)",
        "Not attached: no such file or folder in the workspace.",
      ].join("\n"),
    });
    expect(controller.snapshot.entries[0]).toEqual({
      role: "user",
      content: "explain @src/a.ts and @gone.txt",
      mentions: [
        { path: "src/a.ts", kind: "file", status: "attached", lines: 1 },
        { path: "gone.txt", kind: "file", status: "missing" },
      ],
    });
    expect(JSON.stringify(controller.snapshot)).not.toContain("export const a");
  });

  test("reads a path picked in the menu whole, spaces included, beside a typed mention", async () => {
    const { reader, reads } = fakeReader();
    const { controller } = await ready(mentionsProvider, reader);
    await controller.send("compare @my file.ts with @src/a.ts", ["my file.ts"]);

    expect(reads).toEqual(["my file.ts", "src/a.ts"]);
    expect(controller.snapshot.entries[0]).toMatchObject({
      mentions: [
        { path: "my file.ts", status: "missing" },
        { path: "src/a.ts", status: "attached" },
      ],
    });
  });

  test("resends the message composed at send time on later turns, without reading the files again", async () => {
    const { reader, reads } = fakeReader();
    const { controller } = await ready(mentionsProvider, reader);
    await controller.send("explain @src/a.ts");
    const composed = lastRequest().messages.at(-1);
    await controller.send("And then?");

    expect(lastRequest().messages).toEqual([
      composed!,
      { role: "assistant", content: "Answer" },
      { role: "user", content: "And then?" },
    ]);
    expect(reads).toEqual(["src/a.ts"]);
  });

  test("still sends the message when reading a mention throws, reporting it unreadable", async () => {
    const failing: MentionReader = {
      read: async () => {
        throw new Error("disk on fire");
      },
    };
    const { controller } = await ready(mentionsProvider, failing);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await controller.send("look at @x.ts");
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }

    expect(lastRequest().messages.at(-1)?.content).toBe(
      "look at @x.ts\n\n@x.ts (file, unreadable)\nNot attached: the path could not be read (Error: disk on fire).",
    );
    expect(controller.snapshot.entries[0]).toMatchObject({ mentions: [{ path: "x.ts", status: "unreadable" }] });
    expect(controller.snapshot.entries[1]).toMatchObject({ status: "done", content: "Answer" });
  });

  /** Reader whose reads wait for `release`, each then reporting its path missing. */
  function pendingReader() {
    const waiting: (() => void)[] = [];
    const reader: MentionReader = {
      read: (path) =>
        new Promise((resolve) => {
          waiting.push(() => resolve({ path, kind: "file", status: "missing", content: "", omitted: 0 }));
        }),
    };
    const release = () => {
      for (const resolve of waiting.splice(0)) resolve();
    };
    return { reader, release };
  }

  test("publishes the message and a waiting reply before its mentions are read, then their statuses", async () => {
    const { reader, release } = pendingReader();
    const published: ChatState[] = [];
    const { controller } = await ready(mentionsProvider, reader, (state) => published.push(structuredClone(state)));
    published.length = 0;
    const sent = controller.send("read @slow.ts");

    expect(published.at(-1)?.entries).toEqual([
      { role: "user", content: "read @slow.ts", mentions: [] },
      { role: "assistant", reasoning: "", content: "", status: "waiting" },
    ]);
    release();
    await sent;
    expect(published.at(-1)?.entries[0]).toEqual({
      role: "user",
      content: "read @slow.ts",
      mentions: [{ path: "slow.ts", kind: "file", status: "missing" }],
    });
  });

  test("a send dropped by a new chat while its mentions are read leaves Stop on the next reply", async () => {
    const { reader, release } = pendingReader();
    const { controller, state } = await ready(ollama, reader);
    const dropped = controller.send("read @slow.ts");
    controller.newChat();
    const next = controller.send("Hi");
    await until(state, (s) => s.entries.at(-1)?.content === "Partial ");
    release();
    await dropped;
    // [>]: A lost abort handle makes this Stop a no-op, and `next` never settles: the test times out.
    controller.stop();
    await next;
    expect(state().entries).toMatchObject([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Partial ", status: "stopped" },
    ]);
  });

  test("Stop ends the reply at once while a mention read hangs, and a new send works", async () => {
    const { reader, release } = pendingReader();
    const { controller, state } = await ready(mentionsProvider, reader);
    const stuck = controller.send("read @stuck.ts");
    controller.stop();
    await Promise.race([stuck, Bun.sleep(100)]);

    expect(isReplying(state())).toBe(false);
    expect(state().entries.at(-1)).toMatchObject({ role: "assistant", status: "stopped" });
    expect(state().entries.at(-2)).toMatchObject({ role: "user", mentions: [] });

    await controller.send("Hi");
    expect(state().entries.at(-1)).toMatchObject({ role: "assistant", status: "done", content: "Answer" });
    release();
    await Bun.sleep(0);
    expect(state().entries.at(-4)).toMatchObject({ role: "user", mentions: [] });
  });

  test("sends nothing when the reply is stopped while mentions are read", async () => {
    let release: () => void = () => {};
    const slow: MentionReader = {
      read: (path) =>
        new Promise((resolve) => {
          release = () => resolve({ path, kind: "file", status: "missing", content: "", omitted: 0 });
        }),
    };
    const stopProvider: Provider = { name: "Stop", baseUrl: `http://localhost:${server.port}/mentions-stop/v1` };
    const { controller } = await ready(stopProvider, slow);
    const sent = controller.send("read @slow.ts");
    controller.setProviders({ providers: [], skipped: [] });
    release();
    await sent;

    expect(controller.snapshot.entries.at(-1)).toMatchObject({ role: "assistant", status: "stopped" });
    expect(requests.get("mentions-stop")).toBeUndefined();
  });
});
