import { describe, expect, test } from "bun:test";
import { directoryFiles, type FileSystem, isTemporaryName, type StorageDirectory } from "./conversationFiles";

const FILE = 1;
const DIRECTORY = 2;

class NotFound extends Error {}

/** In-memory file system over path strings, with every call recorded and any call made to fail on demand. */
function fakeFs() {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const calls: string[] = [];
  const failures = new Map<string, Error>();
  const fail = (operation: string) => {
    const error = failures.get(operation);
    if (error) throw error;
  };
  const fs: FileSystem<string> = {
    readDirectory: async (uri) => {
      calls.push(`readDirectory ${uri}`);
      fail("readDirectory");
      if (!directories.has(uri)) throw new NotFound(uri);
      const prefix = `${uri}/`;
      const children = new Map<string, number>();
      for (const path of files.keys()) if (path.startsWith(prefix)) children.set(path.slice(prefix.length), FILE);
      for (const path of directories) if (path.startsWith(prefix)) children.set(path.slice(prefix.length), DIRECTORY);
      return [...children];
    },
    readFile: async (uri) => {
      calls.push(`readFile ${uri}`);
      fail("readFile");
      const content = files.get(uri);
      if (!content) throw new NotFound(uri);
      return content;
    },
    writeFile: async (uri, content) => {
      calls.push(`writeFile ${uri}`);
      fail("writeFile");
      files.set(uri, content);
    },
    rename: async (source, target, options) => {
      calls.push(`rename ${source} ${target} ${options.overwrite}`);
      fail("rename");
      const content = files.get(source);
      if (!content) throw new NotFound(source);
      files.delete(source);
      files.set(target, content);
    },
    delete: async (uri) => {
      calls.push(`delete ${uri}`);
      fail("delete");
      if (!files.delete(uri)) throw new NotFound(uri);
    },
    createDirectory: async (uri) => {
      calls.push(`createDirectory ${uri}`);
      directories.add(uri);
    },
  };
  const storage: StorageDirectory<string> = {
    fs,
    uri: "/store",
    join: (directory, name) => `${directory}/${name}`,
    isFileNotFound: (error) => error instanceof NotFound,
  };
  const text = (path: string) => new TextDecoder().decode(files.get(path));
  return { fs, storage, files, directories, calls, failures, text };
}

function adapter(fake: ReturnType<typeof fakeFs>) {
  const files = directoryFiles(fake.storage);
  if (!files) throw new Error("expected an adapter for a storage directory");
  return files;
}

describe("directoryFiles", () => {
  test("gives no adapter without a storage directory, and one with it", () => {
    expect(directoryFiles(undefined)).toBeUndefined();
    expect(directoryFiles(fakeFs().storage)).toBeDefined();
  });

  test("lists the regular files only, and nothing while the directory does not exist", async () => {
    const fake = fakeFs();
    const files = adapter(fake);
    expect(await files.names()).toEqual([]);

    fake.directories.add("/store");
    fake.directories.add("/store/sub.json");
    fake.files.set("/store/a.json", new Uint8Array());
    expect(await files.names()).toEqual(["a.json"]);
  });

  test("passes on a listing failure other than a missing directory", async () => {
    const fake = fakeFs();
    fake.failures.set("readDirectory", new Error("EACCES: permission denied"));
    await expect(adapter(fake).names()).rejects.toThrow("EACCES");
  });

  test("reads a file's text, nothing for a missing one, and passes on other read failures", async () => {
    const fake = fakeFs();
    const files = adapter(fake);
    fake.files.set("/store/a.json", new TextEncoder().encode("é"));
    expect(await files.read("a.json")).toBe("é");
    expect(await files.read("b.json")).toBeUndefined();

    fake.failures.set("readFile", new Error("EIO: i/o error"));
    await expect(files.read("a.json")).rejects.toThrow("EIO");
  });

  test("writes a uniquely named temporary file in the directory, then renames it over the final one", async () => {
    const fake = fakeFs();
    const files = adapter(fake);
    const name = "0b0d4c1e-8f9a-4c3b-9d2e-1a2b3c4d5e6f.json";
    await files.write(name, "one");
    await files.write(name, "two");

    expect(fake.text(`/store/${name}`)).toBe("two");
    expect([...fake.files.keys()]).toEqual([`/store/${name}`]);
    const temps = fake.calls
      .filter((call) => call.startsWith("writeFile"))
      .map((call) => call.slice("writeFile ".length));
    expect(temps).toHaveLength(2);
    expect(new Set(temps).size).toBe(2);
    for (const temp of temps) {
      expect(temp.startsWith("/store/")).toBe(true);
      expect(isTemporaryName(temp.slice("/store/".length))).toBe(true);
    }
    expect(fake.calls.slice(0, 3)).toEqual([
      "createDirectory /store",
      `writeFile ${temps[0]}`,
      `rename ${temps[0]} /store/${name} true`,
    ]);
  });

  test("on a failed rename, deletes the temporary file and reports the rename error", async () => {
    const fake = fakeFs();
    fake.failures.set("rename", new Error("ENOSPC: no space left on device"));
    await expect(adapter(fake).write("a.json", "one")).rejects.toThrow("ENOSPC");
    expect(fake.files.size).toBe(0);
  });

  test("removes a file, succeeds for a missing one, and passes on other failures", async () => {
    const fake = fakeFs();
    const files = adapter(fake);
    fake.files.set("/store/a.json", new Uint8Array());
    await files.remove("a.json");
    expect(fake.files.size).toBe(0);
    await files.remove("a.json");

    fake.failures.set("delete", new Error("EACCES: permission denied"));
    await expect(files.remove("a.json")).rejects.toThrow("EACCES");
  });
});

describe("isTemporaryName", () => {
  test("matches only the temporary files this adapter writes", () => {
    const id = "0b0d4c1e-8f9a-4c3b-9d2e-1a2b3c4d5e6f";
    expect(isTemporaryName(`${id}.json.1b0d4c1e-8f9a-4c3b-9d2e-1a2b3c4d5e6f.tmp`)).toBe(true);
    for (const name of [`${id}.json`, `${id}.json.tmp`, "notes.tmp", `${id}.json.x/../y.tmp`, `../${id}.json.1.tmp`]) {
      expect(isTemporaryName(name)).toBe(false);
    }
  });
});
