/**
 * @module run
 * One run of a scenario: the chat controller the extension runs, hosted through its ports with the read and write tools
 * over a throwaway copy of the fixture under the system temporary directory, each write applied at once and recorded, no
 * instruction file, no skill, an in-memory conversation store, and the bench's step limit. The copy is removed when
 * the run ends, also when it throws.
 */
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { ChatController, type ChoiceStore } from "../src/core/chatController";
import { ConversationStore } from "../src/core/conversationStore";
import { DEFAULT_CONTEXT_SIZE, parseLimits } from "../src/core/limits";
import type { ChatEntry } from "../src/core/protocol";
import { workspaceToolRunner } from "../src/core/toolRunner";
import { ripgrepCandidates } from "../src/core/tools";
import { type ChangeApplier, fileApplier, type PlannedChange } from "../src/core/writeTools";
import type { Scenario, WorkspaceFiles } from "./scenarios";

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
 * the workspace copy's files.
 */
export type RunOutcome = { entries: ChatEntry[]; planned: AppliedChange[]; after: WorkspaceFiles };

/**
 * Play `scenario` once on `target`: copy its fixture under `tmpRoot`, send its message, and wait for the agent turn to
 * end. Throws when the provider does not list the model, or the copy cannot be made or read back.
 */
export async function playScenario(scenario: Scenario, target: RunTarget, tmpRoot = tmpdir()): Promise<RunOutcome> {
  const copy = await mkdtemp(join(tmpRoot, "broke-code-eval-"));
  const planned: AppliedChange[] = [];
  try {
    await writeWorkspace(copy, scenario.files);
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
      tools: workspaceToolRunner(
        () => [root],
        toolEnv,
        (roots) => recording(fileApplier(roots), planned),
      ),
      instructions: { read: async () => [] },
      skills: { read: async () => ({ skills: [], warnings: [] }) },
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
    await rm(copy, { recursive: true, force: true });
  }
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

async function writeWorkspace(directory: string, files: WorkspaceFiles): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const file = join(directory, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

/** Every regular file under `directory`, by POSIX path relative to it. */
async function readWorkspace(directory: string): Promise<WorkspaceFiles> {
  // [!]: Null prototype: a file named `__proto__` must land as a path, not reach the setter.
  const files: WorkspaceFiles = Object.create(null);
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    files[relative(directory, file).split(sep).join("/")] = await readFile(file, "utf8");
  }
  return files;
}

function memoryChoices(): ChoiceStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => void values.set(key, value),
  };
}
