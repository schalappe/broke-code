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
      description:
        "Folder to run the command in, relative to the workspace folder. Leave it out to run in the workspace folder, the first one when the workspace has several.",
    },
  ],
};

/**
 * What an approved command runs with. `shell`: the program run as `<shell> -c <command>`. `timeoutMs`: how long the
 * command may run before its process group is stopped. `killGraceMs`: how long the group has between SIGTERM and
 * SIGKILL, two seconds unless set (tests shorten it).
 */
export type CommandEnv = { shell: string; timeoutMs: number; killGraceMs?: number };

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
/** How long the pipes may stay open after SIGKILL, held by a process that left the group, before the run settles. */
const CLOSE_AFTER_KILL_MS = 500;

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
 * Run approved `request` as `<shell> -c <command>`: hidden, in its own process group, stdin closed, the host's
 * environment inherited. Never rejects. The result starts with `exit code N`, `killed by <signal>`, or `stopped after N
 * seconds` at the timeout, then a `stdout:` and a `stderr:` section, each cut to its first 2,000 lines and 1 MiB; it
 * is `ok` only on exit code 0.
 *
 * The timeout and `context.signal` (Stop) end the whole group, a pipeline's other processes included: SIGTERM, then
 * SIGKILL after the grace. Processes the command leaves in its group once the shell exits are stopped the same way,
 * since nothing could reach them afterwards. The run settles once the output pipes close, at most a moment after
 * SIGKILL, so a process that ignores SIGTERM cannot keep the turn waiting.
 */
export function runCommand(
  request: CommandRequest,
  context: Pick<ToolContext, "signal">,
  env: CommandEnv,
): Promise<ToolResult> {
  const { signal } = context;
  if (signal.aborted) return Promise.resolve(stopped(TOOL));
  const graceMs = env.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // [!]: `detached` makes the shell lead a process group of its own, so a kill of `-pid` reaches every process
      // of the command, not only the shell. stdin is closed: a command waiting for input reads end of file at once.
      child = spawn(env.shell, ["-c", request.command], {
        cwd: request.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (error) {
      // [>]: spawn throws, rather than emitting `error`, for an argument it refuses, such as one holding a NUL byte.
      resolve(couldNotStart(env.shell, error));
      return;
    }

    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let ending: Ending | undefined;
    let settled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(closeTimer);
      clearTimeout(drainTimer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const finish = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(commandResult({ exit, ending, timeoutMs: env.timeoutMs, stdout, stderr }));
    };
    /**
     * SIGTERM to the group, SIGKILL after the grace. The SIGKILL is never cancelled, also once the result settled: a
     * process that ignores SIGTERM and holds no pipe would outlive it. The result waits for the pipes to close, at most
     * a moment past the SIGKILL, since a process that left the group may still hold one.
     */
    const endGroup = (reason: Ending) => {
      if (ending !== undefined) return;
      ending = reason;
      const pid = child.pid;
      if (pid === undefined) return;
      killGroup(pid, "SIGTERM");
      setTimeout(() => killGroup(pid, "SIGKILL"), graceMs).unref();
      closeTimer = setTimeout(finish, graceMs + CLOSE_AFTER_KILL_MS);
    };
    /** Once the shell exited: a process still in its group was left behind, and nothing else could stop it. */
    const afterExit = () => {
      if (groupAlive(child.pid)) endGroup("leftover");
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
      if (child.pid === undefined) settle(couldNotStart(env.shell, error));
    });
    child.on("exit", (code, exitSignal) => {
      exit = { code, signal: exitSignal };
      clearTimeout(timeout);
      // [>]: A process the command started may hold the pipes open, in the group or out of it: the output gets a
      // moment to drain, then the result no longer waits for it.
      if (ending === undefined) drainTimer = setTimeout(afterExit, DRAIN_MS);
    });
    child.on("close", () => {
      // [>]: A job left in the background with its output redirected holds no pipe, so only this check finds it.
      if (ending === undefined && groupAlive(child.pid)) endGroup("leftover");
      finish();
    });
  });
}

/**
 * Why the group was signalled. `timeout` and `stopped`: before the shell exited. `leftover`: after, to stop processes
 * the command left running.
 */
type Ending = "timeout" | "stopped" | "leftover";

/** Send `name` to every process of group `pgid`. */
function killGroup(pgid: number, name: NodeJS.Signals): void {
  try {
    process.kill(-pgid, name);
  } catch {
    // [>]: ESRCH: no process of the group is left, which is the goal.
  }
}

/**
 * True when group `pid` holds a process this host may signal. [&]: macOS answers EPERM for a group of zombies not yet
 * reaped, and for one whose processes changed user (setuid), which could not be stopped anyway: neither counts.
 */
function groupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function couldNotStart(shell: string, error: unknown): ToolResult {
  return {
    status: "error",
    text: `${TOOL}: the command could not start with the shell ${excerpt(shell)} (${excerpt(errorCode(error))}).`,
  };
}

function commandResult(run: {
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  ending: Ending | undefined;
  timeoutMs: number;
  stdout: CapturedOutput;
  stderr: CapturedOutput;
}): ToolResult {
  if (run.ending === "stopped") return stopped(TOOL);
  const sections = `${section("stdout", run.stdout)}\n${section("stderr", run.stderr)}`;
  const leftover =
    run.ending === "leftover" ? "\n\nThe processes the command left running in the background were stopped." : "";
  if (run.ending === "timeout") {
    return { status: "error", text: `stopped after ${run.timeoutMs / 1000} seconds\n${sections}` };
  }
  const code = run.exit?.code ?? null;
  const first = code !== null ? `exit code ${code}` : `killed by ${run.exit?.signal ?? "an unknown signal"}`;
  return { status: code === 0 ? "ok" : "error", text: `${first}\n${sections}${leftover}` };
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
  // [>]: Back over continuation bytes (10xxxxxx) to the lead byte, then drop it unless its character is whole.
  let start = end - 1;
  while (start >= 0 && start > end - 4 && (bytes[start]! & 0xc0) === 0x80) start--;
  if (start < 0) return bytes;
  const lead = bytes[start]!;
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (start + length > end) end = start;
  return bytes.subarray(0, end);
}
