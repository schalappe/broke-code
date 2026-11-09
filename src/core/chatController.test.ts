import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatController,
  type ChatPorts,
  type ChoiceStore,
  type InstructionReader,
  MAX_TOOL_STEPS,
  type ToolRunner,
} from "./chatController";
import { type ConversationRecord, newConversationId, serializeSummary } from "./conversation";
import { type MemoryFiles, memoryFiles } from "./conversationFixture";
import { ConversationStore } from "./conversationStore";
import type { MentionReader, ReadMention } from "./mentions";
import { type ChatEntry, type ChatState, isReplying } from "./protocol";
import type { Provider } from "./providers";
import { composeSystemPrompt, type InstructionFile } from "./systemPrompt";
import { createTlsFixture } from "./tlsFixture";
import { READ_TOOLS, runReadTool, type ToolResult } from "./tools";
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

/**
 * One scripted reply: its answer and optional reasoning, streamed whole; `hang` streams "Partial " and never ends;
 * `fail` answers HTTP 500.
 */
type ScriptedReply = { content: string; reasoning?: string } | "hang" | "fail";
/** Replies still to send, by path prefix, one per request. */
const scripts = new Map<string, ScriptedReply[]>();

function scriptedResponse(reply: ScriptedReply | undefined): Response {
  const headers = { "content-type": "text/event-stream" };
  if (reply === undefined) return new Response("script exhausted", { status: 500 });
  if (reply === "fail") return new Response("model crashed", { status: 500 });
  if (reply === "hang") {
    return new Response(new ReadableStream({ start: (controller) => controller.enqueue(chunk("Partial ")) }), {
      headers,
    });
  }
  const reasoning = reply.reasoning ? [event({ content: "", reasoning: reply.reasoning })] : [];
  return new Response(`${[...reasoning, event({ content: reply.content })].join("")}data: [DONE]\n\n`, { headers });
}

/** Body of each chat request, by path prefix. */
const requests = new Map<string, unknown[]>();
/** Number of model listings, by path prefix. */
const listings = new Map<string, number>();

// Provider that lists one model. Path `/a/` and `/b/` stream "Partial ", then finish only when `finishReply` is
// called; `/shape-<name>/` streams that shape whole; `/unclosed/` streams `reasoningOnly`; `/vllm/` sends the vLLM
// opening chunk, then the rest of its reasoning reply only when `releaseVllm` is called; `/mentions/` streams the
// `reasoning` shape whole; a prefix with a script in `scripts` answers each request with its next scripted reply.
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
    if (prefix === "fails") return new Response("model crashed", { status: 500 });
    const script = scripts.get(prefix);
    if (script) return scriptedResponse(script.shift());
    if (prefix === "late-flush") {
      // [>]: Ends inside a closing `</think>` tag, then stays open: Stop makes the splitter flush the held `</thi`.
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(chunk("<think>Plan.</thi")),
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
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

/** The text of a user or assistant entry; `undefined` for a tool step or no entry. */
const contentOf = (entry: ChatEntry | undefined) => (entry && entry.role !== "tool" ? entry.content : undefined);

/** The system message of a turn with the read tools and no instruction file. */
const SYSTEM = { role: "system", content: composeSystemPrompt(READ_TOOLS, []) };

/** Agent ports for replies without a call: the read tools listed, any run fails the test, no instruction file. */
const noTools: Pick<ChatPorts, "tools" | "instructions"> = {
  tools: {
    tools: READ_TOOLS,
    run: async (call) => {
      throw new Error(`unexpected tool call ${call.name}`);
    },
  },
  instructions: { read: async () => [] },
};

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
  const controller = new ChatController({
    apiKeys: { get: async () => undefined },
    workspaceState: memoryStore(),
    publish,
    mentions,
    store: new ConversationStore(undefined),
    ...noTools,
  });
  const state = () => controller.snapshot;
  controller.setProviders({ providers: [provider], skipped: [] });
  await until(state, (s) => s.model === "m");
  return { controller, state };
}

/** Controller with `ollama` configured, model listed, and a reply streaming its first chunk. */
async function replying() {
  const { controller, state } = await ready();
  const sent = controller.send("Hi");
  await until(state, (s) => s.entries.at(-1)?.role === "assistant" && contentOf(s.entries.at(-1)) === "Partial ");
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
    const controller = new ChatController({
      apiKeys: { get: async () => undefined },
      workspaceState: memoryStore(),
      publish: () => {},
      mentions: noMentions,
      store: new ConversationStore(undefined),
      ...noTools,
    });
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
          SYSTEM,
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
    const controller = new ChatController({
      apiKeys: { get: async () => undefined },
      workspaceState: memoryStore(),
      publish: (s) => {
        const last = s.entries.at(-1);
        if (last?.role === "assistant") published.push(structuredClone(last));
      },
      mentions: noMentions,
      store: new ConversationStore(undefined),
      ...noTools,
    });
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
        SYSTEM,
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
      messages: [SYSTEM, { role: "user", content: "Hi" }, { role: "user", content: "Again" }],
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
      SYSTEM,
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
    await controller.newChat();
    const next = controller.send("Hi");
    await until(state, (s) => contentOf(s.entries.at(-1)) === "Partial ");
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
    const controller = new ChatController({
      apiKeys: { get: async () => options.apiKey },
      workspaceState: ws.memento,
      publish: () => {},
      mentions: options.mentions ?? noMentions,
      store: new ConversationStore(ws.files),
      now: options.now,
      ...noTools,
    });
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

  const isSummaryName = (name: string) => name.endsWith(".summary.json");

  /** Saved records in `files`, summaries left out. */
  const recordCount = (files: MemoryFiles) => [...files.files.keys()].filter((name) => !isSummaryName(name)).length;

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
      if (!isSummaryName(name)) writes += 1;
      return write(name, text);
    };
    const { controller, state } = await load(ws);
    const sent = controller.send("Hi");
    const id = state().conversationId;
    await until(state, (s) => contentOf(s.entries.at(-1)) === "Partial ");
    await Bun.sleep(50);
    expect(writes).toBe(1);
    expect(raw(ws, id)?.entries[1]).toMatchObject({ content: "", status: "waiting" });

    await eventually(() => contentOf(raw(ws, id)?.entries[1]) === "Partial ", "the streaming save");
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
      SYSTEM,
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
    await controller.newChat();

    expect(state().conversationId).not.toBe(firstId);
    expect(state().entries).toEqual([]);
    await eventually(() => state().conversations.length === 1, "the list");
    expect(state().conversations).toMatchObject([{ id: firstId, title: "First" }]);
    expect([...ws.files.files.keys()].sort()).toEqual([`${firstId}.json`, `${firstId}.summary.json`].sort());

    await controller.send("Second");
    await controller.openConversation(firstId);
    expect(state()).toMatchObject({ conversationId: firstId, entries: [{ content: "First" }, { content: "Answer" }] });
    await controller.send("More");
    expect(lastRequest("saved").messages).toEqual([
      SYSTEM,
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
    await until(state, (s) => contentOf(s.entries.at(-1)) === "Partial ");
    await controller.newChat();
    await one;
    await eventually(() => savedReply(ws, oneId)?.status === "stopped", "one stopped");
    expect(raw(ws, oneId)?.entries[1]).toMatchObject({ content: "Partial " });

    const two = controller.send("Two");
    const twoId = state().conversationId;
    await until(state, (s) => contentOf(s.entries.at(-1)) === "Partial ");
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
    await controller.newChat();
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
    await until(state, (s) => contentOf(s.entries.at(-1)) === "Partial ");
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
        version: 2,
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
    await eventually(() => recordCount(files) === 50 && state().conversations.length === 50, "the oldest deleted");
    expect(files.files.has(`${seeded[0]!.id}.json`)).toBe(false);
    expect(state().conversations[0]).toMatchObject({ id: state().conversationId, title: "Newest" });
    expect(state().conversations.map((c) => c.id)).not.toContain(seeded[0]!.id);
  });

  /** 50 conversations updated at times 1 to 50, each with its summary; `onDisk` changes the record file only. */
  function seededWithSummaries(onDisk: (record: ConversationRecord) => ConversationRecord = (record) => record) {
    const seeded = Array.from({ length: 50 }, (_, index) => savedRecord(`c${index}`, index + 1));
    const files = memoryFiles(
      Object.fromEntries(
        seeded.flatMap((record) => [
          [`${record.id}.json`, JSON.stringify(onDisk(record))],
          [`${record.id}.summary.json`, serializeSummary(record)],
        ]),
      ),
    );
    return { seeded, files };
  }

  test("a failed summary write never makes a recently updated conversation the oldest to prune", async () => {
    const { seeded, files } = seededWithSummaries();
    const [updated, trulyOldest] = [seeded[0]!, seeded[1]!];
    const ws = workspace(files);
    const first = await load(ws, { provider: reasoningProvider, now: () => 1000 });
    await first.controller.openConversation(updated.id);
    const write = files.write;
    let [recordWrites, failedSummaryWrites] = [0, 0];
    files.write = async (name, text) => {
      if (isSummaryName(name)) {
        failedSummaryWrites += 1;
        throw new Error("ENOSPC: no space left on device");
      }
      recordWrites += 1;
      return write(name, text);
    };
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await first.controller.send("Still here");
      await eventually(() => {
        const reply = raw(ws, updated.id)?.entries.at(-1);
        return reply?.role === "assistant" && reply.status === "done" && failedSummaryWrites === recordWrites;
      }, "the final summary write");
    } finally {
      logged.mockRestore();
    }
    files.write = write;
    await first.controller.newChat();

    const { controller, state } = await load(ws, { provider: reasoningProvider, now: () => 2000 });
    expect(state().conversations).toHaveLength(50);
    await controller.send("Newest");
    await eventually(() => recordCount(files) === 50 && state().conversations.length === 50, "the prune");
    expect(raw(ws, updated.id)?.entries).toHaveLength(3);
    expect(files.files.has(`${trulyOldest.id}.json`)).toBe(false);
    expect(state().conversations.map((c) => c.id)).toContain(updated.id);
  });

  test("prunes by the record's update time when a summary left by another build is older", async () => {
    let updatedId: string | undefined;
    const { seeded, files } = seededWithSummaries((record) => {
      if (updatedId !== undefined) return record;
      updatedId = record.id;
      return { ...record, updatedAt: 900 };
    });
    const ws = workspace(files);
    const { controller, state } = await load(ws, { provider: reasoningProvider, now: () => 1000 });
    await controller.send("Newest");
    await eventually(() => recordCount(files) === 50 && state().conversations.length === 50, "the prune");
    expect(files.files.has(`${seeded[0]!.id}.json`)).toBe(true);
    expect(files.files.has(`${seeded[1]!.id}.json`)).toBe(false);
    expect(state().conversations.find((c) => c.id === seeded[0]!.id)).toMatchObject({ updatedAt: 900 });
  });

  test("never prunes a record of an unsupported version listed from its summary, and prunes the oldest valid one", async () => {
    const { seeded, files } = seededWithSummaries((record) =>
      record.updatedAt === 1 ? ({ ...record, version: 3 } as unknown as ConversationRecord) : record,
    );
    const [unsupported, oldestValid] = [seeded[0]!, seeded[1]!];
    const ws = workspace(files);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { controller, state } = await load(ws, { provider: reasoningProvider, now: () => 1000 });
      expect(state().conversations).toHaveLength(50);
      await controller.send("Newest");
      await eventually(() => recordCount(files) === 50 && state().conversations.length === 50, "the prune");
      expect(files.files.has(`${oldestValid.id}.json`)).toBe(false);
      expect(files.files.has(`${unsupported.id}.json`)).toBe(true);
      expect(files.files.has(`${unsupported.id}.summary.json`)).toBe(true);
      expect(JSON.parse(files.files.get(`${unsupported.id}.json`)!)).toMatchObject({ version: 3 });
      expect(state().conversations.map((c) => c.id)).toContain(unsupported.id);
      expect(state().storageProblem).toBeUndefined();
    } finally {
      logged.mockRestore();
    }
  });

  test("keeps and reports a conversation to prune whose record cannot be read, and prunes the next oldest", async () => {
    const { seeded, files } = seededWithSummaries();
    const ws = workspace(files);
    const { controller, state } = await load(ws, { provider: reasoningProvider, now: () => 1000 });
    const read = files.read;
    files.read = async (name) => {
      if (name === `${seeded[0]!.id}.json`) throw new Error("EACCES: permission denied");
      return read(name);
    };
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await controller.send("Newest");
      await eventually(
        () => state().storageProblem?.kind === "deleteFailed" && recordCount(files) === 50,
        "the reported check and the prune",
      );
    } finally {
      logged.mockRestore();
    }
    expect(files.files.has(`${seeded[0]!.id}.json`)).toBe(true);
    expect(files.files.has(`${seeded[1]!.id}.json`)).toBe(false);
    expect(state().conversations).toHaveLength(50);
    expect(state().storageProblem).toMatchObject({ cause: expect.stringContaining("EACCES") });
  });

  test("keeps the failed delete of the oldest conversation shown after the prune deletes the next oldest", async () => {
    const { seeded, files } = seededWithSummaries();
    const ws = workspace(files);
    const { controller, state } = await load(ws, { provider: reasoningProvider, now: () => 1000 });
    const remove = files.remove;
    files.remove = async (name) => {
      if (name.startsWith(seeded[0]!.id)) throw new Error("EBUSY: resource busy");
      return remove(name);
    };
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await controller.send("Newest");
      await eventually(() => !files.files.has(`${seeded[1]!.id}.json`), "the prune of the next oldest");
      await eventually(() => state().storageProblem?.kind === "deleteFailed", "the failed delete shown");
    } finally {
      logged.mockRestore();
    }
    expect(files.files.has(`${seeded[0]!.id}.json`)).toBe(true);
    expect(recordCount(files)).toBe(50);
    expect(state().conversations).toHaveLength(50);
    expect(state().conversations.map((c) => c.id)).toContain(seeded[0]!.id);
    expect(state().storageProblem).toMatchObject({ cause: expect.stringContaining("EBUSY") });
  });

  test("prunes at restore the conversations left past 50 by a stop before the prune", async () => {
    const seeded = Array.from(
      { length: 51 },
      (_, index): ConversationRecord => ({
        version: 2,
        id: newConversationId(),
        createdAt: index + 1,
        updatedAt: index + 1,
        entries: [{ role: "user", content: `c${index}`, mentions: [], modelText: `c${index}` }],
      }),
    );
    const files = memoryFiles(
      Object.fromEntries(seeded.map((record) => [`${record.id}.json`, JSON.stringify(record)])),
    );
    const { state } = await load(workspace(files));
    await eventually(() => recordCount(files) === 50 && state().conversations.length === 50, "the oldest deleted");
    expect(files.files.has(`${seeded[0]!.id}.json`)).toBe(false);
  });

  test("starts a new conversation when the saved current one is unreadable, and lists the valid ones", async () => {
    const valid: ConversationRecord = {
      version: 2,
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
      version: 2,
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
      expect(state().listFailed).toEqual({ cause: `${locked}: Error: EACCES: permission denied` });
      expect(state().storageProblem).toBeUndefined();
    } finally {
      logged.mockRestore();
    }
  });

  test("without a storage directory, chats in memory with an empty list and no error", async () => {
    const controller = new ChatController({
      apiKeys: { get: async () => undefined },
      workspaceState: memoryStore(),
      publish: () => {},
      mentions: noMentions,
      store: new ConversationStore(undefined),
      ...noTools,
    });
    const state = () => controller.snapshot;
    controller.setProviders({ providers: [reasoningProvider], skipped: [] });
    await controller.restore();
    await until(state, (s) => s.model === "m");
    await controller.send("Hi");
    await controller.newChat();
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

    await controller.newChat();
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
    expect(saved).toMatchObject({ version: 2, provider: "Saved", model: "m" });
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
    await until(state, (s) => contentOf(s.entries.at(-1)) === "Partial ");
    await controller.newChat();
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
    await until(state, (s) => contentOf(s.entries.at(-1)) === "Partial ");
    writes.hold();
    await controller.newChat();
    await sent;
    const opening = controller.openConversation(id);
    writes.release();
    await opening;
    expect(state().entries.at(-1)).toMatchObject({ content: "Partial ", status: "stopped" });

    const next = controller.send("Follow-up");
    await until(state, (s) => contentOf(s.entries.at(-1)) === "Partial " && s.entries.length === 4);
    finishReply();
    await next;
    await eventually(() => raw(ws, id)?.entries.length === 4 && savedReply(ws, id) !== undefined, "the next turn");
    expect(raw(ws, id)?.entries[1]).toMatchObject({ content: "Partial " });
  });

  /** One saved conversation `content`, updated at `time`. */
  const savedRecord = (content: string, time = 1): ConversationRecord => ({
    version: 2,
    id: newConversationId(),
    createdAt: time,
    updatedAt: time,
    entries: [{ role: "user", content, mentions: [], modelText: content }],
  });
  const filesOf = (...records: ConversationRecord[]) =>
    memoryFiles(Object.fromEntries(records.map((record) => [`${record.id}.json`, JSON.stringify(record)])));

  test("a delete asked while the conversation is being opened wins: it is not shown in the end", async () => {
    const record = savedRecord("keep history");
    const ws = workspace(filesOf(record));
    const reads = held(ws.files, "read");
    const { controller, state } = await load(ws);
    reads.hold();
    const opening = controller.openConversation(record.id);
    const deleting = controller.deleteConversation(record.id);
    reads.release();
    await Promise.all([opening, deleting]);
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
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = controller.openConversation(first.id);
      const newChat = controller.newChat();
      await eventually(() => failRead !== undefined, "the read");
      failRead!(new Error("old read failed"));
      await Promise.all([failing, newChat]);
    } finally {
      logged.mockRestore();
    }
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

  test("reopening the conversation shown while another open waits shows the one reopened", async () => {
    const [shown, other] = [savedRecord("shown"), savedRecord("other")];
    const ws = workspace(filesOf(shown, other));
    const { controller, state } = await load(ws);
    await controller.openConversation(shown.id);
    const read = holdRead(ws.files, 1);
    const opening = controller.openConversation(other.id);
    await eventually(read.started, "the other open's read");
    const reopening = controller.openConversation(shown.id);
    read.release();
    await Promise.all([opening, reopening]);
    expect(state()).toMatchObject({ conversationId: shown.id, entries: [{ content: "shown" }] });
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
    await eventually(() => recordCount(ws.files) === 50, "the prune");
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
    await until(state, (s) => contentOf(s.entries.at(-1)) === "Partial ");
    removes.hold();
    const deleting = controller.deleteConversation(id);
    await sent;
    await until(state, (s) => s.conversationId !== id);
    expect(state()).toMatchObject({ entries: [] });
    expect(state().conversations.map((summary) => summary.id)).toEqual([id]);
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

  /** Files whose `count`-th read waits for the returned gate: resolve to read on, reject to fail it. */
  function holdRead(files: MemoryFiles, count: number) {
    const read = files.read;
    let reads = 0;
    let started = false;
    let resolveGate: () => void = () => {};
    let rejectGate: (error: Error) => void = () => {};
    const gate = new Promise<void>((resolve, reject) => {
      resolveGate = resolve;
      rejectGate = reject;
    });
    files.read = async (name) => {
      reads += 1;
      if (reads === count) {
        started = true;
        await gate;
      }
      return read(name);
    };
    return { started: () => started, release: () => resolveGate(), fail: (error: Error) => rejectGate(error) };
  }

  /** Controller on `ws` with `current` as the conversation to reopen, not yet restored. */
  async function unrestored(ws: Workspace, current: string) {
    await ws.memento.update("brokeCode.currentConversation", current);
    const controller = new ChatController({
      apiKeys: { get: async () => undefined },
      workspaceState: ws.memento,
      publish: () => {},
      mentions: noMentions,
      store: new ConversationStore(ws.files),
      ...noTools,
    });
    return { controller, state: () => controller.snapshot };
  }

  test("a restore whose read waits never shows a conversation deleted meanwhile", async () => {
    const record = savedRecord("deleted at startup");
    const ws = workspace(filesOf(record));
    const read = holdRead(ws.files, 2);
    const { controller, state } = await unrestored(ws, record.id);
    const restoring = controller.restore();
    await eventually(read.started, "the restore's read");
    const deleting = controller.deleteConversation(record.id);
    read.release();
    await Promise.all([restoring, deleting]);
    expect(state().conversationId).not.toBe(record.id);
    expect(state()).toMatchObject({ entries: [], conversations: [] });
    expect(ws.files.files.size).toBe(0);
  });

  test("a restore read that fails after New chat shows no open error", async () => {
    const record = savedRecord("startup");
    const ws = workspace(filesOf(record));
    const read = holdRead(ws.files, 2);
    const { controller, state } = await unrestored(ws, record.id);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const restoring = controller.restore();
      await eventually(read.started, "the restore's read");
      const newChat = controller.newChat();
      read.fail(new Error("EACCES: delayed read"));
      await Promise.all([restoring, newChat]);
    } finally {
      logged.mockRestore();
    }
    expect(state()).toMatchObject({ entries: [], storageProblem: undefined });
  });

  test("an open read that fails after its conversation is deleted shows no open error", async () => {
    const record = savedRecord("deleted while opening");
    const ws = workspace(filesOf(record));
    const { controller, state } = await load(ws);
    const read = holdRead(ws.files, 1);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const opening = controller.openConversation(record.id);
      await eventually(read.started, "the open's read");
      const deleting = controller.deleteConversation(record.id);
      read.fail(new Error("EACCES: delayed read"));
      await Promise.all([opening, deleting]);
    } finally {
      logged.mockRestore();
    }
    expect(ws.files.files.size).toBe(0);
    expect(state()).toMatchObject({ conversations: [], storageProblem: undefined });
  });

  test("two opens of the oldest and a save past the limit: the conversation shown is never one pruned", async () => {
    const seeded = Array.from({ length: 50 }, (_, index) => savedRecord(`c${index}`, index + 1));
    const oldest = seeded[0]!;
    const ws = workspace(filesOf(...seeded));
    const { controller, state } = await load(ws, { provider: reasoningProvider, now: () => 1000 });
    const read = holdRead(ws.files, 1);
    const first = controller.openConversation(oldest.id);
    await eventually(read.started, "the first open's read");
    const sent = controller.send("Newest");
    const second = controller.openConversation(oldest.id);
    read.release();
    await Promise.all([first, sent, second]);
    await eventually(() => recordCount(ws.files) === 50, "the prune");
    expect(state().conversationId).toBe(oldest.id);
    expect(ws.files.files.has(`${oldest.id}.json`)).toBe(true);
    await controller.send("Still saved");
    await eventually(() => raw(ws, oldest.id)?.entries.length === 3, "the next save");
  });

  test("a row clicked while its delete waits stays listed and reopenable when the delete fails", async () => {
    const record = savedRecord("survivor");
    const ws = workspace(filesOf(record));
    const { controller, state } = await load(ws);
    let failRemove: (error: Error) => void = () => {};
    let removing = false;
    ws.files.remove = () =>
      new Promise((_, reject) => {
        removing = true;
        failRemove = reject;
      });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const deleting = controller.deleteConversation(record.id);
      await eventually(() => removing, "the delete");
      const opening = controller.openConversation(record.id);
      failRemove(new Error("EACCES: permission denied"));
      await Promise.all([deleting, opening]);
    } finally {
      logged.mockRestore();
    }
    expect(state().conversations.map((summary) => summary.id)).toEqual([record.id]);
    await controller.openConversation(record.id);
    expect(state()).toMatchObject({ conversationId: record.id, entries: [{ content: "survivor" }] });
  });

  test("waits for the save of the composed mention text before the request, and Stop ends that wait", async () => {
    const ws = workspace();
    const write = ws.files.write;
    let writes = 0;
    let holding = false;
    ws.files.write = async (name, text) => {
      if (isSummaryName(name)) return write(name, text);
      writes += 1;
      if (writes === 2) {
        holding = true;
        await new Promise(() => {});
      }
      return write(name, text);
    };
    const reader: MentionReader = {
      read: async (path) => ({ path, kind: "file", status: "attached", lines: 1, content: "x\n", omitted: 0 }),
    };
    const provider: Provider = { name: "Composed", baseUrl: `http://localhost:${server.port}/composed-save/v1` };
    const { controller, state } = await load(ws, { provider, mentions: reader });
    const sent = controller.send("read @a.ts");
    await eventually(() => holding, "the composed save");
    await Bun.sleep(30);
    expect(requests.get("composed-save")).toBeUndefined();
    controller.stop();
    await sent;
    expect(state().entries.at(-1)).toMatchObject({ status: "stopped" });
    expect(requests.get("composed-save")).toBeUndefined();
  });

  test("a provider failure is shown, saved with the reply, and still there after a reload", async () => {
    const ws = workspace();
    const provider: Provider = { name: "Fails", baseUrl: `http://localhost:${server.port}/fails/v1` };
    const { controller, state } = await load(ws, { provider });
    await controller.send("Hi");
    const id = state().conversationId;
    const failed = { status: "failed", error: { kind: "rejected", provider: "Fails", status: 500 } };
    expect(state().entries.at(-1)).toMatchObject(failed);
    await eventually(() => savedReply(ws, id)?.status === "failed", "the failed save");
    expect(savedReply(ws, id)).toMatchObject(failed);
    const reloaded = await load(ws, { provider });
    expect(reloaded.state().entries.at(-1)).toMatchObject(failed);
  });

  test("Stop ends a reply at once while its CA file read never settles, and New chat then completes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "broke-code-ca-"));
    const caFile = join(dir, "ca.pem");
    copyFileSync(createTlsFixture().ca.certPath, caFile);
    const provider: Provider = { name: "Hang", baseUrl: `http://localhost:${server.port}/ca-hang/v1`, caFile };
    const ws = workspace();
    const { controller, state } = await load(ws, { provider });
    unlinkSync(caFile);
    expect(Bun.spawnSync(["mkfifo", caFile]).exitCode).toBe(0);
    const sent = controller.send("Hello");
    const id = state().conversationId;
    try {
      await eventually(() => raw(ws, id) !== undefined, "the first save");
      await Bun.sleep(50);
      controller.stop();
      const settled = await Promise.race([sent.then(() => true), Bun.sleep(200).then(() => false)]);
      expect(settled).toBe(true);
      expect(state().entries.at(-1)).toEqual({ role: "assistant", reasoning: "", content: "", status: "stopped" });
      await eventually(() => savedReply(ws, id)?.status === "stopped", "the stopped save");
      const newChat = await Promise.race([controller.newChat().then(() => true), Bun.sleep(200).then(() => false)]);
      expect(newChat).toBe(true);
      expect(state().conversationId).not.toBe(id);
    } finally {
      // [>]: A writer unblocks the read; its late outcome (an invalid CA file) must change nothing.
      await writeFile(caFile, "not a certificate\n");
      await sent;
      await Bun.sleep(20);
      rmSync(dir, { recursive: true, force: true });
    }
    expect(savedReply(ws, id)).toEqual({ role: "assistant", reasoning: "", content: "", status: "stopped" });
    expect(requests.get("ca-hang")).toBeUndefined();
  });

  test("deleting another conversation while a reply streams leaves the reply running to its end", async () => {
    const other = savedRecord("other");
    const ws = workspace(filesOf(other));
    const { controller, state } = await load(ws);
    const sent = controller.send("Hi");
    await until(state, (s) => contentOf(s.entries.at(-1)) === "Partial ");
    await controller.deleteConversation(other.id);
    expect(ws.files.files.has(`${other.id}.json`)).toBe(false);
    expect(state().entries.at(-1)).toMatchObject({ status: "streaming" });
    finishReply();
    await sent;
    expect(state().entries.at(-1)).toMatchObject({ content: "Partial end", status: "done" });
  });

  test("pruning past 50 leaves the reply that triggered it running to its end", async () => {
    const seeded = Array.from({ length: 50 }, (_, index) => savedRecord(`c${index}`, index + 1));
    const ws = workspace(filesOf(...seeded));
    const { controller, state } = await load(ws, { now: () => 1000 });
    const sent = controller.send("Newest");
    await until(state, (s) => contentOf(s.entries.at(-1)) === "Partial ");
    await eventually(() => !ws.files.files.has(`${seeded[0]!.id}.json`), "the prune");
    expect(state().entries.at(-1)).toMatchObject({ status: "streaming" });
    finishReply();
    await sent;
    expect(state().entries.at(-1)).toMatchObject({ content: "Partial end", status: "done" });
  });

  test("a listing error stays through New chat, open, and delete; the next successful listing clears it", async () => {
    const [kept, dropped] = [savedRecord("kept"), savedRecord("dropped")];
    const ws = workspace(filesOf(kept, dropped));
    const names = ws.files.names;
    ws.files.names = async () => {
      throw new Error("EACCES: listing denied");
    };
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { controller, state } = await load(ws);
      const listFailed = { cause: "Error: EACCES: listing denied" };
      expect(state().listFailed).toEqual(listFailed);
      await controller.openConversation(kept.id);
      expect(state()).toMatchObject({ conversationId: kept.id, listFailed });
      await controller.deleteConversation(dropped.id);
      expect(state().listFailed).toEqual(listFailed);
      await controller.newChat();
      expect(state().listFailed).toEqual(listFailed);

      ws.files.names = names;
      await controller.restore();
      expect(state().listFailed).toBeUndefined();
      expect(state().conversations.map((summary) => summary.id)).toEqual([kept.id]);
    } finally {
      logged.mockRestore();
    }
  });

  test("a finished reply no longer owns the controller's reply slot", async () => {
    // [>]: Internal invariant: a stale slot would make the next navigation wait on, or Stop abort, a finished reply.
    const { controller } = await load(workspace(), { provider: reasoningProvider });
    await controller.send("done");
    expect((controller as unknown as { reply: unknown }).reply).toBeUndefined();
  });

  for (const action of ["open", "delete the one shown"] as const) {
    test(`${action} stops a new reply at once, behind an earlier navigation whose read waits`, async () => {
      const record = savedRecord("slow open");
      const ws = workspace(filesOf(record));
      const { controller, state } = await load(ws);
      const shown = state().conversationId;
      const read = holdRead(ws.files, 1);
      const opening = controller.openConversation(record.id);
      await eventually(read.started, "the held read");
      const sent = controller.send("sent during navigation");
      const next = action === "open" ? controller.openConversation(record.id) : controller.deleteConversation(shown);
      try {
        await Bun.sleep(50);
        expect(state().entries.at(-1)).toMatchObject({ status: "stopped" });
      } finally {
        read.release();
        await Promise.all([opening, sent, next]);
      }
    });
  }

  test("an open failure while a listing error shows keeps both, and the next navigation clears only the open error", async () => {
    const record = savedRecord("unreadable later");
    const ws = workspace(filesOf(record));
    const names = ws.files.names;
    ws.files.names = async () => {
      throw new Error("EACCES: listing denied");
    };
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { controller, state } = await load(ws);
      ws.files.names = names;
      const read = ws.files.read;
      ws.files.read = async () => {
        throw new Error("EIO: i/o error");
      };
      await controller.openConversation(record.id);
      expect(state()).toMatchObject({
        listFailed: { cause: "Error: EACCES: listing denied" },
        storageProblem: { kind: "openFailed", cause: "Error: EIO: i/o error" },
      });
      ws.files.read = read;
      await controller.newChat();
      expect(state()).toMatchObject({
        listFailed: { cause: "Error: EACCES: listing denied" },
        storageProblem: undefined,
      });
    } finally {
      logged.mockRestore();
    }
  });

  test("Stop drops the text the reasoning splitter flushes late: panel and record keep the reply as it stood", async () => {
    const ws = workspace();
    const provider: Provider = { name: "Late", baseUrl: `http://localhost:${server.port}/late-flush/v1` };
    const { controller, state } = await load(ws, { provider });
    const sent = controller.send("Hello");
    const id = state().conversationId;
    await until(state, (s) => {
      const last = s.entries.at(-1);
      return last?.role === "assistant" && last.reasoning === "Plan.";
    });
    controller.stop();
    await sent;
    await eventually(() => savedReply(ws, id)?.status === "stopped", "the stopped save");
    await Bun.sleep(30);
    const stopped = { role: "assistant" as const, reasoning: "Plan.", content: "", status: "stopped" as const };
    expect(state().entries.at(-1)).toEqual(stopped);
    expect(savedReply(ws, id)).toEqual(stopped);
  });
});

describe("ChatController agent turn", () => {
  let scriptCount = 0;
  const readCall = (path: string) => `<read_file>\n<path>${path}</path>\n</read_file>`;
  /** An unclosed known tag: the parser reports it malformed. */
  const malformedReply = { content: "<read_file>\n<path>a.ts</path>" };

  /** Runner over `READ_TOOLS` that answers each call with `result`, recording the calls. */
  function fakeRunner(result: (call: { name: string; args: Record<string, string> }) => Promise<ToolResult>) {
    const calls: { name: string; args: Record<string, string> }[] = [];
    const signals: AbortSignal[] = [];
    const runner: ToolRunner = {
      tools: READ_TOOLS,
      run: (call, signal) => {
        calls.push(call);
        signals.push(signal);
        return result(call);
      },
    };
    return { runner, calls, signals };
  }

  const okRunner = () => fakeRunner(async (call) => ({ status: "ok", text: `read ${call.args.path}` }));

  /**
   * Controller on a fresh in-memory workspace whose provider answers with `script`, one reply per request. Returns the
   * requests' bodies, the conversation files, and the controller.
   */
  async function scripted(
    script: ScriptedReply[],
    runner: ToolRunner = okRunner().runner,
    instructions: InstructionReader = { read: async () => [] },
  ) {
    const prefix = `script-${scriptCount++}`;
    scripts.set(prefix, [...script]);
    const files = memoryFiles();
    const controller = new ChatController({
      apiKeys: { get: async () => undefined },
      workspaceState: memoryStore(),
      publish: () => {},
      mentions: noMentions,
      store: new ConversationStore(files),
      tools: runner,
      instructions,
    });
    const state = () => controller.snapshot;
    controller.setProviders({
      providers: [{ name: "Agent", baseUrl: `http://localhost:${server.port}/${prefix}/v1` }],
      skipped: [],
    });
    await until(state, (s) => s.model === "m");
    const sent = () => (requests.get(prefix) ?? []) as { messages: { role: string; content: string }[] }[];
    /** The record saved for the conversation shown. */
    const saved = () => {
      const text = files.files.get(`${state().conversationId}.json`);
      return text === undefined ? undefined : (JSON.parse(text) as ConversationRecord);
    };
    return { controller, state, sent, saved };
  }

  async function settledSave(saved: () => ConversationRecord | undefined, entries: number): Promise<void> {
    for (let waited = 0; ; waited += 5) {
      const last = saved()?.entries.at(-1);
      const settled = saved()?.entries.length === entries && !(last?.role === "assistant" && isInFlight(last.status));
      if (settled) return;
      if (waited > 2000) throw new Error(`timed out; saved: ${JSON.stringify(saved())}`);
      await Bun.sleep(5);
    }
  }
  const isInFlight = (status: string) => status === "waiting" || status === "streaming";

  test("runs the call and sends the reply verbatim and its result back, without the reasoning", async () => {
    const answer = `I will read it.\n${readCall("README.md")}`;
    const { runner, calls } = okRunner();
    const { controller, state, sent } = await scripted(
      [{ reasoning: "Plan.", content: answer }, { content: "It is a demo." }],
      runner,
    );
    await controller.send("what does this repository do?");

    expect(calls).toEqual([{ name: "read_file", args: { path: "README.md" } }]);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.messages).toEqual([
      SYSTEM,
      { role: "user", content: "what does this repository do?" },
      { role: "assistant", content: answer },
      { role: "user", content: '<tool_result tool="read_file" status="ok">\nread README.md\n</tool_result>' },
    ]);
    expect(JSON.stringify(sent()[1])).not.toContain("Plan.");
    expect(state().entries).toEqual([
      { role: "user", content: "what does this repository do?", mentions: [] },
      {
        role: "assistant",
        reasoning: "Plan.",
        content: answer,
        status: "done",
        call: { name: "read_file", args: { path: "README.md" }, start: 16, end: answer.length },
      },
      { role: "tool", name: "read_file", args: { path: "README.md" }, status: "ok", text: "read README.md" },
      { role: "assistant", reasoning: "", content: "It is a demo.", status: "done" },
    ]);
  });

  test("a path outside the workspace gives an error step whose text reaches the model", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "broke-code-agent-"));
    try {
      const runner: ToolRunner = {
        tools: READ_TOOLS,
        run: (call, signal) =>
          runReadTool(call, [{ name: "ws", path: workspaceDir }], { ripgrepCandidates: [] }, signal),
      };
      const { controller, state, sent } = await scripted(
        [{ content: readCall("../secret.txt") }, { content: "I cannot read it." }],
        runner,
      );
      await controller.send("read the secret");

      const refusal = "read_file: ../secret.txt: the path is outside the workspace folders.";
      expect(state().entries[2]).toEqual({
        role: "tool",
        name: "read_file",
        args: { path: "../secret.txt" },
        status: "error",
        text: refusal,
      });
      expect(sent()[1]!.messages.at(-1)).toEqual({
        role: "user",
        content: `<tool_result tool="read_file" status="error">\n${refusal}\n</tool_result>`,
      });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("three malformed replies in a row halt the turn without a fourth request", async () => {
    const { controller, state, sent, saved } = await scripted([
      malformedReply,
      { content: "<nope>x</nope>" },
      malformedReply,
      { content: "never sent" },
    ]);
    await controller.send("go");

    expect(sent()).toHaveLength(3);
    const [, , unknownTool] = sent().at(-1)!.messages.slice(-3);
    expect(unknownTool?.content).toStartWith(
      '<tool_result tool="unknown" status="error">\n<nope> is not a known tool.',
    );
    expect(sent()[1]!.messages.at(-1)?.content).toStartWith(
      '<tool_result tool="read_file" status="error">\nThe <read_file> tag never closes',
    );
    expect(state().entries.at(-2)).toMatchObject({ role: "assistant", status: "halted", haltReason: "malformedCalls" });
    expect(state().entries.at(-1)).toMatchObject({ role: "tool", name: "read_file", status: "malformed" });
    expect(isReplying(state())).toBe(false);
    await settledSave(saved, 7);
    expect(saved()?.entries.at(-2)).toMatchObject({ status: "halted", haltReason: "malformedCalls" });
  });

  test("a call that parses between malformed ones resets the count", async () => {
    const { controller, state, sent } = await scripted([
      malformedReply,
      malformedReply,
      { content: readCall("a.ts") },
      malformedReply,
      malformedReply,
      { content: "Done." },
    ]);
    await controller.send("go");

    expect(sent()).toHaveLength(6);
    expect(state().entries.at(-1)).toEqual({ role: "assistant", reasoning: "", content: "Done.", status: "done" });
    expect(state().entries.filter((entry) => entry.role === "tool")).toHaveLength(5);
  });

  test(`${MAX_TOOL_STEPS} tool steps halt the turn on the step limit`, async () => {
    const calls = Array.from({ length: MAX_TOOL_STEPS + 1 }, (_, index) => ({ content: readCall(`f${index}.ts`) }));
    const { controller, state, sent } = await scripted(calls);
    await controller.send("read everything");

    expect(MAX_TOOL_STEPS).toBe(50);
    expect(sent()).toHaveLength(50);
    expect(state().entries.filter((entry) => entry.role === "tool")).toHaveLength(50);
    expect(state().entries.at(-2)).toMatchObject({ role: "assistant", status: "halted", haltReason: "stepLimit" });
    expect(state().entries.at(-1)).toMatchObject({ role: "tool", args: { path: "f49.ts" }, status: "ok" });
  });

  test("Stop during a streaming reply after a step ends the turn at once and saves the entries so far", async () => {
    const { controller, state, sent, saved } = await scripted([
      { content: readCall("a.ts") },
      "hang",
      { content: "x" },
    ]);
    const turn = controller.send("go");
    await until(state, (s) => contentOf(s.entries.at(-1)) === "Partial ");
    expect(isReplying(state())).toBe(true);
    controller.stop();
    await turn;

    expect(state().entries).toMatchObject([
      { role: "user" },
      { role: "assistant", status: "done", call: { name: "read_file" } },
      { role: "tool", status: "ok" },
      { role: "assistant", content: "Partial ", status: "stopped" },
    ]);
    await Bun.sleep(30);
    expect(sent()).toHaveLength(2);
    await settledSave(saved, 4);
    expect(saved()?.entries.at(-1)).toMatchObject({ content: "Partial ", status: "stopped" });
  });

  test("Stop while a tool runs ends the turn at once, though the runner never settles, and sends nothing more", async () => {
    const { runner, signals } = fakeRunner(() => new Promise(() => {}));
    const { controller, state, sent, saved } = await scripted(
      [{ content: readCall("a.ts") }, { content: "x" }],
      runner,
    );
    const turn = controller.send("go");
    await until(state, () => signals.length === 1);
    expect(isReplying(state())).toBe(true);
    expect(state().entries.at(-1)).toMatchObject({ role: "assistant", call: { name: "read_file" } });
    controller.stop();
    await turn;

    expect(signals[0]!.aborted).toBe(true);
    expect(isReplying(state())).toBe(false);
    expect(state().entries).toMatchObject([
      { role: "user" },
      { role: "assistant", status: "stopped", call: { name: "read_file" } },
    ]);
    await Bun.sleep(30);
    expect(sent()).toHaveLength(1);
    await settledSave(saved, 2);
    expect(saved()?.entries.at(-1)).toMatchObject({ status: "stopped", call: { name: "read_file" } });
  });

  test("New chat while a tool runs waits for the whole turn to settle and saves it stopped in its own record", async () => {
    const { runner, signals } = fakeRunner(() => new Promise(() => {}));
    const { controller, state, saved } = await scripted([{ content: readCall("a.ts") }], runner);
    const turn = controller.send("go");
    const turnId = state().conversationId;
    await until(state, () => signals.length === 1);
    await controller.newChat();
    await turn;

    expect(state().conversationId).not.toBe(turnId);
    expect(state().conversations.map((c) => c.id)).toContain(turnId);
    await controller.openConversation(turnId);
    await settledSave(saved, 2);
    expect(saved()?.entries.at(-1)).toMatchObject({ status: "stopped" });
  });

  test("a failed reply after a step ends the turn failed", async () => {
    const { controller, state } = await scripted([{ content: readCall("a.ts") }, "fail"]);
    await controller.send("go");
    expect(state().entries.at(-1)).toMatchObject({
      role: "assistant",
      status: "failed",
      error: { kind: "rejected", status: 500 },
    });
  });

  test("a runner that rejects gives an error step, logged, and the turn goes on", async () => {
    const { runner } = fakeRunner(async () => {
      throw new Error("bug");
    });
    const { controller, state, sent } = await scripted([{ content: readCall("a.ts") }, { content: "ok" }], runner);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await controller.send("go");
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
    expect(state().entries[2]).toMatchObject({
      role: "tool",
      status: "error",
      text: "read_file: the tool failed (Error: bug).",
    });
    expect(sent()).toHaveLength(2);
  });

  test("the system message holds the instruction files' texts in order, read at each send", async () => {
    const files: InstructionFile[] = [
      { label: "~/.agents/AGENTS.md", text: "Home rules." },
      { label: "AGENTS.md", text: "Workspace rules." },
    ];
    let reads = 0;
    const { controller, sent } = await scripted([{ content: "a" }, { content: "b" }], okRunner().runner, {
      read: async () => {
        reads += 1;
        return files;
      },
    });
    await controller.send("hi");
    await controller.send("again");

    const system = sent()[0]!.messages[0]!;
    expect(system).toEqual({ role: "system", content: composeSystemPrompt(READ_TOOLS, files) });
    expect(system.content.indexOf("Home rules.")).toBeLessThan(system.content.indexOf("Workspace rules."));
    expect(system.content).toStartWith(SYSTEM.content);
    expect(reads).toBe(2);
  });

  test("without instruction files the system message is the prompt alone", async () => {
    const { controller, sent } = await scripted([{ content: "a" }]);
    await controller.send("hi");
    expect(sent()[0]!.messages[0]).toEqual(SYSTEM);
    expect(SYSTEM.content).not.toContain("# Instructions from");
  });

  test("a later message resends the earlier steps as tool results", async () => {
    const { controller, sent } = await scripted([{ content: readCall("a.ts") }, { content: "A." }, { content: "B." }]);
    await controller.send("first");
    await controller.send("second");
    expect(sent()[2]!.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
  });
});
