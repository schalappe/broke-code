import { describe, expect, spyOn, test } from "bun:test";
import { type ConversationRecord, newConversationId } from "./conversation";
import { memoryFiles } from "./conversationFixture";
import { ConversationStore } from "./conversationStore";

function record(updatedAt: number, text = `message at ${updatedAt}`): ConversationRecord {
  return {
    version: 1,
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
  test("saves one file per conversation and lists them newest first", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    const [old, recent] = [record(1000, "old"), record(2000, "recent")];
    expect(await store.save(old)).toBe(true);
    expect(await store.save(recent)).toBe(true);

    expect([...files.files.keys()].sort()).toEqual([`${old.id}.json`, `${recent.id}.json`].sort());
    expect(await store.list()).toEqual([
      { id: recent.id, title: "recent", updatedAt: 2000 },
      { id: old.id, title: "old", updatedAt: 1000 },
    ]);
    expect(await store.load(old.id)).toEqual(old);
  });

  test("skips and logs a file of unknown version or broken shape, and ignores other names", async () => {
    const good = record(1000);
    const broken = newConversationId();
    const future = newConversationId();
    const files = memoryFiles({
      [`${good.id}.json`]: JSON.stringify(good),
      [`${broken}.json`]: "{",
      [`${future}.json`]: JSON.stringify({ ...record(3000), id: future, version: 2 }),
      "notes.txt": "hello",
      [`${good.id}.json.1234.tmp`]: "{",
    });
    const store = new ConversationStore(files);

    let listed: unknown;
    const logged = await quietly(async () => {
      listed = await store.list();
    });
    expect(listed).toEqual([{ id: good.id, title: "message at 1000", updatedAt: 1000 }]);
    expect(logged).toHaveLength(2);
    expect(String(logged.flat())).toContain("unknown version 2");

    let loaded: unknown = "unset";
    await quietly(async () => {
      loaded = await store.load(future);
    });
    expect(loaded).toBeUndefined();
  });

  test("loads nothing for a missing file", async () => {
    expect(await new ConversationStore(memoryFiles()).load(newConversationId())).toBeUndefined();
  });

  test("removes the file, and a save that comes after never brings it back", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    const saved = record(1000);
    await store.save(saved);

    await store.remove(saved.id);
    expect(files.files.size).toBe(0);
    expect(await store.save({ ...saved, updatedAt: 2000 })).toBe(false);
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

  test("after a failed remove, keeps saving the conversation", async () => {
    const files = memoryFiles();
    const store = new ConversationStore(files);
    const saved = record(1000);
    await store.save(saved);
    files.remove = async () => {
      throw new Error("EACCES: permission denied");
    };
    await expect(store.remove(saved.id)).rejects.toThrow("EACCES");
    expect(await store.save({ ...saved, updatedAt: 2000 })).toBe(true);
    expect(await store.load(saved.id)).toMatchObject({ updatedAt: 2000 });
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
    expect(await store.list()).toEqual([]);
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
