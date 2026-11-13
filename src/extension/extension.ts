/**
 * @module extension
 * Activation entry point: wires settings, API keys, mentions (and the diagnostics `@problems`, the git diffs `@diff`,
 * and the selection `@selection` read), read tools, write tools and commands behind their approval, each turn's
 * written files recorded for "Undo changes" and listed in "Changed files" with their diffs, instruction files, skills, turn limits, file index, saved conversations, chat controller, chat view, `broke-code.setApiKey`,
 * `broke-code.addProvider`, `broke-code.generateCommitMessage`, `broke-code.editSelection` and its presets, the notifications of a turn that ended or waits while
 * the chat is not in view, and the editor's entry points into the chat:
 * `broke-code.addSelectionToChat` and the quick fix "Fix with broke-code" (`broke-code.fixDiagnostic`).
 */
import { homedir } from "node:os";
import * as vscode from "vscode";
import { CHAT_COMMANDS, type ChatCommand, runChatCommand } from "../core/chatCommands";
import { ChatController, type InstructionReader, type SkillReader } from "../core/chatController";
import type { ChatModel } from "../core/client";
import { type CommandEnv, commandShell, killRunningCommands } from "../core/commands";
import { directoryFiles } from "../core/conversationFiles";
import { answerConversationSearch, ConversationStore } from "../core/conversationStore";
import { readInstructionFiles } from "../core/instructions";
import { contextOf } from "../core/limits";
import { mentionReader } from "../core/mentionReader";
import type { Diagnostic } from "../core/problems";
import type { DraftInsert } from "../core/protocol";
import { ProviderSupport } from "../core/providerSupport";
import { parseProviders } from "../core/providers";
import { fixDraft, parseDiagnostic } from "../core/quickFix";
import { recordingApplier } from "../core/recordedChanges";
import { editorSelection } from "../core/selection";
import { describeSkillDiscovery, readSkills, type SkillDiscovery } from "../core/skills";
import { workspaceToolRunner } from "../core/toolRunner";
import { ripgrepCandidates } from "../core/tools";
import type { WorkspaceRoot } from "../core/workspaceFiles";
import { approvalApplier, fileApplier, type WriteApprovalHost } from "../core/writeTools";
import { runAddProvider } from "./addProvider";
import { ApiKeys } from "./apiKeys";
import { DiffPreviews, hasUnsavedChanges, readAutoApproveWrites, writeAutoApproveWrites } from "./approval";
import { CHAT_VIEW_ID, ChatContextKeys, ChatView } from "./chatView";
import { registerCommitMessageCommand } from "./commitMessage";
import { askContextSize, LIMIT_SETTINGS, readCommandTimeoutSeconds, readLimits } from "./contextSizes";
import { registerEditSelectionCommand } from "./editSelection";
import { WorkspaceFileIndex } from "./fileIndex";
import { gitDiffs } from "./git";
import { turnNotifier } from "./notifications";
import { registerTurnDiffs } from "./turnDiffs";

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
    selection: { read: async () => editorSelection(vscode.window.activeTextEditor) },
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
  // Every command waits for Run: the runner asks before it spawns, and no setting accepts a command. Each write that
  // reaches the disk is recorded into its turn's changes, for "Undo changes". `ask_user` is offered: the chat shows
  // its question and the controller sends the user's answer back.
  const tools = workspaceToolRunner(
    workspaceRoots,
    toolEnv,
    (roots, { requestApproval, changes }) =>
      approvalApplier(recordingApplier(fileApplier(roots), changes), writeHost, requestApproval),
    commandEnv,
    true,
  );
  const instructions: InstructionReader = { read: () => readInstructionFiles(homedir(), workspaceRoots()) };
  const discoverSkills = () => readSkills(homedir(), workspaceRoots());
  const skills: SkillReader = { read: () => discoverSkills().then(logSkills) };

  // [>]: `storageUri` is a `file:` URI in the desktop extension host, and only with a folder or workspace open.
  const conversations = new ConversationStore(directoryFiles(context.storageUri?.fsPath));
  let view: ChatView | undefined;
  const turnDiffs = registerTurnDiffs();
  // [>]: One for the chat, the commit message, and "Edit selection": a request of any teaches the others which models
  // take a field.
  const providerSupport = new ProviderSupport();
  const chatContext = new ChatContextKeys();
  const controller = new ChatController({
    apiKeys,
    workspaceState: context.workspaceState,
    publish: (state) => {
      view?.publish(state);
      chatContext.update(state);
    },
    mentions,
    store: conversations,
    tools,
    instructions,
    skills,
    limits: { read: readLimits },
    autoApproveWrites: readAutoApproveWrites,
    writeAutoApproveWrites,
    // [>]: The view exists before any request can reach the controller: requests come from its webview.
    returnDraft: (draft) => view?.returnDraft(draft),
    // [>]: The write approval's unsaved check: a restore must not replace a file under an editor's unsaved text.
    undo: { roots: workspaceRoots, hasUnsavedChanges },
    changeDiffs: turnDiffs.diffs,
    providerSupport,
    turnEvents: turnNotifier(() => view?.visible === true),
  });
  const fileIndex = new WorkspaceFileIndex();
  view = new ChatView(context.extensionUri, controller, {
    setApiKey,
    setContextSize: askContextSize,
    queryFiles: (query) => fileIndex.query(query),
    querySkills: discoverSkills,
    // [!]: The host's own listed conversations, never ids from the webview.
    searchConversations: (id, query, post) => {
      const ids = controller.snapshot.conversations.map((conversation) => conversation.id);
      return answerConversationSearch(conversations, { id, ids, query }, post);
    },
    addProvider: () => addProvider(),
  });

  // [>]: The chat's provider and model, its key, context size, and reasoning effort, read when a commit message or edit
  // run starts.
  const chatModel = async (): Promise<ChatModel | undefined> => {
    const { provider: name, model, reasoningEffort } = controller.snapshot;
    const provider = readProviders().providers.find((entry) => entry.name === name);
    if (!provider || model === undefined) return undefined;
    const access = { provider, apiKey: await apiKeys.get(provider.name) };
    return { access, model, contextSize: contextOf(readLimits(), model).size, reasoningEffort };
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

  const chatView = view;
  // [>]: Shows its own failures; a command handler that rejects would only reach VS Code's generic error.
  const insertDraft = (draft: DraftInsert) =>
    chatView.insertDraft(draft).catch((error: unknown) => {
      console.error("broke-code: could not put the draft in the chat", error);
      void vscode.window.showErrorMessage(vscode.l10n.t("Could not open the chat: {0}", String(error)));
    });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, view),
    // [>]: The selection is read when the message is sent, so the editor's selection is left as it is.
    vscode.commands.registerCommand("broke-code.addSelectionToChat", () =>
      insertDraft({ text: "@selection", mode: "caret", picked: [] }),
    ),
    // [!]: Any extension can run this command with any argument: it is checked, then filtered as the quick fix is.
    vscode.commands.registerCommand("broke-code.fixDiagnostic", (raw?: unknown) => {
      const diagnostic = parseDiagnostic(raw);
      const draft = diagnostic ? fixDraft(workspaceRoots(), diagnostic) : undefined;
      return draft ? insertDraft(draft) : undefined;
    }),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new FixWithBrokeCode(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.commands.registerCommand("broke-code.setApiKey", (provider?: unknown) =>
      setApiKey(typeof provider === "string" ? provider : undefined),
    ),
    vscode.commands.registerCommand("broke-code.addProvider", addProvider),
    ...Object.entries(CHAT_COMMANDS).map(([command, id]) =>
      vscode.commands.registerCommand(id, () => runChatCommand(command as ChatCommand, controller)),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("brokeCode.providers")) applySettings();
      if (LIMIT_SETTINGS.some((setting) => event.affectsConfiguration(setting))) controller.limitsChanged();
      if (event.affectsConfiguration("brokeCode.autoApproveWrites")) controller.modeChanged();
    }),
    apiKeys.onDidChange((provider) => controller.keyChanged(provider)),
    fileIndex,
    registerCommitMessageCommand(chatModel, providerSupport),
    registerEditSelectionCommand(chatModel, providerSupport, workspaceRoots),
    // [>]: Stop first, so an open approval request is cancelled before its diff closes with the others. Nothing queued
    // is sent. The changed files' diffs close too: the held turn does not survive a reload.
    {
      dispose: () => {
        controller.dispose();
        previews.dispose();
        turnDiffs.registration.dispose();
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
  return vscode.languages
    .getDiagnostics()
    .flatMap(([uri, diagnostics]) => diagnostics.map((diagnostic) => rawDiagnostic(uri, diagnostic)));
}

/** `diagnostic` of the document at `uri` as the raw record the core reads. */
function rawDiagnostic(uri: vscode.Uri, { range, severity, message, source }: vscode.Diagnostic): Diagnostic {
  return {
    scheme: uri.scheme,
    path: uri.fsPath,
    line: range.start.line,
    character: range.start.character,
    severity: severityName(severity),
    message,
    ...(source ? { source } : {}),
  };
}

/**
 * "Fix with broke-code" on each error or warning of a `file` document inside the workspace folders (`fixDraft`): its
 * command fills the chat's message box and sends nothing.
 */
class FixWithBrokeCode implements vscode.CodeActionProvider {
  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext) {
    const roots = workspaceRoots();
    return context.diagnostics.flatMap((diagnostic) => {
      const raw = rawDiagnostic(document.uri, diagnostic);
      if (!fixDraft(roots, raw)) return [];
      const title = vscode.l10n.t("Fix with broke-code");
      const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.command = { command: "broke-code.fixDiagnostic", title, arguments: [raw] };
      return [action];
    });
  }
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
