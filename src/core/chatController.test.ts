import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { ChatController, type ChoiceStore } from "./chatController";
import { type ConversationRecord, newConversationId } from "./conversation";
import { type MemoryFiles, memoryFiles } from "./conversationFixture";
import { ConversationStore } from "./conversationStore";
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
        : prefix === "mentions" || prefix === "saved"
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
  const controller = new ChatController(
    { get: async () => undefined },
    memoryStore(),
    publish,
    mentions,
    new ConversationStore(undefined),
  );
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
    const controller = new ChatController(
      { get: async () => undefined },
      memoryStore(),
      () => {},
      noMentions,
      new ConversationStore(undefined),
    );
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
      new ConversationStore(undefined),
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

describe("ChatController conversations", () => {
  const reasoningProvider: Provider = { name: "Saved", baseUrl: `http://localhost:${server.port}/saved/v1` };
  const lastRequest = (prefix: string) => requests.get(prefix)?.at(-1) as { messages: unknown[] };

  /** One workspace's storage: conversation files and memento, shared by every controller opened on it. */
  type Workspace = { files: MemoryFiles; memento: ChoiceStore };
  const workspace = (files: MemoryFiles = memoryFiles()): Workspace => ({ files, memento: memoryStore() });

  /** Controller as at window load on `ws`: settings applied, saved conversations restored, model listed. */
  async function load(
    ws: Workspace,
    options: { provider?: Provider; mentions?: MentionReader; apiKey?: string; now?: () => number } = {},
  ) {
    const controller = new ChatController(
      { get: async () => options.apiKey },
      ws.memento,
      () => {},
      options.mentions ?? noMentions,
      new ConversationStore(ws.files),
      options.now,
    );
    const state = () => controller.snapshot;
    controller.setProviders({ providers: [options.provider ?? ollama], skipped: [] });
    await controller.restore();
    await until(state, (s) => s.model === "m");
    return { controller, state };
  }

  /** Raw saved JSON of conversation `id`, as written. */
  const raw = (ws: Workspace, id: string) => {
    const text = ws.files.files.get(`${id}.json`);
    return text === undefined ? undefined : (JSON.parse(text) as ConversationRecord);
  };

  /** Saved reply of conversation `id`: its second entry. */
  const savedReply = (ws: Workspace, id: string) => {
    const entry = raw(ws, id)?.entries[1];
    return entry?.role === "assistant" ? entry : undefined;
  };

  async function eventually(check: () => boolean, what: string): Promise<void> {
    for (let waited = 0; !check(); waited += 5) {
      if (waited > 2000) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(5);
    }
  }

  /** Reader that holds each read until `release`, then reports the path missing. */
  function heldReader() {
    let release: () => void = () => {};
    const reader: MentionReader = {
      read: (path) =>
        new Promise((resolve) => {
          release = () => resolve({ path, kind: "file", status: "missing", content: "", omitted: 0 });
        }),
    };
    return { reader, release: () => release() };
  }

  test("saves the message and its waiting reply when sent, then the text the model received", async () => {
    const ws = workspace();
    const { reader, release } = heldReader();
    const { controller, state } = await load(ws, { provider: reasoningProvider, mentions: reader });
    const sent = controller.send("read  @slow.ts");
    const id = state().conversationId;

    await eventually(() => raw(ws, id) !== undefined, "the first save");
    expect(raw(ws, id)?.entries).toEqual([
      { role: "user", content: "read  @slow.ts", mentions: [], modelText: "read  @slow.ts" },
      { role: "assistant", reasoning: "", content: "", status: "waiting" },
    ]);
    release();
    await sent;
    await eventually(() => savedReply(ws, id)?.status === "done", "the final save");
    expect(raw(ws, id)?.entries).toEqual([
      {
        role: "user",
        content: "read  @slow.ts",
        mentions: [{ path: "slow.ts", kind: "file", status: "missing" }],
        modelText: "read  @slow.ts\n\n@slow.ts (file, missing)\nNot attached: no such file or folder in the workspace.",
      },
      { role: "assistant", reasoning: "Plan.", content: "Answer", status: "done" },
    ]);
    expect(state().conversations).toMatchObject([{ id, title: "read @slow.ts" }]);
    expect(JSON.stringify(state())).not.toContain("Not attached");
  });

  test("saves a streaming reply at most every 500 ms and on its end; a reload meanwhile shows it stopped", async () => {
    const ws = workspace();
    let writes = 0;
    const write = ws.files.write;
    ws.files.write = (name, text) => {
      writes += 1;
      return write(name, text);
    };
    const { controller, state } = await load(ws);
    const sent = controller.send("Hi");
    const id = state().conversationId;
    await until(state, (s) => s.entries.at(-1)?.content === "Partial ");
    await Bun.sleep(50);
    expect(writes).toBe(1);
    expect(raw(ws, id)?.entries[1]).toMatchObject({ content: "", status: "waiting" });

    await eventually(() => raw(ws, id)?.entries[1]?.content === "Partial ", "the streaming save");
    expect(writes).toBe(2);
    expect(raw(ws, id)?.entries[1]).toMatchObject({ status: "streaming" });

    const reloaded = await load(workspace(ws.files), {});
    expect(reloaded.state().conversations).toMatchObject([{ id }]);
    const reopened = await load({ files: ws.files, memento: ws.memento });
    expect(reopened.state().conversationId).toBe(id);
    expect(reopened.state().entries).toEqual([
      { role: "user", content: "Hi", mentions: [] },
      { role: "assistant", reasoning: "", content: "Partial ", status: "stopped" },
    ]);
    expect(isReplying(reopened.state())).toBe(false);

    finishReply();
    await sent;
    await eventually(() => savedReply(ws, id)?.status === "done", "the final save");
    expect(writes).toBe(3);
    expect(raw(ws, id)?.entries[1]).toMatchObject({ content: "Partial end", status: "done" });
  });

  test("after a reload, continues the conversation with every earlier message as sent and no reasoning", async () => {
    const ws = workspace();
    const reader: MentionReader = {
      read: async (path) => ({
        path,
        kind: "file",
        status: "attached",
        lines: 1,
        content: "const a = 1;\n",
        omitted: 0,
      }),
    };
    const first = await load(ws, { provider: reasoningProvider, mentions: reader });
    await first.controller.send("explain @a.ts");
    const composed = lastRequest("saved").messages.at(-1);
    await eventually(() => first.state().conversations.length === 1, "the save");

    const { controller, state } = await load(ws, { provider: reasoningProvider });
    expect(state().entries).toEqual(first.state().entries);
    await controller.send("And then?");
    expect(lastRequest("saved").messages).toEqual([
      composed,
      { role: "assistant", content: "Answer" },
      { role: "user", content: "And then?" },
    ]);
    expect(JSON.stringify(lastRequest("saved"))).not.toContain("Plan.");
  });

  test("New chat starts a new conversation and lists the previous one; reopening it continues it", async () => {
    const ws = workspace();
    const { controller, state } = await load(ws, { provider: reasoningProvider });
    await controller.send("First");
    const firstId = state().conversationId;
    controller.newChat();

    expect(state().conversationId).not.toBe(firstId);
    expect(state().entries).toEqual([]);
    await eventually(() => state().conversations.length === 1, "the list");
    expect(state().conversations).toMatchObject([{ id: firstId, title: "First" }]);
    expect([...ws.files.files.keys()]).toEqual([`${firstId}.json`]);

    await controller.send("Second");
    await controller.openConversation(firstId);
    expect(state()).toMatchObject({ conversationId: firstId, entries: [{ content: "First" }, { content: "Answer" }] });
    await controller.send("More");
    expect(lastRequest("saved").messages).toEqual([
      { role: "user", content: "First" },
      { role: "assistant", content: "Answer" },
      { role: "user", content: "More" },
    ]);
    await eventually(() => state().conversations[0]?.id === firstId, "the reopened one listed newest");
    expect(state().conversations).toHaveLength(2);
  });

  test("New chat or opening another conversation during a reply saves it stopped in its own record", async () => {
    const ws = workspace();
    const { controller, state } = await load(ws);
    const one = controller.send("One");
    const oneId = state().conversationId;
    await until(state, (s) => s.entries.at(-1)?.content === "Partial ");
    controller.newChat();
    await one;
    await eventually(() => savedReply(ws, oneId)?.status === "stopped", "one stopped");
    expect(raw(ws, oneId)?.entries[1]).toMatchObject({ content: "Partial " });

    const two = controller.send("Two");
    const twoId = state().conversationId;
    await until(state, (s) => s.entries.at(-1)?.content === "Partial ");
    await controller.openConversation(oneId);
    await two;
    expect(state()).toMatchObject({ conversationId: oneId, entries: [{ content: "One" }, { status: "stopped" }] });
    await eventually(() => savedReply(ws, twoId)?.status === "stopped", "two stopped");
    expect(raw(ws, twoId)?.entries).toMatchObject([{ content: "Two" }, { content: "Partial " }]);
  });

  test("deleting removes the file and the row; deleting the one shown starts a new one", async () => {
    const ws = workspace();
    const { controller, state } = await load(ws, { provider: reasoningProvider });
    await controller.send("Keep");
    const keepId = state().conversationId;
    controller.newChat();
    await controller.send("Drop");
    const dropId = state().conversationId;
    await eventually(() => state().conversations.length === 2, "two listed");

    await controller.deleteConversation(keepId);
    expect(state().conversationId).toBe(dropId);
    expect(state().conversations.map((c) => c.id)).toEqual([dropId]);
    expect(ws.files.files.has(`${keepId}.json`)).toBe(false);

    await controller.deleteConversation(dropId);
    expect(state().conversationId).not.toBe(dropId);
    expect(state()).toMatchObject({ entries: [], conversations: [] });
    expect(ws.files.files.size).toBe(0);
  });

  test("deleting the conversation shown during a reply stops it and never brings its file back", async () => {
    const ws = workspace();
    const { controller, state } = await load(ws);
    const sent = controller.send("Hi");
    const id = state().conversationId;
    await until(state, (s) => s.entries.at(-1)?.content === "Partial ");
    await controller.deleteConversation(id);
    await sent;
    await Bun.sleep(600);
    expect(ws.files.files.size).toBe(0);
    expect(state().conversations).toEqual([]);
  });

  test("the 51st conversation deletes the oldest from the list and the disk", async () => {
    const seeded = Array.from(
      { length: 50 },
      (_, index): ConversationRecord => ({
        version: 1,
        id: newConversationId(),
        createdAt: index + 1,
        updatedAt: index + 1,
        entries: [{ role: "user", content: `c${index}`, mentions: [], modelText: `c${index}` }],
      }),
    );
    const files = memoryFiles(
      Object.fromEntries(seeded.map((record) => [`${record.id}.json`, JSON.stringify(record)])),
    );
    const ws = workspace(files);
    const { controller, state } = await load(ws, { provider: reasoningProvider, now: () => 1000 });
    expect(state().conversations).toHaveLength(50);

    await controller.send("Newest");
    await eventually(() => files.files.size === 50 && state().conversations.length === 50, "the oldest deleted");
    expect(files.files.has(`${seeded[0]!.id}.json`)).toBe(false);
    expect(state().conversations[0]).toMatchObject({ id: state().conversationId, title: "Newest" });
    expect(state().conversations.map((c) => c.id)).not.toContain(seeded[0]!.id);
  });

  test("starts a new conversation when the saved current one is unreadable, and lists the valid ones", async () => {
    const valid: ConversationRecord = {
      version: 1,
      id: newConversationId(),
      createdAt: 1,
      updatedAt: 1,
      entries: [{ role: "user", content: "ok", mentions: [], modelText: "ok" }],
    };
    const broken = newConversationId();
    const ws = workspace(
      memoryFiles({ [`${valid.id}.json`]: JSON.stringify(valid), [`${broken}.json`]: '{"version":9}' }),
    );
    await ws.memento.update("brokeCode.currentConversation", broken);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { state } = await load(ws);
      expect(state()).toMatchObject({ entries: [], conversations: [{ id: valid.id }], storageProblem: undefined });
      expect(state().conversationId).not.toBe(broken);
    } finally {
      logged.mockRestore();
    }
  });

  test("shows a saved conversation it cannot read as a listing failure, and lists the others", async () => {
    const [good, locked] = [newConversationId(), newConversationId()];
    const saved = (id: string): ConversationRecord => ({
      version: 1,
      id,
      createdAt: 1,
      updatedAt: 1,
      entries: [{ role: "user", content: "ok", mentions: [], modelText: "ok" }],
    });
    const files = memoryFiles({
      [`${good}.json`]: JSON.stringify(saved(good)),
      [`${locked}.json`]: JSON.stringify(saved(locked)),
    });
    const read = files.read;
    files.read = async (name) => {
      if (name === `${locked}.json`) throw new Error("EACCES: permission denied");
      return read(name);
    };
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { state } = await load(workspace(files));
      expect(state().conversations).toMatchObject([{ id: good }]);
      expect(state().storageProblem).toEqual({
        kind: "listFailed",
        cause: `${locked}: Error: EACCES: permission denied`,
      });
    } finally {
      logged.mockRestore();
    }
  });

  test("without a storage directory, chats in memory with an empty list and no error", async () => {
    const controller = new ChatController(
      { get: async () => undefined },
      memoryStore(),
      () => {},
      noMentions,
      new ConversationStore(undefined),
    );
    const state = () => controller.snapshot;
    controller.setProviders({ providers: [reasoningProvider], skipped: [] });
    await controller.restore();
    await until(state, (s) => s.model === "m");
    await controller.send("Hi");
    controller.newChat();
    await Bun.sleep(20);
    expect(state()).toMatchObject({ entries: [], conversations: [], storageProblem: undefined });
  });

  test("reports a failed save, and clears it once a save succeeds", async () => {
    const ws = workspace();
    const { controller, state } = await load(ws, { provider: reasoningProvider });
    ws.files.failWrites = new Error("ENOSPC: no space left on device");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await controller.send("Hi");
      await until(state, (s) => s.storageProblem !== undefined);
      expect(state().storageProblem).toEqual({ kind: "saveFailed", cause: "Error: ENOSPC: no space left on device" });
      expect(state().conversations).toEqual([]);
      expect(logged).toHaveBeenCalled();

      ws.files.failWrites = undefined;
      await controller.send("Again");
      await until(state, (s) => s.storageProblem === undefined && s.conversations.length === 1);
    } finally {
      logged.mockRestore();
    }
  });

  test("says a conversation to open is not found, leaves the one shown alone, and clears it at the next switch", async () => {
    const { controller, state } = await load(workspace(), { provider: reasoningProvider });
    await controller.send("Hi");
    const id = state().conversationId;
    await controller.openConversation(newConversationId());
    expect(state()).toMatchObject({ conversationId: id, storageProblem: { kind: "notFound" } });
    expect(state().entries).toHaveLength(2);

    controller.newChat();
    expect(state().storageProblem).toBeUndefined();
  });

  test("never writes the API key or anything else of the provider access into a saved conversation", async () => {
    const ws = workspace();
    const { controller, state } = await load(ws, { provider: reasoningProvider, apiKey: "sk-secret-123" });
    await controller.send("Hi");
    await eventually(() => state().conversations.length === 1, "the save");
    const text = ws.files.files.get(`${state().conversationId}.json`)!;
    expect(text).not.toContain("sk-secret-123");
    expect(text).not.toContain("apiKey");
    const saved = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual([
      "createdAt",
      "entries",
      "id",
      "model",
      "provider",
      "updatedAt",
      "version",
    ]);
    expect(saved).toMatchObject({ version: 1, provider: "Saved", model: "m" });
  });

  /** Files whose writes, reads, or removes wait for `release` while held. */
  function held(files: MemoryFiles, operation: "write" | "read" | "remove") {
    let hold: Promise<void> | undefined;
    let release: () => void = () => {};
    const original = files[operation] as (name: string, text: string) => Promise<unknown>;
    const wrapped = async (name: string, text: string) => {
      if (hold) await hold;
      return original(name, text);
    };
    (files as Record<string, unknown>)[operation] = wrapped;
    return {
      hold: () => {
        hold = new Promise((resolve) => {
          release = () => {
            hold = undefined;
            resolve();
          };
        });
      },
      release: () => release(),
    };
  }

  test("waits for the first save before the request starts", async () => {
    const ws = workspace();
    const writes = held(ws.files, "write");
    const provider: Provider = { name: "Wait", baseUrl: `http://localhost:${server.port}/wait-save/v1` };
    const { controller, state } = await load(ws, { provider });
    writes.hold();
    const sent = controller.send("Hi");
    await Bun.sleep(50);
    expect(requests.get("wait-save")).toBeUndefined();
    expect(state().entries.at(-1)).toMatchObject({ status: "waiting" });
    writes.release();
    await until(state, () => requests.get("wait-save")?.length === 1);
    controller.stop();
    await sent;
  });

  test("Stop while the first save waits sends nothing and leaves the reply stopped", async () => {
    const ws = workspace();
    const writes = held(ws.files, "write");
    const provider: Provider = { name: "Stop", baseUrl: `http://localhost:${server.port}/stop-save/v1` };
    const { controller, state } = await load(ws, { provider });
    writes.hold();
    const sent = controller.send("Hi");
    controller.stop();
    await sent;
    expect(state().entries.at(-1)).toMatchObject({ status: "stopped" });
    writes.release();
    await eventually(() => savedReply(ws, state().conversationId)?.status === "stopped", "the stopped save");
    expect(requests.get("stop-save")).toBeUndefined();
  });

  test("a failed first save is shown and the reply still streams", async () => {
    const ws = workspace();
    const { controller, state } = await load(ws, { provider: reasoningProvider });
    ws.files.failWrites = new Error("EROFS: read-only file system");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await controller.send("Hi");
      expect(state().entries.at(-1)).toMatchObject({ status: "done", content: "Answer" });
      expect(state().storageProblem).toMatchObject({ kind: "saveFailed" });
    } finally {
      logged.mockRestore();
    }
  });

  test("reopening right after New chat shows the stopped reply as it is, never an older save", async () => {
    const ws = workspace();
    const { controller, state } = await load(ws);
    const sent = controller.send("First");
    const id = state().conversationId;
    await until(state, (s) => s.entries.at(-1)?.content === "Partial ");
    controller.newChat();
    await controller.openConversation(id);
    await sent;
    expect(state()).toMatchObject({ conversationId: id, entries: [{ content: "First" }, { content: "Partial " }] });
    await eventually(() => savedReply(ws, id)?.status === "stopped", "the stopped save");
    expect(savedReply(ws, id)).toMatchObject({ content: "Partial " });
  });

  test("reopening while the stopped reply's save waits shows the saved reply, and the next turn keeps it", async () => {
    const ws = workspace();
    const writes = held(ws.files, "write");
    const { controller, state } = await load(ws);
    const sent = controller.send("First");
    const id = state().conversationId;
    await until(state, (s) => s.entries.at(-1)?.content === "Partial ");
    writes.hold();
    controller.newChat();
    await sent;
    const opening = controller.openConversation(id);
    writes.release();
    await opening;
    expect(state().entries.at(-1)).toMatchObject({ content: "Partial ", status: "stopped" });

    const next = controller.send("Follow-up");
    await until(state, (s) => s.entries.at(-1)?.content === "Partial " && s.entries.length === 4);
    finishReply();
    await next;
    await eventually(() => raw(ws, id)?.entries.length === 4 && savedReply(ws, id) !== undefined, "the next turn");
    expect(raw(ws, id)?.entries[1]).toMatchObject({ content: "Partial " });
  });

  /** One saved conversation `content`, updated at `time`. */
  const savedRecord = (content: string, time = 1): ConversationRecord => ({
    version: 1,
    id: newConversationId(),
    createdAt: time,
    updatedAt: time,
    entries: [{ role: "user", content, mentions: [], modelText: content }],
  });
  const filesOf = (...records: ConversationRecord[]) =>
    memoryFiles(Object.fromEntries(records.map((record) => [`${record.id}.json`, JSON.stringify(record)])));

  test("a delete while the conversation is being opened wins: it is never shown", async () => {
    const record = savedRecord("keep history");
    const ws = workspace(filesOf(record));
    const reads = held(ws.files, "read");
    const { controller, state } = await load(ws);
    reads.hold();
    const opening = controller.openConversation(record.id);
    const deleting = controller.deleteConversation(record.id);
    reads.release();
    await opening;
    expect(state().conversationId).not.toBe(record.id);
    await deleting;
    expect(state().conversationId).not.toBe(record.id);
    expect(state()).toMatchObject({ conversations: [], storageProblem: undefined });
    expect(ws.files.files.size).toBe(0);
  });

  test("a stale open shows neither its entries nor its error", async () => {
    const [first, second] = [savedRecord("first"), savedRecord("second")];
    const ws = workspace(filesOf(first, second));
    const { controller, state } = await load(ws);
    const read = ws.files.read;
    let failRead: ((error: Error) => void) | undefined;
    ws.files.read = () => new Promise((_, reject) => (failRead = reject));
    const failing = controller.openConversation(first.id);
    controller.newChat();
    await eventually(() => failRead !== undefined, "the read");
    failRead!(new Error("old read failed"));
    await failing;
    expect(state()).toMatchObject({ entries: [], storageProblem: undefined });

    let finishRead: (() => void) | undefined;
    ws.files.read = (name) => new Promise((resolve) => (finishRead = () => resolve(read(name))));
    const slow = controller.openConversation(first.id);
    await eventually(() => finishRead !== undefined, "the slow read");
    ws.files.read = read;
    const fast = controller.openConversation(second.id);
    finishRead!();
    await Promise.all([slow, fast]);
    expect(state()).toMatchObject({ conversationId: second.id, entries: [{ content: "second" }] });
  });

  test("never prunes the conversation being opened, even when it is the oldest", async () => {
    const seeded = Array.from({ length: 50 }, (_, index) => savedRecord(`c${index}`, index + 1));
    const oldest = seeded[0]!;
    const ws = workspace(filesOf(...seeded));
    const writes = held(ws.files, "write");
    const { controller, state } = await load(ws, { provider: reasoningProvider, now: () => 1000 });
    writes.hold();
    const sent = controller.send("Newest");
    const opening = controller.openConversation(oldest.id);
    writes.release();
    await Promise.all([sent, opening]);
    await eventually(() => ws.files.files.size === 50, "the prune");
    expect(state().conversationId).toBe(oldest.id);
    expect(ws.files.files.has(`${oldest.id}.json`)).toBe(true);
    expect(ws.files.files.has(`${seeded[1]!.id}.json`)).toBe(false);
  });

  test("deleting the conversation shown stops its reply at once, before a slow delete ends", async () => {
    const ws = workspace();
    const removes = held(ws.files, "remove");
    const { controller, state } = await load(ws);
    const sent = controller.send("Hi");
    const id = state().conversationId;
    await until(state, (s) => s.entries.at(-1)?.content === "Partial ");
    removes.hold();
    const deleting = controller.deleteConversation(id);
    await sent;
    expect(state()).toMatchObject({ entries: [] });
    expect(state().conversationId).not.toBe(id);
    removes.release();
    await deleting;
    expect(ws.files.files.size).toBe(0);
  });

  test("a failed delete keeps the row and says so; a later delete that works clears it", async () => {
    const record = savedRecord("stay");
    const ws = workspace(filesOf(record));
    const { controller, state } = await load(ws);
    const remove = ws.files.remove;
    ws.files.remove = async () => {
      throw new Error("EACCES: permission denied");
    };
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await controller.deleteConversation(record.id);
    } finally {
      logged.mockRestore();
    }
    expect(state()).toMatchObject({
      conversations: [{ id: record.id }],
      storageProblem: { kind: "deleteFailed", cause: "Error: EACCES: permission denied" },
    });
    ws.files.remove = remove;
    await controller.deleteConversation(record.id);
    expect(state()).toMatchObject({ conversations: [], storageProblem: undefined });
  });

  test("opening a listed conversation whose file is gone removes that row only", async () => {
    const [gone, other] = [savedRecord("gone", 1), savedRecord("other", 2)];
    const ws = workspace(filesOf(gone, other));
    const { controller, state } = await load(ws);
    ws.files.files.delete(`${gone.id}.json`);
    await controller.openConversation(gone.id);
    expect(state().conversations.map((summary) => summary.id)).toEqual([other.id]);
    expect(state().storageProblem).toEqual({ kind: "notFound" });
  });
});
