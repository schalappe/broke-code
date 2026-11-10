/**
 * @module chatView
 * Sidebar webview view: serves chat HTML, relays state to webview and actions to controller.
 */
import * as vscode from "vscode";
import type { ChatController } from "../core/chatController";
import type { FileQueryAnswer } from "../core/fileIndex";
import { chooseModel } from "../core/modelList";
import { type ChatState, type HostMessage, parseWebviewMessage } from "../core/protocol";
import { answerSkillQuery, type SkillDiscovery } from "../core/skills";
import { renderWebviewHtml } from "../core/webviewHtml";

export const CHAT_VIEW_ID = "brokeCode.chat";

export type ChatViewActions = {
  setApiKey: (provider: string) => Promise<void>;
  /** Ask for `model`'s context size and save it; shows its own failures. */
  setContextSize: (model: string) => Promise<void>;
  /** Mention menu entries matching `query`. */
  queryFiles: (query: string) => Promise<FileQueryAnswer>;
  /** The skills a send would discover, for the `/` menu; no log line, since nothing is sent. */
  querySkills: () => Promise<SkillDiscovery>;
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

  private async answerQuery(query: string, id: number): Promise<void> {
    try {
      const { items, capped } = await this.actions.queryFiles(query);
      this.post({ type: "fileSuggestions", id, items, capped, failed: false });
    } catch (error) {
      // [>]: The menu says the listing failed; the composer still sends typed mentions.
      console.error("broke-code: could not list workspace files", error);
      this.post({ type: "fileSuggestions", id, items: [], capped: false, failed: true });
    }
  }

  /** The `/model` pick over the editor's Quick Pick; see `chooseModel`. */
  private chooseModel(): Promise<void> {
    const { controller } = this;
    return chooseModel(
      controller.snapshot,
      {
        pick: async (items, placeHolder) => vscode.window.showQuickPick(items, { placeHolder }),
        selectModel: (model) => controller.selectModel(model),
        showError: (message) => void vscode.window.showErrorMessage(message),
      },
      vscode.l10n,
    );
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
        return void controller.send(message.text, message.mentions);
      case "queryFiles":
        return void this.answerQuery(message.query, message.id);
      case "querySkills":
        return void answerSkillQuery(message.id, this.actions.querySkills).then((answer) => this.post(answer));
      case "stop":
        controller.stop();
        return;
      case "newChat":
        return void controller.newChat();
      case "chooseModel":
        return void this.chooseModel();
      case "openConversation":
        return void controller.openConversation(message.id);
      case "deleteConversation":
        return void controller.deleteConversation(message.id);
      case "setApiKey":
        return void this.actions.setApiKey(message.provider).catch((error: unknown) => {
          void vscode.window.showErrorMessage(
            vscode.l10n.t("Could not save the API key for {0}: {1}", message.provider, String(error)),
          );
        });
      case "setContextSize":
        return void this.actions.setContextSize(message.model).catch((error: unknown) => {
          console.error("broke-code: could not ask for a context size", error);
          void vscode.window.showErrorMessage(
            vscode.l10n.t("Could not save the context size of {0}: {1}", message.model, String(error)),
          );
        });
      case "openSettings":
        return void vscode.commands.executeCommand("workbench.action.openSettings", "brokeCode.providers");
      case "approve":
        controller.approve(message.id);
        return;
      case "reject":
        controller.reject(message.id, message.reason);
        return;
    }
  }
}
