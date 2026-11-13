/**
 * @module chatView
 * Sidebar webview view: serves chat HTML, relays state to webview and actions to controller.
 */
import * as vscode from "vscode";
import type { ChatController } from "../core/chatController";
import type { ConversationSearchAnswer } from "../core/conversationStore";
import { DraftQueue } from "../core/draftQueue";
import type { FileQueryAnswer } from "../core/fileIndex";
import { insertCode } from "../core/insertCode";
import { chooseModel } from "../core/modelList";
import { type ChatState, type DraftInsert, type HostMessage, parseWebviewMessage } from "../core/protocol";
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
  /** History's content search over the listed conversations; `undefined` when unanswered (`ConversationStore.search`). */
  searchConversations: (query: string) => Promise<ConversationSearchAnswer | undefined>;
  /** "broke-code: Add provider"; shows its own failures and never rejects. */
  addProvider: () => Promise<void>;
};

export class ChatView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /**
   * False until webview script posts `ready`; the webview is rebuilt on each show, and a hidden one drops what it is
   * posted, so hiding resets it too.
   */
  private ready = false;
  /** Drafts waiting for the webview, posted once, in order, right after `init`. */
  private readonly drafts = new DraftQueue({
    canDeliver: () => this.ready && this.view?.visible === true,
    send: (draft) => this.sendDraft(draft),
  });

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
    view.onDidChangeVisibility(() => {
      if (!view.visible) this.ready = false;
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

  /**
   * Put `draft` in the message box from an editor entry point, and show the chat. Never sends. The draft waits until
   * the webview is ready, a first show included, then is posted once. Without a valid provider the panel has no
   * message box: the chat shows, a notification says to add a provider, and the draft is dropped.
   */
  async insertDraft(draft: DraftInsert): Promise<void> {
    const outcome = await this.drafts.insert(draft, {
      hasProvider: this.controller.snapshot.providers.length > 0,
      // [>]: The view's generated focus command resolves it on a first show, and reveals it when hidden.
      show: async () => void (await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`)),
    });
    if (outcome === "noProvider") {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Add a provider first: the chat has no message box without one."),
      );
    }
  }

  /**
   * Put queued texts the controller returns back in the message box. The request came from the panel, so it is not
   * shown or focused: the draft waits for the webview's next `ready` when it is hidden.
   */
  returnDraft(draft: DraftInsert): void {
    void this.drafts.queue(draft);
  }

  /** Post one draft; `false` when the webview did not get it, which the queue keeps for its next `ready`. */
  private async sendDraft(draft: DraftInsert): Promise<boolean> {
    try {
      const delivered = (await this.view?.webview.postMessage({ type: "insertDraft", ...draft })) === true;
      if (!delivered) console.warn("broke-code: the chat did not take a draft; it waits for the chat's next load");
      return delivered;
    } catch (error) {
      console.error("broke-code: could not post a draft to the chat; it waits for the chat's next load", error);
      return false;
    }
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

  private async answerSearch(query: string, id: number): Promise<void> {
    const answer = await this.actions.searchConversations(query);
    if (answer) this.post({ type: "conversationMatches", id, ...answer });
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
        return void this.drafts.deliver();
      case "selectProvider":
        controller.selectProvider(message.provider);
        return;
      case "selectModel":
        controller.selectModel(message.model);
        return;
      case "retryModels":
        return void controller.loadModels();
      case "send":
        return void controller.send(message.text, message.mentions, message.replaces);
      case "queueMessage":
        return void controller.queueMessage(message.text, message.mentions);
      case "removeQueued":
        controller.removeQueued(message.id);
        return;
      case "editQueued":
        controller.editQueued(message.id);
        return;
      case "sendQueued":
        return void controller.sendQueued(message.id);
      case "queryFiles":
        return void this.answerQuery(message.query, message.id);
      case "querySkills":
        return void answerSkillQuery(message.id, this.actions.querySkills).then((answer) => this.post(answer));
      case "searchConversations":
        return void this.answerSearch(message.query, message.id);
      case "stop":
        controller.stop();
        return;
      case "newChat":
        return void controller.newChat();
      case "undoChanges":
        return void controller.undoChanges();
      case "openChangeDiff":
        return void controller.openChangeDiff(message.path);
      case "retry":
        return void controller.retry(message.shown);
      case "continueTurn":
        // [>]: The entry shows the button's label as typed; the model gets the fixed English text.
        return void controller.continueTurn(message.shown, vscode.l10n.t("Continue"));
      case "chooseModel":
        return void this.chooseModel();
      case "compact":
        return void controller.compact().then((outcome) => {
          if (outcome !== "nothingToSummarize") return;
          void vscode.window.showInformationMessage(
            vscode.l10n.t("Nothing to summarize: the conversation is empty or was just summarized."),
          );
        });
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
      case "addProvider":
        return void this.actions.addProvider();
      case "approve":
        controller.approve(message.id);
        return;
      case "reject":
        controller.reject(message.id, message.reason);
        return;
      case "setMode":
        return void controller.setMode(message.mode).then((change) => {
          if (change.kind !== "failed") return;
          void vscode.window.showErrorMessage(vscode.l10n.t("Could not change the mode: {0}", change.cause));
        });
      case "insertCode":
        // [>]: The active text editor stays the last one focused while the chat has the focus, which stays there.
        return void insertCode(
          message.text,
          {
            activeEditor: () => vscode.window.activeTextEditor,
            showError: (error) => void vscode.window.showErrorMessage(error),
          },
          vscode.l10n,
        );
    }
  }
}
