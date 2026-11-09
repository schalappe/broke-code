import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstructionFiles } from "./instructions";

let base: string;
let home: string;
let workspace: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "broke-code-instructions-"));
  home = join(base, "home");
  workspace = join(base, "workspace");
  await mkdir(join(home, ".agents"), { recursive: true });
  await mkdir(workspace);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Run `work` with `console.error` silenced; returns what it logged. */
async function quietly<T>(work: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await work();
    return { result, logged: logged.mock.calls };
  } finally {
    logged.mockRestore();
  }
}

describe("readInstructionFiles", () => {
  test("reads ~/.agents/AGENTS.md, then the workspace AGENTS.md, and never a CLAUDE.md", async () => {
    await writeFile(join(home, ".agents", "AGENTS.md"), "Home rules.\n");
    await writeFile(join(workspace, "AGENTS.md"), "Workspace rules.\n");
    // [>]: Unreadable: opening any of them would fail and be logged.
    for (const path of [join(home, ".agents", "CLAUDE.md"), join(home, "CLAUDE.md"), join(workspace, "CLAUDE.md")]) {
      await writeFile(path, "Claude rules.\n");
      await chmod(path, 0o000);
    }

    const { result, logged } = await quietly(() =>
      readInstructionFiles(home, [{ name: "workspace", path: workspace }]),
    );
    expect(result).toEqual([
      { label: "~/.agents/AGENTS.md", text: "Home rules.\n" },
      { label: "AGENTS.md", text: "Workspace rules.\n" },
    ]);
    expect(logged).toEqual([]);
  });

  test("leaves out a missing file silently", async () => {
    const { result, logged } = await quietly(() =>
      readInstructionFiles(home, [{ name: "workspace", path: workspace }]),
    );
    expect(result).toEqual([]);
    expect(logged).toEqual([]);
  });

  test("names each workspace folder's file by its folder in a multi-root workspace", async () => {
    const other = join(base, "other");
    await mkdir(other);
    await writeFile(join(workspace, "AGENTS.md"), "One.");
    await writeFile(join(other, "AGENTS.md"), "Two.");
    const roots = [
      { name: "app", path: workspace },
      { name: "lib", path: other },
    ];
    expect(await readInstructionFiles(home, roots)).toEqual([
      { label: "app/AGENTS.md", text: "One." },
      { label: "lib/AGENTS.md", text: "Two." },
    ]);
  });

  test("accepts a workspace AGENTS.md linked to a file in another open workspace folder", async () => {
    const policy = join(base, "policy");
    await mkdir(policy);
    await writeFile(join(policy, "rules.md"), "Shared rules.");
    await symlink(join(policy, "rules.md"), join(workspace, "AGENTS.md"));
    const roots = [
      { name: "app", path: workspace },
      { name: "policy", path: policy },
    ];
    const { result, logged } = await quietly(() => readInstructionFiles(home, roots));
    expect(result).toEqual([{ label: "app/AGENTS.md", text: "Shared rules." }]);
    expect(logged).toEqual([]);
  });

  test("follows a symlinked home file, as dotfiles often are", async () => {
    const dotfiles = join(base, "dotfiles");
    await mkdir(dotfiles);
    await writeFile(join(dotfiles, "AGENTS.md"), "Linked.");
    await symlink(join(dotfiles, "AGENTS.md"), join(home, ".agents", "AGENTS.md"));
    expect(await readInstructionFiles(home, [])).toEqual([{ label: "~/.agents/AGENTS.md", text: "Linked." }]);
  });

  test("cuts a file over 2,000 lines with the truncation notice", async () => {
    const lines = Array.from({ length: 2003 }, (_, index) => `line ${index + 1}`);
    await writeFile(join(workspace, "AGENTS.md"), `${lines.join("\n")}\n`);
    const [file] = await readInstructionFiles(home, [{ name: "workspace", path: workspace }]);
    expect(file?.text).toBe(`${lines.slice(0, 2000).join("\n")}\n[truncated: 3 more lines not shown]`);
  });

  test("logs and leaves out a file that is unreadable, binary, over 1 MiB, or a symlink out of the workspace", async () => {
    const outside = join(base, "outside.md");
    await writeFile(outside, "Outside.");
    await symlink(outside, join(workspace, "AGENTS.md"));
    await writeFile(join(home, ".agents", "AGENTS.md"), "x".repeat(1024 * 1024 + 1));
    const binary = join(base, "binary");
    await mkdir(binary);
    await writeFile(join(binary, "AGENTS.md"), "a\0b");
    const locked = join(base, "locked");
    await mkdir(locked);
    await writeFile(join(locked, "AGENTS.md"), "Locked.");
    await chmod(join(locked, "AGENTS.md"), 0o000);
    const roots = [
      { name: "workspace", path: workspace },
      { name: "binary", path: binary },
      { name: "locked", path: locked },
    ];

    const { result, logged } = await quietly(() => readInstructionFiles(home, roots));
    expect(result).toEqual([]);
    const text = logged.map((call) => call.join(" "));
    expect(text).toHaveLength(4);
    expect(text[0]).toContain("~/.agents/AGENTS.md (tooLarge)");
    expect(text[1]).toContain("workspace/AGENTS.md (outsideWorkspace)");
    expect(text[2]).toContain("binary/AGENTS.md (binary)");
    expect(text[3]).toContain("locked/AGENTS.md (unreadable: EACCES)");
  });
});
