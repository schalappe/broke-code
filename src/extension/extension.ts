/**
 * @module extension
 * Activation entry point: wires settings, API keys, mentions, read tools, instruction files, skills, turn limits, file index,
 * saved conversations, chat controller, chat view, and `broke-code.setApiKey`.
 */
import { homedir } from "node:os";
import * as vscode from "vscode";
import { ChatController, type InstructionReader, type SkillReader, type ToolRunner } from "../core/chatController";
import { directoryFiles } from "../core/conversationFiles";
import { ConversationStore } from "../core/conversationStore";
import { readInstructionFiles } from "../core/instructions";
import { type MentionReader, readMention } from "../core/mentions";
import { parseProviders } from "../core/providers";
import { readSkills, type SkillDiscovery } from "../core/skills";
import { READ_TOOLS, ripgrepCandidates, runReadTool } from "../core/tools";
import type { WorkspaceRoot } from "../core/workspaceFiles";
import { ApiKeys } from "./apiKeys";
import { CHAT_VIEW_ID, ChatView } from "./chatView";
import { askContextSize, LIMIT_SETTINGS, readLimits } from "./contextSizes";
import { WorkspaceFileIndex } from "./fileIndex";

export function activate(context: vscode.ExtensionContext): void {
  // [!]: User settings only. A workspace value could reuse a provider name with another base URL and receive its stored key.
  // The manifest's `application` scope already makes VS Code ignore it; reading `globalValue` keeps that explicit here.
  const readProviders = () =>
    parseProviders(vscode.workspace.getConfiguration("brokeCode").inspect<unknown>("providers")?.globalValue);
  const apiKeys = new ApiKeys(context.secrets, () => readProviders().providers);
  const setApiKey = (provider?: string) => apiKeys.runSetCommand(provider);

  // [>]: Roots read at each mention, since folders can be added or removed while the window is open.
  const mentions: MentionReader = { read: (path) => readMention(workspaceRoots(), path) };
  const toolEnv = { ripgrepCandidates: ripgrepCandidates(vscode.env.appRoot, process.env.PATH) };
  const tools: ToolRunner = {
    tools: READ_TOOLS,
    run: (call, { signal }) => runReadTool(call, workspaceRoots(), toolEnv, signal),
  };
  const instructions: InstructionReader = { read: () => readInstructionFiles(homedir(), workspaceRoots()) };
  const skills: SkillReader = { read: () => readSkills(homedir(), workspaceRoots()).then(logSkills) };

  // [>]: `storageUri` is a `file:` URI in the desktop extension host, and only with a folder or workspace open.
  const conversations = new ConversationStore(directoryFiles(context.storageUri?.fsPath));
  let view: ChatView | undefined;
  const controller = new ChatController({
    apiKeys,
    workspaceState: context.workspaceState,
    publish: (state) => view?.publish(state),
    mentions,
    store: conversations,
    tools,
    instructions,
    skills,
    limits: { read: readLimits },
  });
  const fileIndex = new WorkspaceFileIndex();
  view = new ChatView(context.extensionUri, controller, {
    setApiKey,
    setContextSize: askContextSize,
    queryFiles: (query) => fileIndex.query(query),
  });

  const applySettings = () => {
    controller.setProviders(readProviders());
    apiKeys.promptMissing();
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, view),
    vscode.commands.registerCommand("broke-code.setApiKey", (provider?: unknown) =>
      setApiKey(typeof provider === "string" ? provider : undefined),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("brokeCode.providers")) applySettings();
      if (LIMIT_SETTINGS.some((setting) => event.affectsConfiguration(setting))) controller.limitsChanged();
    }),
    apiKeys.onDidChange((provider) => controller.keyChanged(provider)),
    fileIndex,
    { dispose: () => controller.stop() },
  );
  applySettings();
  void controller.restore();
}

export function deactivate(): void {}

/**
 * Log what a send discovered, one line, so the skills the model sees can be checked in the extension host log. The
 * warnings show in the chat panel.
 */
function logSkills(discovery: SkillDiscovery): SkillDiscovery {
  const listed = discovery.skills
    .filter((skill) => skill.listedToModel)
    .map((skill) => `${skill.name} (${skill.root})`);
  const unlisted = discovery.skills.filter((skill) => !skill.listedToModel).map((skill) => skill.name);
  console.info(
    `broke-code: skills listed to the model: ${listed.join(", ") || "none"}; kept from the model: ${unlisted.join(", ") || "none"}; skipped: ${discovery.warnings.length}`,
  );
  return discovery;
}

/** Workspace folders on disk. Folders of other schemes (remote, virtual) hold no path to read: v1 is local only. */
function workspaceRoots(): WorkspaceRoot[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => ({ name: folder.name, path: folder.uri.fsPath }));
}
