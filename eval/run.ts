/**
 * @module run
 * One run of a scenario: the chat controller the extension runs, hosted through its ports with the read and write
 * tools, `run_command`, and `load_skill` over a throwaway copy of the fixture under the system temporary directory, each
 * write applied at once and recorded, each command approved at once and run with `/bin/sh` in the copy, the skills
 * discovered as the extension does but in a throwaway copy of the scenario's home fixture (never the real home), no
 * instruction file, an in-memory conversation store, and the bench's step limit. The copies are removed when the run
 * ends, also when it throws.
 */
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { ChatController, type ChoiceStore, type ToolRunner } from "../src/core/chatController";
import type { CommandEnv } from "../src/core/commands";
import { ConversationStore } from "../src/core/conversationStore";
import { DEFAULT_CONTEXT_SIZE, parseLimits } from "../src/core/limits";
import type { ChatEntry } from "../src/core/protocol";
import { readSkills } from "../src/core/skills";
import { workspaceToolRunner } from "../src/core/toolRunner";
import { ripgrepCandidates } from "../src/core/tools";
import { type ChangeApplier, fileApplier, type PlannedChange } from "../src/core/writeTools";
import type { Scenario, WorkspaceFiles, WorkspaceSnapshot } from "./scenarios";

/**
 * How the bench runs a command: `/bin/sh`, the shell the extension falls back to, so a run reads no user profile, and
 * 10 seconds, far above the milliseconds a command over a fixture takes, so a command that waits fails the run in
 * seconds rather than after the extension's 120.
 */
export const BENCH_COMMAND_ENV: CommandEnv = { shell: "/bin/sh", timeoutMs: 10_000 };

/**
 * Where and how a run plays. `baseUrl`: an OpenAI-compatible provider without a key. `maxToolSteps`: the turn's step
 * limit, small so a looping model fails fast.
 */
export type RunTarget = { baseUrl: string; model: string; maxToolSteps: number };

/**
 * A change a write tool handed to the applier, as the dump records it: `before` is `null` for a new file, `status` the
 * applier's result. `target` is left out: it names the throwaway copy, removed once the run ends.
 */
export type AppliedChange = Omit<PlannedChange, "target" | "before"> & {
  before: string | null;
  status: "ok" | "error";
};

/**
 * What the bench reads after a run: the conversation's entries, each change handed to the applier in call order, and
 * every entry of the workspace copy but its folders.
 */
export type RunOutcome = { entries: ChatEntry[]; planned: AppliedChange[]; after: WorkspaceSnapshot };

/**
 * Play `scenario` once on `target`: copy its workspace and home fixtures under `tmpRoot`, send its message, and wait
 * for the agent turn to end. Throws when the provider does not list the model, or a copy cannot be made or read back.
 */
export async function playScenario(scenario: Scenario, target: RunTarget, tmpRoot = tmpdir()): Promise<RunOutcome> {
  const runFolder = await mkdtemp(join(tmpRoot, "broke-code-eval-"));
  const copy = join(runFolder, "workspace");
  const home = join(runFolder, "home");
  const planned: AppliedChange[] = [];
  try {
    await writeWorkspace(copy, scenario.files);
    await writeWorkspace(home, scenario.home ?? {});
    // [>]: The tools compare resolved paths; on macOS the temporary directory sits behind the /var symlink.
    const root = { name: basename(copy), path: await realpath(copy) };
    const toolEnv = { ripgrepCandidates: ripgrepCandidates(undefined, process.env.PATH) };
    // [>]: The loaded context, not the model card's: Ollama loads both bench models with 32,768 tokens.
    const limits = parseLimits({
      maxToolSteps: target.maxToolSteps,
      contextSizes: { [target.model]: DEFAULT_CONTEXT_SIZE },
    });
    const controller = new ChatController({
      apiKeys: { get: async () => undefined },
      workspaceState: memoryChoices(),
      publish: () => {},
      mentions: {
        read: async (path) => {
          throw new Error(`The bench message mentions nothing, yet ${path} was read.`);
        },
      },
      store: new ConversationStore(undefined),
      tools: approvingCommands(
        workspaceToolRunner(
          () => [root],
          toolEnv,
          (roots) => recording(fileApplier(roots), planned),
          () => BENCH_COMMAND_ENV,
        ),
      ),
      instructions: { read: async () => [] },
      // [!]: Never `homedir()`: the maintainer's own skills would change the prompt between runs and machines.
      skills: { read: () => readSkills(home, [root]) },
      limits: { read: () => limits },
    });

    controller.setProviders({ providers: [{ name: "Ollama", baseUrl: target.baseUrl }], skipped: [] });
    // [>]: `setProviders` starts a listing it does not return; this one supersedes it and can be awaited.
    await controller.loadModels();
    const models = controller.snapshot.models;
    if (models.status !== "loaded") throw new Error(`Could not list the models: ${JSON.stringify(models)}`);
    controller.selectModel(target.model);
    if (controller.snapshot.model !== target.model) {
      throw new Error(`${target.model} is not listed by ${target.baseUrl}.`);
    }

    await controller.send(scenario.message);
    return { entries: controller.snapshot.entries, planned, after: await readWorkspace(copy) };
  } finally {
    await rm(runFolder, { recursive: true, force: true });
  }
}

/**
 * `runner`, with every approval request of its runs accepted at once: the bench plays the model, not the user, and the
 * product never auto-approves a command, so this lives in the run context the bench hands the tools, not in a setting.
 * Only `run_command` asks; a write goes straight to the bench's applier.
 */
function approvingCommands(runner: ToolRunner): ToolRunner {
  return {
    tools: runner.tools,
    run: (call, context) => runner.run(call, { ...context, requestApproval: async () => ({ kind: "accept" }) }),
  };
}

/** `apply`, appending each change it is handed and its result's status to `planned`. */
function recording(apply: ChangeApplier, planned: AppliedChange[]): ChangeApplier {
  return async (change) => {
    const result = await apply(change);
    const { tool, path, before, after } = change;
    planned.push({ tool, path, before: before ?? null, after, status: result.status });
    return result;
  };
}

/** Writes `files` under `directory`, creating it even when `files` is empty. */
async function writeWorkspace(directory: string, files: WorkspaceFiles): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    const file = join(directory, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

/**
 * Every entry under `directory` but its folders, by POSIX path relative to it: a command may add a symlink or a FIFO as
 * well as a file, and the judge must see it. A symlink is recorded, never followed, a link to a folder included.
 */
async function readWorkspace(directory: string): Promise<WorkspaceSnapshot> {
  // [!]: Null prototype: a file named `__proto__` must land as a path, not reach the setter.
  const entries: WorkspaceSnapshot = Object.create(null);
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const key = relative(directory, path).split(sep).join("/");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) entries[key] = await readFile(path, "utf8");
      else if (entry.isSymbolicLink()) entries[key] = { symlink: await readlink(path) };
      else entries[key] = { special: specialKind(entry) };
    }
  };
  await walk(directory);
  return entries;
}

function specialKind(entry: Dirent): string {
  if (entry.isFIFO()) return "fifo";
  if (entry.isSocket()) return "socket";
  if (entry.isBlockDevice()) return "blockDevice";
  if (entry.isCharacterDevice()) return "characterDevice";
  return "unknown";
}

function memoryChoices(): ChoiceStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => void values.set(key, value),
  };
}
