/**
 * @module extension
 * Activation entry point: wires settings, API keys, chat controller, chat view, and `broke-code.setApiKey`.
 */
import * as vscode from "vscode";
import { ChatController } from "../core/chatController";
import { parseProviders } from "../core/providers";
import { ApiKeys } from "./apiKeys";
import { CHAT_VIEW_ID, ChatView } from "./chatView";

export function activate(context: vscode.ExtensionContext): void {
  // [!]: User settings only. A workspace value could reuse a provider name with another base URL and receive its stored key.
  // The manifest's `application` scope already makes VS Code ignore it; reading `globalValue` keeps that explicit here.
  const readProviders = () =>
    parseProviders(vscode.workspace.getConfiguration("brokeCode").inspect<unknown>("providers")?.globalValue);
  const apiKeys = new ApiKeys(context.secrets, () => readProviders().providers);
  const setApiKey = (provider?: string) => apiKeys.runSetCommand(provider);

  let view: ChatView | undefined;
  const controller = new ChatController(apiKeys, context.workspaceState, (state) => view?.publish(state));
  view = new ChatView(context.extensionUri, controller, { setApiKey });

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
    { dispose: () => controller.stop() },
  );
  applySettings();
}

export function deactivate(): void {}
