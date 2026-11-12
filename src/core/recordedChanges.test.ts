import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordedChanges, recordingApplier } from "./recordedChanges";
import type { WorkspaceRoot } from "./workspaceFiles";
import { approvalApplier, type ChangeApplier, fileApplier, runWriteTool } from "./writeTools";

// [>]: `tmpdir()` sits under /var, a symlink to /private/var on macOS: the root's real path differs from its path, as
// a workspace opened through a symlink would.
let base: string;
let app: WorkspaceRoot;
let realApp: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "broke-code-restore-"));
  app = { name: "app", path: join(base, "app") };
  await mkdir(app.path);
  realApp = await realpath(app.path);
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Runs write tool `name` with `args` in `app`, through `apply` (recording into `changes` by default). */
function write(changes: RecordedChanges, name: string, args: Record<string, string>, apply?: ChangeApplier) {
  const applier = apply ?? recordingApplier(fileApplier([app]), changes);
  return runWriteTool({ name, args }, [app], applier, new AbortController().signal);
}

describe("recordingApplier", () => {
  test("one file edited three times is one entry, from its text before the first write to the last one's", async () => {
    await mkdir(join(app.path, "e1"));
    await writeFile(join(app.path, "e1", "a.txt"), "T0\n");
    const changes = new RecordedChanges();
    for (const [old, replacement] of [
      ["T0", "T1"],
      ["T1", "T2"],
      ["T2", "T3"],
    ]) {
      expect(await write(changes, "edit_file", { path: "e1/a.txt", old: old!, new: replacement! })).toMatchObject({
        status: "ok",
      });
    }
    expect(changes.files).toEqual([
      { path: "e1/a.txt", realPath: join(realApp, "e1", "a.txt"), original: "T0\n", written: "T3\n" },
    ]);
  });

  test("a created file records that it did not exist, also once edited after", async () => {
    const changes = new RecordedChanges();
    await write(changes, "write_file", { path: "e2/new/a.txt", content: "made" });
    await write(changes, "edit_file", { path: "e2/new/a.txt", old: "made", new: "edited" });
    expect(changes.files).toEqual([
      { path: "e2/new/a.txt", realPath: join(realApp, "e2", "new", "a.txt"), original: undefined, written: "edited\n" },
    ]);
  });

  test("a rejected write, an already written one, and a refused one record nothing", async () => {
    await mkdir(join(app.path, "e3"));
    await writeFile(join(app.path, "e3", "a.txt"), "same\n");
    const changes = new RecordedChanges();
    const rejecting = approvalApplier(
      fileApplier([app]),
      { preview: async () => ({ close: async () => {} }), hasUnsavedChanges: async () => false },
      async () => ({ kind: "reject" }),
    );
    expect(
      await write(changes, "write_file", { path: "e3/b.txt", content: "x" }, recordingApplier(rejecting, changes)),
    ).toMatchObject({ status: "error" });
    expect(await write(changes, "write_file", { path: "e3/a.txt", content: "same" })).toMatchObject({ status: "ok" });
    expect(await write(changes, "write_file", { path: "../out.txt", content: "x" })).toMatchObject({ status: "error" });
    expect(changes.files).toEqual([]);
  });

  test("the same file written under two spellings is one entry, keyed by its folder's real path", async () => {
    await mkdir(join(app.path, "e4", "real"), { recursive: true });
    await symlink(join(app.path, "e4", "real"), join(app.path, "e4", "alias"));
    const changes = new RecordedChanges();
    await write(changes, "write_file", { path: "e4/real/a.txt", content: "one" });
    await write(changes, "write_file", { path: "e4/alias/a.txt", content: "two" });
    expect(changes.files).toEqual([
      { path: "e4/real/a.txt", realPath: join(realApp, "e4", "real", "a.txt"), original: undefined, written: "two\n" },
    ]);
  });
});
