/**
 * @module extension
 * Activation entry point: registers chat view.
 */
import * as vscode from "vscode";
import { renderWebviewHtml } from "../core/webviewHtml";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("brokeCode.chat", {
      resolveWebviewView(view) {
        const distUri = vscode.Uri.joinPath(context.extensionUri, "dist", "webview");
        view.webview.options = { enableScripts: true, localResourceRoots: [distUri] };
        view.webview.html = renderWebviewHtml({
          cspSource: view.webview.cspSource,
          scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(distUri, "main.js")).toString(),
          styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(distUri, "main.css")).toString(),
          nonce: crypto.randomUUID().replaceAll("-", ""),
          language: vscode.env.language,
        });
      },
    }),
  );
}

export function deactivate(): void {}
