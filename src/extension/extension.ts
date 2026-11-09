/**
 * @module extension
 * Activation entry point: wires settings, API keys, mentions, file index, saved conversations, chat controller, chat
 * view, and `broke-code.setApiKey`.
 */
import * as vscode from "vscode";
import { ChatController } from "../core/chatController";
import { directoryFiles } from "../core/conversationFiles";
import { ConversationStore } from "../core/conversationStore";
import { type MentionReader, readMention } from "../core/mentions";
import { parseProviders } from "../core/providers";
import type { WorkspaceRoot } from "../core/workspaceFiles";
import { ApiKeys } from "./apiKeys";
import { CHAT_VIEW_ID, ChatView } from "./chatView";
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

  // [>]: `storageUri` is a `file:` URI in the desktop extension host, and only with a folder or workspace open.
  const conversations = new ConversationStore(directoryFiles(context.storageUri?.fsPath));
  let view: ChatView | undefined;
  const controller = new ChatController(
    apiKeys,
    context.workspaceState,
    (state) => view?.publish(state),
    mentions,
    conversations,
  );
  const fileIndex = new WorkspaceFileIndex();
  view = new ChatView(context.extensionUri, controller, { setApiKey, queryFiles: (query) => fileIndex.query(query) });

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
    }),
    apiKeys.onDidChange((provider) => controller.keyChanged(provider)),
    fileIndex,
    { dispose: () => controller.stop() },
  );
  applySettings();
  void controller.restore();
}

export function deactivate(): void {}

/** Workspace folders on disk. Folders of other schemes (remote, virtual) hold no path to read: v1 is local only. */
function workspaceRoots(): WorkspaceRoot[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => ({ name: folder.name, path: folder.uri.fsPath }));
}
