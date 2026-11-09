import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./chatController";
import { LOAD_SKILL_TOOL } from "./skills";
import type { Skill } from "./systemPrompt";
import { workspaceToolRunner } from "./toolRunner";
import { READ_TOOLS } from "./tools";
import type { WorkspaceRoot } from "./workspaceFiles";
import { type PlannedChange, WRITE_TOOLS } from "./writeTools";

let base: string;
let root: WorkspaceRoot;
/** A personal skill outside the workspace, by the real path discovery gives it. */
let skill: Skill;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "broke-code-runner-")));
  root = { name: "app", path: join(base, "app") };
  await mkdir(root.path);
  await writeFile(join(root.path, "a.txt"), "alpha\n");
  const skillRoot = join(base, "skills", "review");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "---\nname: review\ndescription: Review.\n---\nRead reference.md.\n");
  await writeFile(join(skillRoot, "reference.md"), "reference\n");
  skill = { name: "review", description: "Review.", root: skillRoot, listedToModel: true };
});
afterAll(() => rm(base, { recursive: true, force: true }));

const context: ToolContext = {
  signal: new AbortController().signal,
  requestApproval: async () => ({ kind: "accept" }),
  skills: [],
  skillRoots: [],
};

/** A runner over `root` whose applier records each change and the context it was built for, and writes nothing. */
function recordingRunner() {
  const applied: { change: PlannedChange; roots: WorkspaceRoot[]; context: ToolContext }[] = [];
  const runner = workspaceToolRunner(
    () => [root],
    { ripgrepCandidates: [] },
    (roots, runContext) => async (change) => {
      applied.push({ change, roots, context: runContext });
      return { status: "ok", text: "applied" };
    },
  );
  return { runner, applied };
}

describe("workspaceToolRunner", () => {
  test("lists the read tools, then the write tools, then load_skill", () => {
    expect(recordingRunner().runner.tools).toEqual([...READ_TOOLS, ...WRITE_TOOLS, LOAD_SKILL_TOOL]);
  });

  test("loads a skill of the run's discovery, and says so again once its folder is loaded", async () => {
    const { runner } = recordingRunner();
    const call = { name: "load_skill", args: { name: "review" } };
    const first = await runner.run(call, { ...context, skills: [skill] });
    expect(first).toEqual({
      status: "ok",
      text: `Skill review loaded; its files live in ${skill.root}; read them by that absolute path.\n\nRead reference.md.\n`,
    });
    const again = await runner.run(call, { ...context, skills: [skill], skillRoots: [skill.root] });
    expect(again.text).toStartWith("Skill review is already loaded;");
  });

  test("reads a loaded skill's file by absolute path, and refuses it before the load", async () => {
    const { runner } = recordingRunner();
    const call = { name: "read_file", args: { path: join(skill.root, "reference.md") } };
    expect((await runner.run(call, { ...context, skills: [skill], skillRoots: [skill.root] })).status).toBe("ok");
    expect(await runner.run(call, { ...context, skills: [skill] })).toMatchObject({
      status: "error",
      text: expect.stringContaining("outside the workspace folders"),
    });
  });

  test("refuses a write into a loaded skill's folder as outside the workspace, applying nothing", async () => {
    const { runner, applied } = recordingRunner();
    const loaded = { ...context, skills: [skill], skillRoots: [skill.root] };
    const writes: { name: string; args: Record<string, string> }[] = [
      { name: "write_file", args: { path: join(skill.root, "reference.md"), content: "changed" } },
      { name: "edit_file", args: { path: join(skill.root, "reference.md"), old: "reference", new: "changed" } },
      { name: "write_file", args: { path: join(skill.root, "new.md"), content: "new" } },
    ];
    for (const call of writes) {
      expect(await runner.run(call, loaded)).toEqual({
        status: "error",
        text: `${call.name}: ${call.args.path}: the path is outside the workspace folders.`,
      });
    }
    expect(applied).toEqual([]);
    expect(await readFile(join(skill.root, "reference.md"), "utf8")).toBe("reference\n");
  });

  test("hands a write tool's planned change to the applier built for the run's roots and context", async () => {
    const { runner, applied } = recordingRunner();
    const call = { name: "write_file", args: { path: "a.txt", content: "beta" } };

    expect(await runner.run(call, context)).toEqual({ status: "ok", text: "applied" });
    expect(applied).toHaveLength(1);
    expect(applied[0]?.change).toMatchObject({ tool: "write_file", path: "a.txt", before: "alpha\n", after: "beta\n" });
    expect(applied[0]?.roots).toEqual([root]);
    expect(applied[0]?.context).toBe(context);
    expect(await readFile(join(root.path, "a.txt"), "utf8")).toBe("alpha\n");
  });

  test("runs a read tool directly, never through the applier", async () => {
    const { runner, applied } = recordingRunner();
    const result = await runner.run({ name: "read_file", args: { path: "a.txt" } }, context);

    expect(result.status).toBe("ok");
    expect(result.text).toContain("alpha");
    expect(applied).toEqual([]);
  });
});
