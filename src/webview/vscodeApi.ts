import type { WebviewMessage } from "../core/protocol";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

// [&]: acquireVsCodeApi may be called once per webview load.
const api = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
  api.postMessage(message);
}
