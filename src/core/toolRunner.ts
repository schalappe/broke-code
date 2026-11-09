/**
 * @module toolRunner
 * The tool runner of the read and write tools over the workspace and of `load_skill`, shared by the extension and the
 * eval. They differ by the applier a write's planned change goes to: the extension's asks the user first, the eval's
 * writes at once.
 */
import type { ToolContext, ToolRunner } from "./chatController";
import { LOAD_SKILL_TOOL, loadSkill } from "./skills";
import { READ_TOOLS, type ReadToolEnv, runReadTool, stopped } from "./tools";
import type { WorkspaceRoot } from "./workspaceFiles";
import { type ChangeApplier, runWriteTool, WRITE_TOOLS } from "./writeTools";

/**
 * Runs each call over `roots()`, read at each call since folders can be added or removed while the window is open. A
 * write tool hands its planned change to `applier(roots, context)`, built for that run, and never reaches a loaded
 * skill's folder outside the workspace; a read tool runs with `env` and may also read the run's `skillRoots`;
 * `load_skill` loads from the run's `skills`.
 */
export function workspaceToolRunner(
  roots: () => WorkspaceRoot[],
  env: ReadToolEnv,
  applier: (roots: WorkspaceRoot[], context: ToolContext) => ChangeApplier,
): ToolRunner {
  return {
    tools: [...READ_TOOLS, ...WRITE_TOOLS, LOAD_SKILL_TOOL],
    run: async (call, context) => {
      if (call.name === LOAD_SKILL_TOOL.name) {
        if (context.signal.aborted) return stopped(call.name);
        return loadSkill(call.args.name ?? "", context.skills, context.skillRoots);
      }
      const current = roots();
      if (WRITE_TOOLS.some((tool) => tool.name === call.name)) {
        return runWriteTool(call, current, applier(current, context), context.signal);
      }
      return runReadTool(call, current, env, context.signal, { skillRoots: context.skillRoots });
    },
  };
}
