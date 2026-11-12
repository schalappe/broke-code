import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordedChanges, type RestoreOutcome, recordingApplier } from "./recordedChanges";
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
  await chmod(join(app.path, "s5"), 0o755).catch(() => {});
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

const noUnsaved = { hasUnsavedChanges: async () => false };

/** A recorder of the writes made through it, and the set it records into. */
function recorder(): {
  changes: RecordedChanges;
  edit: (path: string, old: string, replacement: string) => Promise<void>;
} {
  const changes = new RecordedChanges();
  return {
    changes,
    edit: async (path, old, replacement) => {
      expect(await write(changes, "edit_file", { path, old, new: replacement })).toMatchObject({ status: "ok" });
    },
  };
}

describe("RecordedChanges.restore", () => {
  test("puts an edited file back to its text before the first write, byte for byte, a BOM included", async () => {
    await mkdir(join(app.path, "r1"));
    await writeFile(join(app.path, "r1", "a.txt"), "\uFEFFT0\r\n");
    const { changes, edit } = recorder();
    await edit("r1/a.txt", "T0", "T1");
    await edit("r1/a.txt", "T1", "T2");
    await edit("r1/a.txt", "T2", "T3");
    expect(await changes.restore([app], noUnsaved)).toEqual([
      { status: "restored", path: "r1/a.txt", realPath: join(realApp, "r1", "a.txt") },
    ]);
    expect(await readFile(join(app.path, "r1", "a.txt"))).toEqual(Buffer.from("\uFEFFT0\r\n"));
    expect(await readdir(join(app.path, "r1"))).toEqual(["a.txt"]);
    expect(changes.files).toEqual([]);
  });

  test("removes a created file, and a file created then edited, keeping the folders made for them", async () => {
    const changes = new RecordedChanges();
    await write(changes, "write_file", { path: "r2/made.txt", content: "made" });
    await write(changes, "write_file", { path: "r2/new/deeper/b.txt", content: "first" });
    await write(changes, "edit_file", { path: "r2/new/deeper/b.txt", old: "first", new: "second" });
    expect(await changes.restore([app], noUnsaved)).toEqual([
      { status: "removed", path: "r2/made.txt", realPath: join(realApp, "r2", "made.txt") },
      { status: "removed", path: "r2/new/deeper/b.txt", realPath: join(realApp, "r2", "new", "deeper", "b.txt") },
    ]);
    expect(await readdir(join(app.path, "r2"))).toEqual(["new"]);
    expect(await readdir(join(app.path, "r2", "new", "deeper"))).toEqual([]);
  });

  test("skips a file changed since the writes, unsaved in an editor, or swapped for a symlink, touching none", async () => {
    await mkdir(join(app.path, "r3"));
    for (const name of ["changed.txt", "unsaved.txt", "linked.txt", "target.txt"]) {
      await writeFile(join(app.path, "r3", name), "T0\n");
    }
    const { changes, edit } = recorder();
    for (const name of ["changed.txt", "unsaved.txt", "linked.txt"]) await edit(`r3/${name}`, "T0", "T1");
    // [>]: As `run_command` would, behind the recorder's back.
    await writeFile(join(app.path, "r3", "changed.txt"), "T1 and more\n");
    await unlink(join(app.path, "r3", "linked.txt"));
    await symlink(join(app.path, "r3", "target.txt"), join(app.path, "r3", "linked.txt"));
    const unsaved = join(realApp, "r3", "unsaved.txt");
    const host = { hasUnsavedChanges: async (target: string) => (await realpath(target)) === unsaved };

    expect(await changes.restore([app], host)).toEqual([
      { status: "skipped", reason: "changed", path: "r3/changed.txt", realPath: join(realApp, "r3", "changed.txt") },
      { status: "skipped", reason: "unsaved", path: "r3/unsaved.txt", realPath: unsaved },
      { status: "skipped", reason: "symlink", path: "r3/linked.txt", realPath: join(realApp, "r3", "linked.txt") },
    ]);
    expect(await readFile(join(app.path, "r3", "changed.txt"), "utf8")).toBe("T1 and more\n");
    expect(await readFile(join(app.path, "r3", "unsaved.txt"), "utf8")).toBe("T1\n");
    expect(await readFile(join(app.path, "r3", "target.txt"), "utf8")).toBe("T0\n");
    expect(changes.files.map((file) => file.path)).toEqual(["r3/changed.txt", "r3/unsaved.txt", "r3/linked.txt"]);
  });

  test("skips a file of a folder no longer in the workspace", async () => {
    await mkdir(join(app.path, "r4"));
    await writeFile(join(app.path, "r4", "a.txt"), "T0\n");
    const { changes, edit } = recorder();
    await edit("r4/a.txt", "T0", "T1");
    const other = { name: "other", path: join(base, "other") };
    await mkdir(other.path);
    expect(await changes.restore([other], noUnsaved)).toEqual([
      { status: "skipped", reason: "outsideWorkspace", path: "r4/a.txt", realPath: join(realApp, "r4", "a.txt") },
    ]);
    expect(await readFile(join(app.path, "r4", "a.txt"), "utf8")).toBe("T1\n");
  });

  test("reports a failed write and a failed removal with their cause, then retries only them once it clears", async () => {
    await mkdir(join(app.path, "s5"));
    await writeFile(join(app.path, "s5", "a.txt"), "T0\n");
    await mkdir(join(app.path, "s6"));
    await writeFile(join(app.path, "s6", "a.txt"), "T0\n");
    const { changes, edit } = recorder();
    await edit("s5/a.txt", "T0", "T1");
    await write(changes, "write_file", { path: "s5/made.txt", content: "made" });
    await edit("s6/a.txt", "T0", "T1");
    await chmod(join(app.path, "s5"), 0o555);

    expect(await changes.restore([app], noUnsaved)).toEqual([
      {
        status: "skipped",
        reason: "failed",
        cause: "EACCES",
        path: "s5/a.txt",
        realPath: join(realApp, "s5", "a.txt"),
      },
      {
        status: "skipped",
        reason: "failed",
        cause: "EACCES",
        path: "s5/made.txt",
        realPath: join(realApp, "s5", "made.txt"),
      },
      { status: "restored", path: "s6/a.txt", realPath: join(realApp, "s6", "a.txt") },
    ]);
    expect(await readFile(join(app.path, "s5", "a.txt"), "utf8")).toBe("T1\n");
    expect(existsSync(join(app.path, "s5", "made.txt"))).toBe(true);
    expect(changes.files.map((file) => file.path)).toEqual(["s5/a.txt", "s5/made.txt"]);

    await chmod(join(app.path, "s5"), 0o755);
    expect(await changes.restore([app], noUnsaved)).toEqual([
      { status: "restored", path: "s5/a.txt", realPath: join(realApp, "s5", "a.txt") },
      { status: "removed", path: "s5/made.txt", realPath: join(realApp, "s5", "made.txt") },
    ]);
    expect(await readdir(join(app.path, "s5"))).toEqual(["a.txt"]);
    expect(await readFile(join(app.path, "s5", "a.txt"), "utf8")).toBe("T0\n");
    expect(changes.files).toEqual([]);
  });

  test("restoring the same writes twice reports the same files and changes nothing the second time", async () => {
    await mkdir(join(app.path, "r7"));
    await writeFile(join(app.path, "r7", "a.txt"), "T0\n");
    // [>]: Two sets recording the same writes: the second restore is the one that would run after a crash that kept
    // the set as it was before the first.
    const first = new RecordedChanges();
    const second = new RecordedChanges();
    const apply = recordingApplier(recordingApplier(fileApplier([app]), first), second);
    await write(first, "edit_file", { path: "r7/a.txt", old: "T0", new: "T1" }, apply);
    await write(first, "write_file", { path: "r7/made.txt", content: "made" }, apply);

    const expected: RestoreOutcome[] = [
      { status: "restored", path: "r7/a.txt", realPath: join(realApp, "r7", "a.txt") },
      { status: "removed", path: "r7/made.txt", realPath: join(realApp, "r7", "made.txt") },
    ];
    expect(await first.restore([app], noUnsaved)).toEqual(expected);
    const before = await stat(join(app.path, "r7", "a.txt"));
    expect(await second.restore([app], noUnsaved)).toEqual(expected);
    const after = await stat(join(app.path, "r7", "a.txt"));
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    expect(await readFile(join(app.path, "r7", "a.txt"), "utf8")).toBe("T0\n");
    expect(await readdir(join(app.path, "r7"))).toEqual(["a.txt"]);
    expect(second.files).toEqual([]);
  });
});
