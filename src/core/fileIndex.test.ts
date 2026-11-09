import { describe, expect, test } from "bun:test";
import { FileIndex, type FileScan } from "./fileIndex";
import { MAX_INDEXED_FILES } from "./suggestions";

/** Scan port whose scans wait until settled by hand, oldest first. Counts the scans started. */
function manualScan() {
  const pending: { resolve: (files: string[]) => void; reject: (error: Error) => void }[] = [];
  const scan: FileScan = async (limit) => {
    expect(limit).toBe(MAX_INDEXED_FILES);
    const files = await new Promise<string[]>((resolve, reject) => pending.push({ resolve, reject }));
    return { local: files, found: files.length };
  };
  return { scan, pending, started: () => pending.length };
}

/** Scan port that answers at once with `files`, counting its calls. */
function fixedScan(files: string[]) {
  let calls = 0;
  const scan: FileScan = async () => {
    calls++;
    return { local: files, found: files.length };
  };
  return { scan, calls: () => calls };
}

const paths = (answer: { items: { path: string }[] }) => answer.items.map((item) => item.path);

describe("FileIndex", () => {
  test("concurrent queries share one scan", async () => {
    const { scan, pending, started } = manualScan();
    const index = new FileIndex(scan);
    const first = index.query("a");
    const second = index.query("b");
    await Bun.sleep(0);
    expect(started()).toBe(1);
    pending[0]!.resolve(["a.ts", "b.ts"]);
    expect(paths(await first)).toEqual(["a.ts"]);
    expect(paths(await second)).toEqual(["b.ts"]);
  });

  test("answers later queries from the same scan until a file changes outside the excluded folders", async () => {
    const { scan, calls } = fixedScan(["src/a.ts"]);
    const index = new FileIndex(scan);
    expect(paths(await index.query("a"))).toEqual(["src/a.ts"]);
    await index.query("src");
    expect(calls()).toBe(1);

    index.fileChanged("node_modules/x/index.js");
    index.fileChanged(".git/HEAD");
    await index.query("a");
    expect(calls()).toBe(1);

    index.fileChanged("src/new.ts");
    await index.query("a");
    expect(calls()).toBe(2);
  });

  test("scans again after the workspace folders change", async () => {
    const { scan, calls } = fixedScan(["a.ts"]);
    const index = new FileIndex(scan);
    await index.query("a");
    index.invalidate();
    await index.query("a");
    expect(calls()).toBe(2);
  });

  test("retries a failed scan on the next query", async () => {
    const { scan, pending, started } = manualScan();
    const index = new FileIndex(scan);
    const failed = index.query("a");
    await Bun.sleep(0);
    pending[0]!.reject(new Error("search failed"));
    await expect(failed).rejects.toThrow("search failed");

    const retried = index.query("a");
    await Bun.sleep(0);
    expect(started()).toBe(2);
    pending[1]!.resolve(["a.ts"]);
    expect(paths(await retried)).toEqual(["a.ts"]);
  });

  test("a failed older scan leaves the newer scan in flight for the next queries", async () => {
    const { scan, pending, started } = manualScan();
    const index = new FileIndex(scan);
    const old = index.query("a");
    await Bun.sleep(0);
    index.fileChanged("src/new.ts");
    const fresh = index.query("a");
    await Bun.sleep(0);
    pending[0]!.reject(new Error("search failed"));
    await expect(old).rejects.toThrow("search failed");

    const later = index.query("a");
    await Bun.sleep(0);
    expect(started()).toBe(2);
    pending[1]!.resolve(["a.ts"]);
    expect(paths(await fresh)).toEqual(["a.ts"]);
    expect(paths(await later)).toEqual(["a.ts"]);
  });

  test("says the index is capped when the search found as many files as the limit, local or not", async () => {
    const files = (count: number) => Array.from({ length: count }, (_, index) => `f${index}.ts`);
    const capped = new FileIndex(async () => ({ local: files(MAX_INDEXED_FILES - 1), found: MAX_INDEXED_FILES }));
    expect((await capped.query("f")).capped).toBe(true);
    const below = new FileIndex(async () => ({ local: files(MAX_INDEXED_FILES - 1), found: MAX_INDEXED_FILES - 1 }));
    expect((await below.query("f")).capped).toBe(false);
  });

  test("offers at most 20 rows, folders derived from the files", async () => {
    const files = Array.from({ length: 30 }, (_, index) => `src/file${index}.ts`);
    const answer = await new FileIndex(fixedScan(files).scan).query("");
    expect(answer.items).toHaveLength(20);
    expect(answer.items[0]).toEqual({ path: "src/", kind: "folder" });
  });
});
