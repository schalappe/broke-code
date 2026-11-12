import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest, Decision } from "./approval";
import {
  type CommandEnv,
  commandShell,
  type KillFunction,
  killRunningCommands,
  ownCommandGroup,
  runCommand,
  runCommandTool,
} from "./commands";
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

async function waitFor(condition: () => Promise<boolean> | boolean) {
  for (let tries = 0; tries < 100 && !(await condition()); tries++) await Bun.sleep(10);
}

/** True while process `pid` exists, a zombie not yet reaped included. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== "ESRCH";
  }
}

const MIB = 1024 * 1024;

/**
 * The signals `body` sends through `process.kill`, none of them delivered: each succeeds, or throws an error with
 * `failWith` as its code. A run captures its own kill when it starts, so only calls made now are seen.
 */
function spyKill(body: () => void, failWith?: string): [number, NodeJS.Signals | number | undefined][] {
  const sent: [number, NodeJS.Signals | number | undefined][] = [];
  const original = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    sent.push([pid, signal]);
    if (failWith !== undefined) throw Object.assign(new Error(failWith), { code: failWith });
    return true;
  }) as typeof process.kill;
  try {
    body();
  } finally {
    process.kill = original;
  }
  return sent;
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

  test("without an environment, the command sees the host's", async () => {
    process.env.BROKE_CODE_HOST_PROBE = "host-value";
    try {
      expect((await run('echo "$BROKE_CODE_HOST_PROBE"')).text).toBe(
        "exit code 0\nstdout:\nhost-value\nstderr: (empty)",
      );
    } finally {
      delete process.env.BROKE_CODE_HOST_PROBE;
    }
  });

  test("an environment given is the command's whole environment", async () => {
    process.env.BROKE_CODE_HOST_PROBE = "host-value";
    try {
      const result = await run("env | sort", { environment: { PATH: "/usr/bin:/bin", ONLY: "this" } });
      const names = (result.text.split("\nstdout:\n")[1] ?? "")
        .split("\nstderr:")[0]
        ?.split("\n")
        .map((line) => line.split("=")[0]);
      expect(names).toEqual(["ONLY", "PATH", "PWD", "SHLVL", "_"]);
    } finally {
      delete process.env.BROKE_CODE_HOST_PROBE;
    }
  });

  test("a launcher runs before the shell, which keeps its name and the process group", async () => {
    const result = await run('echo "$0"; [ "$$" = "$(ps -o pgid= -p $$ | tr -d " ")" ] && echo leads', {
      launcher: ["/usr/bin/env", "LAUNCHED=yes"],
    });
    expect(result.text).toBe("exit code 0\nstdout:\n/bin/sh\nleads\nstderr: (empty)");
    expect((await run('echo "$LAUNCHED"', { launcher: ["/usr/bin/env", "LAUNCHED=yes"] })).text).toBe(
      "exit code 0\nstdout:\nyes\nstderr: (empty)",
    );
  });

  test("a launcher that cannot start is an error naming it", async () => {
    expect(await run("true", { launcher: [join(base, "no-launcher"), "-x"] })).toEqual({
      status: "error",
      text: `run_command: the command could not start with ${join(base, "no-launcher")} (ENOENT).`,
    });
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

  test("a process that ignores SIGTERM and holds no output gets SIGKILL before the result is in", async () => {
    const command = "echo $$; (trap '' TERM; exec sleep 5 >/dev/null 2>&1) & wait";
    const started = Date.now();
    const result = await run(command, { timeoutMs: 100, killGraceMs: 200 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(result.text).toStartWith("stopped after 0.1 seconds");
    await expectGroupGone(Number(result.text.split("\n")[2]));
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

  test.each([
    ["three-byte", "\\xe2\\x82\\xac", "€", [0, 2]],
    ["four-byte", "\\xf0\\x9f\\x98\\x80", "😀", [1, 2, 3]],
  ])(
    "keeps the first MiB cut inside a %s character, at each byte of it, as whole characters",
    async (_case, bytes, character, prefixes) => {
      const width = Buffer.byteLength(character);
      for (const prefix of prefixes) {
        // [>]: `prefix` ASCII bytes shift where the 1 MiB cut lands inside a character: 1 MiB - prefix is not a multiple of
        // the character's width for any prefix listed.
        expect((MIB - prefix) % width).not.toBe(0);
        const result = await run(`perl -e 'print "x" x ${prefix}, "${bytes}" x 400000, "\\n"'`);
        const stdout = result.text.split("\n")[2]!;
        expect(stdout).toBe(`${"x".repeat(prefix)}${character.repeat(Math.floor((MIB - prefix) / width))}`);
      }
    },
  );

  test("output a background job writes within the drain is kept, and the job ends on its own", async () => {
    const result = await run("(sleep 0.4; echo late) & echo early", { drainMs: 1500 });
    expect(result).toEqual({ status: "ok", text: "exit code 0\nstdout:\nearly\nlate\nstderr: (empty)" });
  });

  test("a stop after the shell exited, while the output drains, ends the wait at once", async () => {
    const abort = new AbortController();
    const pidFile = join(base, "drain.pid");
    const running = run(`sleep 5 & echo $$ > '${pidFile}'`, { drainMs: 5000 }, abort.signal);
    await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).endsWith("\n"));
    const shell = Number(await readFile(pidFile, "utf8"));
    await waitFor(async () => !processExists(shell));
    const stopped = Date.now();
    abort.abort();
    const result = await running;
    expect(Date.now() - stopped).toBeLessThan(1500);
    expect(result.text).toEndWith("The processes the command left running in the background were stopped.");
    await expectGroupGone(shell);
  });

  test("a leftover process that ignores SIGTERM gets SIGKILL at the grace, and the result says so then", async () => {
    const started = Date.now();
    const result = await run("echo $$; (trap '' TERM; exec sleep 5 >/dev/null 2>&1) & sleep 0.05", {
      killGraceMs: 300,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(result.status).toBe("ok");
    expect(result.text).toEndWith(
      "The processes the command left running in the background did not stop on SIGTERM; they were sent SIGKILL after 0.3 seconds.",
    );
    await expectGroupGone(Number(result.text.split("\n")[2]));
  });

  test("a signal that cannot be sent is an error naming it, its message kept when it has no code", async () => {
    const kill = (pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === "SIGTERM") throw new Error("signals are off");
      process.kill(pid, signal);
    };
    const result = await run("echo $$; sleep 5", { timeoutMs: 100, killGraceMs: 200, kill });
    expect(result.status).toBe("error");
    expect(result.text).toStartWith("stopped after 0.1 seconds\n");
    expect(result.text).toEndWith("\n\nSending SIGTERM to the command's processes failed (signals are off).");
    await expectGroupGone(Number(result.text.split("\n")[2]));
  });

  test.each([
    [
      "a timeout",
      { timeoutMs: 100 },
      false,
      "timed out after 0.1 seconds; its processes could not be stopped and may still be running\nstdout:\n",
    ],
    [
      "a Stop",
      { timeoutMs: 10_000 },
      true,
      "run_command: Stop could not end the command; its processes may still be running.\n",
    ],
  ])("%s whose signals all fail never says the command stopped", async (_case, overrides, stopIt, first) => {
    const kill: KillFunction = (pid, signal) => {
      if (signal !== 0) throw Object.assign(new Error("not allowed"), { code: "EINVAL" });
      process.kill(pid, signal);
    };
    const abort = new AbortController();
    const pidFile = join(base, `unreachable-${stopIt}.pid`);
    const running = run(
      `echo $$ > '${pidFile}'; echo $$; sleep 5`,
      { ...overrides, killGraceMs: 100, kill },
      abort.signal,
    );
    await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).endsWith("\n"));
    const pgid = Number(await readFile(pidFile, "utf8"));
    try {
      if (stopIt) abort.abort();
      const result = await running;
      expect(result.status).toBe("error");
      expect(result.text).toStartWith(first);
      expect(result.text).not.toContain("stopped after");
      expect(result.text).toEndWith(
        "\nSending SIGTERM to the command's processes failed (EINVAL).\nSending SIGKILL to the command's processes failed (EINVAL).",
      );
    } finally {
      process.kill(-pgid, "SIGKILL");
    }
  });

  test("a probe answering EPERM counts the group as gone, without waiting through the grace", async () => {
    const kill: KillFunction = (pid, signal) => {
      if (signal === 0) throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      process.kill(pid, signal);
    };
    const started = Date.now();
    const result = await run("echo $$; sleep 5", { timeoutMs: 100, kill });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.text).toStartWith("stopped after 0.1 seconds\n");
    await expectGroupGone(Number(result.text.split("\n")[2]));
  });

  test("a process that left the group holding the output keeps the result at most a moment past the group's end", async () => {
    const abort = new AbortController();
    const escaped = join(base, "escaped.pid");
    // [>]: The escaped process writes its pid once out of the group, holding stdout for 3 seconds.
    const perl = `perl -MPOSIX -e 'setsid(); open(my $f, ">", $ARGV[0]); print $f "$$\\n"; close $f; sleep 3' '${escaped}'`;
    const running = run(`${perl} & sleep 5`, {}, abort.signal);
    await waitFor(async () => (await readFile(escaped, "utf8").catch(() => "")).endsWith("\n"));
    try {
      const stopped = Date.now();
      abort.abort();
      // [>]: The group is gone within a poll or two; the result then waits for the pipes until 500 ms past that.
      await Bun.sleep(250);
      expect(spyKill(() => killRunningCommands())).toEqual([]);
      expect(await running).toEqual({ status: "error", text: "run_command: stopped before it finished." });
      expect(Date.now() - stopped).toBeLessThan(1500);
    } finally {
      process.kill(Number(await readFile(escaped, "utf8")), "SIGKILL");
    }
  });

  test("a group no signal reaches is said to be maybe still running", async () => {
    const pids: number[] = [];
    const kill = (pid: number, signal: NodeJS.Signals | 0) => {
      pids.push(pid);
      if (signal !== 0) throw Object.assign(new Error("not allowed"), { code: "EINVAL" });
      process.kill(pid, signal);
    };
    const result = await run("echo $$; sleep 5 >/dev/null 2>&1 & echo started", { killGraceMs: 100, kill });
    const pgid = Number(result.text.split("\n")[2]);
    try {
      expect(result.status).toBe("ok");
      expect(result.text).toEndWith(
        [
          "The processes the command left running in the background could not be stopped; they may still be running.",
          "Sending SIGTERM to the command's processes failed (EINVAL).",
          "Sending SIGKILL to the command's processes failed (EINVAL).",
        ].join("\n"),
      );
    } finally {
      process.kill(-pgid, "SIGKILL");
    }
  });

  test("a shell that cannot start is an error naming it", async () => {
    expect(await run("true", { shell: join(base, "no-shell") })).toEqual({
      status: "error",
      text: `run_command: the command could not start with the shell ${join(base, "no-shell")} (ENOENT).`,
    });
  });
});

describe("killRunningCommands", () => {
  test.each([
    ["while it runs", false],
    ["after a stop, during the grace", true],
  ])("sends SIGKILL at once to a command that ignores SIGTERM, %s", async (_case, stopFirst) => {
    const abort = new AbortController();
    const pidFile = join(base, `host-exit-${stopFirst}.pid`);
    const running = runCommand(
      { command: `trap '' TERM; echo $$ > '${pidFile}'; exec sleep 30`, cwd: base },
      { signal: abort.signal },
      { shell: "/bin/sh", timeoutMs: 60_000 },
    );
    await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).endsWith("\n"));
    const pgid = Number(await readFile(pidFile, "utf8"));
    if (stopFirst) abort.abort();
    const killed = Date.now();
    killRunningCommands();
    // [>]: Well under the 2-second grace a stopped command would otherwise get before its SIGKILL.
    await expectGroupGone(pgid);
    expect(Date.now() - killed).toBeLessThan(1000);
    expect(await running).toEqual({ status: "error", text: "run_command: stopped before it finished." });
  });

  test.each([
    ["while it runs", false],
    ["after a stop, during the grace", true],
  ])("a SIGKILL that fails at deactivation never says the command stopped, %s", async (_case, stopFirst) => {
    const abort = new AbortController();
    const pidFile = join(base, `host-exit-failed-${stopFirst}.pid`);
    const running = runCommand(
      { command: `trap '' TERM; echo $$ > '${pidFile}'; exec sleep 30`, cwd: base },
      { signal: abort.signal },
      { shell: "/bin/sh", timeoutMs: 60_000 },
    );
    await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).endsWith("\n"));
    const pgid = Number(await readFile(pidFile, "utf8"));
    try {
      if (stopFirst) abort.abort();
      const original = console.error;
      console.error = () => {};
      try {
        spyKill(() => killRunningCommands(), "EINVAL");
      } finally {
        console.error = original;
      }
      expect(await running).toEqual({
        status: "error",
        text: [
          "run_command: Stop could not end the command; its processes may still be running.",
          "",
          "Sending SIGKILL to the command's processes failed (EINVAL).",
        ].join("\n"),
      });
    } finally {
      process.kill(-pgid, "SIGKILL");
    }
  });

  test("a deactivation while a leftover job waits for its grace keeps the command's result and says so", async () => {
    const pidFile = join(base, "leftover-deactivated.pid");
    const started = Date.now();
    const running = run(`echo $$ > '${pidFile}'; (trap '' TERM; exec sleep 30 >/dev/null 2>&1) & echo started`);
    await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).endsWith("\n"));
    const pgid = Number(await readFile(pidFile, "utf8"));
    // [>]: Past the 200 ms drain, the leftover job got SIGTERM and ignores it: the run is in its grace.
    await Bun.sleep(400);
    killRunningCommands();
    const result = await running;
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result).toEqual({
      status: "ok",
      text: [
        "exit code 0",
        "stdout:",
        "started",
        "stderr: (empty)",
        "",
        "The processes the command left running in the background were sent SIGKILL as the extension shut down.",
      ].join("\n"),
    });
    await expectGroupGone(pgid);
  });
});

describe("command group ownership", () => {
  test("deactivation after a Stop sends no later signal, even to a reused group id", async () => {
    const abort = new AbortController();
    const pidFile = join(base, "reuse.pid");
    let deactivated = false;
    const late: string[] = [];
    const kill: KillFunction = (pid, signal) => {
      // [>]: Past deactivation, signal 0 finds a group: the id now names another command's group.
      if (!deactivated) return void process.kill(pid, signal);
      if (signal !== 0) late.push(`${signal} ${pid}`);
    };
    const running = run(
      `trap '' TERM; echo $$ > '${pidFile}'; exec sleep 30`,
      { killGraceMs: 250, kill },
      abort.signal,
    );
    await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).endsWith("\n"));
    const pgid = Number(await readFile(pidFile, "utf8"));
    abort.abort();
    killRunningCommands();
    deactivated = true;
    await running;
    await Bun.sleep(400);
    expect(late).toEqual([]);
    await expectGroupGone(pgid);
  });

  test("an owner that releases late never releases a later owner of the same group id", () => {
    const killed: (string | undefined)[] = [];
    const releaseOld = ownCommandGroup(424242, () => killed.push("old"));
    const releaseNew = ownCommandGroup(424242, (failure) => killed.push(failure));
    releaseOld();
    releaseOld();
    expect(spyKill(() => killRunningCommands())).toEqual([[-424242, "SIGKILL"]]);
    expect(killed).toEqual([undefined]);
    releaseNew();
  });

  test("a second deactivation signals nothing the first one released", () => {
    const killed: (string | undefined)[] = [];
    ownCommandGroup(424243, (failure) => killed.push(failure));
    expect(spyKill(() => killRunningCommands())).toEqual([[-424243, "SIGKILL"]]);
    expect(spyKill(() => killRunningCommands())).toEqual([]);
    expect(killed).toEqual([undefined]);
  });

  test("a command that ended is no longer owned: deactivation afterwards signals nothing", async () => {
    expect((await run("echo done")).status).toBe("ok");
    expect(spyKill(() => killRunningCommands())).toEqual([]);
  });

  test("deactivation logs a SIGKILL that fails for another reason than a group gone, and nothing on success", () => {
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const failed: (string | undefined)[] = [];
      ownCommandGroup(424244, (failure) => failed.push(failure));
      spyKill(() => killRunningCommands(), "EINVAL");
      expect(failed).toEqual(["EINVAL"]);
      expect(logged).toEqual([["broke-code: could not kill the command group 424244 (EINVAL)"]]);
      logged.length = 0;
      ownCommandGroup(424245, () => {});
      spyKill(() => killRunningCommands());
      ownCommandGroup(424246, () => {});
      spyKill(() => killRunningCommands(), "ESRCH");
      expect(logged).toEqual([]);
    } finally {
      console.error = original;
    }
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
