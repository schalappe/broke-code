import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CodeModeHost, CodeModeSwitch, codeModeSetting, hostScriptEnv } from "./codeMode";
import type { ScriptEnv } from "./script";

describe("codeModeSetting", () => {
  test("only the user value true turns Code Mode on, never a workspace value", () => {
    expect(codeModeSetting({ globalValue: true })).toBe(true);
    expect(codeModeSetting({ globalValue: true, workspaceValue: false })).toBe(true);
    expect(codeModeSetting({ workspaceValue: true })).toBe(false);
    expect(codeModeSetting({ workspaceFolderValue: true })).toBe(false);
    expect(codeModeSetting({ globalValue: "true" })).toBe(false);
    expect(codeModeSetting({ globalValue: 1 })).toBe(false);
    expect(codeModeSetting({ globalValue: false })).toBe(false);
    expect(codeModeSetting({})).toBe(false);
    expect(codeModeSetting(undefined)).toBe(false);
  });
});

describe("hostScriptEnv", () => {
  let base = "";
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "broke-code-host-env-")));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  /** A fake app bundle under `base`: its frameworks folder, and an executable file at `relative` inside `Contents`. */
  function bundle(name: string, relative: string): string {
    const contents = join(base, `${name}.app`, "Contents");
    for (const framework of ["Electron Framework.framework", "Squirrel.framework"]) {
      mkdirSync(join(contents, "Frameworks", framework), { recursive: true });
    }
    writeFileSync(join(contents, "Frameworks", "notes.txt"), "not a framework");
    const executable = join(contents, relative);
    mkdirSync(join(executable, ".."), { recursive: true });
    writeFileSync(executable, "");
    chmodSync(executable, 0o755);
    return executable;
  }

  test("runs a helper as Node, its app's frameworks readable, nothing else", async () => {
    const helper = bundle("Helper", "Frameworks/Code Helper.app/Contents/MacOS/Code Helper");
    const frameworks = join(base, "Helper.app", "Contents", "Frameworks");
    expect(await hostScriptEnv(helper)).toEqual({
      runtime: [helper],
      environment: { ELECTRON_RUN_AS_NODE: "1" },
      readable: [join(frameworks, "Electron Framework.framework"), join(frameworks, "Squirrel.framework")],
    });
  });

  test("finds the frameworks beside the main executable, and resolves a symbolic link to the runtime", async () => {
    const main = bundle("Main", "MacOS/Code");
    const link = join(base, "code-link");
    symlinkSync(main, link);
    const env = await hostScriptEnv(link);
    expect(env.runtime).toEqual([main]);
    expect(env.readable).toHaveLength(2);
  });

  test("outside an app bundle, nothing is readable", async () => {
    const plain = join(base, "bin", "node");
    mkdirSync(join(base, "bin"), { recursive: true });
    writeFileSync(plain, "");
    expect((await hostScriptEnv(plain)).readable).toEqual([]);
  });

  test("rejects when the runtime does not exist", async () => {
    await expect(hostScriptEnv(join(base, "missing"))).rejects.toThrow();
  });
});

describe("CodeModeSwitch", () => {
  const env: ScriptEnv = { runtime: ["/runtime"], environment: {}, readable: [] };
  const signal = () => new AbortController().signal;

  /** A switch over a host whose setting reads `on`, probing with `probe`, counting its probes and warnings. */
  function codeMode(probe: CodeModeHost["probe"], on = { value: true }) {
    const counts = { probes: 0, warnings: [] as string[] };
    const host: CodeModeHost = {
      enabled: () => on.value,
      scriptEnv: async () => env,
      warn: (problem) => counts.warnings.push(problem),
      probe: async (probed, probeSignal) => {
        counts.probes += 1;
        return probe?.(probed, probeSignal);
      },
    };
    return { codeMode: new CodeModeSwitch(host), counts, on };
  }

  test("off: no runtime, and no probe", async () => {
    const { codeMode: modes, counts } = codeMode(async () => undefined, { value: false });
    expect(await modes.scriptEnv(signal())).toBeUndefined();
    expect(counts.probes).toBe(0);
  });

  test("on: probes at the first send only, then gives the runtime to every send", async () => {
    const { codeMode: modes, counts } = codeMode(async () => undefined);
    expect(await modes.scriptEnv(signal())).toBe(env);
    expect(await modes.scriptEnv(signal())).toBe(env);
    expect(counts.probes).toBe(1);
    expect(counts.warnings).toEqual([]);
  });

  test("a failed probe gives no runtime for the window and warns once", async () => {
    const { codeMode: modes, counts } = codeMode(async () => "the sandbox refused it");
    expect(await modes.scriptEnv(signal())).toBeUndefined();
    expect(await modes.scriptEnv(signal())).toBeUndefined();
    expect(counts.probes).toBe(1);
    expect(counts.warnings).toEqual(["the sandbox refused it"]);
  });

  test("a runtime that cannot be found is a failed probe", async () => {
    const warnings: string[] = [];
    const modes = new CodeModeSwitch({
      enabled: () => true,
      scriptEnv: async () => {
        throw new Error("ENOENT: no such file");
      },
      warn: (problem) => warnings.push(problem),
    });
    expect(await modes.scriptEnv(signal())).toBeUndefined();
    expect(warnings).toEqual(["The script runtime could not be found (ENOENT: no such file)."]);
  });

  test("a probe the send's Stop aborted is not kept: the next send probes again", async () => {
    const { codeMode: modes, counts } = codeMode(async (_env, probeSignal) =>
      probeSignal.aborted ? "stopped" : undefined,
    );
    const stopped = new AbortController();
    stopped.abort();
    expect(await modes.scriptEnv(stopped.signal)).toBeUndefined();
    expect(counts.warnings).toEqual([]);
    expect(await modes.scriptEnv(signal())).toBe(env);
    expect(counts.probes).toBe(2);
  });

  test("turning the setting off then on probes again, and so does a change of the setting", async () => {
    const { codeMode: modes, counts, on } = codeMode(async () => "refused");
    expect(await modes.scriptEnv(signal())).toBeUndefined();
    on.value = false;
    expect(await modes.scriptEnv(signal())).toBeUndefined();
    on.value = true;
    expect(await modes.scriptEnv(signal())).toBeUndefined();
    expect(counts.probes).toBe(2);
    modes.settingChanged();
    await modes.scriptEnv(signal());
    expect(counts.probes).toBe(3);
    expect(counts.warnings).toHaveLength(3);
  });

  test("a probe that settles after a change of the setting is not kept", async () => {
    let finish: (problem: string | undefined) => void = () => {};
    const { codeMode: modes, counts } = codeMode(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = modes.scriptEnv(signal());
    await Bun.sleep(0);
    modes.settingChanged();
    finish(undefined);
    expect(await first).toBeUndefined();
    const second = modes.scriptEnv(signal());
    await Bun.sleep(0);
    finish(undefined);
    expect(await second).toBe(env);
    expect(counts.probes).toBe(2);
  });
});
