import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConversationRecord, newConversationId } from "./conversation";
import { directoryFiles } from "./conversationFiles";
import { memoryFiles } from "./conversationFixture";
import { answerConversationSearch, ConversationStore } from "./conversationStore";

function record(updatedAt: number, text = `message at ${updatedAt}`): ConversationRecord {
  return {
    version: 2,
    id: newConversationId(),
    createdAt: updatedAt,
    updatedAt,
    entries: [{ role: "user", content: text, mentions: [], modelText: text }],
  };
}

/** Run `work` with `console.error` silenced; returns what it logged. */
async function quietly(work: () => Promise<unknown>): Promise<unknown[][]> {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    await work();
    return logged.mock.calls;
  } finally {
    logged.mockRestore();
  }
}

describe("ConversationStore", () => {
  test("saves a record and its summary per conversation, and lists them newest first from the summaries", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    const [old, recent] = [record(1000, "old"), record(2000, "recent")];
    expect(await store.save(old)).toBe(true);
    expect(await store.save(recent)).toBe(true);

    const names = [old.id, recent.id].flatMap((id) => [`${id}.json`, `${id}.summary.json`]);
    expect([...files.files.keys()].sort()).toEqual(names.sort());
    expect(JSON.parse(files.files.get(`${old.id}.summary.json`) ?? "")).toEqual({
      version: 2,
      id: old.id,
      title: "old",
      updatedAt: 1000,
      messages: 1,
    });
    expect(await store.list()).toEqual({
      conversations: [
        { id: recent.id, title: "recent", updatedAt: 2000, messages: 1 },
        { id: old.id, title: "old", updatedAt: 1000, messages: 1 },
      ],
      unreadable: [],
    });
    expect(files.reads.get(`${old.id}.json`)).toBeUndefined();
    expect(files.reads.get(`${recent.id}.json`)).toBeUndefined();
    expect(await store.load(old.id)).toEqual(old);
  });

  test("lists a conversation from its record when its summary is missing", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    const saved = record(1000, "kept");
    await store.save(saved);
    files.files.delete(`${saved.id}.summary.json`);
    expect(await new ConversationStore(files).list()).toEqual({
      conversations: [{ id: saved.id, title: "kept", updatedAt: 1000, messages: 1 }],
      unreadable: [],
    });
  });

  test("skips a corrupt, foreign, or unreadable summary and lists the record's values", async () => {
    const [corrupt, foreign, locked] = [record(1000, "corrupt"), record(2000, "foreign"), record(3000, "locked")];
    const files = memoryFiles({
      [`${corrupt.id}.json`]: JSON.stringify(corrupt),
      [`${corrupt.id}.summary.json`]: JSON.stringify({ version: 2, id: corrupt.id, title: 7, updatedAt: 9000 }),
      [`${foreign.id}.json`]: JSON.stringify(foreign),
      [`${foreign.id}.summary.json`]: JSON.stringify({ version: 2, id: corrupt.id, title: "other", updatedAt: 9000 }),
      [`${locked.id}.json`]: JSON.stringify(locked),
      [`${locked.id}.summary.json`]: JSON.stringify({ version: 2, id: locked.id, title: "stale", updatedAt: 9000 }),
    });
    const read = files.read;
    files.read = async (name) => {
      if (name === `${locked.id}.summary.json`) throw new Error("EACCES: permission denied");
      return read(name);
    };
    let listed: unknown;
    await quietly(async () => {
      listed = await new ConversationStore(files).list();
    });
    expect(listed).toEqual({
      conversations: [
        { id: locked.id, title: "locked", updatedAt: 3000, messages: 1 },
        { id: foreign.id, title: "foreign", updatedAt: 2000, messages: 1 },
        { id: corrupt.id, title: "corrupt", updatedAt: 1000, messages: 1 },
      ],
      unreadable: [],
    });
  });

  test("never lists a record of unknown version, even beside a summary of that version", async () => {
    const future = newConversationId();
    const files = memoryFiles({
      [`${future}.json`]: JSON.stringify({ ...record(1000), id: future, version: 3 }),
      [`${future}.summary.json`]: JSON.stringify({ version: 3, id: future, title: "future", updatedAt: 1000 }),
    });
    let listed: unknown;
    const logged = await quietly(async () => {
      listed = await new ConversationStore(files).list();
    });
    expect(listed).toEqual({ conversations: [], unreadable: [] });
    expect(String(logged.flat())).toContain("unknown version 3");
  });

  test("skips a version 1 conversation with a logged reason, also beside its version 1 summary", async () => {
    const old = newConversationId();
    const files = memoryFiles({
      [`${old}.json`]: JSON.stringify({ ...record(1000), id: old, version: 1 }),
      [`${old}.summary.json`]: JSON.stringify({ version: 1, id: old, title: "old", updatedAt: 1000 }),
    });
    let listed: unknown;
    const logged = await quietly(async () => {
      listed = await new ConversationStore(files).list();
    });
    expect(listed).toEqual({ conversations: [], unreadable: [] });
    expect(String(logged.flat())).toContain("unknown version 1");
  });

  test("a summary without its record is not listed and is gone after the listing", async () => {
    const orphan = newConversationId();
    const files = memoryFiles({
      [`${orphan}.summary.json`]: JSON.stringify({ version: 2, id: orphan, title: "orphan", updatedAt: 1000 }),
    });
    expect(await new ConversationStore(files).list()).toEqual({ conversations: [], unreadable: [] });
    expect(files.files.size).toBe(0);
  });

  test("skips and logs a file of unknown version or broken shape, and ignores other names", async () => {
    const good = record(1000);
    const broken = newConversationId();
    const future = newConversationId();
    const empty = record(4000);
    const files = memoryFiles({
      [`${good.id}.json`]: JSON.stringify(good),
      [`${broken}.json`]: "{",
      [`${future}.json`]: JSON.stringify({ ...record(3000), id: future, version: 3 }),
      "notes.txt": "hello",
      [`${good.id}.json.1234.tmp`]: "{",
      [`${empty.id}.json`]: JSON.stringify({ ...empty, entries: [] }),
    });
    const store = new ConversationStore(files);

    let listed: unknown;
    const logged = await quietly(async () => {
      listed = await store.list();
    });
    expect(listed).toEqual({
      conversations: [{ id: good.id, title: "message at 1000", updatedAt: 1000, messages: 1 }],
      unreadable: [],
    });
    expect(logged).toHaveLength(2);
    expect(String(logged.flat())).toContain("unknown version 3");

    let loaded: unknown = "unset";
    await quietly(async () => {
      loaded = await store.load(future);
    });
    expect(loaded).toBeUndefined();
  });

  test("reports a file it cannot read apart from the ones it lists", async () => {
    const [good, locked] = [record(1000), record(2000)];
    const files = memoryFiles({
      [`${good.id}.json`]: JSON.stringify(good),
      [`${locked.id}.json`]: JSON.stringify(locked),
    });
    const read = files.read;
    files.read = async (name) => {
      if (name === `${locked.id}.json`) throw new Error("EACCES: permission denied");
      return read(name);
    };
    expect(await new ConversationStore(files).list()).toEqual({
      conversations: [{ id: good.id, title: "message at 1000", updatedAt: 1000, messages: 1 }],
      unreadable: [{ id: locked.id, cause: "Error: EACCES: permission denied" }],
    });
  });

  test("deletes leftover temporary files when it first lists, and keeps everything else", async () => {
    const saved = record(1000);
    const leftover = `${saved.id}.json.${newConversationId()}.tmp`;
    const summaryLeftover = `${saved.id}.summary.json.${newConversationId()}.tmp`;
    const files = memoryFiles({
      [`${saved.id}.json`]: JSON.stringify(saved),
      [leftover]: "{",
      [summaryLeftover]: "{",
      "notes.tmp": "x",
    });
    await new ConversationStore(files).list();
    expect([...files.files.keys()].sort()).toEqual([`${saved.id}.json`, "notes.tmp"].sort());
  });

  test("a first listing passes a long run of hyphens after .json. at once and keeps that file", async () => {
    const name = `a.json.${"-".repeat(247)}x`;
    const files = memoryFiles({ [name]: "x" });
    const start = performance.now();
    await new ConversationStore(files).list();
    expect(performance.now() - start).toBeLessThan(1000);
    expect([...files.files.keys()]).toEqual([name]);
  });

  test("a listing waits for an earlier write, and its cleanup never touches that write's temporary file", async () => {
    const files = memoryFiles();
    const removed: string[] = [];
    const remove = files.remove;
    files.remove = async (name) => {
      removed.push(name);
      return remove(name);
    };
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    files.write = async (name, text) => {
      const temp = `${name}.${newConversationId()}.tmp`;
      files.files.set(temp, text);
      await hold;
      files.files.delete(temp);
      files.files.set(name, text);
    };
    const store = new ConversationStore(files);
    const saved = record(1000);
    const saving = store.save(saved);
    let listed = false;
    const listing = store.list().then((listing) => {
      listed = true;
      return listing;
    });
    await Bun.sleep(10);
    expect(listed).toBe(false);
    release();
    await saving;
    expect((await listing).conversations).toMatchObject([{ id: saved.id }]);
    expect(removed).toEqual([`${saved.id}.summary.json`]);
  });

  test("deletes leftover temporary files at the first listing only", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    await store.list();
    const leftover = `${newConversationId()}.json.${newConversationId()}.tmp`;
    files.files.set(leftover, "{");
    await store.list();
    expect(files.files.has(leftover)).toBe(true);
  });

  test("reads after the writes and removes queued before them", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    const first = record(1000, "first");
    await store.save(first);
    let release: () => void = () => {};
    files.holdWrites = new Promise((resolve) => {
      release = resolve;
    });
    const saving = store.save({ ...first, updatedAt: 2000 });
    const loading = store.load(first.id);
    const listing = store.list();
    const removing = store.remove(first.id);
    const afterRemove = store.load(first.id);
    release();

    expect(await loading).toMatchObject({ updatedAt: 2000 });
    expect((await listing).conversations).toMatchObject([{ id: first.id, updatedAt: 2000 }]);
    await Promise.all([saving, removing]);
    expect(await afterRemove).toBeUndefined();
  });

  test("loads nothing for a missing file", async () => {
    expect(await new ConversationStore(memoryFiles()).load(newConversationId())).toBeUndefined();
  });

  test("removes the record and its summary, and a save that comes after writes neither", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    const saved = record(1000);
    await store.save(saved);

    await store.remove(saved.id);
    expect(files.files.size).toBe(0);
    expect(await store.save({ ...saved, updatedAt: 2000 })).toBe(false);
    expect(files.files.size).toBe(0);
  });

  test("never lists a conversation it removed, even when another store writes it back", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    const saved = record(1000);
    await store.save(saved);
    await store.remove(saved.id);
    expect(await new ConversationStore(files).save(saved)).toBe(true);
    expect(await store.list()).toEqual({ conversations: [], unreadable: [] });
  });

  test("a save queued while a remove is pending writes neither file", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    const saved = record(1000);
    await store.save(saved);
    let release: () => void = () => {};
    files.holdRemoves = new Promise((resolve) => {
      release = resolve;
    });
    const removing = store.remove(saved.id);
    const saving = store.save({ ...saved, updatedAt: 2000 });
    release();
    await removing;
    expect(await saving).toBe(false);
    expect(files.files.size).toBe(0);
  });

  test("a save queued before a remove lands first, and the remove still wins", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    const saved = record(1000);
    let release: () => void = () => {};
    files.holdWrites = new Promise((resolve) => {
      release = resolve;
    });
    const saving = store.save(saved);
    const removing = store.remove(saved.id);
    release();
    await Promise.all([saving, removing]);
    expect(files.files.size).toBe(0);
  });

  test("writes in call order, so an older save never lands over a newer one", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    const first = record(1000, "first");
    let release: () => void = () => {};
    files.holdWrites = new Promise((resolve) => {
      release = resolve;
    });
    const older = store.save(first);
    files.holdWrites = undefined;
    const newer = store.save({ ...first, updatedAt: 2000 });
    release();
    await Promise.all([older, newer]);
    expect(await store.load(first.id)).toMatchObject({ updatedAt: 2000 });
  });

  test("reports a failed write to its caller, and the next write still runs", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    files.failWrites = new Error("ENOSPC: no space left on device");
    await expect(store.save(record(1000))).rejects.toThrow("ENOSPC");
    files.failWrites = undefined;
    expect(await store.save(record(2000))).toBe(true);
  });

  test("a failed summary write after the record's still saves, leaves no summary, and lists the record", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    const saved = record(1000, "first");
    await store.save(saved);
    const write = files.write;
    files.write = async (name, text) => {
      if (name.endsWith(".summary.json")) throw new Error("ENOSPC: no space left on device");
      return write(name, text);
    };
    let result: unknown;
    const logged = await quietly(async () => {
      result = await store.save({ ...saved, updatedAt: 2000 });
    });
    expect(result).toBe(true);
    expect(String(logged.flat())).toContain("ENOSPC");
    expect(await store.load(saved.id)).toMatchObject({ updatedAt: 2000 });
    expect(files.files.has(`${saved.id}.summary.json`)).toBe(false);
    expect((await new ConversationStore(files).list()).conversations).toEqual([
      { id: saved.id, title: "first", updatedAt: 2000, messages: 1 },
    ]);
  });

  test("a crash after the record write leaves no summary, so the list reads the new record", async () => {
    const files = memoryFiles();
    const saved = record(1000, "first");
    await new ConversationStore(files).save(saved);
    const write = files.write;
    let crash: Promise<void> | undefined;
    files.write = async (name, text) => {
      if (!name.endsWith(".summary.json")) return write(name, text);
      crash = new Promise(() => {});
      return crash;
    };
    void new ConversationStore(files).save({ ...saved, updatedAt: 2000 });
    for (let waited = 0; crash === undefined; waited += 5) {
      if (waited > 2000) throw new Error("timed out waiting for the summary write");
      await Bun.sleep(5);
    }
    files.write = write;
    expect([...files.files.keys()]).toEqual([`${saved.id}.json`]);
    expect((await new ConversationStore(files).list()).conversations).toEqual([
      { id: saved.id, title: "first", updatedAt: 2000, messages: 1 },
    ]);
  });

  test("when the old summary cannot be deleted, the save fails and both files keep the last save", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    const saved = record(1000, "first");
    await store.save(saved);
    const remove = files.remove;
    files.remove = async (name) => {
      if (name.endsWith(".summary.json")) throw new Error("EPERM: operation not permitted");
      return remove(name);
    };
    await expect(store.save({ ...saved, updatedAt: 2000 })).rejects.toThrow("EPERM");
    expect(await store.load(saved.id)).toMatchObject({ updatedAt: 1000 });
    expect((await store.list()).conversations).toEqual([
      { id: saved.id, title: "first", updatedAt: 1000, messages: 1 },
    ]);
    files.remove = remove;
    expect(await store.save({ ...saved, updatedAt: 3000 })).toBe(true);
    expect((await new ConversationStore(files).list()).conversations).toMatchObject([{ updatedAt: 3000 }]);
  });

  test("after a failed remove, keeps both files and keeps saving the conversation", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    const saved = record(1000);
    await store.save(saved);
    const remove = files.remove;
    files.remove = async (name) => {
      if (name === `${saved.id}.json`) throw new Error("EACCES: permission denied");
      return remove(name);
    };
    await expect(store.remove(saved.id)).rejects.toThrow("EACCES");
    expect([...files.files.keys()].sort()).toEqual([`${saved.id}.json`, `${saved.id}.summary.json`].sort());
    expect(await store.save({ ...saved, updatedAt: 2000 })).toBe(true);
    expect(await store.load(saved.id)).toMatchObject({ updatedAt: 2000 });
    expect((await store.list()).conversations).toMatchObject([{ id: saved.id, updatedAt: 2000 }]);
  });

  test("a failed summary delete after the record's still removes the conversation", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    const saved = record(1000);
    await store.save(saved);
    const remove = files.remove;
    files.remove = async (name) => {
      if (name.endsWith(".summary.json")) throw new Error("EACCES: permission denied");
      return remove(name);
    };
    const logged = await quietly(() => store.remove(saved.id));
    expect(String(logged.flat())).toContain("EACCES");
    expect(await store.save({ ...saved, updatedAt: 2000 })).toBe(false);
    expect([...files.files.keys()]).toEqual([`${saved.id}.summary.json`]);
    let listed: unknown;
    const relogged = await quietly(async () => {
      listed = await store.list();
    });
    expect(listed).toEqual({ conversations: [], unreadable: [] });
    expect(String(relogged.flat())).toContain("could not delete the summary of a removed conversation");
    files.remove = remove;
    await store.list();
    expect(files.files.size).toBe(0);
  });

  test("never writes a conversation without entries", async () => {
    const files = memoryFiles();
    expect(await new ConversationStore(files).save({ ...record(1000), entries: [] })).toBe(false);
    expect(files.files.size).toBe(0);
  });

  test("without a storage directory, keeps nothing and lists nothing", async () => {
    const store = new ConversationStore(undefined);
    const saved = record(1000);
    expect(await store.save(saved)).toBe(false);
    expect(await store.list()).toEqual({ conversations: [], unreadable: [] });
    expect(await store.load(saved.id)).toBeUndefined();
    await store.remove(saved.id);
  });

  test("refuses an id that is not one it made, touching no file", async () => {
    const files = memoryFiles({ "secret.json": "{}" });
    const store = new ConversationStore(files);
    await expect(store.remove("../secret")).rejects.toThrow();
    await expect(store.load("secret")).rejects.toThrow();
    expect(files.files.has("secret.json")).toBe(true);
  });
});

describe("ConversationStore.search", () => {
  const reply = (text: string) => ({
    role: "assistant" as const,
    reasoning: "",
    content: text,
    status: "done" as const,
  });
  /** A record whose first message is `title` and whose answer is `answer`. */
  function conversation(updatedAt: number, title: string, answer: string): ConversationRecord {
    const saved = record(updatedAt, title);
    return { ...saved, entries: [...saved.entries, reply(answer)] };
  }
  const recordReads = (files: ReturnType<typeof memoryFiles>, ids: string[]) =>
    ids.reduce((total, id) => total + (files.reads.get(`${id}.json`) ?? 0), 0);
  /** Let every pending promise callback run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function storeOf(...records: ConversationRecord[]) {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    for (const saved of records) await store.save(saved);
    files.reads.clear();
    return { files, store };
  }

  test("returns every conversation whose messages match, in order, one matching by title included", async () => {
    const byTitle = conversation(3000, "the parser bug", "fixed it");
    const other = conversation(2000, "release notes", "nothing here");
    const byAnswer = conversation(1000, "question", "The parser reads blocks.");
    const { store } = await storeOf(byTitle, other, byAnswer);
    expect(await store.search([byTitle.id, other.id, byAnswer.id], "Parser")).toEqual({
      items: [
        { id: byTitle.id, excerpt: "the parser bug" },
        { id: byAnswer.id, excerpt: "The parser reads blocks." },
      ],
      unreadableCount: 0,
    });
  });

  test("a query with two spaces between two words finds a text with one", async () => {
    const saved = conversation(1000, "question", "the parser reads");
    const { store } = await storeOf(saved);
    expect((await store.search([saved.id], "parser  reads"))?.items).toEqual([
      { id: saved.id, excerpt: "the parser reads" },
    ]);
  });

  test("counts an invalid record and a failed read, not a deleted one, and fails nothing", async () => {
    const [good, invalid, failing, deleted, missing] = [
      conversation(1, "q", "parser"),
      conversation(2, "q", "parser"),
      conversation(3, "q", "parser"),
      conversation(4, "q", "parser"),
      conversation(5, "q", "parser"),
    ];
    const { files, store } = await storeOf(good, invalid, failing, deleted);
    files.files.set(`${invalid.id}.json`, JSON.stringify({ ...invalid, version: 3 }));
    await store.remove(deleted.id);
    const read = files.read;
    files.read = async (name) => {
      if (name === `${failing.id}.json`) throw new Error("EACCES: permission denied");
      return read(name);
    };
    let answer: unknown;
    await quietly(async () => {
      answer = await store.search([good.id, invalid.id, failing.id, deleted.id, missing.id], "parser");
    });
    expect(answer).toEqual({ items: [{ id: good.id, excerpt: "parser" }], unreadableCount: 2 });
  });

  test("a save asked during a search waits behind at most one of its reads", async () => {
    const records = [1, 2, 3].map((at) => conversation(at, "q", "parser"));
    const ids = records.map((saved) => saved.id);
    const { files, store } = await storeOf(...records);
    let readsAtWrite: number | undefined;
    const write = files.write;
    files.write = async (name, text) => {
      readsAtWrite ??= recordReads(files, ids);
      return write(name, text);
    };
    let release = () => {};
    files.holdReads = new Promise((resolve) => {
      release = resolve;
    });
    const search = store.search(ids, "parser");
    await settle();
    const saved = store.save(conversation(9, "new", "answer"));
    files.holdReads = undefined;
    release();
    await Promise.all([search, saved]);
    expect(readsAtWrite).toBe(1);
    expect((await search)?.items).toHaveLength(3);
  });

  test("a newer query stops the older one's remaining reads, and only the newer one is answered", async () => {
    const records = [1, 2, 3].map((at) => conversation(at, "q", "parser and lexer"));
    const ids = records.map((saved) => saved.id);
    const { files, store } = await storeOf(...records);
    let release = () => {};
    files.holdReads = new Promise((resolve) => {
      release = resolve;
    });
    const older = store.search(ids, "parser");
    await settle();
    const newer = store.search(ids, "lexer");
    files.holdReads = undefined;
    release();
    expect(await older).toBeUndefined();
    expect((await newer)?.items.map((item) => item.id)).toEqual(ids);
    expect(recordReads(files, ids)).toBe(ids.length + 1);
  });

  test("a query under 3 characters once normalized reads nothing and is not answered", async () => {
    const saved = conversation(1, "q", "ab");
    const { files, store } = await storeOf(saved);
    expect(await store.search([saved.id], "  AB  ")).toBeUndefined();
    expect(recordReads(files, [saved.id])).toBe(0);
  });

  test("searches at most the 50 most recent conversations given and changes nothing on disk", async () => {
    const records = Array.from({ length: 51 }, (_, index) => conversation(100 - index, "q", "parser"));
    const { files, store } = await storeOf(...records);
    const before = new Map(files.files);
    const answer = await store.search(
      records.map((saved) => saved.id),
      "parser",
    );
    expect(answer?.items).toHaveLength(50);
    expect(recordReads(files, [records[50]?.id ?? ""])).toBe(0);
    expect(files.files).toEqual(before);
  });
});

describe("ConversationStore.search timing", () => {
  test("finds a word of an answer across 20 records of about 1 MB on disk in under a second", async () => {
    const root = await mkdtemp(join(tmpdir(), "broke-code-search-"));
    try {
      const store = new ConversationStore(directoryFiles(root));
      const result = "const value = readTheFile(path);\n".repeat(600);
      const records: ConversationRecord[] = Array.from({ length: 20 }, (_, index) => {
        const saved = record(1000 + index, `question ${index}`);
        const steps = Array.from({ length: 50 }, () => [
          {
            role: "assistant" as const,
            reasoning: "Thinking.",
            content: "Reading the next file.",
            status: "done" as const,
          },
          { role: "tool" as const, name: "read_file", args: { path: "a.ts" }, status: "ok" as const, text: result },
        ]).flat();
        const last = index === 0 ? "The quarantined module moved." : "Done.";
        const answer = { role: "assistant" as const, reasoning: "", content: last, status: "done" as const };
        return { ...saved, entries: [...saved.entries, ...steps, answer] };
      });
      for (const saved of records) await store.save(saved);
      const ids = records.map((saved) => saved.id).reverse();

      const started = performance.now();
      const answer = await store.search(ids, "quarantined");
      const elapsed = performance.now() - started;
      console.log(`search over 20 records of about 1 MB: ${elapsed.toFixed(1)} ms`);

      expect(answer?.items).toEqual([{ id: records[0]?.id ?? "", excerpt: "The quarantined module moved." }]);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("answerConversationSearch", () => {
  const ids = [newConversationId(), newConversationId(), newConversationId()];
  /** Run the answer over a `search` stub; returns what was posted. */
  async function answered(search: () => Promise<unknown>) {
    const posted: unknown[] = [];
    const store = { search } as unknown as ConversationStore;
    await answerConversationSearch(store, { id: 7, ids, query: "lexer" }, (message) => posted.push(message));
    return posted;
  }

  test("posts the search's answer under the request id", async () => {
    const items = [{ id: ids[1] ?? "", excerpt: "the lexer" }];
    expect(await answered(async () => ({ items, unreadableCount: 1 }))).toEqual([
      { type: "conversationMatches", id: 7, items, unreadableCount: 1 },
    ]);
  });

  test("posts nothing for a search that was not answered: stopped by a newer one, or not searchable", async () => {
    expect(await answered(async () => undefined)).toEqual([]);
  });

  test("logs an unexpected failure and answers every conversation searched as unreadable", async () => {
    let posted: unknown[] = [];
    const logged = await quietly(async () => {
      posted = await answered(async () => {
        throw new Error("boom");
      });
    });
    expect(posted).toEqual([{ type: "conversationMatches", id: 7, items: [], unreadableCount: 3 }]);
    expect(logged).toHaveLength(1);
  });

  test("passes the ids and the query to the store's search", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    const text = "the lexer";
    const saved: ConversationRecord = {
      ...record(1, "q"),
      entries: [{ role: "user", content: text, mentions: [], modelText: text }],
    };
    await store.save(saved);
    const posted: unknown[] = [];
    await answerConversationSearch(store, { id: 2, ids: [saved.id], query: "LEXER" }, (message) =>
      posted.push(message),
    );
    expect(posted).toEqual([
      { type: "conversationMatches", id: 2, items: [{ id: saved.id, excerpt: text }], unreadableCount: 0 },
    ]);
  });
});
