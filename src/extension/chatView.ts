/**
 * @module chatView
 * Sidebar webview view: serves chat HTML, relays state to webview and actions to controller.
 */
import * as vscode from "vscode";
import type { ChatController } from "../core/chatController";
import type { ChatState, HostMessage, WebviewMessage } from "../core/protocol";
import { renderWebviewHtml } from "../core/webviewHtml";

export const CHAT_VIEW_ID = "brokeCode.chat";

export type ChatViewActions = {
  setApiKey: (provider: string) => Promise<void>;
};

export class ChatView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /** False until webview script posts `ready`; webview rebuilt on each show -> reset. */
  private ready = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
    private readonly actions: ChatViewActions,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const distUri = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    view.webview.onDidReceiveMessage((message: unknown) => this.receive(message));
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
    view.webview.html = renderWebviewHtml({
      cspSource: view.webview.cspSource,
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(distUri, "main.js")).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(distUri, "main.css")).toString(),
      nonce: crypto.randomUUID().replaceAll("-", ""),
      language: vscode.env.language,
    });
  }

  publish(state: ChatState): void {
    if (this.ready) this.post({ type: "state", state });
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private receive(raw: unknown): void {
    const message = parseWebviewMessage(raw);
    if (!message) return;
    const { controller } = this;
    switch (message.type) {
      case "ready":
        this.ready = true;
        this.post({ type: "init", l10n: vscode.l10n.bundle, state: controller.snapshot });
        return;
      case "selectProvider":
        controller.selectProvider(message.provider);
        return;
      case "selectModel":
        controller.selectModel(message.model);
        return;
      case "retryModels":
        return void controller.loadModels();
      case "send":
        return void controller.send(message.text);
      case "stop":
        controller.stop();
        return;
      case "newChat":
        controller.newChat();
        return;
      case "setApiKey":
        return void this.actions.setApiKey(message.provider).catch((error: unknown) => {
          void vscode.window.showErrorMessage(
            vscode.l10n.t("Could not save the API key for {0}: {1}", message.provider, String(error)),
          );
        });
      case "openSettings":
        return void vscode.commands.executeCommand("workbench.action.openSettings", "brokeCode.providers");
    }
  }
}

/** Validate webview message shape at host boundary. Unknown -> `undefined`. */
function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const message = raw as Record<string, unknown>;
  const text = (key: string) => (typeof message[key] === "string" ? (message[key] as string) : undefined);
  switch (message.type) {
    case "ready":
    case "retryModels":
    case "stop":
    case "newChat":
    case "openSettings":
      return { type: message.type };
    case "selectProvider":
    case "setApiKey": {
      const provider = text("provider");
      return provider === undefined ? undefined : { type: message.type, provider };
    }
    case "selectModel": {
      const model = text("model");
      return model === undefined ? undefined : { type: "selectModel", model };
    }
    case "send": {
      const value = text("text");
      return value === undefined ? undefined : { type: "send", text: value };
    }
    default:
      return undefined;
  }
}
