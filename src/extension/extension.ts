/**
 * @module extension
 * Activation entry point: wires settings, API keys, chat controller, chat view, and `broke-code.setApiKey`.
 */
import * as vscode from "vscode";
import { parseProviders } from "../core/providers";
import { ApiKeys } from "./apiKeys";
import { ChatController } from "./chatController";
import { CHAT_VIEW_ID, ChatView } from "./chatView";

export function activate(context: vscode.ExtensionContext): void {
  const apiKeys = new ApiKeys(context.secrets);
  const readProviders = () => parseProviders(vscode.workspace.getConfiguration("brokeCode").get<unknown>("providers"));
  const setApiKey = (provider?: string) => apiKeys.runSetCommand(readProviders().providers, provider);

  let view: ChatView | undefined;
  const controller = new ChatController(apiKeys, context.workspaceState, (state) => view?.publish(state));
  view = new ChatView(context.extensionUri, controller, { setApiKey });

  const applySettings = () => {
    const parsed = readProviders();
    controller.setProviders(parsed);
    apiKeys.promptMissing(parsed.providers);
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
