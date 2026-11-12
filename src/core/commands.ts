/**
 * @module commands
 * The `run_command` tool: one shell command, run hidden in a workspace folder once the user clicks Run, its output and
 * exit code returned to the model. `runCommandTool` checks the call and asks the approval; `runCommand` runs an
 * approved command. No `vscode` import: the host passes the shell and the timeout. Model-facing text is English and
 * never localized.
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { type Decision, rejectionText } from "./approval";
import type { ToolContext } from "./chatController";
import { accessFailureReason, MAX_MENTION_LINES, truncationNotice } from "./mentions";
import type { ToolSpec } from "./toolCalls";
import { excerpt, stopped, type ToolCall, type ToolResult } from "./tools";
import { locateWorkspacePath, type WorkspaceRoot } from "./workspaceFiles";

const TOOL = "run_command";

/** The tool as the model sees it: for the system prompt and the body tool call parser. */
export const RUN_COMMAND_TOOL: ToolSpec = {
  name: TOOL,
  description:
    "Run a shell command once the user approves it, and get its exit code, stdout, and stderr. The command runs with the user's shell, without a terminal: it cannot read input, so pass every answer on the command line. Each of stdout and stderr is cut to its first 2,000 lines and 1 MiB. The command is stopped when it runs too long, and the result says so with the output so far. Processes it leaves running in the background are stopped once it ends.",
  args: [
    {
      name: "command",
      required: true,
      description: "The shell command, as raw text; it may span several lines.",
    },
    {
      name: "cwd",
      required: false,
      oneLine: true,
      description:
        "Folder to run the command in, relative to the workspace folder. Leave it out to run in the workspace folder, the first one when the workspace has several.",
    },
  ],
};

/**
 * What an approved command runs with. `shell`: the program run as `<shell> -c <command>`. `timeoutMs`: how long the
 * command may run before its process group is stopped. `environment`: the child's whole environment, nothing else
 * inherited; absent, the host's. `launcher`: a program and its arguments placed before `<shell> -c <command>`, which
 * must replace itself with the shell (`exec`), so the spawned pid stays the shell's and leads the process group;
 * absent, the shell is spawned itself. The extension passes neither; the eval bench passes both to run a command in a
 * sandbox with a minimal environment. The rest is for tests: `killGraceMs`, how long the group has
 * between SIGTERM and SIGKILL (two seconds); `drainMs`, how long the output may keep coming once the shell exited
 * (200 ms); `kill`, what sends the signals (`process.kill`).
 */
export type CommandEnv = {
  shell: string;
  timeoutMs: number;
  environment?: Record<string, string>;
  launcher?: readonly [string, ...string[]];
  killGraceMs?: number;
  drainMs?: number;
  kill?: KillFunction;
};

/** `process.kill`'s shape: signal `pid`, a negative one naming a process group. Throws when the signal is not sent. */
export type KillFunction = (pid: number, signal: NodeJS.Signals | 0) => void;

/**
 * The shell commands run with: `terminalShell` (`vscode.env.shell`, the terminal's default profile, empty where VS Code
 * has none), else `shellEnv` (`$SHELL`), else `/bin/sh`.
 */
export function commandShell(terminalShell: string | undefined, shellEnv: string | undefined): string {
  return terminalShell || shellEnv || "/bin/sh";
}

/** An approved command. `cwd`: the real path of the folder it runs in, already checked. */
export type CommandRequest = { command: string; cwd: string };

/** Bytes kept of each of stdout and stderr; lines are kept up to `MAX_MENTION_LINES`. */
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2000;
/**
 * How long the output may keep coming once the shell exited, before the processes still holding it are stopped: a job
 * the command left in the background keeps the pipes open, and would keep the result waiting until the timeout.
 */
const DRAIN_MS = 200;
/**
 * How long the pipes may stay open once the signalled group is done, held by a process that left the group, before
 * the run settles.
 */
const CLOSE_AFTER_KILL_MS = 500;
/** How often a signalled group is checked for its end during the grace. */
const GROUP_POLL_MS = 20;

/**
 * Run `call` in `roots`: check `command` and `cwd`, ask the user through `context.requestApproval`, then run it with
 * `env`. Never rejects. Nothing runs unless the user clicked Run; a rejection gives its `rejectionText`, a cancelled
 * request the stopped error. Each approval runs the command once.
 */
export async function runCommandTool(
  call: ToolCall,
  roots: WorkspaceRoot[],
  context: Pick<ToolContext, "signal" | "requestApproval">,
  env: CommandEnv,
): Promise<ToolResult> {
  if (context.signal.aborted) return stopped(TOOL);
  if (roots.length === 0) return { status: "error", text: `${TOOL}: no workspace folder is open.` };
  const command = call.args.command ?? "";
  if (command.trim() === "") return { status: "error", text: `${TOOL}: the command is empty.` };
  const cwd = await commandFolder(roots, call.args.cwd);
  if (typeof cwd !== "string") return cwd;
  if (context.signal.aborted) return stopped(TOOL);

  let decision: Decision;
  try {
    decision = await context.requestApproval({ kind: "command", tool: TOOL, summary: command });
  } catch (error) {
    console.error("broke-code: could not ask the approval of a command", error);
    return {
      status: "error",
      text: `${TOOL}: the command could not be shown for approval (${excerpt(String(error))}). Nothing ran.`,
    };
  }
  switch (decision.kind) {
    case "cancel":
      return stopped(TOOL);
    case "reject":
      return { status: "error", text: rejectionText(decision.reason, "command") };
    case "accept":
      return runCommand({ command, cwd }, context, env);
  }
}

/**
 * The real path of the folder a command runs in: `cwd` resolved as a read tool's path, which must be an existing
 * folder inside the workspace, or the first workspace folder when `cwd` is left out or empty. Else the error result.
 *
 * [!]: The shell opens the folder by name after the check, so a folder swapped for a symlink out between the two is
 * entered. Accepted, as for `search`: a process that can swap workspace files already runs with the user's rights.
 */
async function commandFolder(roots: WorkspaceRoot[], cwd: string | undefined): Promise<string | ToolResult> {
  const given = cwd !== undefined && cwd !== "";
  const path = given ? cwd : ".";
  try {
    const located = await locateWorkspacePath(given ? roots : roots.slice(0, 1), path);
    if (located.status !== "ok") return refused(path, accessFailureReason(located.status));
    if (!(await stat(located.realPath)).isDirectory()) return refused(path, "the path is not a folder");
    return located.realPath;
  } catch (error) {
    return refused(path, accessFailureReason("unreadable", errorCode(error)));
  }
}

function refused(path: string, reason: string): ToolResult {
  return { status: "error", text: `${TOOL}: ${excerpt(path)}: ${reason}.` };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
}

/**
 * Run approved `request` as `<shell> -c <command>`, after `env.launcher` when given: hidden, in its own process group,
 * stdin closed, with `env.environment`, else the host's environment inherited. Never rejects. The result starts with
 * `exit code N`, `killed by <signal>`, or `stopped after N seconds` at the timeout, then a `stdout:` and a `stderr:`
 * section, each cut to its first 2,000 lines and 1 MiB; it is `ok` only on exit code 0.
 *
 * The timeout and `context.signal` (Stop) end the whole group, a pipeline's other processes included: SIGTERM, then
 * SIGKILL after the grace. Processes the command leaves in its group once the shell exits are stopped the same way,
 * since nothing could reach them afterwards. Once the group is signalled, the run settles when the group is gone or
 * SIGKILL was sent, so the result never claims a stop that has not happened, and when the output pipes close, at most
 * a moment past that, so a process that left the group cannot keep the turn waiting. A signal that fails for another
 * reason than a group already gone adds a line naming it. `killRunningCommands` ends every group still running at once.
 */
export function runCommand(
  request: CommandRequest,
  context: Pick<ToolContext, "signal">,
  env: CommandEnv,
): Promise<ToolResult> {
  const { signal } = context;
  if (signal.aborted) return Promise.resolve(stopped(TOOL));
  const graceMs = env.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const kill = env.kill ?? process.kill;

  const [program = env.shell, ...args] = [...(env.launcher ?? []), env.shell, "-c", request.command];
  const programName = env.launcher === undefined ? `the shell ${excerpt(env.shell)}` : excerpt(program);

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // [!]: `detached` makes the shell lead a process group of its own, so a kill of `-pid` reaches every process
      // of the command, not only the shell. stdin is closed: a command waiting for input reads end of file at once.
      child = spawn(program, args, {
        cwd: request.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: env.environment ?? process.env,
      });
    } catch (error) {
      // [>]: spawn throws, rather than emitting `error`, for an argument it refuses, such as one holding a NUL byte.
      resolve(couldNotStart(programName, error));
      return;
    }
    const pgid = child.pid;

    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let ending: Ending | undefined;
    let groupEnd: GroupEnd | undefined;
    const signalFailures: string[] = [];
    let closed = false;
    let settled = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    // [!]: Once released, the run never signals or probes its group id again: the system may have reused it.
    let released = false;
    const releaseOwnership =
      pgid === undefined ? () => {} : ownCommandGroup(pgid, (failure) => killedOnDeactivation(failure));
    const release = () => {
      released = true;
      releaseOwnership();
      clearInterval(pollTimer);
      clearTimeout(killTimer);
    };
    const alive = () => !released && groupAlive(kill, pgid);

    const settle = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      release();
      for (const timer of [timeout, drainTimer, closeTimer]) clearTimeout(timer);
      clearInterval(pollTimer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const finish = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(
        commandResult({ exit, ending, groupEnd, signalFailures, timeoutMs: env.timeoutMs, graceMs, stdout, stderr }),
      );
    };
    /**
     * `killRunningCommands` sent SIGKILL, or failed to (`failure`, its code). A run not yet stopping ends as stopped; a
     * timeout or leftover cleanup keeps its reason.
     */
    const killedOnDeactivation = (failure: string | undefined) => {
      if (settled) return;
      ending ??= "stopped";
      clearTimeout(timeout);
      clearTimeout(drainTimer);
      if (failure !== undefined) signalFailures.push(signalFailureLine("SIGKILL", failure));
      groupDone(failure === undefined ? "killedAtOnce" : "unreachable");
    };
    /** The run may settle: the group was never signalled, or it is done and its pipes closed. */
    const finishIfDone = () => {
      if (ending === undefined || (groupEnd !== undefined && closed)) finish();
    };
    /** Signal the group; false when the signal could not be sent, a line then saying why. */
    const send = (name: NodeJS.Signals): boolean => {
      if (pgid === undefined || released) return true;
      const failure = killGroup(kill, pgid, name);
      if (failure === undefined) return true;
      // [>]: Logged too: after a Stop the controller drops the result, line included.
      console.error(`broke-code: could not send ${name} to the command group ${pgid} (${failure})`);
      signalFailures.push(signalFailureLine(name, failure));
      return false;
    };
    /** The group is gone or got SIGKILL: no signal goes to its id again, since the system may reuse it. */
    const groupDone = (how: GroupEnd) => {
      groupEnd = how;
      release();
      // [>]: A process that left the group may still hold a pipe: the result waits for it only a moment.
      if (!closed) closeTimer = setTimeout(finish, CLOSE_AFTER_KILL_MS);
      finishIfDone();
    };
    /** SIGTERM to the group, then a check for its end until SIGKILL at the grace. */
    const endGroup = (reason: Ending) => {
      if (ending !== undefined) return;
      ending = reason;
      clearTimeout(drainTimer);
      if (pgid === undefined || released) return;
      send("SIGTERM");
      pollTimer = setInterval(() => {
        if (!alive()) groupDone("gone");
      }, GROUP_POLL_MS);
      killTimer = setTimeout(() => groupDone(send("SIGKILL") ? "killed" : "unreachable"), graceMs);
    };
    /** Once the shell exited: a process still in its group was left behind, and nothing else could stop it. */
    const afterExit = () => {
      if (alive()) endGroup("leftover");
      else finish();
    };

    const onAbort = () => {
      // [>]: A command that already exited ran to its end: its result stands, whatever ends the wait for its output.
      if (exit === undefined) endGroup("stopped");
      else if (ending === undefined) afterExit();
    };
    const timeout = setTimeout(() => endGroup("timeout"), env.timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      // [>]: Without a pid the shell never started (ENOENT, EACCES), so no `close` is sure to follow.
      if (child.pid === undefined) settle(couldNotStart(programName, error));
    });
    child.on("exit", (code, exitSignal) => {
      exit = { code, signal: exitSignal };
      clearTimeout(timeout);
      // [>]: A process the command started may hold the pipes open, in the group or out of it: the output gets a
      // moment to drain, then the result no longer waits for it.
      if (ending === undefined) drainTimer = setTimeout(afterExit, env.drainMs ?? DRAIN_MS);
    });
    child.on("close", () => {
      closed = true;
      // [>]: A job left in the background with its output redirected holds no pipe, so only this check finds it.
      if (ending === undefined && alive()) endGroup("leftover");
      finishIfDone();
    });
  });
}

/**
 * Why the group was signalled. `timeout` and `stopped`: before the shell exited. `leftover`: after, to stop processes
 * the command left running.
 */
type Ending = "timeout" | "stopped" | "leftover";

/**
 * How a signalled group ended: `gone` once no process of it is left, `killed` once SIGKILL was sent at the grace,
 * `killedAtOnce` once `killRunningCommands` sent it, `unreachable` when SIGKILL could not be sent.
 */
type GroupEnd = "gone" | "killed" | "killedAtOnce" | "unreachable";

function signalFailureLine(name: NodeJS.Signals, failure: string): string {
  return `Sending ${name} to the command's processes failed (${failure}).`;
}

/** A run's claim on its process group, by identity: two runs may see the same id, one after the other. */
type GroupOwner = { pgid: number; onKilled: (failure: string | undefined) => void };

/** The groups of commands still running, or stopped but not yet gone or sent SIGKILL: what `killRunningCommands` ends. */
const owners = new Set<GroupOwner>();

/**
 * Claim group `pgid` for a run until the returned release is called (any number of times; it releases this claim
 * only). `killRunningCommands` calls `onKilled` once after its SIGKILL, with the failure's code when it failed, and
 * releases the claim; the run must then never signal the id again. Exported for the ownership tests.
 */
export function ownCommandGroup(pgid: number, onKilled: (failure: string | undefined) => void): () => void {
  const owner: GroupOwner = { pgid, onKilled };
  owners.add(owner);
  return () => owners.delete(owner);
}

/**
 * Send SIGKILL at once to the group of every command still owned: running, or stopped but still in its grace. For the
 * extension's `deactivate`: the host may exit right after it, and a timer would die with it, leaving a process that
 * ignores SIGTERM running. A host that crashes never calls it. Each run is told and cancels its pending signals.
 */
export function killRunningCommands(): void {
  const killed = [...owners];
  owners.clear();
  for (const { pgid, onKilled } of killed) {
    const failure = killGroup(process.kill, pgid, "SIGKILL");
    if (failure !== undefined) console.error(`broke-code: could not kill the command group ${pgid} (${failure})`);
    onKilled(failure);
  }
}

/**
 * Send `name` to every process of group `pgid`: `undefined` when sent or when nothing is left to signal, else the
 * error's code or message.
 */
function killGroup(kill: KillFunction, pgid: number, name: NodeJS.Signals): string | undefined {
  try {
    kill(-pgid, name);
    return undefined;
  } catch (error) {
    // [>]: ESRCH: no process of the group is left, which is the goal. EPERM: see `groupAlive`.
    const code = errorCode(error);
    return code === "ESRCH" || code === "EPERM" ? undefined : code;
  }
}

/**
 * True when group `pid` holds a process this host may signal. [&]: macOS answers EPERM for a group of zombies not yet
 * reaped, and for one whose processes changed user (setuid), which could not be stopped anyway: neither counts. Signal
 * 0 fails for no other reason; should it, the group counts as alive, so the stop goes on and its failure shows.
 */
function groupAlive(kill: KillFunction, pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    return code !== "ESRCH" && code !== "EPERM";
  }
}

/** `program`: what was spawned, as the result names it ("the shell /bin/zsh", or the launcher's path). */
function couldNotStart(program: string, error: unknown): ToolResult {
  return {
    status: "error",
    text: `${TOOL}: the command could not start with ${program} (${excerpt(errorCode(error))}).`,
  };
}

function commandResult(run: {
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  ending: Ending | undefined;
  groupEnd: GroupEnd | undefined;
  signalFailures: string[];
  timeoutMs: number;
  graceMs: number;
  stdout: CapturedOutput;
  stderr: CapturedOutput;
}): ToolResult {
  const unreachable = run.groupEnd === "unreachable";
  if (run.ending === "stopped" && run.signalFailures.length === 0) return stopped(TOOL);
  const failures = run.signalFailures.map((line) => `\n${line}`).join("");
  if (run.ending === "stopped") {
    const first = unreachable
      ? `${TOOL}: Stop could not end the command; its processes may still be running.`
      : stopped(TOOL).text;
    return { status: "error", text: `${first}\n${failures}` };
  }
  const sections = `${section("stdout", run.stdout)}\n${section("stderr", run.stderr)}`;
  if (run.ending === "timeout") {
    const seconds = run.timeoutMs / 1000;
    // [>]: "stopped after N seconds" only once the stop happened; the step row reads that first line.
    const first = unreachable
      ? `timed out after ${seconds} seconds; its processes could not be stopped and may still be running`
      : `stopped after ${seconds} seconds`;
    const tail = failures === "" ? "" : `\n${failures}`;
    return { status: "error", text: `${first}\n${sections}${tail}` };
  }
  const leftover = run.ending === "leftover" ? `\n\n${leftoverLine(run.groupEnd, run.graceMs)}${failures}` : "";
  const code = run.exit?.code ?? null;
  const first = code !== null ? `exit code ${code}` : `killed by ${run.exit?.signal ?? "an unknown signal"}`;
  return { status: code === 0 ? "ok" : "error", text: `${first}\n${sections}${leftover}` };
}

/** What became of the processes the command left running, as true when the result settles. */
function leftoverLine(groupEnd: GroupEnd | undefined, graceMs: number): string {
  const subject = "The processes the command left running in the background";
  switch (groupEnd) {
    case "killed":
      return `${subject} did not stop on SIGTERM; they were sent SIGKILL after ${graceMs / 1000} seconds.`;
    case "killedAtOnce":
      return `${subject} were sent SIGKILL as the extension shut down.`;
    case "unreachable":
      return `${subject} could not be stopped; they may still be running.`;
    default:
      return `${subject} were stopped.`;
  }
}

/** `name:` then the output on the lines after it, or `name: (empty)`. */
function section(name: string, output: CapturedOutput): string {
  const text = output.text();
  return text === "" ? `${name}: (empty)` : `${name}:\n${text}`;
}

/**
 * One output stream, kept to its first 2,000 lines and 1 MiB; the rest is counted, never stored, so memory stays
 * bounded whatever the command writes. Lines end at `\n` only: a `\r` of a progress bar stays inside its line.
 */
class CapturedOutput {
  private readonly chunks: Buffer[] = [];
  private keptBytes = 0;
  private totalBytes = 0;
  private newlines = 0;
  private lastByte: number | undefined;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    const room = MAX_OUTPUT_BYTES - this.keptBytes;
    if (room > 0) {
      const kept = chunk.subarray(0, room);
      this.chunks.push(kept);
      this.keptBytes += kept.length;
    }
    this.totalBytes += chunk.length;
    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, index + 1)) this.newlines++;
    this.lastByte = chunk[chunk.length - 1];
  }

  /** The output as the result shows it: its kept lines without the final line break, then the notice if cut. */
  text(): string {
    if (this.totalBytes === 0) return "";
    const totalLines = this.newlines + (this.lastByte === 10 ? 0 : 1);
    const kept = new TextDecoder().decode(toCharacterBoundary(Buffer.concat(this.chunks)));
    const lines = kept.split("\n");
    // [>]: A final line break ends the last line, not a new one.
    if (lines[lines.length - 1] === "") lines.pop();
    const byteCut = this.totalBytes > this.keptBytes;
    const shown = lines.slice(0, MAX_MENTION_LINES);
    // [>]: A line the byte cap cut is shown in part, so it counts among the lines not shown.
    const partial = byteCut && shown.length === lines.length && !kept.endsWith("\n") ? 1 : 0;
    const omitted = totalLines - (shown.length - partial);
    const body = shown.join("\n");
    return omitted > 0 ? `${body}\n${truncationNotice(omitted)}` : body;
  }
}

/** `bytes` without a UTF-8 character the byte cap cut in its middle. */
function toCharacterBoundary(bytes: Buffer): Buffer {
  let end = bytes.length;
  // [>]: The decoder would turn a cut character into U+FFFD, a character the command never wrote: drop it instead.
  let start = end - 1;
  while (start >= 0 && start > end - 4 && (bytes[start]! & 0xc0) === 0x80) start--;
  if (start < 0) return bytes;
  const lead = bytes[start]!;
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (start + length > end) end = start;
  return bytes.subarray(0, end);
}
