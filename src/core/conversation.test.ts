import { describe, expect, test } from "bun:test";
import {
  type ConversationRecord,
  conversationsOverLimit,
  conversationTitle,
  isConversationId,
  newConversationId,
  parseConversation,
  parseSummary,
  serializeConversation,
  serializeSummary,
  summarize,
} from "./conversation";

const ID = "0b0d4c1e-8f9a-4c3b-9d2e-1a2b3c4d5e6f";

function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    version: 2,
    id: ID,
    createdAt: 1000,
    updatedAt: 2000,
    provider: "Ollama",
    model: "m",
    entries: [
      {
        role: "user",
        content: "explain @a.ts",
        mentions: [{ path: "a.ts", kind: "file", status: "attached", lines: 1 }],
        modelText: "explain @a.ts\n\n@a.ts (file, 1 line)",
      },
      { role: "assistant", reasoning: "Plan.", content: "Answer", status: "done" },
    ],
    ...overrides,
  };
}

const parse = (value: unknown) => parseConversation(JSON.stringify(value));

describe("conversation record", () => {
  test("reads back what it wrote", () => {
    expect(parseConversation(serializeConversation(record()))).toEqual({ ok: true, record: record() });
  });

  test("reads back an agent turn: a reply with its call, its tool steps, and a halted reply", () => {
    const answer = "Let me look.\n<read_file>\n<path>a.ts</path>\n</read_file>";
    const turn = record({
      entries: [
        { role: "user", content: "explain", mentions: [], modelText: "explain" },
        {
          role: "assistant",
          reasoning: "",
          content: answer,
          status: "done",
          call: { name: "read_file", args: { path: "a.ts" }, start: 13, end: answer.length },
        },
        { role: "tool", name: "read_file", args: { path: "a.ts" }, status: "ok", text: "@a.ts (file, 1 line)" },
        { role: "assistant", reasoning: "", content: "<read_file>", status: "done" },
        { role: "tool", name: "read_file", args: {}, status: "malformed", text: "The <read_file> tag never closes." },
        { role: "assistant", reasoning: "", content: "<nope></nope>", status: "halted", haltReason: "malformedCalls" },
        { role: "tool", name: "unknown", args: {}, status: "error", text: "boom" },
      ],
    });
    expect(parseConversation(serializeConversation(turn))).toEqual({ ok: true, record: turn });
  });

  test("brings back an in-flight reply as stopped, partial text kept", () => {
    for (const status of ["waiting", "streaming"]) {
      const saved = record({
        entries: [
          { role: "user", content: "Hi", mentions: [], modelText: "Hi" },
          { role: "assistant", reasoning: "", content: "Partial ", status: status as "waiting" },
        ],
      });
      const parsed = parseConversation(serializeConversation(saved));
      expect(parsed).toMatchObject({ ok: true, record: { entries: [{}, { content: "Partial ", status: "stopped" }] } });
    }
  });

  test("accepts times up to the last date JavaScript can show", () => {
    expect(parse({ ...record(), createdAt: 0, updatedAt: 8.64e15 })).toMatchObject({ ok: true });
  });

  test("rejects a record whose user entry has no model text", () => {
    const { modelText: _, ...user } = record().entries[0] as ConversationRecord["entries"][0] & { modelText: string };
    const parsed = parse({ ...record(), entries: [user] });
    expect(parsed.ok).toBe(false);
  });

  test("keeps a failed reply's error and drops fields it does not know", () => {
    const error = { kind: "rejected" as const, provider: "P", status: 500, detail: "boom" };
    const parsed = parse({
      ...record(),
      extra: "x",
      entries: [{ role: "assistant", reasoning: "", content: "", status: "failed", error: { ...error, junk: 1 } }],
    });
    expect(parsed).toEqual({
      ok: true,
      record: { ...record(), entries: [{ role: "assistant", reasoning: "", content: "", status: "failed", error }] },
    });
  });

  test("refuses a version 1 record, saying so: no migration, nothing was released with it", () => {
    expect(parse({ ...record(), version: 1 })).toEqual({ ok: false, reason: "unknown version 1" });
  });

  test("refuses a tool step or a call of the wrong shape, and a halt without its reason", () => {
    const user = { role: "user", content: "x", mentions: [], modelText: "x" };
    const reply = { role: "assistant", reasoning: "", content: "<a>b</a>", status: "done" };
    const step = { role: "tool", name: "read_file", args: { path: "a" }, status: "ok", text: "t" };
    const bad: unknown[] = [
      { ...step, status: "running" },
      { ...step, args: { path: 3 } },
      { ...step, args: ["a"] },
      { ...step, name: 1 },
      { ...step, text: undefined },
      { ...reply, call: { name: "a", args: {}, start: 0, end: 99 } },
      { ...reply, call: { name: "a", args: {}, start: 5, end: 2 } },
      { ...reply, call: { name: "a", args: {}, start: -1, end: 2 } },
      { ...reply, call: { name: "a", start: 0, end: 2 } },
      { ...reply, status: "halted" },
      { ...reply, status: "halted", haltReason: "tired" },
      { ...reply, status: "done", haltReason: "stepLimit" },
    ];
    for (const entry of bad) {
      expect(parse({ ...record(), entries: [user, entry] }).ok).toBe(false);
    }
  });

  test("refuses an unknown version, invalid JSON, and a malformed shape, saying why", () => {
    const bad: unknown[] = [
      { ...record(), version: 3 },
      { ...record(), id: "../escape" },
      { ...record(), updatedAt: "yesterday" },
      { ...record(), updatedAt: 1e100 },
      { ...record(), updatedAt: 8.64e15 + 1 },
      { ...record(), updatedAt: 1.5 },
      { ...record(), createdAt: -1 },
      { ...record(), provider: 3 },
      { ...record(), entries: "none" },
      { ...record(), entries: [{ role: "system", content: "x" }] },
      {
        ...record(),
        entries: [{ role: "user", content: "x", mentions: [{ path: "a", kind: "pipe", status: "attached" }] }],
      },
      { ...record(), entries: [{ role: "assistant", reasoning: "", content: "", status: "lost" }] },
      {
        ...record(),
        entries: [
          { role: "assistant", reasoning: "", content: "", status: "failed", error: { kind: "nope", provider: "P" } },
        ],
      },
      {
        ...record(),
        entries: [
          {
            role: "assistant",
            reasoning: "",
            content: "",
            status: "failed",
            error: { kind: "invalidKey", provider: "P" },
          },
        ],
      },
      null,
    ];
    for (const value of bad) {
      const parsed = parse(value);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).not.toBe("");
    }
    expect(parseConversation("{not json")).toMatchObject({ ok: false });
    expect(parse({ ...record(), version: 3 })).toEqual({ ok: false, reason: "unknown version 3" });
  });
});

describe("conversation title", () => {
  const user = (content: string) => ({ role: "user" as const, content, mentions: [] });

  test("is the first user message with its whitespace collapsed", () => {
    expect(conversationTitle([user("  fix\n\tthe   bug "), user("second")])).toBe("fix the bug");
  });

  test("cuts a long message to 60 characters and an ellipsis", () => {
    const long = `${"a".repeat(59)}é bcd`;
    expect(conversationTitle([user(long)])).toBe(`${"a".repeat(59)}é…`);
    expect(conversationTitle([user("b".repeat(60))])).toBe("b".repeat(60));
  });

  test("never splits a character made of two code units", () => {
    expect(conversationTitle([user("😀".repeat(61))])).toBe(`${"😀".repeat(60)}…`);
  });

  test("summarizes a record by id, title, and update time", () => {
    expect(summarize(record())).toEqual({ id: ID, title: "explain @a.ts", updatedAt: 2000 });
  });
});

describe("conversation summary", () => {
  const summary = (overrides: Record<string, unknown> = {}) =>
    parseSummary(JSON.stringify({ version: 2, id: ID, title: "t", updatedAt: 2000, ...overrides }));

  test("reads back the row it wrote, under the record's version", () => {
    const text = serializeSummary(record());
    expect(JSON.parse(text)).toEqual({ version: 2, id: ID, title: "explain @a.ts", updatedAt: 2000 });
    expect(parseSummary(text)).toEqual({ id: ID, title: "explain @a.ts", updatedAt: 2000 });
  });

  test("refuses a summary of a version 1 record, so the record reports its own version", () => {
    expect(summary({ version: 1 })).toBeUndefined();
  });

  test("refuses an id that is not one the store makes", () => {
    expect(summary({ id: "../escape" })).toBeUndefined();
  });

  test("refuses a time that is not whole milliseconds within the Date range", () => {
    for (const updatedAt of [-1, 1.5, 8.64e15 + 1, "2000"]) {
      expect(summary({ updatedAt })).toBeUndefined();
    }
  });
});

describe("conversation id", () => {
  test("accepts a new id and refuses anything that could name another file", () => {
    expect(isConversationId(newConversationId())).toBe(true);
    for (const id of ["", "a/b", "..", `${ID}.json`, `${ID}/`, ID.toUpperCase(), `../${ID}`, 7]) {
      expect(isConversationId(id)).toBe(false);
    }
  });
});

describe("conversations over the limit", () => {
  const summaries = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ id: `c${index}`, title: "t", updatedAt: index }));

  test("keeps 50: lists the oldest beyond them, oldest first", () => {
    expect(conversationsOverLimit(summaries(50), ["c49"])).toEqual([]);
    expect(conversationsOverLimit(summaries(52).reverse(), ["c51"])).toEqual(["c0", "c1"]);
  });

  test("never lists a kept conversation, even when it is the oldest", () => {
    expect(conversationsOverLimit(summaries(51), ["c0"])).toEqual(["c1"]);
    expect(conversationsOverLimit(summaries(52), ["c50", "c0", "absent"])).toEqual(["c1", "c2"]);
  });
});
