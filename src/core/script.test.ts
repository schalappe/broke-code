import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_USER_TOOL } from "./askUser";
import { StepCount } from "./limits";
import {
  admit,
  ancestorFolders,
  MAX_SCRIPT_OUTPUT,
  QUEUE_REFUSAL,
  RUN_SCRIPT_TOOL,
  runScript,
  type ScriptEnv,
  scriptLaunch,
  scriptProblem,
  stepLimitRefusal,
} from "./script";
import { LOAD_SKILL_TOOL } from "./skills";
import { parseToolCall } from "./toolCalls";
import { READ_TOOLS, type ToolCall, type ToolResult } from "./tools";
import { WRITE_TOOLS } from "./writeTools";

// [!]: These tests run real children under `sandbox-exec`, so they fail inside a harness that is itself sandboxed
// (exit 71, `sandbox_apply: Operation not permitted`), as the bench's command tests do.
const RUNTIME = realpathSync(process.execPath);
const ENV: ScriptEnv = { runtime: [RUNTIME], environment: {}, readable: [] };
const TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];
/** A turn's step count with room for every call of a test that is not about the step limit. */
const ROOM = 1000;

/** A `callTool` that answers each call with `answer`, recording the calls in order. */
function recorder(answer: (call: ToolCall) => ToolResult | Promise<ToolResult> = okEcho) {
  const calls: ToolCall[] = [];
  const run = async (call: ToolCall, _signal: AbortSignal) => {
    calls.push(call);
    return answer(call);
  };
  return { calls, run };
}

function okEcho(call: ToolCall): ToolResult {
  return { status: "ok", text: `${call.name} ${JSON.stringify(call.args)}` };
}

function script(
  code: string,
  run = recorder().run,
  env: ScriptEnv = ENV,
  signal = new AbortController().signal,
  steps = new StepCount(ROOM),
) {
  return runScript(code, { tools: TOOLS, steps, run }, signal, env);
}

describe("runScript", () => {
  test("chains two tools: each call runs with its arguments as text, and only what the script prints comes back", async () => {
    const tools = recorder((call) =>
      call.name === "read_file" ? { status: "ok", text: "def old_name():" } : { status: "ok", text: "Edited a.py." },
    );
    const result = await script(
      [
        'const text = await read_file({ path: "a.py" });',
        'const edited = await edit_file({ path: "a.py", old: "old_name", new: text.includes("old_name") ? "new_name" : "x" });',
        "console.log(edited, 2, { lines: 1 });",
      ].join("\n"),
      tools.run,
    );
    expect(tools.calls).toEqual([
      { name: "read_file", args: { path: "a.py" } },
      { name: "edit_file", args: { path: "a.py", old: "old_name", new: "new_name" } },
    ]);
    expect(result).toEqual({ status: "ok", text: 'Edited a.py. 2 {"lines":1}' });
  });

  test("converts each value with String() and drops an undefined one", async () => {
    const tools = recorder();
    await script("await read_file({ path: 'a', start_line: 3, end_line: undefined });", tools.run);
    expect(tools.calls).toEqual([{ name: "read_file", args: { path: "a", start_line: "3" } }]);
  });

  test("a failed call throws an Error holding the result text, which the script may catch", async () => {
    const tools = recorder(() => ({ status: "error", text: "edit_file: the passage was not found." }));
    const result = await script(
      [
        "try { await edit_file({ path: 'a', old: 'x', new: 'y' }); }",
        "catch (error) { console.log('caught:', error.message, error instanceof Error); }",
      ].join("\n"),
      tools.run,
    );
    expect(result).toEqual({ status: "ok", text: "caught: edit_file: the passage was not found. true" });
  });

  test("an uncaught error ends the script: its output so far, then the error", async () => {
    const tools = recorder(() => ({ status: "error", text: "The user rejected this change." }));
    const result = await script(
      ["console.log('before');", "await write_file({ path: 'a', content: 'x' });", "console.log('never');"].join("\n"),
      tools.run,
    );
    expect(result).toEqual({
      status: "error",
      text: "before\nrun_script: the script stopped on an error: The user rejected this change.",
    });
  });

  test("names the kind of an error other than Error, such as a syntax error", async () => {
    const result = await script("const = 1;");
    expect(result.status).toBe("error");
    expect(result.text).toStartWith("run_script: the script stopped on an error: SyntaxError: ");
  });

  test("prints the log lines in order, console.error among them, then the returned value", async () => {
    const result = await script("console.log('a'); console.error('b'); console.log('c'); return { done: true };");
    expect(result).toEqual({ status: "ok", text: 'a\nb\nc\n{"done":true}' });
    expect(await script("return 'as is';")).toEqual({ status: "ok", text: "as is" });
  });

  test("cuts the output to its first 2,000 lines, with the usual notice", async () => {
    const result = await script("for (let i = 1; i <= 2100; i++) console.log('line ' + i);");
    expect(result.status).toBe("ok");
    const lines = result.text.split("\n");
    expect(lines).toHaveLength(2001);
    expect(lines[1999]).toBe("line 2000");
    expect(lines[2000]).toBe("[truncated: 100 more lines not shown]");
  });

  test("keeps the error line when the output is cut", async () => {
    const result = await script("for (let i = 1; i <= 2100; i++) console.log(i); throw new Error('late');");
    expect(result.text).toEndWith(
      "[truncated: 100 more lines not shown]\nrun_script: the script stopped on an error: late",
    );
  });

  test("tells the model to print what it needs when the script prints and returns nothing", async () => {
    const result = await script("await read_file({ path: 'a' });");
    expect(result).toEqual({
      status: "ok",
      text: "run_script: the script printed nothing and returned nothing. Print what you need to read with console.log, or return it.",
    });
  });

  test("runs the calls one at a time in arrival order, so Promise.all works", async () => {
    let running = 0;
    let most = 0;
    const tools = recorder(async (call) => {
      running += 1;
      most = Math.max(most, running);
      await Bun.sleep(20);
      running -= 1;
      return { status: "ok", text: call.args.path ?? "" };
    });
    const result = await script(
      "const all = await Promise.all(['a', 'b', 'c'].map((path) => read_file({ path }))); console.log(all.join(','));",
      tools.run,
    );
    expect(result).toEqual({ status: "ok", text: "a,b,c" });
    expect(most).toBe(1);
    expect(tools.calls.map((call) => call.args.path)).toEqual(["a", "b", "c"]);
  });

  test("settles only once a call the script did not wait for has settled", async () => {
    let finished = false;
    const tools = recorder(async () => {
      await Bun.sleep(100);
      finished = true;
      return { status: "ok", text: "late" };
    });
    const result = await script("write_file({ path: 'a', content: 'x' }); return 'returned';", tools.run);
    expect(result).toEqual({ status: "ok", text: "returned" });
    expect(finished || tools.calls.length === 0).toBe(true);
  });

  test("once the script ends, the call it did not wait for is aborted and the queued ones never run", async () => {
    const signals: AbortSignal[] = [];
    const tools = recorder();
    const run = (call: ToolCall, signal: AbortSignal) => {
      signals.push(signal);
      void tools.run(call, signal);
      return new Promise<ToolResult>((resolve) => {
        signal.addEventListener("abort", () => resolve({ status: "error", text: "cancelled" }), { once: true });
      });
    };
    const result = await script(
      "write_file({ path: 'a', content: 'x' }); write_file({ path: 'b', content: 'y' }); return 'returned';",
      run,
    );
    expect(result).toEqual({ status: "ok", text: "returned" });
    expect(tools.calls.map((call) => call.args.path)).not.toContain("b");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  test("a script that throws while a call is pending never gets to run the calls queued behind it", async () => {
    const tools = recorder(async () => {
      await Bun.sleep(50);
      return { status: "ok", text: "done" };
    });
    const result = await script(
      "await Promise.all([read_file({ path: 'a' }), Promise.reject(new Error('early')), write_file({ path: 'b', content: 'y' })]);",
      tools.run,
    );
    expect(result).toEqual({ status: "error", text: "run_script: the script stopped on an error: early" });
    expect(tools.calls.map((call) => call.args.path)).not.toContain("b");
  });

  test("offers no require, process, fetch, or timers", async () => {
    const result = await script(
      "console.log([typeof require, typeof process, typeof fetch, typeof setTimeout, typeof Bun].join(','));",
    );
    expect(result).toEqual({ status: "ok", text: "undefined,undefined,undefined,undefined,undefined" });
    const required = await script("require('node:fs');");
    expect(required.status).toBe("error");
    expect(required.text).toContain("ReferenceError");
  });

  test("never offers run_script, load_skill, or ask_user, even when the send offers them", async () => {
    const tools = [...READ_TOOLS, RUN_SCRIPT_TOOL, LOAD_SKILL_TOOL, ASK_USER_TOOL];
    const result = await runScript(
      "console.log([typeof run_script, typeof load_skill, typeof ask_user, typeof read_file].join(','));",
      { tools, steps: new StepCount(ROOM), run: recorder().run },
      new AbortController().signal,
      ENV,
    );
    expect(result).toEqual({ status: "ok", text: "undefined,undefined,undefined,function" });
  });

  test("refuses arguments that are not one object, without running the call", async () => {
    const tools = recorder();
    const result = await script(
      "try { await read_file('a.ts'); } catch (error) { console.log(error.message); }",
      tools.run,
    );
    expect(result.text).toBe('read_file takes one object of arguments, such as read_file({ path: "..." }).');
    expect(tools.calls).toEqual([]);
  });

  test("refuses an unknown argument and a missing required one, without running the call", async () => {
    const tools = recorder();
    const result = await script(
      [
        "for (const args of [{ pth: 'a' }, { old: 'x', new: 'y' }]) {",
        "  try { await edit_file(args); } catch (error) { console.log(error.message); }",
        "}",
      ].join("\n"),
      tools.run,
    );
    expect(result.text).toBe(
      "edit_file has no argument pth. Its arguments are: path, old, new.\nedit_file is missing the required argument path.",
    );
    expect(tools.calls).toEqual([]);
  });

  test("an empty script runs nothing", async () => {
    expect(await script("  \n")).toEqual({ status: "error", text: "run_script: the code is empty." });
  });
});

describe("runScript limits", () => {
  test("counts the arguments of the calls waiting as they arrive: one past the limit throws, and an answer frees its share", async () => {
    const ran: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = {
      tools: TOOLS,
      steps: new StepCount(ROOM),
      run: async (call: ToolCall) => {
        ran.push(call.args.path?.length ?? 0);
        if (ran.length === 1) await gate;
        return { status: "ok" as const, text: "done" };
      },
    };
    // [>]: The first call waits; three of 3 MiB queue behind it, so the third passes the 8 MiB limit.
    const code = [
      'const big = "x".repeat(3 * 1024 * 1024);',
      'const first = read_file({ path: "a" });',
      "const queued = [0, 1, 2].map(() => read_file({ path: big }).catch((error) => error.message));",
      "const refusal = await queued[2];",
      "await Promise.all([first, ...queued]);",
      "await read_file({ path: big });",
      "return refusal;",
    ].join("\n");
    const result = runScript(code, inner, new AbortController().signal, ENV);
    for (let tries = 0; ran.length < 1 && tries < 200; tries++) await Bun.sleep(10);
    await Bun.sleep(200);
    expect(ran).toEqual([1]);
    release();
    expect(await result).toEqual({ status: "ok", text: QUEUE_REFUSAL });
    const big = 3 * 1024 * 1024;
    expect(ran).toEqual([1, big, big, big]);
  });

  test("each admitted call takes a step of the turn: the call past the limit throws inside the script, is never run, and takes none", async () => {
    const tools = recorder();
    // [>]: A limit of 4 with the run_script call's own step taken leaves room for exactly 3 calls.
    const steps = new StepCount(4);
    steps.take();
    const result = await script(
      [
        "for (let i = 0; i < 3; i++) await read_file({ path: String(i) });",
        "try { await read_file({ path: 'one more' }); } catch (error) { console.log(error.message); }",
        "return 'finished';",
      ].join("\n"),
      tools.run,
      ENV,
      undefined,
      steps,
    );
    expect(tools.calls.map((call) => call.args.path)).toEqual(["0", "1", "2"]);
    expect(result).toEqual({ status: "ok", text: `${stepLimitRefusal(4)}\nfinished` });
    expect(stepLimitRefusal(4)).toBe(
      "run_script: the agent turn has reached its limit of 4 tool steps, where each call a script makes is one step; this call was not made. End the script with what it has so far.",
    );
    expect(steps.reached).toBe(true);
  });

  test("calls queued at once are admitted only while steps are left", async () => {
    const tools = recorder();
    const steps = new StepCount(2);
    const result = await script(
      [
        "const settled = await Promise.allSettled([0, 1, 2, 3].map((i) => read_file({ path: String(i) })));",
        "return settled.map((each) => each.status).join(',');",
      ].join("\n"),
      tools.run,
      ENV,
      undefined,
      steps,
    );
    expect(tools.calls.map((call) => call.args.path)).toEqual(["0", "1"]);
    expect(result).toEqual({ status: "ok", text: "fulfilled,fulfilled,rejected,rejected" });
  });

  test("a call refused for another reason takes no step", async () => {
    const tools = recorder();
    const steps = new StepCount(1);
    const result = await script(
      [
        "try { await read_file('a'); } catch {}",
        "try { await edit_file({ path: 'a' }); } catch {}",
        "return await read_file({ path: 'b' });",
      ].join("\n"),
      tools.run,
      ENV,
      undefined,
      steps,
    );
    expect(tools.calls).toEqual([{ name: "read_file", args: { path: "b" } }]);
    expect(result).toEqual({ status: "ok", text: 'read_file {"path":"b"}' });
  });

  test("a script that runs past its time without a tool call is killed", async () => {
    const started = performance.now();
    const result = await script("console.log('looping'); for (;;) {}", recorder().run, { ...ENV, runMs: 300 });
    expect(result).toEqual({
      status: "error",
      text: "run_script: the script ran for 0.3 seconds without a tool call and was stopped. The tool calls it made before ran.",
    });
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("the time a call takes, such as a wait for approval, never counts toward the running time", async () => {
    const tools = recorder(async () => {
      await Bun.sleep(600);
      return { status: "ok", text: "approved" };
    });
    const result = await script("console.log(await write_file({ path: 'a', content: 'x' }));", tools.run, {
      ...ENV,
      runMs: 300,
    });
    expect(result).toEqual({ status: "ok", text: "approved" });
  });

  test("a loop of refused calls still runs out of time", async () => {
    const result = await script("for (;;) { try { await read_file(1); } catch {} }", recorder().run, {
      ...ENV,
      runMs: 300,
    });
    expect(result.text).toStartWith("run_script: the script ran for 0.3 seconds without a tool call");
  });

  test("output past the limit ends the script on an error, even when the script catches it", async () => {
    const line = "x".repeat(1000);
    const result = await script(
      `for (let i = 0; i < 2000; i++) { try { console.log('${line}'); } catch {} } return 'end';`,
    );
    expect(result.status).toBe("error");
    expect(result.text).toEndWith(
      `run_script: the script stopped on an error: the script printed more than ${MAX_SCRIPT_OUTPUT} characters`,
    );
  });

  test("a call made after catching the output overflow never reaches the tools", async () => {
    const line = "x".repeat(1000);
    const tools = recorder();
    const result = await script(
      [
        `for (let i = 0; i < 2000; i++) { try { console.log('${line}'); } catch {} }`,
        "try { await write_file({ path: 'a', content: 'x' }); } catch {}",
        "return 'end';",
      ].join("\n"),
      tools.run,
    );
    expect(tools.calls).toEqual([]);
    expect(result.status).toBe("error");
    expect(result.text).toEndWith(
      `run_script: the script stopped on an error: the script printed more than ${MAX_SCRIPT_OUTPUT} characters`,
    );
  });

  test("a child that ends and then stays alive is killed once its time to exit is up", async () => {
    // [>]: The vm is no guard: the script reaches the child's process, sends a done frame itself, and keeps it alive.
    const result = await script(
      [
        "const outer = console.log.constructor('return globalThis')();",
        "outer.process.stdin.removeAllListeners('end');",
        "outer.setInterval(() => {}, 1000);",
        "outer.process.stdout.write(JSON.stringify({ done: { output: 'ended' } }) + '\\n');",
        "await new Promise(() => {});",
      ].join("\n"),
      recorder().run,
      { ...ENV, runMs: 300 },
    );
    expect(result).toEqual({
      status: "error",
      text: "run_script: the script was stopped, since it did not exit once it ended.",
    });
  });

  test("a child past its memory limit is killed", async () => {
    const memoryBytes = 128 * 1024 * 1024;
    const started = performance.now();
    const result = await script(
      "const kept = []; for (let i = 0; i < 8; i++) kept.push(new Uint8Array(32 * 1024 * 1024).fill(1)); for (;;) {}",
      recorder().run,
      { ...ENV, memoryBytes },
    );
    expect(result).toEqual({
      status: "error",
      text: `run_script: the script was stopped, since it used more than ${memoryBytes} bytes of memory.`,
    });
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("a child that stops reading its input while it asks for calls is stopped", async () => {
    const result = await script(
      [
        "const outer = console.log.constructor('return globalThis')();",
        "outer.process.stdin.pause();",
        "const out = outer.process.stdout;",
        "for (let id = 1; ; id++) {",
        "  const sent = out.write(JSON.stringify({ call: { id, name: 'nope', args: {} } }) + '\\n');",
        "  if (!sent) await new Promise((resolve) => out.once('drain', resolve));",
        "}",
      ].join("\n"),
      recorder().run,
      { ...ENV, runMs: 30_000 },
    );
    expect(result).toEqual({
      status: "error",
      text: "run_script: the script was stopped, since it left more than 33554432 characters of its input unread.",
    });
  });

  test("a call frame past the frame bound stops the script, the call never run", async () => {
    const tools = recorder();
    const result = await script("await write_file({ path: 'a', content: 'x'.repeat(9 * 1024 * 1024) });", tools.run);
    expect(result).toEqual({
      status: "error",
      text: "run_script: the script was stopped, since it sent a line over 8388608 characters.",
    });
    expect(tools.calls).toEqual([]);
  });

  test("a call frame that arrives in pieces runs once its newline arrives", async () => {
    const tools = recorder();
    const result = await script(
      [
        "const outer = console.log.constructor('return globalThis')();",
        "const pause = (ms) => new Promise((resolve) => outer.setTimeout(resolve, ms));",
        `for (const piece of ['{"call":{"id":1,', '"name":"read_file","args":', '{"path":"a"}}}', '\\n']) {`,
        "  outer.process.stdout.write(piece);",
        "  await pause(20);",
        "}",
        "await pause(200);",
        "console.log('sent');",
      ].join("\n"),
      tools.run,
    );
    expect(tools.calls).toEqual([{ name: "read_file", args: { path: "a" } }]);
    expect(result).toEqual({ status: "ok", text: "sent" });
  });

  test("a line sent in many small pieces is stopped once it passes the frame bound", async () => {
    const result = await script(
      [
        "const outer = console.log.constructor('return globalThis')();",
        "const out = outer.process.stdout;",
        "const piece = 'x'.repeat(1024);",
        "for (;;) {",
        "  if (!out.write(piece)) await new Promise((resolve) => out.once('drain', resolve));",
        "  await new Promise((resolve) => outer.setImmediate(resolve));",
        "}",
      ].join("\n"),
      recorder().run,
      { ...ENV, runMs: 60_000 },
    );
    expect(result).toEqual({
      status: "error",
      text: "run_script: the script was stopped, since it sent a line over 8388608 characters.",
    });
  });

  test("the kernel limit on processor time kills a looping child even without the host's timer", async () => {
    const result = await script("for (;;) {}", recorder().run, { ...ENV, runMs: 60_000, cpuSeconds: 1 });
    expect(result).toEqual({
      status: "error",
      text: "run_script: the script used more than 1 seconds of processor time and was stopped.",
    });
  });
});

describe("runScript cancellation", () => {
  test("an abort while a call waits gives the stopped error, aborts the call's signal, and kills the child", async () => {
    const abort = new AbortController();
    let callSignal: AbortSignal | undefined;
    const run = (_call: ToolCall, signal: AbortSignal) =>
      new Promise<ToolResult>((resolve) => {
        callSignal = signal;
        signal.addEventListener("abort", () => resolve({ status: "error", text: "cancelled" }), { once: true });
        abort.abort();
      });
    const result = await runScript(
      "await write_file({ path: 'a', content: 'x' });",
      { tools: TOOLS, steps: new StepCount(ROOM), run },
      abort.signal,
      ENV,
    );
    expect(result).toEqual({ status: "error", text: "run_script: stopped before it finished." });
    expect(callSignal?.aborted).toBe(true);
  });

  test("an abort while the script loops kills it at once", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    const started = performance.now();
    const result = await script("for (;;) {}", recorder().run, ENV, abort.signal);
    expect(result).toEqual({ status: "error", text: "run_script: stopped before it finished." });
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test("an aborted signal runs nothing", async () => {
    const abort = new AbortController();
    abort.abort();
    const tools = recorder();
    expect(await script("await read_file({ path: 'a' });", tools.run, ENV, abort.signal)).toEqual({
      status: "error",
      text: "run_script: stopped before it finished.",
    });
    expect(tools.calls).toEqual([]);
  });
});

describe("runScript fails closed", () => {
  test("without sandbox-exec, nothing runs and the result names the cause", async () => {
    const tools = recorder();
    const result = await script("await read_file({ path: 'a' });", tools.run, {
      ...ENV,
      sandboxExec: "/nonexistent/sandbox-exec",
    });
    expect(result).toEqual({
      status: "error",
      text: "run_script: /nonexistent/sandbox-exec was not found. A script runs only inside its sandbox, so nothing ran.",
    });
    expect(tools.calls).toEqual([]);
  });

  test("a sandbox that cannot apply its profile gives an error with its message, and nothing runs", async () => {
    const folder = await mkdtemp(join(tmpdir(), "broke-code-script-"));
    try {
      // [>]: What `sandbox-exec` does inside another sandbox: it prints why and exits 71 before running anything.
      const fake = join(folder, "sandbox-exec");
      await writeFile(fake, "#!/bin/sh\necho 'sandbox-exec: sandbox_apply: Operation not permitted' >&2\nexit 71\n");
      await chmod(fake, 0o755);
      const tools = recorder();
      const result = await script("await read_file({ path: 'a' });", tools.run, { ...ENV, sandboxExec: fake });
      expect(result).toEqual({
        status: "error",
        text: "run_script: the script runtime ended before the script did (exit code 71), so the script may not have run:\nsandbox-exec: sandbox_apply: Operation not permitted",
      });
      expect(tools.calls).toEqual([]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  test("a protocol line that is not JSON stops the script", async () => {
    // [>]: The vm is no guard: a script can reach the child's process and write to the channel itself.
    const result = await script(
      "const child = console.log.constructor('return process')(); child.stdout.write('not json\\n'); await new Promise(() => {});",
    );
    expect(result).toEqual({
      status: "error",
      text: "run_script: the script was stopped, since it sent a line that is not JSON.",
    });
  });
});

/**
 * Runs `probe`, a trusted program in the bootstrap's place, under the exact launch and profile of a script, and returns
 * its stdout: each check prints `name: ok` or `name: <error code>`.
 */
async function probe(source: string, env: ScriptEnv = ENV): Promise<string> {
  const launch = scriptLaunch(env, source);
  const child = spawn(launch.command, launch.args, { ...launch.options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  await new Promise((resolve) => child.on("close", resolve));
  return stdout;
}

/** A probe line per check: `name: ok` when `body` ran without throwing, else the error's code. */
const attempt = (name: string, body: string) =>
  `try { ${body}; console.log("${name}: ok"); } catch (error) { console.log("${name}: " + (error.code ?? error.message)); }`;

describe("the script sandbox", () => {
  test("refuses a file write, a home folder read, a workspace read, and a process spawn", async () => {
    const folder = await mkdtemp(join(tmpdir(), "broke-code-script-"));
    try {
      const workspaceFile = join(realpathSync(folder), "workspace.txt");
      await writeFile(workspaceFile, "secret");
      const written = join(realpathSync(folder), "written.txt");
      const output = await probe(
        [
          'const fs = require("node:fs");',
          'const child = require("node:child_process");',
          'console.log("alive: ok");',
          attempt("write", `fs.writeFileSync(${JSON.stringify(written)}, "x")`),
          attempt("home", `fs.readdirSync(${JSON.stringify(realpathSync(homedir()))})`),
          attempt("workspace", `fs.readFileSync(${JSON.stringify(workspaceFile)}, "utf8")`),
          attempt("spawn", 'const run = child.spawnSync("/bin/echo", ["x"]); if (run.error) throw run.error'),
        ].join("\n"),
      );
      expect(output.split("\n").filter(Boolean)).toEqual([
        "alive: ok",
        "write: EPERM",
        "home: EPERM",
        "workspace: EPERM",
        "spawn: EPERM",
      ]);
      await expect(readFile(written)).rejects.toThrow();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  test("refuses a socket to a server listening on this machine", async () => {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.end("hello");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const output = await probe(
        [
          'const net = require("node:net");',
          `const socket = net.connect(${port}, "127.0.0.1");`,
          'socket.on("connect", () => { console.log("socket: ok"); socket.destroy(); });',
          'socket.on("error", (error) => console.log("socket: " + error.code));',
        ].join("\n"),
      );
      // [>]: bun reports the sandbox's refusal as ECONNREFUSED; the server never sees the connection.
      expect(output.trim()).toMatch(/^socket: (EPERM|ECONNREFUSED)$/);
      expect(connections).toBe(0);
    } finally {
      server.close();
    }
  });

  test("a script that leaves the vm still meets the sandbox", async () => {
    const folder = await mkdtemp(join(tmpdir(), "broke-code-script-"));
    try {
      const written = join(realpathSync(folder), "escaped.txt");
      const result = await script(
        [
          "const child = console.log.constructor('return process')();",
          `child.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(written)}, 'x');`,
        ].join("\n"),
      );
      expect(result.status).toBe("error");
      expect(result.text).toContain("EPERM");
      await expect(readFile(written)).rejects.toThrow();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  test("reads a readable path given to it, and only that", async () => {
    const folder = await mkdtemp(join(tmpdir(), "broke-code-script-"));
    try {
      const real = realpathSync(folder);
      await writeFile(join(real, "allowed.txt"), "yes");
      await writeFile(join(real, "other.txt"), "no");
      const output = await probe(
        [
          'const fs = require("node:fs");',
          attempt("allowed", `fs.readFileSync(${JSON.stringify(join(real, "allowed.txt"))})`),
          attempt("other", `fs.readFileSync(${JSON.stringify(join(real, "other.txt"))})`),
        ].join("\n"),
        { ...ENV, readable: [join(real, "allowed.txt")] },
      );
      expect(output.split("\n").filter(Boolean)).toEqual(["allowed: ok", "other: EPERM"]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

describe("admit", () => {
  test("refuses a tool the script may not call, and a call without a tool name", () => {
    expect(admit({ name: "load_skill", args: {} }, READ_TOOLS)).toBe(
      "load_skill cannot be called from a script. A script can call: read_file, list_files, search.",
    );
    expect(admit({ args: {} }, READ_TOOLS)).toBe(
      "This tool cannot be called from a script. A script can call: read_file, list_files, search.",
    );
  });

  test("refuses arguments that are not text, and keeps a valid call's arguments", () => {
    expect(admit({ name: "read_file", args: { path: 1 } }, READ_TOOLS)).toBe(
      'read_file takes one object of arguments, such as read_file({ path: "..." }).',
    );
    expect(admit({ name: "read_file", args: ["a"] }, READ_TOOLS)).toBe(
      'read_file takes one object of arguments, such as read_file({ path: "..." }).',
    );
    expect(admit({ name: "list_files", args: {} }, READ_TOOLS)).toEqual({ name: "list_files", args: {} });
  });
});

describe("a run_script call in a reply", () => {
  const code = (body: string) => `<run_script>\n<code>\n${body}\n</code>\n</run_script>`;

  test("parses code that holds </code> and </run_script> in strings", () => {
    const body = "console.log('</code>');\nconsole.log(\"</run_script>\");\nreturn 1;";
    const parsed = parseToolCall(code(body), [RUN_SCRIPT_TOOL]);
    expect(parsed).toMatchObject({ kind: "call", name: "run_script", args: { code: body } });
  });

  test("parses code that holds a fenced block", () => {
    const body = "const fence = `\n```js\nlet a = 1;\n```\n`;\nconsole.log(fence);";
    const parsed = parseToolCall(`Updating.\n${code(body)}`, [RUN_SCRIPT_TOOL]);
    expect(parsed).toMatchObject({ kind: "call", name: "run_script", args: { code: body } });
  });

  test("the malformed-call message teaches a shape the parser accepts", () => {
    const parsed = parseToolCall("<run_script>\n</run_script>", [RUN_SCRIPT_TOOL]);
    if (parsed.kind !== "malformed") throw new Error(`expected a malformed call, got ${parsed.kind}`);
    const lines = parsed.message.split("\n");
    const shape = lines.slice(lines.indexOf("<run_script>"), lines.indexOf("</run_script>") + 1).join("\n");
    expect(shape).toBe("<run_script>\n<code>…</code>\n</run_script>");
    const taught = shape.replace("…", "\nconsole.log(1);\n");
    expect(parseToolCall(taught, [RUN_SCRIPT_TOOL])).toMatchObject({ kind: "call", args: { code: "console.log(1);" } });
  });
});

describe("scriptProblem, the runtime probe", () => {
  test("passes where a script calls a stub tool and gets its answer back through the real launch", async () => {
    expect(await scriptProblem(ENV)).toBeUndefined();
  });

  test("names the runtime and the cause when the sandbox cannot run it", async () => {
    const problem = await scriptProblem({ ...ENV, sandboxExec: "/nonexistent/sandbox-exec" });
    expect(problem).toBe(
      `Scripts run with ${RUNTIME} under /nonexistent/sandbox-exec, which could not run a test script:\nrun_script: /nonexistent/sandbox-exec was not found. A script runs only inside its sandbox, so nothing ran.`,
    );
  });

  test("fails within its time bound on a runtime that never answers, and stops on its signal", async () => {
    const folder = await mkdtemp(join(tmpdir(), "broke-code-probe-"));
    try {
      // [>]: A sandbox whose runtime reads nothing and never exits, as a stuck start would.
      const fake = join(realpathSync(folder), "sandbox-exec");
      await writeFile(fake, "#!/bin/sh\nexec /bin/sleep 60\n");
      await chmod(fake, 0o755);
      const env = { ...ENV, sandboxExec: fake };
      const started = performance.now();
      expect(await scriptProblem(env, undefined, 300)).toBe(
        `Scripts run with ${RUNTIME} under ${fake}, which did not run a test script within 0.3 seconds.`,
      );
      expect(performance.now() - started).toBeLessThan(3000);
      const stop = new AbortController();
      setTimeout(() => stop.abort(), 100);
      expect(await scriptProblem(env, stop.signal)).toBe(
        `Scripts run with ${RUNTIME} under ${fake}; the test script was stopped before it finished.`,
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

describe("the script launch", () => {
  test("lets the runtime read the metadata of each folder above it, those folders alone", () => {
    expect(ancestorFolders("/Applications/X.app/Contents/MacOS/X")).toEqual([
      "/",
      "/Applications",
      "/Applications/X.app",
      "/Applications/X.app/Contents",
      "/Applications/X.app/Contents/MacOS",
    ]);
    const launch = scriptLaunch({ runtime: ["/opt/bin/node"], environment: {}, readable: [] }, "1");
    const profile = launch.args.find((arg) => arg.includes("(deny default)")) ?? "";
    expect(profile).toContain(
      '(allow file-read-metadata (literal (param "A0")) (literal (param "A1")) (literal (param "A2")))',
    );
    expect(launch.args.filter((arg) => /^A\d=/.test(arg))).toEqual(["A0=/", "A1=/opt", "A2=/opt/bin"]);
  });

  test("a script whose processor time limit cannot be set never runs, and the result says why", async () => {
    // [>]: A limit `ulimit` refuses, as a lower hard limit inherited from the parent would make it refuse.
    const tools = recorder();
    const result = await script("await read_file({ path: 'a' });", tools.run, { ...ENV, cpuSeconds: -1 });
    expect(result.status).toBe("error");
    expect(result.text).toStartWith(
      "run_script: the limit on the script's processor time could not be set, so the script did not run:\n",
    );
    expect(result.text).toContain("ulimit");
    expect(tools.calls).toEqual([]);
  });
});
