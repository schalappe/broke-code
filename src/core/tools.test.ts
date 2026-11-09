import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ_TOOLS, type ReadToolEnv, ripgrepCandidates, runReadTool, type ToolCall, type ToolResult } from "./tools";
import type { WorkspaceRoot } from "./workspaceFiles";

// [>]: `tmpdir()` sits under /var, a symlink to /private/var on macOS: every root here has a real path that differs
// from its path, as a workspace opened through a symlink would.
let base: string;
let app: WorkspaceRoot;
let lib: WorkspaceRoot;
const env: ReadToolEnv = { ripgrepCandidates: ripgrepCandidates(undefined, process.env.PATH) };

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "broke-code-tools-"));
  app = { name: "app", path: join(base, "app") };
  lib = { name: "lib", path: join(base, "lib") };
  await mkdir(join(app.path, "src", "core"), { recursive: true });
  await mkdir(lib.path);
  await writeFile(join(base, "outside.txt"), "secret needle\n");
  await writeFile(join(app.path, "ten.txt"), numberedLines(10));
  await writeFile(join(app.path, "long.txt"), numberedLines(3000));
  await writeFile(join(app.path, "src", "a.ts"), "const needle = 1;\nexport {};\n");
  await writeFile(join(app.path, "src", "b.ts"), "export {};\n// needle here\n");
  await writeFile(join(lib.path, "x.ts"), "lib needle\n");
  await symlink(join(base, "outside.txt"), join(app.path, "link-out.txt"));
  await symlink(base, join(app.path, "link-out-dir"));
});
afterAll(async () => {
  // [>]: The file exists only once its test ran; without it there is nothing to unlock.
  await chmod(join(base, "partial", "locked.ts"), 0o600).catch(() => {});
  await rm(base, { recursive: true, force: true });
});

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}\n`).join("");
}

function run(name: string, args: Record<string, string>, roots = [app], toolEnv = env): Promise<ToolResult> {
  return runReadTool({ name, args }, roots, toolEnv, new AbortController().signal);
}

/** The result lines, sorted: ripgrep searches files in parallel, so their order varies from run to run. */
function sortedLines(result: ToolResult): string[] {
  return result.text.split("\n").sort();
}

/**
 * An executable shell script standing in for ripgrep, for runs that must last. It is run once with `warm` first: macOS
 * checks a new executable on its first run, which can take longer than a short test timeout.
 */
async function fakeRipgrep(name: string, body: string): Promise<string> {
  const path = join(base, name);
  await writeFile(path, `#!/bin/sh\n[ "$1" = warm ] && exit 0\n${body}\n`);
  await chmod(path, 0o755);
  spawnSync(path, ["warm"]);
  return path;
}

async function mkdirp(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

describe("read_file", () => {
  test("returns a 10-line file as a mention attaches it, with the (file, 10 lines) header", async () => {
    expect(await run("read_file", { path: "ten.txt" })).toEqual({
      status: "ok",
      text: `@ten.txt (file, 10 lines)\n\`\`\`\n${numberedLines(10)}\`\`\``,
    });
  });

  test("cuts a 3,000-line file to its first 2,000 lines with the mention notice", async () => {
    const result = await run("read_file", { path: "long.txt" });
    expect(result.status).toBe("ok");
    expect(result.text.startsWith("@long.txt (file, 2000 lines, truncated)\n```\nline 1\n")).toBe(true);
    expect(result.text).toContain("\nline 2000\n```\n[truncated: 1000 more lines not shown]");
    expect(result.text).not.toContain("line 2001");
  });

  test("refuses a folder, naming list_files", async () => {
    const result = await run("read_file", { path: "src" });
    expect(result.status).toBe("error");
    expect(result.text).toContain("list_files");
  });

  test("reports a missing file with the mention wording", async () => {
    expect(await run("read_file", { path: "nope.txt" })).toEqual({
      status: "error",
      text: "read_file: nope.txt: no such file or folder in the workspace.",
    });
  });

  test("refuses a path outside by ../, by absolute path, and through a committed symlink, reading nothing", async () => {
    for (const path of ["../outside.txt", join(base, "outside.txt"), "link-out.txt", "link-out-dir/outside.txt"]) {
      const result = await run("read_file", { path });
      expect(result).toEqual({
        status: "error",
        text: `read_file: ${path}: the path is outside the workspace folders.`,
      });
      expect(result.text).not.toContain("secret");
    }
  });

  test("reads from the folder named by the first segment in a multi-root workspace", async () => {
    const result = await run("read_file", { path: "lib/x.ts" }, [app, lib]);
    expect(result).toEqual({ status: "ok", text: "@lib/x.ts (file, 1 line)\n```\nlib needle\n```" });
  });
});

describe("list_files", () => {
  test("lists the workspace folder one level deep when the path is left out, empty, or .", async () => {
    const expected: ToolResult = {
      status: "ok",
      text: "@. (folder, 5 entries)\n```\nlink-out-dir/\nlink-out.txt\nlong.txt\nsrc/\nten.txt\n```",
    };
    // [>]: `link-out-dir/` lists as a folder: a listing shows names only, never the outside content.
    expect(await run("list_files", {})).toEqual(expected);
    expect(await run("list_files", { path: "" })).toEqual(expected);
    expect(await run("list_files", { path: "." })).toEqual(expected);
  });

  test("lists a subfolder's direct children, folders suffixed with /", async () => {
    expect(await run("list_files", { path: "src" })).toEqual({
      status: "ok",
      text: "@src (folder, 3 entries)\n```\na.ts\nb.ts\ncore/\n```",
    });
  });

  test("refuses a file, naming read_file", async () => {
    const result = await run("list_files", { path: "ten.txt" });
    expect(result.status).toBe("error");
    expect(result.text).toContain("read_file");
  });

  test("refuses a folder outside the workspace", async () => {
    expect(await run("list_files", { path: "link-out-dir" })).toEqual({
      status: "error",
      text: "list_files: link-out-dir: the path is outside the workspace folders.",
    });
  });

  test("lists the folder names in a multi-root workspace when the path is left out or .", async () => {
    const expected: ToolResult = { status: "ok", text: "@. (folder, 2 entries)\n```\napp/\nlib/\n```" };
    expect(await run("list_files", {}, [app, lib])).toEqual(expected);
    expect(await run("list_files", { path: "." }, [app, lib])).toEqual(expected);
  });

  test("sorts the folder names by code unit, before the / suffix, as a folder listing does", async () => {
    const roots = ["b", "a-b", "a", "B"].map((name) => ({ name, path: join(base, name) }));
    expect(await run("list_files", {}, roots)).toEqual({
      status: "ok",
      text: "@. (folder, 4 entries)\n```\nB/\na/\na-b/\nb/\n```",
    });
  });

  test("lists a folder of a multi-root workspace by its name", async () => {
    expect(await run("list_files", { path: "lib" }, [app, lib])).toEqual({
      status: "ok",
      text: "@lib (folder, 1 entry)\n```\nx.ts\n```",
    });
  });
});

describe("search", () => {
  test("finds a pattern in two files as path:line:text lines, never through a symlink out", async () => {
    const result = await run("search", { pattern: "needle" });
    expect(result.status).toBe("ok");
    expect(sortedLines(result)).toEqual(["src/a.ts:1:const needle = 1;", "src/b.ts:2:// needle here"]);
  });

  test("says when nothing matches, and what ripgrep skips", async () => {
    const result = await run("search", { pattern: "absent[0-9]{9}" });
    expect(result.status).toBe("ok");
    expect(result.text).toContain("No match");
    expect(result.text).toContain("hidden files");
    expect(result.text).toContain(".gitignore");
    expect(result.text).toContain("symlinks");
  });

  test("takes a pattern starting with - as a pattern, never as an option", async () => {
    expect(await run("search", { pattern: "--files" })).toMatchObject({
      status: "ok",
      text: expect.stringContaining("No match"),
    });
  });

  test("returns ripgrep's message as an error for an invalid regular expression", async () => {
    const result = await run("search", { pattern: "(" });
    expect(result.status).toBe("error");
    expect(result.text).toStartWith("search: ripgrep failed:\nrg: regex parse error");
  });

  test("refuses an empty pattern, which would match every line", async () => {
    expect(await run("search", { pattern: "" })).toEqual({ status: "error", text: "search: the pattern is empty." });
  });

  test("reports another exit code with ripgrep's message", async () => {
    const odd = await fakeRipgrep("odd-rg", "echo 'odd failure' >&2\nexit 3");
    expect(await run("search", { pattern: "x" }, [app], { ripgrepCandidates: [odd] })).toEqual({
      status: "error",
      text: "search: ripgrep failed (exit code 3):\nodd failure",
    });
  });

  test("keeps the first 4,096 characters of ripgrep's messages and marks the cut", async () => {
    const loud = await fakeRipgrep("loud-rg", "head -c 5000 /dev/zero | tr '\\0' e >&2\nexit 2");
    expect(await run("search", { pattern: "x" }, [app], { ripgrepCandidates: [loud] })).toEqual({
      status: "error",
      text: `search: ripgrep failed:\n${"e".repeat(4096)}\n…`,
    });
  });

  test("reports a path it may not resolve as unreadable, with the error code", async () => {
    const guarded: WorkspaceRoot = { name: "guarded", path: join(base, "guarded") };
    await mkdir(join(guarded.path, "sealed"), { recursive: true });
    await chmod(join(guarded.path, "sealed"), 0o000);
    try {
      expect(await run("search", { pattern: "x", path: "sealed/x" }, [guarded])).toEqual({
        status: "error",
        text: "search: sealed/x: the path could not be read (EACCES).",
      });
    } finally {
      await chmod(join(guarded.path, "sealed"), 0o700);
    }
  });

  test("says when no workspace folder can be resolved", async () => {
    const gone: WorkspaceRoot = { name: "gone", path: join(base, "gone") };
    expect(await run("search", { pattern: "x" }, [gone])).toEqual({
      status: "error",
      text: "search: no workspace folder can be searched.",
    });
  });

  test("searches only the given file or folder, paths shown from the workspace folder", async () => {
    expect(await run("search", { pattern: "needle", path: "src/b.ts" })).toEqual({
      status: "ok",
      text: "src/b.ts:2:// needle here",
    });
    expect(sortedLines(await run("search", { pattern: "needle", path: "src" }))).toEqual([
      "src/a.ts:1:const needle = 1;",
      "src/b.ts:2:// needle here",
    ]);
  });

  test("refuses a path outside by ../, by absolute path, and through a committed symlink, searching nothing", async () => {
    for (const path of ["../outside.txt", join(base, "outside.txt"), "link-out.txt", "link-out-dir"]) {
      expect(await run("search", { pattern: "secret", path })).toEqual({
        status: "error",
        text: `search: ${path}: the path is outside the workspace folders.`,
      });
    }
  });

  test("reports a missing path with the mention wording", async () => {
    expect(await run("search", { pattern: "needle", path: "nope" })).toEqual({
      status: "error",
      text: "search: nope: no such file or folder in the workspace.",
    });
  });

  test("cuts output over 2,000 lines with the mention notice", async () => {
    await mkdir(join(app.path, "many"));
    await writeFile(join(app.path, "many", "hits.txt"), "hit\n".repeat(2500));
    const result = await run("search", { pattern: "hit", path: "many" });
    const lines = result.text.split("\n");
    expect(result.status).toBe("ok");
    expect(lines).toHaveLength(2001);
    expect(lines[0]).toBe("many/hits.txt:1:hit");
    expect(lines[1999]).toBe("many/hits.txt:2000:hit");
    expect(lines[2000]).toBe("[truncated: 500 more lines not shown]");
  });

  test("returns the matches of a run that could not read every file, with ripgrep's message, as a partial success", async () => {
    // [>]: A folder of its own, so the unreadable file never shows in the other searches.
    const partial: WorkspaceRoot = { name: "partial", path: join(base, "partial") };
    await mkdir(partial.path);
    await writeFile(join(partial.path, "open.ts"), "partial match\n");
    await writeFile(join(partial.path, "locked.ts"), "partial match\n");
    await chmod(join(partial.path, "locked.ts"), 0o000);
    const result = await run("search", { pattern: "partial match" }, [partial]);
    expect(result.status).toBe("ok");
    expect(result.text.startsWith("open.ts:1:partial match\n")).toBe(true);
    expect(result.text).toContain("rg: locked.ts: Permission denied");
    expect(result.text).not.toContain(base);
  });

  test("searches every folder of a multi-root workspace, paths prefixed with the folder name", async () => {
    const result = await run("search", { pattern: "needle" }, [app, lib]);
    expect(sortedLines(result)).toEqual([
      "app/src/a.ts:1:const needle = 1;",
      "app/src/b.ts:2:// needle here",
      "lib/x.ts:1:lib needle",
    ]);
    expect(await run("search", { pattern: "needle", path: "lib" }, [app, lib])).toEqual({
      status: "ok",
      text: "lib/x.ts:1:lib needle",
    });
  });

  test("searches a folder nested in another once, shown under its own name", async () => {
    const nested: WorkspaceRoot = { name: "core", path: join(app.path, "src") };
    expect(sortedLines(await run("search", { pattern: "needle" }, [app, nested, app]))).toEqual([
      "core/a.ts:1:const needle = 1;",
      "core/b.ts:2:// needle here",
    ]);
  });

  test("searches a nested root the parent's walk would skip, each file once, other same-named folders still", async () => {
    const nest = join(base, "nest");
    await writeFile(join(await mkdirp(nest), "top.ts"), "needle top\n");
    await writeFile(join(await mkdirp(join(nest, ".hidden")), "x.ts"), "needle x\n");
    await writeFile(join(await mkdirp(join(nest, "plain")), "y.ts"), "needle y\n");
    await writeFile(join(await mkdirp(join(base, "elsewhere", "plain")), "z.ts"), "needle z\n");
    const roots = [
      { name: "nest", path: nest },
      { name: "hid", path: join(nest, ".hidden") },
      { name: "plain", path: join(nest, "plain") },
      { name: "elsewhere", path: join(base, "elsewhere") },
    ];
    expect(sortedLines(await run("search", { pattern: "needle" }, roots))).toEqual([
      "elsewhere/plain/z.ts:1:needle z",
      "hid/x.ts:1:needle x",
      "nest/top.ts:1:needle top",
      "plain/y.ts:1:needle y",
    ]);
  });

  test("excludes a nested root whose real path holds glob characters", async () => {
    const weird = join(base, "we[i]rd*{x}?");
    await writeFile(join(await mkdirp(weird), "w.ts"), "needle w\n");
    await writeFile(join(await mkdirp(join(weird, "in")), "q.ts"), "needle q\n");
    const roots = [
      { name: "weird", path: weird },
      { name: "in", path: join(weird, "in") },
    ];
    expect(sortedLines(await run("search", { pattern: "needle" }, roots))).toEqual([
      "in/q.ts:1:needle q",
      "weird/w.ts:1:needle w",
    ]);
  });

  test("stops at the timeout with the output so far and a note", async () => {
    const slow = await fakeRipgrep("slow-rg", "echo 'early.ts:1:early'\nexec sleep 30");
    const result = await run("search", { pattern: "x" }, [app], { ripgrepCandidates: [slow], searchTimeoutMs: 500 });
    expect(result.status).toBe("ok");
    expect(result.text.startsWith("early.ts:1:early\n")).toBe(true);
    expect(result.text).toContain("stopped after 0.5 seconds");
  });

  test("ends as stopped when the signal aborts, the process gone", async () => {
    const pidFile = join(base, "rg.pid");
    const slow = await fakeRipgrep("pid-rg", `echo $$ > '${pidFile}'\nexec sleep 30`);
    const controller = new AbortController();
    const running = runReadTool(
      { name: "search", args: { pattern: "x" } },
      [app],
      { ripgrepCandidates: [slow] },
      controller.signal,
    );
    await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).endsWith("\n"));
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    controller.abort();
    expect(await running).toEqual({ status: "error", text: "search: stopped before it finished." });
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  test("returns stopped without running anything when the signal is already aborted", async () => {
    const marker = join(base, "ran");
    const tool = await fakeRipgrep("marker-rg", `touch '${marker}'`);
    const controller = new AbortController();
    controller.abort();
    const result = await runReadTool(
      { name: "search", args: { pattern: "x" } },
      [app],
      { ripgrepCandidates: [tool] },
      controller.signal,
    );
    expect(result).toEqual({ status: "error", text: "search: stopped before it finished." });
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("names every path tried when no ripgrep is found, while read_file still works", async () => {
    const plain = join(base, "outside.txt");
    const none: ReadToolEnv = { ripgrepCandidates: ["/nowhere/rg", plain, base] };
    const result = await run("search", { pattern: "needle" }, [app], none);
    expect(result.status).toBe("error");
    for (const tried of none.ripgrepCandidates) expect(result.text).toContain(tried);
    expect((await run("read_file", { path: "ten.txt" }, [app], none)).status).toBe("ok");
  });

  test("returns an error, never a rejection, when the binary found cannot start", async () => {
    const broken = join(base, "broken-rg");
    await writeFile(broken, "#!/nowhere/interpreter\n");
    await chmod(broken, 0o755);
    const result = await run("search", { pattern: "needle" }, [app], { ripgrepCandidates: [broken] });
    expect(result).toEqual({ status: "error", text: "search: ripgrep could not run (ENOENT)." });
  });

  test("returns an error, never a rejection, when spawn refuses the arguments", async () => {
    expect(await run("search", { pattern: "a\0b" })).toEqual({
      status: "error",
      text: "search: ripgrep could not run (ERR_INVALID_ARG_VALUE).",
    });
  });

  test("uses the first candidate that is an executable file", async () => {
    const result = await run("search", { pattern: "needle", path: "src/a.ts" }, [app], {
      ripgrepCandidates: ["/nowhere/rg", join(base, "outside.txt"), base, ...env.ripgrepCandidates],
    });
    expect(result).toEqual({ status: "ok", text: "src/a.ts:1:const needle = 1;" });
  });
});

describe("ripgrepCandidates", () => {
  test("lists the VSCodium and VS Code binaries under the app root, then rg in each PATH folder", () => {
    expect(ripgrepCandidates("/App", "/opt/homebrew/bin:/usr/bin", "arm64")).toEqual([
      "/App/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/darwin-arm64/rg",
      "/App/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg",
      "/App/node_modules/@vscode/ripgrep/bin/rg",
      "/opt/homebrew/bin/rg",
      "/usr/bin/rg",
    ]);
    expect(ripgrepCandidates("/App", undefined, "x64")[0]).toBe(
      "/App/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/darwin-x64/rg",
    );
  });

  test("skips empty and relative PATH entries, which would resolve against an unknown folder", () => {
    expect(ripgrepCandidates(undefined, ":bin:/usr/bin:./tools:")).toEqual(["/usr/bin/rg"]);
  });
});

describe("runReadTool", () => {
  test("ends read_file and list_files as stopped when the signal aborts during the read, never a late ok", async () => {
    const calls: ToolCall[] = [
      { name: "read_file", args: { path: "ten.txt" } },
      { name: "list_files", args: {} },
    ];
    for (const call of calls) {
      const controller = new AbortController();
      const running = runReadTool(call, [app], env, controller.signal);
      controller.abort();
      expect(await running).toEqual({ status: "error", text: `${call.name}: stopped before it finished.` });
    }
  });

  test("shows a model-given path in an error by its first line, cut at 200 characters", async () => {
    for (const name of ["read_file", "list_files", "search"]) {
      const result = await run(name, { pattern: "x", path: "x\n".repeat(3000) });
      expect(result.status).toBe("error");
      expect(result.text).toStartWith(`${name}: x…: `);
      expect(result.text).not.toContain("\n");
    }
    expect(await run("read_file", { path: "a/".repeat(150) })).toEqual({
      status: "error",
      text: `read_file: ${"a/".repeat(100)}…: no such file or folder in the workspace.`,
    });
  });

  test("returns an unexpected failure as a bounded error, never a rejection", async () => {
    const throwing = (thrown: unknown) => ({
      name: "read_file",
      args: {
        get path(): string {
          throw thrown;
        },
      },
    });
    const signal = new AbortController().signal;
    expect(await runReadTool(throwing(new Error("boom\n".repeat(3000))), [app], env, signal)).toEqual({
      status: "error",
      text: "read_file: boom…",
    });
    expect(await runReadTool(throwing("plain"), [app], env, signal)).toEqual({
      status: "error",
      text: "read_file: plain",
    });
  });

  test("says no workspace folder is open, for every read tool", async () => {
    for (const [name, args] of [
      ["read_file", { path: "ten.txt" }],
      ["list_files", {}],
      ["list_files", { path: "src" }],
      ["search", { pattern: "x" }],
      ["search", { pattern: "x", path: "src" }],
    ] as const) {
      expect(await run(name, args, [])).toEqual({ status: "error", text: `${name}: no workspace folder is open.` });
    }
  });

  test("returns an error for an unknown tool", async () => {
    expect(await run("write_file", { path: "ten.txt" })).toEqual({
      status: "error",
      text: "write_file is not a read tool.",
    });
  });

  test("lists the three read tools, path optional for list_files and search", () => {
    expect(READ_TOOLS.map((tool) => [tool.name, tool.args.map((arg) => [arg.name, arg.required])])).toEqual([
      ["read_file", [["path", true]]],
      ["list_files", [["path", false]]],
      [
        "search",
        [
          ["pattern", true],
          ["path", false],
        ],
      ],
    ]);
  });
});
