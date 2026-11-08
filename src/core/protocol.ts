/**
 * @module protocol
 * Messages between extension host and chat webview. Host owns state; webview renders snapshots.
 */
import type { ProviderError } from "./providerError";
import type { SkippedProvider } from "./providers";

export type ModelsState =
  | { status: "noProvider" }
  | { status: "loading" }
  | { status: "loaded"; models: string[] }
  | { status: "failed"; error: ProviderError };

/** `waiting`: request sent, no reasoning or answer yet (model may still be loading). `streaming`: either has started. */
export type ReplyStatus = "waiting" | "streaming" | "done" | "stopped" | "failed";

export type ChatEntry =
  | { role: "user"; content: string }
  /** `reasoning`: model's thinking before its answer, shown collapsed, never sent back. `content`: the answer. */
  | { role: "assistant"; reasoning: string; content: string; status: ReplyStatus; error?: ProviderError };

export type ChatState = {
  providers: string[];
  skipped: SkippedProvider[];
  provider: string | undefined;
  models: ModelsState;
  model: string | undefined;
  entries: ChatEntry[];
};

/** L10n bundle as `vscode.l10n.bundle`: absent in English. */
export type L10nBundle = Record<string, string>;

export type HostMessage = { type: "init"; l10n: L10nBundle | undefined; state: ChatState } | { type: "state"; state: ChatState };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "selectProvider"; provider: string }
  | { type: "selectModel"; model: string }
  | { type: "retryModels" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "setApiKey"; provider: string }
  | { type: "openSettings" };

/** True while a reply is in flight. */
export function isReplying(state: ChatState): boolean {
  const last = state.entries.at(-1);
  return last?.role === "assistant" && (last.status === "waiting" || last.status === "streaming");
}
