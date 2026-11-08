/**
 * @module protocol
 * Messages between extension host and chat webview, and their validation at the host boundary. Host owns state;
 * webview renders snapshots.
 */
import type { MentionResult } from "./mentions";
import type { ProviderError } from "./providerError";
import type { SkippedProvider } from "./providers";
import type { Suggestion } from "./suggestions";

export type ModelsState =
  | { status: "noProvider" }
  | { status: "loading" }
  | { status: "loaded"; models: string[] }
  | { status: "failed"; error: ProviderError };

/** `waiting`: request sent, no reasoning or answer yet (model may still be loading). `streaming`: either has started. */
export type ReplyStatus = "waiting" | "streaming" | "done" | "stopped" | "failed";

export type ChatEntry =
  /** `content`: the text as typed. `mentions`: each mention read at send time, in order. */
  | { role: "user"; content: string; mentions: MentionResult[] }
  /** `reasoning`: text the model writes before its answer, shown collapsed, never sent back. `content`: the answer. */
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

export type HostMessage =
  | { type: "init"; l10n: L10nBundle | undefined; state: ChatState }
  | { type: "state"; state: ChatState }
  /** Answer to the `queryFiles` of the same `id`. `capped`: the index stopped at its file limit. */
  | { type: "fileSuggestions"; id: number; items: Suggestion[]; capped: boolean };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "selectProvider"; provider: string }
  | { type: "selectModel"; model: string }
  | { type: "retryModels" }
  /** `mentions`: paths picked in the menu; see `ChatController.send`. */
  | { type: "send"; text: string; mentions: string[] }
  /** `id`: grows with each query, so the webview can drop stale answers. */
  | { type: "queryFiles"; query: string; id: number }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "setApiKey"; provider: string }
  | { type: "openSettings" };

/** True while a reply is in flight. */
export function isReplying(state: ChatState): boolean {
  const last = state.entries.at(-1);
  return last?.role === "assistant" && (last.status === "waiting" || last.status === "streaming");
}

/** Longest menu query the host answers; the webview asks nothing past it. */
export const MAX_QUERY_LENGTH = 1024;
/** Longest picked mention path accepted. */
export const MAX_MENTION_PATH_LENGTH = 4096;
/** Most picked mentions accepted in one `send`. */
export const MAX_PICKED_MENTIONS = 100;

/** Validate a webview message's shape at the host boundary. Unknown or out of bounds -> `undefined`. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
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
      const mentions = pathList(message.mentions);
      return value === undefined || mentions === undefined ? undefined : { type: "send", text: value, mentions };
    }
    case "queryFiles": {
      const query = text("query");
      const id = message.id;
      if (query === undefined || query.length > MAX_QUERY_LENGTH) return undefined;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return undefined;
      return { type: "queryFiles", query, id };
    }
    default:
      return undefined;
  }
}

function pathList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PICKED_MENTIONS) return undefined;
  const valid = value.every(
    (path) => typeof path === "string" && path !== "" && path.length <= MAX_MENTION_PATH_LENGTH,
  );
  return valid ? (value as string[]) : undefined;
}
