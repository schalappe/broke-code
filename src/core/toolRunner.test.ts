import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./chatController";
import { workspaceToolRunner } from "./toolRunner";
import { READ_TOOLS } from "./tools";
import type { WorkspaceRoot } from "./workspaceFiles";
import { type PlannedChange, WRITE_TOOLS } from "./writeTools";

let root: WorkspaceRoot;

beforeAll(async () => {
  const path = await mkdtemp(join(tmpdir(), "broke-code-runner-"));
  root = { name: "app", path };
  await writeFile(join(path, "a.txt"), "alpha\n");
});
afterAll(() => rm(root.path, { recursive: true, force: true }));

const context: ToolContext = {
  signal: new AbortController().signal,
  requestApproval: async () => ({ kind: "accept" }),
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
  test("lists the read tools, then the write tools", () => {
    expect(recordingRunner().runner.tools).toEqual([...READ_TOOLS, ...WRITE_TOOLS]);
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
