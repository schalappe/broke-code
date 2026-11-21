/**
 * @module toolRunner
 * The tool runner of the read and write tools over the workspace, of `run_command`, of `load_skill`, of `ask_user`,
 * and of `run_script`, shared by the extension and the eval. They differ by the applier a write's planned change goes to: the
 * extension's asks the user first, the eval's writes at once; and by the command setup they pass. A command's approval
 * goes through the run context: the extension asks the user, the eval accepts at once.
 */
import { ASK_USER_TOOL, askUser } from "./askUser";
import type { ToolContext, ToolRunner } from "./chatController";
import { type CommandEnv, RUN_COMMAND_TOOL, runCommandTool } from "./commands";
import { RUN_SCRIPT_TOOL, runScript } from "./script";
import { LOAD_SKILL_TOOL, loadSkill } from "./skills";
import { READ_TOOLS, type ReadToolEnv, runReadTool, stopped } from "./tools";
import type { WorkspaceRoot } from "./workspaceFiles";
import { type ChangeApplier, runWriteTool, WRITE_TOOLS } from "./writeTools";

/**
 * Runs each call over `roots()`, read at each call since folders can be added or removed while the window is open. A
 * write tool hands its planned change to `applier(roots, context)`, built for that run, and never reaches a loaded
 * skill's folder outside the workspace; a read tool runs with `env` and may also read the run's `skillRoots`;
 * `load_skill` loads from the run's `skills`, a skill of `sentSkillRoots` answering "already loaded". `run_command` is
 * offered only with `commandEnv`, read at each call so a changed setting or shell reaches the next command; it asks the
 * run's `requestApproval` before anything runs. `ask_user` is offered only when `offerAskUser` is on, and asks the
 * run's `requestAnswer`; the extension turns it on, and so does the eval bench, except in its baseline run without
 * the tool. `run_script` is never in `tools`: the turn adds it when its send offers Code Mode (`ChatPorts.codeMode`),
 * and its call then runs under the run's `scriptEnv`, its script's calls through the run's `innerCalls`, which the
 * turn approves and records.
 */
export function workspaceToolRunner(
  roots: () => WorkspaceRoot[],
  env: ReadToolEnv,
  applier: (roots: WorkspaceRoot[], context: ToolContext) => ChangeApplier,
  commandEnv?: () => CommandEnv,
  offerAskUser = false,
): ToolRunner {
  return {
    tools: [
      ...READ_TOOLS,
      ...WRITE_TOOLS,
      ...(commandEnv ? [RUN_COMMAND_TOOL] : []),
      LOAD_SKILL_TOOL,
      ...(offerAskUser ? [ASK_USER_TOOL] : []),
    ],
    run: async (call, context) => {
      if (call.name === RUN_SCRIPT_TOOL.name) {
        const { innerCalls: inner, scriptEnv } = context;
        // [>]: The turn gives both only to a reply's call of a send that offered run_script; a script never calls it.
        if (!inner || !scriptEnv) return { status: "error", text: "run_script: scripts cannot run in this call." };
        return runScript(call.args.code ?? "", inner.tools, inner.run, context.signal, scriptEnv, inner.blocked);
      }
      if (offerAskUser && call.name === ASK_USER_TOOL.name) return askUser(call, context);
      if (call.name === LOAD_SKILL_TOOL.name) {
        if (context.signal.aborted) return stopped(call.name);
        return loadSkill(call.args.name ?? "", context.skills, context.sentSkillRoots);
      }
      const current = roots();
      if (commandEnv && call.name === RUN_COMMAND_TOOL.name) {
        return runCommandTool(call, current, context, commandEnv());
      }
      if (WRITE_TOOLS.some((tool) => tool.name === call.name)) {
        return runWriteTool(call, current, applier(current, context), context.signal);
      }
      const forScript = context.fromScript === true;
      return runReadTool(call, current, env, context.signal, { skillRoots: context.skillRoots, forScript });
    },
  };
}
