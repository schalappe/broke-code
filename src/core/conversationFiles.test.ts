import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryFiles, isTemporaryName } from "./conversationFiles";

const ID = "0b0d4c1e-8f9a-4c3b-9d2e-1a2b3c4d5e6f";
const NAME = `${ID}.json`;

let root: string;
let store: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "broke-code-files-"));
  store = join(root, "store");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function adapter() {
  const files = directoryFiles(store);
  if (!files) throw new Error("expected an adapter for a storage directory");
  return files;
}

describe("directoryFiles", () => {
  test("gives no adapter without a storage directory, and one with it", () => {
    expect(directoryFiles(undefined)).toBeUndefined();
    expect(directoryFiles(store)).toBeDefined();
  });

  test("lists the regular files only, and nothing while the directory does not exist", async () => {
    const files = adapter();
    expect(await files.names()).toEqual([]);

    await mkdir(join(store, "sub.json"), { recursive: true });
    await writeFile(join(store, "a.json"), "");
    await writeFile(join(root, "outside.json"), "");
    await symlink(join(root, "outside.json"), join(store, "link.json"));
    expect(await files.names()).toEqual(["a.json"]);
  });

  test("passes on a listing failure other than a missing directory", async () => {
    await writeFile(store, "a file, not a directory");
    await expect(adapter().names()).rejects.toThrow("ENOTDIR");
  });

  test("reads a file's text, nothing for a missing one, and passes on other read failures", async () => {
    const files = adapter();
    await mkdir(store);
    await writeFile(join(store, "a.json"), "é");
    expect(await files.read("a.json")).toBe("é");
    expect(await files.read("b.json")).toBeUndefined();

    await mkdir(join(store, "c.json"));
    await expect(files.read("c.json")).rejects.toThrow("EISDIR");
  });

  test("creates the directory, replaces the file whole, and leaves no temporary file", async () => {
    const files = adapter();
    await files.write(NAME, "one");
    await files.write(NAME, "two");
    expect(await readFile(join(store, NAME), "utf8")).toBe("two");
    expect(await readdir(store)).toEqual([NAME]);
  });

  test("a failed replacement keeps what the destination held and removes its temporary file", async () => {
    const files = adapter();
    const destination = join(store, NAME);
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "kept"), "old");
    await expect(files.write(NAME, "new")).rejects.toThrow();
    expect(await readFile(join(destination, "kept"), "utf8")).toBe("old");
    expect(await readdir(store)).toEqual([NAME]);
  });

  test("removes a file, succeeds for a missing one, and passes on other failures", async () => {
    const files = adapter();
    await mkdir(store);
    await writeFile(join(store, "a.json"), "");
    await files.remove("a.json");
    expect(await readdir(store)).toEqual([]);
    await files.remove("a.json");

    await mkdir(join(store, "b.json"));
    await expect(files.remove("b.json")).rejects.toThrow();
  });
});

describe("isTemporaryName", () => {
  test("matches only the temporary files this adapter writes", () => {
    const uuid = "1b0d4c1e-8f9a-4c3b-9d2e-1a2b3c4d5e6f";
    expect(isTemporaryName(`${ID}.json.${uuid}.tmp`)).toBe(true);
    expect(isTemporaryName(`${ID}.summary.json.${uuid}.tmp`)).toBe(true);
    for (const name of [
      `${ID}.json`,
      `${ID}.json.tmp`,
      "notes.tmp",
      `${ID}.json.x/../y.tmp`,
      `../${ID}.json.1.tmp`,
      `${ID}.summary.json`,
      `${ID}.summary.json.tmp`,
      `${ID}.other.json.${uuid}.tmp`,
      `${ID}.summary.summary.json.${uuid}.tmp`,
      `notes.summary.json.${uuid}.tmp`,
    ]) {
      expect(isTemporaryName(name)).toBe(false);
    }
  });
});
