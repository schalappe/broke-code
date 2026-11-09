import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareNames,
  locateWriteTarget,
  readWorkspaceEntry,
  truncateLines,
  type WorkspaceRoot,
  writeWorkspaceFile,
} from "./workspaceFiles";

// [>]: `tmpdir()` sits under /var, a symlink to /private/var on macOS: every root here has a real path that differs
// from its path, as a workspace opened through a symlink would.
let base: string;
let app: WorkspaceRoot;
let lib: WorkspaceRoot;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "broke-code-files-"));
  app = { name: "app", path: join(base, "app") };
  lib = { name: "lib", path: join(base, "lib") };
  await mkdir(join(app.path, "src", "core"), { recursive: true });
  await mkdir(join(app.path, "docs"));
  await mkdir(lib.path);
  await writeFile(join(base, "outside.txt"), "secret\n");
  await writeFile(join(app.path, "src", "main.ts"), "export {};\n");
  await writeFile(join(app.path, "src", "core", "deep.ts"), "deep\n");
  await writeFile(join(app.path, "src", "b.txt"), "b\n");
  await writeFile(join(app.path, "src", "a.txt"), "a\n");
  await writeFile(join(app.path, "docs", "x.txt"), "app docs\n");
  await writeFile(join(lib.path, "x.txt"), "lib x\n");
  await writeFile(join(lib.path, "only-lib.txt"), "only in lib\n");
  await symlink(join(base, "outside.txt"), join(app.path, "link-out.txt"));
  await symlink(base, join(app.path, "link-out-dir"));
  await symlink(join(app.path, "src", "main.ts"), join(app.path, "link-in.ts"));
});
afterAll(async () => {
  // [>]: The file exists only once its test ran; without it there is nothing to unlock.
  await chmod(join(app.path, "locked.txt"), 0o600).catch(() => {});
  await chmod(join(app.path, "w7"), 0o755).catch(() => {});
  await rm(base, { recursive: true, force: true });
});

describe("readWorkspaceEntry in one folder", () => {
  test("reads a file as UTF-8", async () => {
    await writeFile(join(app.path, "utf8.txt"), "héllo ✓\n");
    expect(await readWorkspaceEntry([app], "utf8.txt")).toEqual({ status: "ok", kind: "file", text: "héllo ✓\n" });
  });

  test("lists a folder's direct children, sorted by name, folders suffixed with /", async () => {
    expect(await readWorkspaceEntry([app], "src/")).toEqual({
      status: "ok",
      kind: "folder",
      entries: ["a.txt", "b.txt", "core/", "main.ts"],
    });
    expect(await readWorkspaceEntry([app], "src")).toMatchObject({ kind: "folder" });
  });

  test("lists a symlink to a folder with /, and a symlink to a file or a broken one as a plain name", async () => {
    const links = join(app.path, "links");
    await mkdir(links);
    await symlink(join(app.path, "src", "core"), join(links, "to-folder"));
    await symlink(join(app.path, "src", "main.ts"), join(links, "to-file"));
    await symlink(join(app.path, "nowhere"), join(links, "broken"));
    await symlink(join(links, "loop"), join(links, "loop"));
    expect(await readWorkspaceEntry([app], "links/")).toEqual({
      status: "ok",
      kind: "folder",
      entries: ["broken", "loop", "to-file", "to-folder/"],
    });
  });

  test("lists a symlink whose target cannot be checked as a plain name, the rest of the listing intact", async () => {
    const sealed = join(base, "sealed");
    await mkdir(join(sealed, "inner"), { recursive: true });
    const links = join(app.path, "sealed-links");
    await mkdir(links);
    await symlink(join(sealed, "inner"), join(links, "forbidden"));
    await writeFile(join(links, "plain.txt"), "plain\n");
    await chmod(sealed, 0o000);
    try {
      expect(await readWorkspaceEntry([app], "sealed-links/")).toEqual({
        status: "ok",
        kind: "folder",
        entries: ["forbidden", "plain.txt"],
      });
    } finally {
      await chmod(sealed, 0o700);
    }
  });

  test("refuses a path that leaves the folder, existing or not", async () => {
    for (const path of ["../outside.txt", "../nothing.txt", "src/../../outside.txt", join(base, "outside.txt")]) {
      expect(await readWorkspaceEntry([app], path)).toEqual({ status: "outsideWorkspace", kind: "file" });
    }
  });

  test("refuses a symlink that points outside the folder", async () => {
    expect(await readWorkspaceEntry([app], "link-out.txt")).toEqual({ status: "outsideWorkspace", kind: "file" });
    expect(await readWorkspaceEntry([app], "link-out-dir/outside.txt")).toEqual({
      status: "outsideWorkspace",
      kind: "file",
    });
  });

  test("follows a symlink that stays inside the folder, and accepts an absolute path inside it", async () => {
    expect(await readWorkspaceEntry([app], "link-in.ts")).toEqual({ status: "ok", kind: "file", text: "export {};\n" });
    expect(await readWorkspaceEntry([app], join(app.path, "src", "main.ts"))).toMatchObject({ status: "ok" });
  });

  test("reports a missing path, as a folder when it ends with /", async () => {
    expect(await readWorkspaceEntry([app], "gone.txt")).toEqual({ status: "missing", kind: "file" });
    expect(await readWorkspaceEntry([app], "gone/")).toEqual({ status: "missing", kind: "folder" });
    expect(await readWorkspaceEntry([app], "src/main.ts/x")).toEqual({ status: "missing", kind: "file" });
  });

  test("calls a file binary when its first 8 KiB hold a NUL byte, and reads it when the NUL comes later", async () => {
    await writeFile(join(app.path, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    expect(await readWorkspaceEntry([app], "image.bin")).toEqual({ status: "binary", kind: "file" });

    await writeFile(join(app.path, "late-nul.txt"), `${"a".repeat(8 * 1024)}\0`);
    expect(await readWorkspaceEntry([app], "late-nul.txt")).toMatchObject({ status: "ok", kind: "file" });
  });

  test("refuses a file over 1 MiB and reads one of exactly 1 MiB", async () => {
    await writeFile(join(app.path, "big.txt"), "a".repeat(1024 * 1024 + 1));
    expect(await readWorkspaceEntry([app], "big.txt")).toEqual({ status: "tooLarge", kind: "file" });

    await writeFile(join(app.path, "limit.txt"), "a".repeat(1024 * 1024));
    expect(await readWorkspaceEntry([app], "limit.txt")).toMatchObject({ status: "ok", kind: "file" });
  });

  test("reports a file it may not read as unreadable, with the error code", async () => {
    await writeFile(join(app.path, "locked.txt"), "x");
    await chmod(join(app.path, "locked.txt"), 0o000);
    expect(await readWorkspaceEntry([app], "locked.txt")).toEqual({
      status: "unreadable",
      kind: "file",
      cause: "EACCES",
    });
  });

  test("reports a path that is neither a file nor a folder as unreadable, without opening it", async () => {
    Bun.spawnSync(["/usr/bin/mkfifo", join(app.path, "pipe")]);
    expect(await readWorkspaceEntry([app], "pipe")).toEqual({
      status: "unreadable",
      kind: "file",
      cause: "not a file or folder",
    });
  });

  test("refuses everything when no folder is open", async () => {
    expect(await readWorkspaceEntry([], "src/main.ts")).toEqual({ status: "outsideWorkspace", kind: "file" });
  });
});

describe("readWorkspaceEntry while the path changes", () => {
  // [>]: The swap runs where a concurrent rename would land: after the boundary check, before the open.
  test("refuses a file swapped for a symlink to an outside file after the check", async () => {
    await writeFile(join(app.path, "swapped.txt"), "inside\n");
    const swap = async () => {
      await unlink(join(app.path, "swapped.txt"));
      await symlink(join(base, "outside.txt"), join(app.path, "swapped.txt"));
    };
    expect(await readWorkspaceEntry([app], "swapped.txt", { beforeOpen: swap })).toEqual({
      status: "outsideWorkspace",
      kind: "file",
    });
  });

  test("refuses a file whose parent folder is swapped for a symlink to an outside folder after the check", async () => {
    const outsideDir = join(base, "outside-dir");
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, "x.txt"), "secret\n");
    await mkdir(join(app.path, "moved"));
    await writeFile(join(app.path, "moved", "x.txt"), "inside\n");
    const swap = async () => {
      await rename(join(app.path, "moved"), join(base, "moved-away"));
      await symlink(outsideDir, join(app.path, "moved"));
    };
    expect(await readWorkspaceEntry([app], "moved/x.txt", { beforeOpen: swap })).toEqual({
      status: "outsideWorkspace",
      kind: "file",
    });
  });

  test("refuses a folder swapped for a symlink to an outside folder after the check", async () => {
    await mkdir(join(app.path, "listed"));
    const swap = async () => {
      await rename(join(app.path, "listed"), join(base, "listed-away"));
      await symlink(base, join(app.path, "listed"));
    };
    expect(await readWorkspaceEntry([app], "listed/", { beforeOpen: swap })).toEqual({
      status: "outsideWorkspace",
      kind: "folder",
    });
  });
});

describe("writeWorkspaceFile while the file changes", () => {
  // [>]: Each hook runs where a concurrent writer could land; the planned `before` comes from a real plan.
  async function planned(path: string): Promise<{ target: string; before: string | undefined }> {
    const target = await locateWriteTarget([app], path);
    if (target.status !== "ok") throw new Error(`not planned: ${target.status}`);
    return { target: target.path, before: target.before };
  }

  async function temporaryFiles(folder: string): Promise<string[]> {
    return (await readdir(folder)).filter((name) => name.includes(".broke-code-"));
  }

  test("refuses a file edited after the new text is staged, keeping the edit and leaving no temporary file", async () => {
    await mkdir(join(app.path, "w1"));
    await writeFile(join(app.path, "w1", "a.txt"), "original\n");
    const { target, before } = await planned("w1/a.txt");
    const edit = () => writeFile(join(app.path, "w1", "a.txt"), "user edit\n");
    expect(await writeWorkspaceFile([app], target, before, "agent edit\n", { afterTempWritten: edit })).toEqual({
      status: "changed",
    });
    expect(await readFile(join(app.path, "w1", "a.txt"), "utf8")).toBe("user edit\n");
    expect(await temporaryFiles(join(app.path, "w1"))).toEqual([]);
  });

  test("takes a file that came to hold the new text meanwhile as already written, leaving no temporary file", async () => {
    await mkdir(join(app.path, "w2"));
    await writeFile(join(app.path, "w2", "a.txt"), "original\n");
    const { target, before } = await planned("w2/a.txt");
    const same = () => writeFile(join(app.path, "w2", "a.txt"), "agent edit\n");
    expect(await writeWorkspaceFile([app], target, before, "agent edit\n", { afterTempWritten: same })).toEqual({
      status: "alreadyWritten",
    });
    expect(await temporaryFiles(join(app.path, "w2"))).toEqual([]);
  });

  test("never clobbers a new file created after the last check", async () => {
    await mkdir(join(app.path, "w3"));
    const { target, before } = await planned("w3/new.txt");
    const create = () => writeFile(join(app.path, "w3", "new.txt"), "theirs\n");
    expect(await writeWorkspaceFile([app], target, before, "mine\n", { afterLastCheck: create })).toEqual({
      status: "changed",
    });
    expect(await readFile(join(app.path, "w3", "new.txt"), "utf8")).toBe("theirs\n");
    expect(await temporaryFiles(join(app.path, "w3"))).toEqual([]);
  });

  test("goes on when a missing folder is created meanwhile, and refuses one created as a symlink out", async () => {
    await mkdir(join(app.path, "w4"));
    const made = await planned("w4/made/a.txt");
    const create = () => mkdir(join(app.path, "w4", "made")).then(() => {});
    expect(await writeWorkspaceFile([app], made.target, made.before, "a\n", { afterCheck: create })).toEqual({
      status: "written",
    });
    expect(await readFile(join(app.path, "w4", "made", "a.txt"), "utf8")).toBe("a\n");

    const outsideDir = join(base, "outside-w4");
    await mkdir(outsideDir);
    const linked = await planned("w4/linked/a.txt");
    const link = () => symlink(outsideDir, join(app.path, "w4", "linked"));
    // [>]: Not even the temporary file may land outside, however briefly.
    const seenOutside: string[][] = [];
    const look = async () => {
      seenOutside.push(await readdir(outsideDir));
    };
    const seam = { afterCheck: link, afterTempWritten: look };
    expect(await writeWorkspaceFile([app], linked.target, linked.before, "a\n", seam)).toEqual({
      status: "outsideWorkspace",
    });
    expect(seenOutside).toEqual([]);
    expect(await readdir(outsideDir)).toEqual([]);
  });

  test("refuses when the folder is swapped for a link to another folder inside once the new text is staged", async () => {
    await mkdir(join(app.path, "w5", "sub"), { recursive: true });
    await mkdir(join(app.path, "w5", "other"));
    const { target, before } = await planned("w5/sub/a.txt");
    const swap = async () => {
      await rename(join(app.path, "w5", "sub"), join(app.path, "w5", "sub-moved"));
      await symlink(join(app.path, "w5", "other"), join(app.path, "w5", "sub"));
    };
    expect(await writeWorkspaceFile([app], target, before, "a\n", { afterTempWritten: swap })).toEqual({
      status: "changed",
    });
    expect(await readdir(join(app.path, "w5", "other"))).toEqual([]);
  });

  test("names a temporary file it could not remove, with the cause, leaving the file as it was", async () => {
    await mkdir(join(app.path, "w7"));
    await writeFile(join(app.path, "w7", "a.txt"), "original\n");
    const { target, before } = await planned("w7/a.txt");
    const lock = () => chmod(join(app.path, "w7"), 0o555);
    const outcome = await writeWorkspaceFile([app], target, before, "new\n", { afterLastCheck: lock });
    expect(outcome).toEqual({
      status: "notWritten",
      cause: "EACCES",
      leftover: { name: expect.stringMatching(/^\.a\.txt\.broke-code-[0-9a-f]{12}\.tmp$/), cause: "EACCES" },
    });
    expect(await readFile(join(app.path, "w7", "a.txt"), "utf8")).toBe("original\n");
    expect(await temporaryFiles(join(app.path, "w7"))).toEqual([outcome.leftover!.name]);
  });

  test("reports a target deleted between its check and its read as missing", async () => {
    await writeFile(join(app.path, "vanishing.txt"), "here\n");
    const remove = () => unlink(join(app.path, "vanishing.txt"));
    expect(await locateWriteTarget([app], "vanishing.txt", { beforeOpen: remove })).toEqual({ status: "missing" });
    expect(existsSync(join(app.path, "vanishing.txt"))).toBe(false);
  });
});

describe("readWorkspaceEntry in several folders", () => {
  test("reads from the folder named by the first segment", async () => {
    expect(await readWorkspaceEntry([app, lib], "lib/x.txt")).toEqual({ status: "ok", kind: "file", text: "lib x\n" });
    expect(await readWorkspaceEntry([app, lib], "app/docs/x.txt")).toMatchObject({ text: "app docs\n" });
    expect(await readWorkspaceEntry([app, lib], "lib")).toEqual({
      status: "ok",
      kind: "folder",
      entries: ["only-lib.txt", "x.txt"],
    });
  });

  test("reads from a folder whose custom name holds a /, preferring the longest name that prefixes the path", async () => {
    const libsCore = { name: "libs/core", path: lib.path };
    const libs = { name: "libs", path: app.path };
    expect(await readWorkspaceEntry([libs, libsCore], "libs/core/x.txt")).toEqual({
      status: "ok",
      kind: "file",
      text: "lib x\n",
    });
    expect(await readWorkspaceEntry([libs, libsCore], "libs/docs/x.txt")).toMatchObject({ text: "app docs\n" });
    expect(await readWorkspaceEntry([libs, libsCore], "libs/core")).toMatchObject({ status: "ok", kind: "folder" });
  });

  test("otherwise reads from the first folder that holds the path", async () => {
    expect(await readWorkspaceEntry([app, lib], "docs/x.txt")).toMatchObject({ text: "app docs\n" });
    expect(await readWorkspaceEntry([app, lib], "only-lib.txt")).toMatchObject({ text: "only in lib\n" });
    expect(await readWorkspaceEntry([app, lib], "nowhere.txt")).toEqual({ status: "missing", kind: "file" });
  });

  test("still refuses a path that leaves every folder", async () => {
    expect(await readWorkspaceEntry([app, lib], "lib/../outside.txt")).toEqual({
      status: "outsideWorkspace",
      kind: "file",
    });
  });

  test("takes the first segment as a plain folder when only one folder is open", async () => {
    expect(await readWorkspaceEntry([lib], "lib/x.txt")).toEqual({ status: "missing", kind: "file" });
  });
});

describe("compareNames", () => {
  test("orders by UTF-16 code unit, equal names as equal", () => {
    expect(compareNames("B", "a")).toBe(-1);
    expect(compareNames("a", "B")).toBe(1);
    expect(compareNames("a-b", "a-b")).toBe(0);
  });
});

describe("truncateLines", () => {
  test("keeps a text within the limit whole and counts its lines, a final newline ending the last line", () => {
    expect(truncateLines("a\nb\n", 2)).toEqual({ text: "a\nb\n", lines: 2, omitted: 0 });
    expect(truncateLines("a\nb", 2)).toEqual({ text: "a\nb", lines: 2, omitted: 0 });
    expect(truncateLines("", 2)).toEqual({ text: "", lines: 0, omitted: 0 });
  });

  test("cuts a 2,001-line text to its first 2,000 lines", () => {
    const text = Array.from({ length: 2001 }, (_, index) => `line ${index + 1}`).join("\n");
    const cut = truncateLines(text, 2000);
    expect(cut.lines).toBe(2000);
    expect(cut.omitted).toBe(1);
    expect(cut.text.split("\n")).toHaveLength(2000);
    expect(cut.text.endsWith("line 2000")).toBe(true);
  });
});
