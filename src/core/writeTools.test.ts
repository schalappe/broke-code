import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "./tools";
import type { WorkspaceRoot } from "./workspaceFiles";
import { fileApplier, type PlannedChange, runWriteTool } from "./writeTools";

// [>]: `tmpdir()` sits under /var, a symlink to /private/var on macOS: every root here has a real path that differs
// from its path, as a workspace opened through a symlink would.
let base: string;
let app: WorkspaceRoot;
let lib: WorkspaceRoot;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "broke-code-write-"));
  app = { name: "app", path: join(base, "app") };
  lib = { name: "lib", path: join(base, "lib") };
  await mkdir(join(base, "outside-dir"), { recursive: true });
  await mkdir(join(app.path, "src"), { recursive: true });
  await mkdir(lib.path);
  await writeFile(join(base, "outside.txt"), "secret\n");
  await symlink(join(base, "outside.txt"), join(app.path, "link-out.txt"));
  await symlink(join(base, "outside-dir"), join(app.path, "link-out-dir"));
});
afterAll(async () => {
  // [>]: Tests lock these folders and files; unlock them so the cleanup can remove them.
  for (const path of ["locked", "locked-parent", "denied.txt"])
    await chmod(join(app.path, path), 0o755).catch(() => {});
  await rm(base, { recursive: true, force: true });
});

function run(name: string, args: Record<string, string>, roots = [app]): Promise<ToolResult> {
  return runWriteTool({ name, args }, roots, fileApplier(roots), new AbortController().signal);
}

describe("write_file", () => {
  test("creates a new file in new subfolders, with the content and one final line break", async () => {
    const result = await run("write_file", { path: "new/deeper/a.txt", content: "hello\nworld" });
    expect(result.status).toBe("ok");
    expect(await readFile(join(app.path, "new", "deeper", "a.txt"), "utf8")).toBe("hello\nworld\n");
  });

  test("refuses a path outside by ../, through a committed symlink, and under a parent symlink out, writing nothing", async () => {
    const reason = "the path is outside the workspace folders.";
    expect(await run("write_file", { path: "../x.txt", content: "x" })).toEqual({
      status: "error",
      text: `write_file: ../x.txt: ${reason}`,
    });
    expect(await run("write_file", { path: "link-out.txt", content: "x" })).toEqual({
      status: "error",
      text: `write_file: link-out.txt: ${reason}`,
    });
    expect(await run("write_file", { path: "link-out-dir/y.txt", content: "x" })).toEqual({
      status: "error",
      text: `write_file: link-out-dir/y.txt: ${reason}`,
    });
    expect(await run("write_file", { path: "link-out-dir/sub/y.txt", content: "x" })).toMatchObject({
      text: `write_file: link-out-dir/sub/y.txt: ${reason}`,
    });
    expect(existsSync(join(base, "x.txt"))).toBe(false);
    expect(await readFile(join(base, "outside.txt"), "utf8")).toBe("secret\n");
    expect(existsSync(join(base, "outside-dir", "y.txt"))).toBe(false);
    expect(existsSync(join(base, "outside-dir", "sub"))).toBe(false);
  });

  test("replaces an existing file whole, and writes empty content as an empty file", async () => {
    await writeFile(join(app.path, "whole.txt"), "old\ncontent\n");
    expect(await run("write_file", { path: "whole.txt", content: "new" })).toEqual({
      status: "ok",
      text: "write_file: replaced whole.txt.",
    });
    expect(await readFile(join(app.path, "whole.txt"), "utf8")).toBe("new\n");
    await run("write_file", { path: "whole.txt", content: "" });
    expect(await readFile(join(app.path, "whole.txt"), "utf8")).toBe("");
  });

  test("refuses a binary target, a target over 1 MiB, and content over 1 MiB with the read tools' wording", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x00, 0x47]);
    await writeFile(join(app.path, "image.bin"), binary);
    await writeFile(join(app.path, "big.txt"), "a".repeat(1024 * 1024 + 1));
    expect(await run("write_file", { path: "image.bin", content: "x" })).toEqual({
      status: "error",
      text: "write_file: image.bin: the file is binary.",
    });
    expect(await run("write_file", { path: "big.txt", content: "x" })).toEqual({
      status: "error",
      text: "write_file: big.txt: the file is larger than 1 MiB.",
    });
    expect(await run("write_file", { path: "huge.txt", content: "a".repeat(1024 * 1024) })).toEqual({
      status: "error",
      text: "write_file: huge.txt: the file is larger than 1 MiB.",
    });
    expect(await readFile(join(app.path, "image.bin"))).toEqual(binary);
    expect((await readFile(join(app.path, "big.txt"))).length).toBe(1024 * 1024 + 1);
    expect(existsSync(join(app.path, "huge.txt"))).toBe(false);
  });

  test("refuses a folder, a symlink that stays inside, and a file that is not UTF-8, writing nothing", async () => {
    await writeFile(join(app.path, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await symlink(join(app.path, "latin1.txt"), join(app.path, "link-in.txt"));
    expect((await run("write_file", { path: "src", content: "x" })).text).toBe(
      "write_file: src: the path is a folder.",
    );
    expect((await run("write_file", { path: "link-in.txt", content: "x" })).text).toBe(
      "write_file: link-in.txt: the path is a symbolic link; write to the file it points to instead.",
    );
    expect((await run("write_file", { path: "latin1.txt", content: "x" })).text).toBe(
      "write_file: latin1.txt: the file is not UTF-8 text.",
    );
    expect(await readFile(join(app.path, "latin1.txt"))).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  });

  test("writes a bare new path to the first folder, and a folder-named path to that folder, in a multi-root workspace", async () => {
    expect((await run("write_file", { path: "first.txt", content: "1" }, [app, lib])).status).toBe("ok");
    expect((await run("write_file", { path: "lib/named.txt", content: "2" }, [app, lib])).status).toBe("ok");
    expect(await readFile(join(app.path, "first.txt"), "utf8")).toBe("1\n");
    expect(await readFile(join(lib.path, "named.txt"), "utf8")).toBe("2\n");
  });

  test("edits a bare path that exists only in a later folder there, in a multi-root workspace", async () => {
    await writeFile(join(lib.path, "only-lib.txt"), "lib\n");
    expect((await run("edit_file", { path: "only-lib.txt", old: "lib", new: "LIB" }, [app, lib])).status).toBe("ok");
    expect(await readFile(join(lib.path, "only-lib.txt"), "utf8")).toBe("LIB\n");
    expect(existsSync(join(app.path, "only-lib.txt"))).toBe(false);
  });

  test("refuses every path when no folder is open", async () => {
    expect(await run("write_file", { path: "a.txt", content: "x" }, [])).toEqual({
      status: "error",
      text: "write_file: no workspace folder is open.",
    });
  });
});

describe("edit_file", () => {
  test("replaces the one exact passage and nothing else, in a CRLF file too", async () => {
    await writeFile(join(app.path, "lf.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    expect(await run("edit_file", { path: "lf.ts", old: "const b = 2;", new: "const b = 20;" })).toEqual({
      status: "ok",
      text: "edit_file: replaced the passage in lf.ts.",
    });
    expect(await readFile(join(app.path, "lf.ts"), "utf8")).toBe("const a = 1;\nconst b = 20;\nconst c = 3;\n");

    await writeFile(join(app.path, "crlf.ts"), "﻿one\r\ntwo\r\nthree\r\n");
    expect((await run("edit_file", { path: "crlf.ts", old: "two\r\nthree", new: "2\r\n3" })).status).toBe("ok");
    expect(await readFile(join(app.path, "crlf.ts"))).toEqual(Buffer.from("﻿one\r\n2\r\n3\r\n"));
  });

  test("finds no passage written with other line endings than the file's, and leaves it byte-identical", async () => {
    const bytes = Buffer.from("one\r\ntwo\r\n");
    await writeFile(join(app.path, "endings.txt"), bytes);
    expect(await run("edit_file", { path: "endings.txt", old: "one\ntwo", new: "x" })).toEqual({
      status: "error",
      text: "edit_file: the passage was not found in endings.txt.",
    });
    expect(await readFile(join(app.path, "endings.txt"))).toEqual(bytes);
  });

  test("refuses a passage that appears twice, overlapping or not, and leaves the file byte-identical", async () => {
    const bytes = Buffer.from("x = 1;\ny = 1;\naaa\n");
    await writeFile(join(app.path, "twice.ts"), bytes);
    expect(await run("edit_file", { path: "twice.ts", old: " = 1;", new: " = 2;" })).toEqual({
      status: "error",
      text: "edit_file: the passage appears 2 times in twice.ts; include more context so it matches once.",
    });
    expect((await run("edit_file", { path: "twice.ts", old: "aa", new: "b" })).text).toContain("appears 2 times");
    expect(await readFile(join(app.path, "twice.ts"))).toEqual(bytes);
  });

  test("refuses a missing file and an empty passage with nothing created", async () => {
    expect(await run("edit_file", { path: "nowhere.ts", old: "a", new: "b" })).toEqual({
      status: "error",
      text: "edit_file: nowhere.ts: no such file or folder in the workspace.",
    });
    expect(existsSync(join(app.path, "nowhere.ts"))).toBe(false);
    await writeFile(join(app.path, "empty-old.ts"), "a\n");
    expect((await run("edit_file", { path: "empty-old.ts", old: "", new: "b" })).status).toBe("error");
    expect(await readFile(join(app.path, "empty-old.ts"), "utf8")).toBe("a\n");
  });

  test("refuses a file it may not read, naming the cause", async () => {
    await writeFile(join(app.path, "denied.txt"), "a\n");
    await chmod(join(app.path, "denied.txt"), 0o000);
    expect(await run("edit_file", { path: "denied.txt", old: "a", new: "b" })).toEqual({
      status: "error",
      text: "edit_file: denied.txt: the path could not be read (EACCES).",
    });
  });

  test("refuses a binary file and a file over 1 MiB with the read tools' wording", async () => {
    await writeFile(join(app.path, "edit.bin"), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(join(app.path, "edit-big.txt"), `${"a".repeat(1024 * 1024)}b`);
    expect((await run("edit_file", { path: "edit.bin", old: "a", new: "c" })).text).toBe(
      "edit_file: edit.bin: the file is binary.",
    );
    expect((await run("edit_file", { path: "edit-big.txt", old: "b", new: "c" })).text).toBe(
      "edit_file: edit-big.txt: the file is larger than 1 MiB.",
    );
  });
});

describe("fileApplier", () => {
  /** The change a write tool hands over, captured instead of applied. */
  async function plan(name: string, args: Record<string, string>): Promise<PlannedChange> {
    let captured: PlannedChange | undefined;
    await runWriteTool(
      { name, args },
      [app],
      async (change) => {
        captured = change;
        return { status: "ok", text: "" };
      },
      new AbortController().signal,
    );
    if (captured === undefined) throw new Error("no change planned");
    return captured;
  }

  test("plans a change without writing it", async () => {
    await writeFile(join(app.path, "planned.txt"), "before\n");
    const change = await plan("edit_file", { path: "planned.txt", old: "before", new: "after" });
    expect(change).toMatchObject({ tool: "edit_file", path: "planned.txt", before: "before\n", after: "after\n" });
    expect(await readFile(join(app.path, "planned.txt"), "utf8")).toBe("before\n");
  });

  test("applies a change twice with the same outcome on disk, the second time saying it is already there", async () => {
    await writeFile(join(app.path, "again.txt"), "one\n");
    const change = await plan("edit_file", { path: "again.txt", old: "one", new: "two" });
    const apply = fileApplier([app]);
    expect((await apply(change)).status).toBe("ok");
    expect(await apply(change)).toEqual({ status: "ok", text: "edit_file: again.txt already holds this change." });
    expect(await readFile(join(app.path, "again.txt"), "utf8")).toBe("two\n");
  });

  test("leaves alone a file that changed since the change was planned, and one created meanwhile", async () => {
    await writeFile(join(app.path, "moved-on.txt"), "one\n");
    const change = await plan("edit_file", { path: "moved-on.txt", old: "one", new: "two" });
    await writeFile(join(app.path, "moved-on.txt"), "user edit\n");
    expect(await fileApplier([app])(change)).toEqual({
      status: "error",
      text: "edit_file: moved-on.txt: the file changed since this change was planned. Read it again.",
    });
    expect(await readFile(join(app.path, "moved-on.txt"), "utf8")).toBe("user edit\n");

    const creation = await plan("write_file", { path: "raced.txt", content: "mine" });
    await writeFile(join(app.path, "raced.txt"), "theirs\n");
    expect((await fileApplier([app])(creation)).status).toBe("error");
    expect(await readFile(join(app.path, "raced.txt"), "utf8")).toBe("theirs\n");
  });

  test("refuses at apply a target swapped for a symlink out since the plan, writing nothing outside", async () => {
    await writeFile(join(app.path, "swap.txt"), "inside\n");
    const change = await plan("write_file", { path: "swap.txt", content: "x" });
    await rm(join(app.path, "swap.txt"));
    await symlink(join(base, "outside.txt"), join(app.path, "swap.txt"));
    expect(await fileApplier([app])(change)).toEqual({
      status: "error",
      text: "write_file: swap.txt: the path is outside the workspace folders.",
    });
    expect(await readFile(join(base, "outside.txt"), "utf8")).toBe("secret\n");
  });

  test("replaces a file whole by a new one: its permission bits kept, a hard link left on the old text, no temporary file", async () => {
    await mkdir(join(app.path, "swap-in"));
    const file = join(app.path, "swap-in", "a.sh");
    await writeFile(file, "old\n");
    await chmod(file, 0o751);
    await link(file, join(app.path, "swap-in", "hard-link.sh"));
    const change = await plan("write_file", { path: "swap-in/a.sh", content: "new" });
    expect((await fileApplier([app])(change)).status).toBe("ok");
    expect(await readFile(file, "utf8")).toBe("new\n");
    expect((await stat(file)).mode & 0o777).toBe(0o751);
    expect(await readFile(join(app.path, "swap-in", "hard-link.sh"), "utf8")).toBe("old\n");
    expect(await readdir(join(app.path, "swap-in"))).toEqual(["a.sh", "hard-link.sh"]);
  });

  test("creates a new file with the default permission bits", async () => {
    const change = await plan("write_file", { path: "fresh.txt", content: "x" });
    expect((await fileApplier([app])(change)).status).toBe("ok");
    expect((await stat(join(app.path, "fresh.txt"))).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  test("a write that fails leaves the file byte-identical and no temporary file, and names the cause", async () => {
    await mkdir(join(app.path, "locked"));
    await writeFile(join(app.path, "locked", "a.txt"), "original\n");
    const change = await plan("edit_file", { path: "locked/a.txt", old: "original", new: "changed" });
    await chmod(join(app.path, "locked"), 0o555);
    expect(await fileApplier([app])(change)).toEqual({
      status: "error",
      text: "edit_file: locked/a.txt: the file was not written (EACCES).",
    });
    expect(await readFile(join(app.path, "locked", "a.txt"), "utf8")).toBe("original\n");
    expect(await readdir(join(app.path, "locked"))).toEqual(["a.txt"]);
  });

  test("a folder that cannot be created fails the write with its cause", async () => {
    await mkdir(join(app.path, "locked-parent"));
    const change = await plan("write_file", { path: "locked-parent/new/a.txt", content: "x" });
    await chmod(join(app.path, "locked-parent"), 0o555);
    expect(await fileApplier([app])(change)).toEqual({
      status: "error",
      text: "write_file: locked-parent/new/a.txt: the file was not written (EACCES).",
    });
  });

  test("hands nothing over once Stop is pressed", async () => {
    const controller = new AbortController();
    controller.abort();
    let handed = false;
    const result = await runWriteTool(
      { name: "write_file", args: { path: "stopped.txt", content: "x" } },
      [app],
      async () => {
        handed = true;
        return { status: "ok", text: "" };
      },
      controller.signal,
    );
    expect(result).toEqual({ status: "error", text: "write_file: stopped before it finished." });
    expect(handed).toBe(false);
  });
});
