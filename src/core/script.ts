/**
 * @module script
 * The `run_script` tool of Code Mode: the model writes one JavaScript script that chains the harness's tools,
 * and only what the script prints or returns goes back to it. The script runs in a separate process under macOS
 * `sandbox-exec` with a default-deny profile (`SCRIPT_SANDBOX_PROFILE`): it can read nothing of the user's, write
 * nothing, reach no network, and start no process, so it acts only through the tools. The host owns the execution
 * policy: it checks each call the script asks for against the tools offered, runs the calls one at a time through the
 * caller's `InnerCalls`, which records and approves each one as a direct call, and enforces the limits. No `vscode`
 * import. Model-facing text is English and never localized.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { SANDBOX_EXEC } from "./fullAccess";
import { MAX_MENTION_LINES, truncationNotice } from "./mentions";
import type { ToolSpec } from "./toolCalls";
import { excerpt, stopped, type ToolCall, type ToolResult } from "./tools";
import { truncateLines } from "./workspaceFiles";

const TOOL = "run_script";

/** The tool as the model sees it: for the system prompt and the body tool call parser. */
export const RUN_SCRIPT_TOOL: ToolSpec = {
  name: TOOL,
  description:
    "Run a JavaScript script that calls the other tools, and get back what it prints. It is useful when a task takes several related tool calls: one script makes them in one reply. In the script, each tool listed here except run_script, load_skill, and ask_user is an async function of the same name that takes one object of its arguments, such as await read_file({ path: \"src/a.ts\" }). read_file returns the file's exact text, with no header and no fence. Every other tool returns its result text. A call throws an Error holding the result text when the tool fails or the user rejects it. Every call asks for approval as a direct call does. To change a passage, use edit_file; use write_file only to replace a whole file. A script cannot ask the user: when you need the user's choice, call ask_user directly, not in a script. The code is the body of an async function, so await and return work at the top level. Only the lines the script prints with console.log, then the value it returns, come back to you. The script has no require, no file system, no process, no fetch, and no timers: only the tool functions. It is stopped after 10 seconds without a tool call, and a script may make at most 100 tool calls.",
  args: [
    {
      name: "code",
      required: true,
      description: "The JavaScript code, as raw text; it may span several lines.",
    },
  ],
  // [>]: Models write the code straight inside the call (ADR 0001, 2026-11-21).
  bareArg: "code",
};

/**
 * What runs a script. `runtime`: the program that runs JavaScript and its arguments, its first element a real path,
 * which the profile lets the sandbox run and read; the bootstrap is passed after them as `-e <source>`. `environment`:
 * the child's whole environment, nothing inherited. `readable`: real paths the runtime must read besides its program
 * and the system libraries (a file or a folder, read-only). The rest is for tests: `sandboxExec`, where `sandbox-exec`
 * is (`SANDBOX_EXEC`); `runMs`, the script's running time between calls (`SCRIPT_RUN_MS`); `cpuSeconds`, the kernel
 * limit on the child's processor time (`SCRIPT_CPU_SECONDS`).
 */
export type ScriptEnv = {
  runtime: readonly [string, ...string[]];
  environment: Record<string, string>;
  readable: readonly string[];
  sandboxExec?: string;
  runMs?: number;
  cpuSeconds?: number;
};

/**
 * How the script's calls run, from the turn that runs the script. `tools`: the tools offered in this send; a script may
 * call each of them but `NOT_CALLABLE`. `blocked`: tools the send leaves out that still exist in the script, each a
 * function that throws its text without running anything (Plan's write tools and `run_command`, so ordinary code
 * gets the Plan message rather than a `ReferenceError`). `run`: runs one call as the turn runs a direct one (its
 * approval, its record), under `signal`, which aborts when the turn stops or the script ends. Must not reject.
 */
export type InnerCalls = {
  tools: readonly ToolSpec[];
  blocked?: Readonly<Record<string, string>>;
  run(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
};

/**
 * Calls one script may make. A script that loops over tool calls ends in a bounded number of steps; call 101 throws
 * inside the script and is never run.
 */
export const MAX_SCRIPT_CALLS = 100;
/**
 * How long the script may run between calls, in milliseconds: its own running time, never the time a call takes, so a
 * wait for the user's approval never counts. A script that loops without calling a tool is stopped.
 */
export const SCRIPT_RUN_MS = 10_000;
/**
 * Characters the script may print, its returned value included, captured in the child: a bound on the child's memory
 * and on the frame it sends. Passing it ends the script on an error.
 */
export const MAX_SCRIPT_OUTPUT = 1024 * 1024;
/**
 * The kernel limit on the child's processor time (`ulimit -t`), set before the sandbox applies. It holds without the
 * host: a child stuck in a loop dies even when the host died first and its own timer with it.
 */
export const SCRIPT_CPU_SECONDS = 60;
/**
 * Characters of one line the child sends: room for a call's arguments (a `write_file` content over 1 MiB is refused
 * anyway) and for the done frame, whose output may grow six times when escaped. Past it the script is stopped.
 */
const MAX_FRAME_CHARS = 8 * 1024 * 1024;
/** The child's error output kept for the result: enough for the runtime's or the sandbox's message, never a flood. */
const MAX_STDERR_CHARS = 4096;
/** Characters of a thrown error's text the child keeps. */
const MAX_ERROR_CHARS = 2000;
/**
 * Tools a script never calls: itself, and those whose result must reach the model whole (a skill's instructions, the
 * user's answer).
 */
const NOT_CALLABLE: readonly string[] = [TOOL, "load_skill", "ask_user"];

/** The shell that sets the kernel limit, then replaces itself with `sandbox-exec`. */
const SHELL = "/bin/sh";
/**
 * The shell's exit code when it cannot set the kernel limit (a lower hard limit inherited): it stops there, so no
 * script runs without the limit.
 */
const CPU_LIMIT_FAILED = 125;

/**
 * The macOS sandbox of a script, default deny, every allowance measured on bun 1.4, node 23, and the VSCodium 1.143
 * extension host's helper run as Node (`docs/eval.md`): exec and read the runtime's own program (`RUNTIME`); read the
 * system libraries, the dyld cache, and the ICU data (`Intl`); list `/`, the child's working folder, which bun opens at
 * start; read and write `/dev/null`, which node opens at start; read the kernel's settings (`sysctl-read`), without
 * which bun aborts; read the metadata of each folder above the runtime (`A0`, ...), the folders alone, never what they
 * hold, without which Electron, resolving its own path, aborts. Then each `readable` path, read-only. No network, no
 * other file read or write, no process creation, no service lookup. The paths come as `sandbox-exec -D` parameters,
 * never spliced into this text.
 */
export function scriptSandboxProfile(readable: number, ancestors = 0): string {
  const params = Array.from({ length: readable }, (_, index) => `(subpath (param "R${index}"))`);
  const folders = Array.from({ length: ancestors }, (_, index) => `(literal (param "A${index}"))`);
  return [
    "(version 1)",
    "(deny default)",
    '(allow process-exec (literal (param "RUNTIME")))',
    '(allow file-read* (literal (param "RUNTIME")))',
    '(allow file-read* (subpath "/usr/lib") (subpath "/usr/share/icu") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS"))',
    '(allow file-read-data (literal "/"))',
    '(allow file-read* file-write-data (literal "/dev/null"))',
    "(allow sysctl-read)",
    ...(ancestors > 0 ? [`(allow file-read-metadata ${folders.join(" ")})`] : []),
    ...(readable > 0 ? [`(allow file-read* ${params.join(" ")})`] : []),
  ].join("\n");
}

/** The folders above `path`, from `/` down to its parent: `/a/b/c` gives `/`, `/a`, `/a/b`. */
export function ancestorFolders(path: string): string[] {
  const folders = path
    .split("/")
    .filter((part) => part !== "")
    .slice(0, -1);
  return ["/", ...folders.map((_, index) => `/${folders.slice(0, index + 1).join("/")}`)];
}

/** The message a script that printed too much ends on, in the child and in the result. */
const OUTPUT_OVERFLOW = `the script printed more than ${MAX_SCRIPT_OUTPUT} characters`;

/**
 * The child's program, run as `<runtime> -e <source>`. It reads JSON Lines on stdin: first `{ code, tools }`, then
 * `{ id, status, text }`, the result of each call it asked for. It writes JSON Lines on stdout: `{ call: { id, name,
 * args } }` per tool call, then `{ done: { output, error? } }`. The script runs inside a `node:vm` context whose only
 * globals are the tool functions and `console`, whose `log` and `error` are captured here, never written to stdout. A
 * second layer only: functions passed into the context lead back to the child's realm, so the OS sandbox is the guard.
 * The child exits when its stdin ends. Plain JavaScript in quotes, no template literal, so the text runs as written.
 */
export const SCRIPT_BOOTSTRAP = [
  '"use strict";',
  'const vm = require("node:vm");',
  `const MAX_OUTPUT = ${MAX_SCRIPT_OUTPUT};`,
  `const MAX_ERROR = ${MAX_ERROR_CHARS};`,
  `const OVERFLOW = ${JSON.stringify(OUTPUT_OVERFLOW)};`,
  "const waiting = new Map();",
  "const output = [];",
  "let outputSize = 0;",
  "let overflow = false;",
  "let finished = false;",
  "let started = false;",
  "let nextId = 0;",
  'let buffered = "";',
  "let ContextError = Error;",
  'function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }',
  "function plain(value) {",
  "  try { return String(value); } catch (error) { return Object.prototype.toString.call(value); }",
  "}",
  "function shown(value) {",
  '  if (typeof value === "string") return value;',
  "  try {",
  '    if (value !== null && typeof value === "object" && typeof value.message === "string" && typeof value.name === "string") return value.name + ": " + value.message;',
  "    const text = JSON.stringify(value);",
  "    return text === undefined ? plain(value) : text;",
  "  } catch (error) { return plain(value); }",
  "}",
  "function keep(line) {",
  "  if (overflow) throw new ContextError(OVERFLOW);",
  "  outputSize += line.length + 1;",
  "  if (outputSize > MAX_OUTPUT) { overflow = true; throw new ContextError(OVERFLOW); }",
  "  output.push(line);",
  "}",
  'function log(...values) { keep(values.map(shown).join(" ")); }',
  "function errorText(error) {",
  "  let text;",
  "  try {",
  '    if (error !== null && typeof error === "object" && typeof error.message === "string") {',
  '      const name = typeof error.name === "string" ? error.name : "Error";',
  '      text = name === "Error" ? error.message : name + ": " + error.message;',
  "    } else text = shown(error);",
  "  } catch (failure) { text = plain(error); }",
  '  return text.length > MAX_ERROR ? text.slice(0, MAX_ERROR) + "…" : text;',
  "}",
  "function finish(failed, value, error) {",
  "  if (finished) return;",
  "  finished = true;",
  "  if (!failed && value !== undefined) { try { keep(shown(value)); } catch (overflowed) {} }",
  '  const done = { output: output.join("\\n") };',
  "  if (overflow) done.error = OVERFLOW;",
  "  else if (failed) done.error = errorText(error);",
  "  send({ done });",
  "}",
  "function argumentsOf(args) {",
  "  if (args === undefined) return {};",
  '  if (args === null || typeof args !== "object" || Array.isArray(args)) return null;',
  "  const converted = Object.create(null);",
  "  for (const key of Object.keys(args)) { if (args[key] !== undefined) converted[key] = String(args[key]); }",
  "  return converted;",
  "}",
  "function call(name, args) {",
  "  return new Promise((resolve, reject) => {",
  "    const frame = { id: ++nextId, name, args: argumentsOf(args) };",
  "    waiting.set(frame.id, { resolve, reject });",
  "    send({ call: frame });",
  "  });",
  "}",
  "function start(setup) {",
  "  const globals = { console: { log, error: log } };",
  "  for (const name of setup.tools) globals[name] = (args) => call(name, args);",
  "  const context = vm.createContext(globals);",
  '  ContextError = vm.runInContext("Error", context);',
  "  let running;",
  '  try { running = vm.runInContext("(async () => {\\n" + setup.code + "\\n})()", context, { filename: "script.js" }); }',
  "  catch (error) { finish(true, undefined, error); return; }",
  "  Promise.resolve(running).then((value) => finish(false, value), (error) => finish(true, undefined, error));",
  "}",
  "function receive(frame) {",
  "  if (!started) { started = true; start(frame); return; }",
  "  const pending = waiting.get(frame.id);",
  "  if (pending === undefined) return;",
  "  waiting.delete(frame.id);",
  '  if (frame.status === "ok") pending.resolve(frame.text);',
  "  else pending.reject(new ContextError(frame.text));",
  "}",
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (chunk) => {',
  "  buffered += chunk;",
  '  for (let end = buffered.indexOf("\\n"); end !== -1; end = buffered.indexOf("\\n")) {',
  "    const line = buffered.slice(0, end);",
  "    buffered = buffered.slice(end + 1);",
  "    receive(JSON.parse(line));",
  "  }",
  "});",
  'process.stdin.on("end", () => process.exit(0));',
].join("\n");

/**
 * The program, arguments, and options that run `source` under the script sandbox with `env`: `/bin/sh` sets the
 * kernel limit on processor time, or exits `CPU_LIMIT_FAILED` when it cannot, then replaces itself with
 * `sandbox-exec`, which applies the profile and replaces itself with the runtime, so the spawned pid is the runtime's.
 * The working folder is `/` and the environment is `env.environment` alone. `runScript` runs `SCRIPT_BOOTSTRAP` this
 * way; the tests run their own probes the same way.
 */
export function scriptLaunch(
  env: ScriptEnv,
  source: string,
): { command: string; args: string[]; options: { cwd: string; env: Record<string, string> } } {
  const readable = env.readable.flatMap((path, index) => ["-D", `R${index}=${path}`]);
  const ancestors = ancestorFolders(env.runtime[0]);
  const folders = ancestors.flatMap((path, index) => ["-D", `A${index}=${path}`]);
  const cpuSeconds = env.cpuSeconds ?? SCRIPT_CPU_SECONDS;
  return {
    command: SHELL,
    args: [
      "-c",
      `ulimit -t ${cpuSeconds} || exit ${CPU_LIMIT_FAILED}; exec "$@"`,
      "sh",
      env.sandboxExec ?? SANDBOX_EXEC,
      "-p",
      scriptSandboxProfile(env.readable.length, ancestors.length),
      "-D",
      `RUNTIME=${env.runtime[0]}`,
      ...folders,
      ...readable,
      ...env.runtime,
      "-e",
      source,
    ],
    options: { cwd: "/", env: { ...env.environment } },
  };
}

/**
 * Run `code` as a script that may call `tools` (less `NOT_CALLABLE`) through `callTool`, under `env`'s sandbox. Never
 * rejects. Each call the script asks for is checked here before anything runs (a tool it may call, one object of known
 * arguments, every required one given, at most `MAX_SCRIPT_CALLS`); a refused call throws inside the script. Admitted
 * calls run one at a time, in arrival order, so `Promise.all` works but runs them in turn, under a signal that aborts
 * with `signal` or when the script ends. The result is final once the child has exited and no admitted call is
 * outstanding. `ok`: what the script printed, then its returned value; `error`: that output, then why the script
 * stopped. Fail closed: when `sandbox-exec` is missing or cannot apply the profile, the result is an `error` naming
 * the cause, and the script never runs outside the sandbox. An abort of `signal` kills the child and gives the stopped
 * error; so do the limits and a protocol error, each with its own message.
 */
export async function runScript(
  code: string,
  tools: readonly ToolSpec[],
  callTool: InnerCalls["run"],
  signal: AbortSignal,
  env: ScriptEnv,
  blocked: Readonly<Record<string, string>> = {},
): Promise<ToolResult> {
  if (signal.aborted) return stopped(TOOL);
  if (code.trim() === "") return { status: "error", text: `${TOOL}: the code is empty.` };
  const sandboxExec = env.sandboxExec ?? SANDBOX_EXEC;
  const found = await access(sandboxExec, constants.X_OK).then(
    () => true,
    () => false,
  );
  if (!found) {
    return {
      status: "error",
      text: `${TOOL}: ${sandboxExec} was not found. A script runs only inside its sandbox, so nothing ran.`,
    };
  }
  if (signal.aborted) return stopped(TOOL);
  const callable = tools.filter((tool) => !NOT_CALLABLE.includes(tool.name));
  return runChild(code, callable, blocked, callTool, signal, env);
}

/**
 * How long the runtime probe (`scriptProblem`) may take: a cold start of an Electron helper from disk takes well under
 * a second (measured), so a probe past this is stuck, and Code Mode stays off rather than wait on it.
 */
export const SCRIPT_PROBE_MS = 10_000;

/** The stub tool the probe's script calls, and what it answers, so the probe proves a full round trip. */
const PROBE_TOOL: ToolSpec = { name: "probe", description: "Answers the runtime probe.", args: [] };
const PROBE_ANSWER = "ready";

/**
 * Why scripts cannot run under `env`, or `undefined` when they can: runs, through the exact launch of every script
 * (`runScript`: the profile, the kernel limit, the environment), a script that calls one stub tool and returns its
 * answer, and requires that answer back. Bounded by `timeoutMs` (`SCRIPT_PROBE_MS`) and aborted with `signal`, which
 * give a problem of their own. Never rejects. The text names the runtime and what failed, for a notification or a log.
 */
export async function scriptProblem(
  env: ScriptEnv,
  signal: AbortSignal = new AbortController().signal,
  timeoutMs = SCRIPT_PROBE_MS,
): Promise<string | undefined> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const answer = async () => ({ status: "ok" as const, text: PROBE_ANSWER });
  const result = await runScript(
    `return await ${PROBE_TOOL.name}();`,
    [PROBE_TOOL],
    answer,
    AbortSignal.any([signal, timeout]),
    env,
  );
  if (result.status === "ok" && result.text === PROBE_ANSWER) return undefined;
  const what = `Scripts run with ${env.runtime[0]} under ${env.sandboxExec ?? SANDBOX_EXEC}`;
  if (timeout.aborted) return `${what}, which did not run a test script within ${timeoutMs / 1000} seconds.`;
  if (signal.aborted) return `${what}; the test script was stopped before it finished.`;
  return `${what}, which could not run a test script:\n${result.text}`;
}

/** Why the host ended a script before its done frame settled it. */
type Ending = { kind: "stopped" } | { kind: "timeout" } | { kind: "protocol"; detail: string };

/** The child's final frame: what the script printed, and why it stopped when it failed. */
type Done = { output: string; error?: string };

function runChild(
  code: string,
  callable: readonly ToolSpec[],
  blocked: Readonly<Record<string, string>>,
  callTool: InnerCalls["run"],
  signal: AbortSignal,
  env: ScriptEnv,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const runMs = env.runMs ?? SCRIPT_RUN_MS;
    const inner = new AbortController();
    const usedIds = new Set<number>();
    let ending: Ending | undefined;
    let done: Done | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let startFailure: string | undefined;
    let outstanding = 0;
    let calls = 0;
    let queue: Promise<void> = Promise.resolve();
    let pendingLine = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const launch = scriptLaunch(env, SCRIPT_BOOTSTRAP);
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, { ...launch.options, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ status: "error", text: `${TOOL}: the script runtime could not start (${describeError(error)}).` });
      return;
    }

    const stopTimer = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const startTimer = () => {
      stopTimer();
      if (outstanding === 0 && done === undefined && ending === undefined) {
        timer = setTimeout(() => end({ kind: "timeout" }), runMs);
      }
    };
    const end = (reason: Ending) => {
      ending ??= reason;
      stopTimer();
      inner.abort();
      child.kill("SIGKILL");
    };
    const onAbort = () => end({ kind: "stopped" });
    const settle = () => {
      if (settled || exit === undefined || outstanding > 0) return;
      settled = true;
      stopTimer();
      inner.abort();
      signal.removeEventListener("abort", onAbort);
      resolve(
        scriptResult({
          ending,
          done,
          exit,
          startFailure,
          stderr,
          runMs,
          cpuSeconds: env.cpuSeconds ?? SCRIPT_CPU_SECONDS,
        }),
      );
    };
    const send = (frame: unknown) => {
      if (ending !== undefined || child.stdin?.writable !== true) return;
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    };
    const finishInput = () => {
      if (done !== undefined && outstanding === 0) child.stdin?.end();
    };

    const onCall = (frame: Record<string, unknown>) => {
      const id = frame.id;
      if (done !== undefined) return end({ kind: "protocol", detail: "a tool call came after the script ended" });
      if (typeof id !== "number" || !Number.isSafeInteger(id) || usedIds.has(id)) {
        return end({ kind: "protocol", detail: "a tool call came without a new id" });
      }
      usedIds.add(id);
      calls += 1;
      const refusal =
        typeof frame.name === "string" && Object.hasOwn(blocked, frame.name) ? blocked[frame.name] : undefined;
      const admitted = calls > MAX_SCRIPT_CALLS ? callLimitText() : (refusal ?? admit(frame, callable));
      if (typeof admitted === "string") {
        // [>]: A refusal is answered at once and the running time keeps counting, so a loop of refused calls ends.
        send({ id, status: "error", text: admitted });
        return;
      }
      outstanding += 1;
      stopTimer();
      queue = queue.then(async () => {
        const result = inner.signal.aborted
          ? stopped(admitted.name)
          : await callSafely(callTool, admitted, inner.signal);
        send({ id, status: result.status, text: result.text });
        outstanding -= 1;
        startTimer();
        finishInput();
        settle();
      });
    };
    const onDone = (frame: Record<string, unknown>) => {
      if (done !== undefined) return end({ kind: "protocol", detail: "the script ended twice" });
      if (typeof frame.output !== "string" || (frame.error !== undefined && typeof frame.error !== "string")) {
        return end({ kind: "protocol", detail: "the script's end came without its output" });
      }
      done = { output: frame.output, ...(frame.error !== undefined ? { error: frame.error as string } : {}) };
      stopTimer();
      finishInput();
    };
    const onLine = (line: string) => {
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        return end({ kind: "protocol", detail: "it sent a line that is not JSON" });
      }
      if (isRecord(frame) && isRecord(frame.call)) return onCall(frame.call);
      if (isRecord(frame) && isRecord(frame.done)) return onDone(frame.done);
      end({ kind: "protocol", detail: "it sent a message that is neither a tool call nor its end" });
    };

    signal.addEventListener("abort", onAbort, { once: true });
    // [!]: Writes to a child that died (EPIPE) must not throw in the host; its exit settles the run.
    child.stdin?.on("error", () => {});
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (ending !== undefined) return;
      const parts = (pendingLine + chunk).split("\n");
      pendingLine = parts.pop() ?? "";
      if (pendingLine.length > MAX_FRAME_CHARS) {
        return end({ kind: "protocol", detail: `it sent a line over ${MAX_FRAME_CHARS} characters` });
      }
      for (const line of parts) {
        if (ending !== undefined) return;
        if (line.length > MAX_FRAME_CHARS) {
          return end({ kind: "protocol", detail: `it sent a line over ${MAX_FRAME_CHARS} characters` });
        }
        onLine(line);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(0, MAX_STDERR_CHARS);
    });
    child.on("error", (error) => {
      // [>]: Without a pid the process never started, so no `close` is sure to follow.
      if (child.pid !== undefined) return;
      startFailure = describeError(error);
      exit = { code: null, signal: null };
      settle();
    });
    child.on("close", (code, exitSignal) => {
      exit = { code, signal: exitSignal };
      // [>]: Nothing more can come from the child: a call it was waiting on is no longer wanted.
      inner.abort();
      settle();
    });

    if (signal.aborted) return end({ kind: "stopped" });
    const names = [...callable.map((tool) => tool.name), ...Object.keys(blocked)];
    child.stdin?.write(`${JSON.stringify({ code, tools: names })}\n`);
    startTimer();
  });
}

/** `callTool(call, signal)`, whose rejection, against its contract, becomes an `error` result for the script. */
async function callSafely(callTool: InnerCalls["run"], call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
  try {
    return await callTool(call, signal);
  } catch (error) {
    console.error("broke-code: a script's tool call failed", call.name, error);
    return { status: "error", text: `${call.name}: the tool failed (${describeError(error)}).` };
  }
}

function callLimitText(): string {
  return `${TOOL}: a script may make at most ${MAX_SCRIPT_CALLS} tool calls; this call was not made.`;
}

/**
 * The call the script asked for in `frame`, once checked against `callable`, or why it is refused: a tool the script
 * may not call, arguments that are not one object of text values, an unknown argument, or a required one missing.
 */
export function admit(frame: Record<string, unknown>, callable: readonly ToolSpec[]): ToolCall | string {
  const name = frame.name;
  const tool = callable.find((candidate) => candidate.name === name);
  if (typeof name !== "string" || tool === undefined) {
    const shown = typeof name === "string" ? excerpt(name) : "This tool";
    const names = callable.map((candidate) => candidate.name).join(", ");
    return `${shown} cannot be called from a script. A script can call: ${names || "no tool"}.`;
  }
  const args = frame.args;
  const example = tool.args[0] ? `{ ${tool.args[0].name}: "..." }` : "{}";
  if (!isRecord(args) || Object.values(args).some((value) => typeof value !== "string")) {
    return `${name} takes one object of arguments, such as ${name}(${example}).`;
  }
  const known = tool.args.map((arg) => arg.name);
  const unknown = Object.keys(args).find((key) => !known.includes(key));
  if (unknown !== undefined) {
    const list = known.length > 0 ? `Its arguments are: ${known.join(", ")}.` : "It takes no argument.";
    return `${name} has no argument ${excerpt(unknown)}. ${list}`;
  }
  const missing = tool.args.filter((arg) => arg.required && !Object.hasOwn(args, arg.name)).map((arg) => arg.name);
  if (missing.length > 0) {
    return `${name} is missing the required argument${missing.length > 1 ? "s" : ""} ${missing.join(", ")}.`;
  }
  return { name, args: { ...(args as Record<string, string>) } };
}

/** What a script that printed nothing and returned nothing gets back, so the model knows where its output went. */
const NO_OUTPUT = `${TOOL}: the script printed nothing and returned nothing. Print what you need to read with console.log, or return it.`;

/** The result of a script run, from how it ended. */
function scriptResult(run: {
  ending: Ending | undefined;
  done: Done | undefined;
  exit: { code: number | null; signal: NodeJS.Signals | null };
  startFailure: string | undefined;
  stderr: string;
  runMs: number;
  cpuSeconds: number;
}): ToolResult {
  const { ending, done, exit } = run;
  if (ending?.kind === "stopped") return stopped(TOOL);
  if (ending?.kind === "timeout") {
    const seconds = run.runMs / 1000;
    const text = `${TOOL}: the script ran for ${seconds} seconds without a tool call and was stopped. The tool calls it made before ran.`;
    return { status: "error", text };
  }
  if (ending?.kind === "protocol") {
    return { status: "error", text: `${TOOL}: the script was stopped, since ${ending.detail}.` };
  }
  if (done !== undefined) {
    const output = cutOutput(done.output);
    if (done.error !== undefined) {
      const line = `${TOOL}: the script stopped on an error: ${done.error}`;
      return { status: "error", text: output === "" ? line : `${output}\n${line}` };
    }
    return { status: "ok", text: output === "" ? NO_OUTPUT : output };
  }
  if (run.startFailure !== undefined) {
    return { status: "error", text: `${TOOL}: the script runtime could not start (${run.startFailure}).` };
  }
  return { status: "error", text: endedEarlyText(exit, run.stderr, run.cpuSeconds) };
}

/** `output` cut to its first 2,000 lines, with the usual notice. */
function cutOutput(output: string): string {
  const cut = truncateLines(output, MAX_MENTION_LINES);
  return cut.omitted > 0 ? `${cut.text}\n${truncationNotice(cut.omitted)}` : cut.text;
}

/**
 * Why the child ended before its done frame: the kernel limit on processor time (SIGXCPU), that limit failing to set
 * (`CPU_LIMIT_FAILED`), or another exit, such as `sandbox-exec` failing to apply the profile (exit 71), with the
 * child's first error lines.
 */
function endedEarlyText(
  exit: { code: number | null; signal: NodeJS.Signals | null },
  stderr: string,
  cpuSeconds: number,
): string {
  if (exit.signal === "SIGXCPU") {
    return `${TOOL}: the script used more than ${cpuSeconds} seconds of processor time and was stopped.`;
  }
  if (exit.code === CPU_LIMIT_FAILED) {
    const detail = stderr.trim() === "" ? "" : `:\n${stderr.trim()}`;
    return `${TOOL}: the limit on the script's processor time could not be set, so the script did not run${detail}`;
  }
  const how = exit.signal !== null ? `signal ${exit.signal}` : `exit code ${exit.code}`;
  const messages = stderr.trim();
  const detail = messages === "" ? "" : `:\n${messages}`;
  return `${TOOL}: the script runtime ended before the script did (${how}), so the script may not have run${detail}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.message : String(error);
}
