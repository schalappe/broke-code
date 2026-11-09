import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest, Decision } from "./approval";
import { type CommandEnv, commandShell, runCommand, runCommandTool } from "./commands";
import type { ToolCall } from "./tools";
import type { WorkspaceRoot } from "./workspaceFiles";

let base: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "broke-code-commands-")));
});
afterAll(() => rm(base, { recursive: true, force: true }));

const env: CommandEnv = { shell: "/bin/sh", timeoutMs: 10_000 };

function run(command: string, overrides: Partial<CommandEnv> = {}, signal = new AbortController().signal) {
  return runCommand({ command, cwd: base }, { signal }, { ...env, ...overrides });
}

/**
 * Every process of group `pgid` has exited: a signal 0 to the group finds none. [&]: On macOS a group of zombies not
 * yet reaped answers EPERM, so the check polls a moment for ESRCH, well under the 2-second grace a survivor would have.
 */
async function expectGroupGone(pgid: number) {
  expect(pgid).toBeGreaterThan(1);
  let code: unknown;
  for (let tries = 0; tries < 50; tries++) {
    try {
      process.kill(-pgid, 0);
      code = "alive";
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    if (code === "ESRCH") break;
    await Bun.sleep(10);
  }
  expect(code).toBe("ESRCH");
}

async function waitFor(condition: () => Promise<boolean>) {
  for (let tries = 0; tries < 100 && !(await condition()); tries++) await Bun.sleep(10);
}

describe("runCommand", () => {
  test("a command that exits 0 is ok, with its stdout", async () => {
    expect(await run("echo hello")).toEqual({
      status: "ok",
      text: "exit code 0\nstdout:\nhello\nstderr: (empty)",
    });
  });

  test("a command that exits 3 is an error naming its exit code, with its stderr", async () => {
    expect(await run("echo out; echo broken >&2; exit 3")).toEqual({
      status: "error",
      text: "exit code 3\nstdout:\nout\nstderr:\nbroken",
    });
  });

  test("a command killed by a signal says which", async () => {
    expect(await run("kill -KILL $$")).toEqual({
      status: "error",
      text: "killed by SIGKILL\nstdout: (empty)\nstderr: (empty)",
    });
  });

  test("a command reading stdin reads its end at once", async () => {
    const started = Date.now();
    const result = await run("cat; read line; echo read $?");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toEqual({ status: "ok", text: "exit code 0\nstdout:\nread 1\nstderr: (empty)" });
  });

  test("runs in the folder given", async () => {
    expect((await run("pwd")).text).toBe(`exit code 0\nstdout:\n${base}\nstderr: (empty)`);
  });

  test("a pipeline past the timeout stops with its whole group, its output so far kept", async () => {
    const started = Date.now();
    const result = await run("echo $$; sleep 5 | cat", { timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.status).toBe("error");
    const [first, header, pid] = result.text.split("\n");
    expect(first).toBe("stopped after 0.2 seconds");
    expect(header).toBe("stdout:");
    await expectGroupGone(Number(pid));
  });

  test("a group that ignores SIGTERM gets SIGKILL after the grace, and the run settles", async () => {
    const started = Date.now();
    const result = await run("trap '' TERM; echo $$; sleep 5", { timeoutMs: 100, killGraceMs: 200 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.text).toStartWith("stopped after 0.1 seconds\nstdout:\n");
    await expectGroupGone(Number(result.text.split("\n")[2]));
  });

  test("an abort during the run kills the group and gives the stopped error", async () => {
    const abort = new AbortController();
    const pidFile = join(base, "abort.pid");
    const running = run(`echo $$ > '${pidFile}'; sleep 5 | cat`, {}, abort.signal);
    await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).endsWith("\n"));
    abort.abort();
    expect(await running).toEqual({ status: "error", text: "run_command: stopped before it finished." });
    await expectGroupGone(Number(await readFile(pidFile, "utf8")));
  });

  test("an abort after the command ended keeps its result", async () => {
    const abort = new AbortController();
    const result = await run("echo done", {}, abort.signal);
    abort.abort();
    expect(result.status).toBe("ok");
  });

  test.each([
    ["holding the output", "sleep 5 & echo $$"],
    ["its output redirected", "sleep 5 >/dev/null 2>&1 & echo $$"],
  ])("a job left in the background, %s, is stopped once the shell exits", async (_case, command) => {
    const started = Date.now();
    const result = await run(command, { killGraceMs: 200 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.status).toBe("ok");
    expect(result.text).toEndWith("The processes the command left running in the background were stopped.");
    await expectGroupGone(Number(result.text.split("\n")[2]));
  });

  test("a process that ignores SIGTERM and holds no output still gets SIGKILL once the result is in", async () => {
    const command = "echo $$; (trap '' TERM; exec sleep 5 >/dev/null 2>&1) & wait";
    const result = await run(command, { timeoutMs: 100, killGraceMs: 200 });
    expect(result.text).toStartWith("stopped after 0.1 seconds");
    const pgid = Number(result.text.split("\n")[2]);
    await Bun.sleep(400);
    await expectGroupGone(pgid);
  });

  test("a process that left the group while holding the output does not keep the result waiting", async () => {
    const started = Date.now();
    const result = await run("perl -MPOSIX -e 'setsid(); sleep 2' & echo started");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toEqual({ status: "ok", text: "exit code 0\nstdout:\nstarted\nstderr: (empty)" });
  });

  test("keeps the first 2,000 lines of an output, with the notice", async () => {
    const result = await run("seq 1 3000");
    const lines = result.text.split("\n");
    expect(lines.slice(0, 4)).toEqual(["exit code 0", "stdout:", "1", "2"]);
    expect(lines[2001]).toBe("2000");
    expect(lines[2002]).toBe("[truncated: 1000 more lines not shown]");
    expect(lines[2003]).toBe("stderr: (empty)");
  });

  test("keeps the first MiB of an output, cut between characters, with the notice", async () => {
    // [>]: One byte, then 600,000 two-byte characters on one line, then a second line: the cut lands inside a
    // character of the first.
    const result = await run(`printf x; printf 'é%.0s' $(seq 1 600000); printf '\\nend\\n'`);
    const stdout = result.text.split("\n")[2]!;
    expect(stdout).toBe(`x${"é".repeat(524_287)}`);
    expect(result.text).toContain("\n[truncated: 2 more lines not shown]\nstderr: (empty)");
  });

  test("a shell that cannot start is an error naming it", async () => {
    expect(await run("true", { shell: join(base, "no-shell") })).toEqual({
      status: "error",
      text: `run_command: the command could not start with the shell ${join(base, "no-shell")} (ENOENT).`,
    });
  });
});

describe("runCommandTool", () => {
  /** A run context that answers each approval request with `decision` and records it. */
  function deciding(decision: Decision) {
    const requests: ApprovalRequest[] = [];
    const context = {
      signal: new AbortController().signal,
      requestApproval: async (request: ApprovalRequest) => {
        requests.push(request);
        return decision;
      },
    };
    return { context, requests };
  }

  function roots(): WorkspaceRoot[] {
    return [
      { name: "app", path: join(base, "app") },
      { name: "lib", path: join(base, "lib") },
    ];
  }

  beforeAll(async () => {
    await mkdir(join(base, "app"), { recursive: true });
    await mkdir(join(base, "lib", "sub"), { recursive: true });
    await writeFile(join(base, "app", "file.txt"), "text\n");
  });

  const call = (command: string, cwd?: string): ToolCall => ({
    name: "run_command",
    args: cwd === undefined ? { command } : { command, cwd },
  });

  test("asks to run the whole command, then runs it once in the first workspace folder", async () => {
    const { context, requests } = deciding({ kind: "accept" });
    const command = "pwd\necho ran >> ran.txt";
    const result = await runCommandTool(call(command), roots(), context, env);
    expect(requests).toEqual([{ kind: "command", tool: "run_command", summary: command }]);
    expect(result).toEqual({ status: "ok", text: `exit code 0\nstdout:\n${join(base, "app")}\nstderr: (empty)` });
    expect(await readFile(join(base, "app", "ran.txt"), "utf8")).toBe("ran\n");
  });

  test("runs in the folder cwd names, a multi-root folder name first", async () => {
    const { context } = deciding({ kind: "accept" });
    const result = await runCommandTool(call("pwd", "lib/sub"), roots(), context, env);
    expect(result.text).toBe(`exit code 0\nstdout:\n${join(base, "lib", "sub")}\nstderr: (empty)`);
  });

  test("a rejection runs nothing and gives the user's reason", async () => {
    const { context } = deciding({ kind: "reject", reason: "Not on this branch." });
    const result = await runCommandTool(call("echo no > rejected.txt"), roots(), context, env);
    expect(result).toEqual({ status: "error", text: "The user rejected this command.\nNot on this branch." });
    expect(await exists(join(base, "app", "rejected.txt"))).toBe(false);
  });

  test("a cancelled request runs nothing and gives the stopped error", async () => {
    const { context } = deciding({ kind: "cancel" });
    const result = await runCommandTool(call("echo no > cancelled.txt"), roots(), context, env);
    expect(result).toEqual({ status: "error", text: "run_command: stopped before it finished." });
    expect(await exists(join(base, "app", "cancelled.txt"))).toBe(false);
  });

  test("a request that fails runs nothing and says why", async () => {
    const context = {
      signal: new AbortController().signal,
      requestApproval: async () => {
        throw new Error("another approval request is still open");
      },
    };
    const result = await runCommandTool(call("echo no > failed.txt"), roots(), context, env);
    expect(result).toEqual({
      status: "error",
      text: "run_command: the command could not be shown for approval (Error: another approval request is still open). Nothing ran.",
    });
    expect(await exists(join(base, "app", "failed.txt"))).toBe(false);
  });

  test.each([
    ["no workspace folder", [], call("true"), "run_command: no workspace folder is open."],
    ["an empty command", undefined, call("  \n "), "run_command: the command is empty."],
    [
      "a cwd outside the workspace",
      undefined,
      call("true", "../.."),
      "run_command: ../..: the path is outside the workspace folders.",
    ],
    [
      "a missing cwd",
      undefined,
      call("true", "app/nowhere"),
      "run_command: app/nowhere: no such file or folder in the workspace.",
    ],
    [
      "a cwd that is a file",
      undefined,
      call("true", "app/file.txt"),
      "run_command: app/file.txt: the path is not a folder.",
    ],
  ])("refuses %s before asking", async (_case, given, refusedCall, text) => {
    const { context, requests } = deciding({ kind: "accept" });
    expect(await runCommandTool(refusedCall, given ?? roots(), context, env)).toEqual({ status: "error", text });
    expect(requests).toEqual([]);
  });
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("commandShell", () => {
  test("is VS Code's terminal shell, else $SHELL, else /bin/sh", () => {
    expect(commandShell("/opt/homebrew/bin/fish", "/bin/zsh")).toBe("/opt/homebrew/bin/fish");
    expect(commandShell("", "/bin/zsh")).toBe("/bin/zsh");
    expect(commandShell(undefined, undefined)).toBe("/bin/sh");
    expect(commandShell("", "")).toBe("/bin/sh");
  });
});
