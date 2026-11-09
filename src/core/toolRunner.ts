/**
 * @module toolRunner
 * The tool runner of the read and write tools over the workspace, shared by the extension and the eval. They differ by
 * the applier a write's planned change goes to: the extension's asks the user first, the eval's writes at once.
 */
import type { ToolContext, ToolRunner } from "./chatController";
import { READ_TOOLS, type ReadToolEnv, runReadTool } from "./tools";
import type { WorkspaceRoot } from "./workspaceFiles";
import { type ChangeApplier, runWriteTool, WRITE_TOOLS } from "./writeTools";

/**
 * Runs each call over `roots()`, read at each call since folders can be added or removed while the window is open. A
 * write tool hands its planned change to `applier(roots, context)`, built for that run; any other call is a read tool
 * run with `env`.
 */
export function workspaceToolRunner(
  roots: () => WorkspaceRoot[],
  env: ReadToolEnv,
  applier: (roots: WorkspaceRoot[], context: ToolContext) => ChangeApplier,
): ToolRunner {
  return {
    tools: [...READ_TOOLS, ...WRITE_TOOLS],
    run: (call, context) => {
      const current = roots();
      if (!WRITE_TOOLS.some((tool) => tool.name === call.name)) return runReadTool(call, current, env, context.signal);
      return runWriteTool(call, current, applier(current, context), context.signal);
    },
  };
}
