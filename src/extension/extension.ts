/**
 * @module extension
 * Activation entry point: wires settings, API keys, mentions (and the diagnostics `@problems` reads, the git diffs
 * `@diff` reads), read tools, write tools and commands behind their approval, instruction files, skills, turn limits,
 * file index, saved conversations, chat controller, chat view, `broke-code.setApiKey`, `broke-code.addProvider`, and `broke-code.generateCommitMessage`.
 */
import { homedir } from "node:os";
import * as vscode from "vscode";
import { ChatController, type InstructionReader, type SkillReader } from "../core/chatController";
import { type CommandEnv, commandShell, killRunningCommands } from "../core/commands";
import { directoryFiles } from "../core/conversationFiles";
import { ConversationStore } from "../core/conversationStore";
import { readInstructionFiles } from "../core/instructions";
import { contextOf } from "../core/limits";
import { mentionReader } from "../core/mentionReader";
import type { Diagnostic } from "../core/problems";
import { parseProviders } from "../core/providers";
import { describeSkillDiscovery, readSkills, type SkillDiscovery } from "../core/skills";
import { workspaceToolRunner } from "../core/toolRunner";
import { ripgrepCandidates } from "../core/tools";
import type { WorkspaceRoot } from "../core/workspaceFiles";
import { approvalApplier, fileApplier, type WriteApprovalHost } from "../core/writeTools";
import { runAddProvider } from "./addProvider";
import { ApiKeys } from "./apiKeys";
import { DiffPreviews, hasUnsavedChanges, readAutoApproveWrites, writeAutoApproveWrites } from "./approval";
import { CHAT_VIEW_ID, ChatView } from "./chatView";
import { registerCommitMessageCommand } from "./commitMessage";
import { askContextSize, LIMIT_SETTINGS, readCommandTimeoutSeconds, readLimits } from "./contextSizes";
import { WorkspaceFileIndex } from "./fileIndex";
import { gitDiffs } from "./git";

export function activate(context: vscode.ExtensionContext): void {
  // [!]: User settings only. A workspace value could reuse a provider name with another base URL and receive its stored key.
  // The manifest's `application` scope already makes VS Code ignore it; reading `globalValue` keeps that explicit here.
  const providersSetting = () =>
    vscode.workspace.getConfiguration("brokeCode").inspect<unknown>("providers")?.globalValue;
  const readProviders = () => parseProviders(providersSetting());
  const apiKeys = new ApiKeys(context.secrets, () => readProviders().providers);
  const setApiKey = (provider?: string) => apiKeys.runSetCommand(provider);

  // [>]: Roots read at each mention, since folders can be added or removed while the window is open.
  const mentions = mentionReader({
    roots: workspaceRoots,
    diagnostics: { read: async () => readDiagnostics() },
    diff: gitDiffs,
  });
  const toolEnv = { ripgrepCandidates: ripgrepCandidates(vscode.env.appRoot, process.env.PATH) };
  const previews = new DiffPreviews();
  const writeHost: WriteApprovalHost = { preview: (change) => previews.preview(change), hasUnsavedChanges };
  // [>]: Read at each command, so a changed terminal profile or timeout reaches the next one.
  const commandEnv = (): CommandEnv => ({
    shell: commandShell(vscode.env.shell, process.env.SHELL),
    timeoutMs: readCommandTimeoutSeconds() * 1000,
  });
  // [!]: Every write goes through `approvalApplier`: no build writes without a click unless the user setting says so.
  // Every command waits for Run: the runner asks before it spawns, and no setting accepts a command.
  const tools = workspaceToolRunner(
    workspaceRoots,
    toolEnv,
    (roots, { requestApproval }) => approvalApplier(fileApplier(roots), writeHost, requestApproval),
    commandEnv,
  );
  const instructions: InstructionReader = { read: () => readInstructionFiles(homedir(), workspaceRoots()) };
  const discoverSkills = () => readSkills(homedir(), workspaceRoots());
  const skills: SkillReader = { read: () => discoverSkills().then(logSkills) };

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
    autoApproveWrites: readAutoApproveWrites,
    writeAutoApproveWrites,
  });
  const fileIndex = new WorkspaceFileIndex();
  view = new ChatView(context.extensionUri, controller, {
    setApiKey,
    setContextSize: askContextSize,
    queryFiles: (query) => fileIndex.query(query),
    querySkills: discoverSkills,
    addProvider: () => addProvider(),
  });

  // [>]: The chat's selection, its key, and its context size, read when a commit message run starts.
  const commitSelection = async () => {
    const { provider: name, model } = controller.snapshot;
    const provider = readProviders().providers.find((entry) => entry.name === name);
    if (!provider || model === undefined) return undefined;
    const access = { provider, apiKey: await apiKeys.get(provider.name) };
    return { access, model, contextSize: contextOf(readLimits(), model).size };
  };

  const applySettings = () => {
    controller.setProviders(readProviders());
    apiKeys.promptMissing();
  };
  // [>]: Applied here too, since the settings change event may come after the write settles; applying twice is harmless.
  // `selectProvider` leaves the selection alone while a reply is in flight.
  const addProvider = () =>
    runAddProvider(apiKeys, providersSetting, (name) => {
      applySettings();
      controller.selectProvider(name);
    });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, view),
    vscode.commands.registerCommand("broke-code.setApiKey", (provider?: unknown) =>
      setApiKey(typeof provider === "string" ? provider : undefined),
    ),
    vscode.commands.registerCommand("broke-code.addProvider", addProvider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("brokeCode.providers")) applySettings();
      if (LIMIT_SETTINGS.some((setting) => event.affectsConfiguration(setting))) controller.limitsChanged();
      if (event.affectsConfiguration("brokeCode.autoApproveWrites")) controller.modeChanged();
    }),
    apiKeys.onDidChange((provider) => controller.keyChanged(provider)),
    fileIndex,
    registerCommitMessageCommand(commitSelection),
    // [>]: Stop first, so an open approval request is cancelled before its diff closes with the others.
    {
      dispose: () => {
        controller.stop();
        previews.dispose();
      },
    },
  );
  applySettings();
  controller.modeChanged();
  void controller.restore();
}

/**
 * Kill every command still running, or stopped and in its grace, at once: the host may exit right after this, and the
 * SIGKILL a stop schedules would die with it. Synchronous, so it is done before VS Code moves on.
 */
export function deactivate(): void {
  killRunningCommands();
}

/** Log what a send discovered, one line; the warnings show in the chat panel. */
function logSkills(discovery: SkillDiscovery): SkillDiscovery {
  console.info(describeSkillDiscovery(discovery));
  return discovery;
}

/** Every diagnostic VS Code holds now, as the raw records `@problems` filters and formats. */
function readDiagnostics(): Diagnostic[] {
  return vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) =>
    diagnostics.map(({ range, severity, message, source }) => ({
      scheme: uri.scheme,
      path: uri.fsPath,
      line: range.start.line,
      character: range.start.character,
      severity: severityName(severity),
      message,
      ...(source ? { source } : {}),
    })),
  );
}

function severityName(severity: vscode.DiagnosticSeverity): Diagnostic["severity"] {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
  }
}

/** Workspace folders on disk. Folders of other schemes (remote, virtual) hold no path to read: v1 is local only. */
function workspaceRoots(): WorkspaceRoot[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => ({ name: folder.name, path: folder.uri.fsPath }));
}
