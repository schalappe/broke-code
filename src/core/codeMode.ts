/**
 * @module codeMode
 * Code Mode in the extension: the experimental user setting `brokeCode.codeMode`, the script runtime (the extension
 * host's own executable run as Node), and the per-window probe that must pass before a send offers `run_script`
 * (`CodeModeSwitch`). The controller asks once per send (`ChatPorts.codeMode`); the answer gates both the tool list
 * and the runtime. No `vscode` import.
 */
import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { InspectedSetting } from "./approval";
import { type ScriptEnv, scriptProblem } from "./script";

/**
 * Whether Code Mode is on: only the user (`globalValue`) value `true` turns it on, so a workspace `settings.json` never
 * does, and any other value (absent, `false`, a string) leaves it off. The manifest's `application` scope already
 * makes VS Code ignore a workspace value; reading `globalValue` keeps that explicit here.
 */
export function codeModeSetting(inspected: InspectedSetting | undefined): boolean {
  return inspected?.globalValue === true;
}

/**
 * The runtime of the extension's scripts: `execPath`, the extension host's own executable, by its real path, run as
 * Node (`ELECTRON_RUN_AS_NODE=1`, the child's only variable), with the Electron frameworks it loads readable, each
 * `*.framework` folder of its app bundle's `Contents/Frameworks` (measured on VSCodium 1.143: the helper aborts
 * without the four of them, and needs nothing else of the bundle). Outside an app bundle (a plain `node`), nothing is
 * readable beyond the profile's own allowances. Rejects only when `execPath` cannot be resolved.
 */
export async function hostScriptEnv(execPath: string): Promise<ScriptEnv> {
  const runtime = await realpath(execPath);
  const frameworks = frameworksFolder(runtime);
  const readable = frameworks === undefined ? [] : await frameworkBundles(frameworks);
  return { runtime: [runtime], environment: { ELECTRON_RUN_AS_NODE: "1" }, readable };
}

/**
 * The `Contents/Frameworks` folder of the app bundle `runtime` belongs to: the nearest folder above it named
 * `Frameworks` inside a `Contents` folder (a helper, `….app/Contents/Frameworks/… Helper.app/Contents/MacOS/…`), else
 * the `Frameworks` beside the `MacOS` folder holding it (the app's main executable); `undefined` outside a bundle.
 */
function frameworksFolder(runtime: string): string | undefined {
  for (let folder = dirname(runtime); folder !== dirname(folder); folder = dirname(folder)) {
    if (basename(folder) === "Frameworks" && basename(dirname(folder)) === "Contents") return folder;
  }
  const macOS = dirname(runtime);
  if (basename(macOS) === "MacOS" && basename(dirname(macOS)) === "Contents") return join(dirname(macOS), "Frameworks");
  return undefined;
}

/** The real paths of the `*.framework` folders in `folder`, sorted; none when it cannot be listed. */
async function frameworkBundles(folder: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    // [>]: The probe then fails on the missing frameworks and says so: Code Mode stays off, visibly.
    return [];
  }
  const bundles = names.filter((name) => name.endsWith(".framework")).sort();
  return Promise.all(bundles.map((name) => realpath(join(folder, name))));
}

/**
 * What `CodeModeSwitch` needs from the host. `enabled`: the setting (`codeModeSetting`), read at each send.
 * `scriptEnv`: the runtime (`hostScriptEnv`); a rejection is a failed probe. `warn`: shows why Code Mode is off in this
 * window, once per failed probe. `probe`: for tests, `scriptProblem` by default.
 */
export type CodeModeHost = {
  enabled(): boolean;
  scriptEnv(): Promise<ScriptEnv>;
  warn(problem: string): void;
  probe?: (env: ScriptEnv, signal: AbortSignal) => Promise<string | undefined>;
};

/** A probe's settled outcome, kept for the window: the runtime that passed, or why it failed. */
type Probed = { env: ScriptEnv } | { problem: string };

/**
 * Whether a send offers `run_script`, for `ChatPorts.codeMode`. Off while the setting is off. On, the first send that
 * asks probes the runtime (`scriptProblem`: the real launch, a full round trip, a time bound), lazily and once per
 * window: a pass gives the runtime to every later send; a failure gives none, and `warn` says why once. A probe the
 * send's Stop aborts is not kept, so the next send probes again. The kept outcome is dropped when the setting changes
 * (`settingChanged`) or reads as off, so turning it off then on probes again; a probe that settles after such a drop
 * is not kept. Never rejects.
 */
export class CodeModeSwitch {
  private probed: Probed | undefined;
  /** Bumped at each drop, so a probe that started before it is not kept. */
  private generation = 0;

  constructor(private readonly host: CodeModeHost) {}

  /** The runtime this send's scripts run with, or `undefined` when the send offers no `run_script`. */
  async scriptEnv(signal: AbortSignal): Promise<ScriptEnv | undefined> {
    if (!this.enabled()) {
      this.settingChanged();
      return undefined;
    }
    let probed = this.probed;
    if (probed === undefined) {
      const generation = this.generation;
      probed = await this.probe(signal);
      if (signal.aborted || generation !== this.generation) return undefined;
      this.probed = probed;
      if ("problem" in probed) this.warn(probed.problem);
    }
    return "env" in probed ? probed.env : undefined;
  }

  /** The setting changed: the next send that finds it on probes again. */
  settingChanged(): void {
    this.probed = undefined;
    this.generation += 1;
  }

  private enabled(): boolean {
    try {
      return this.host.enabled();
    } catch (error) {
      console.error("broke-code: could not read the Code Mode setting; it stays off", error);
      return false;
    }
  }

  private async probe(signal: AbortSignal): Promise<Probed> {
    try {
      const env = await this.host.scriptEnv();
      const problem = await (this.host.probe ?? scriptProblem)(env, signal);
      return problem === undefined ? { env } : { problem };
    } catch (error) {
      return {
        problem: `The script runtime could not be found (${error instanceof Error ? error.message : String(error)}).`,
      };
    }
  }

  private warn(problem: string): void {
    console.error(`broke-code: Code Mode is off in this window: ${problem}`);
    try {
      this.host.warn(problem);
    } catch (error) {
      console.error("broke-code: could not show why Code Mode is off", error);
    }
  }
}
