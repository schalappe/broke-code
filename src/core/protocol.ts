/**
 * @module protocol
 * Messages between extension host and chat webview, and their validation at the host boundary. Host owns state;
 * webview renders snapshots.
 */
import { type ConversationSummary, isConversationId } from "./conversation";
import type { MentionResult } from "./mentions";
import type { ProviderError } from "./providerError";
import type { SkippedProvider } from "./providers";
import type { Suggestion } from "./suggestions";

export type ModelsState =
  | { status: "noProvider" }
  | { status: "loading" }
  | { status: "loaded"; models: string[] }
  | { status: "failed"; error: ProviderError };

/**
 * `waiting`: request sent, no reasoning or answer yet (model may still be loading). `streaming`: either has started,
 * and a reply whose call is running stays `streaming` until its tool step is recorded. `halted`: the agent turn ended
 * on a limit after this reply's tool step (see `HaltReason`).
 */
export type ReplyStatus = "waiting" | "streaming" | "done" | "stopped" | "failed" | "halted";

/** `malformedCalls`: three malformed calls in a row. `stepLimit`: the turn reached its tool step limit. */
export type HaltReason = "malformedCalls" | "stepLimit";

/** The body tool call a reply's answer holds: tool name, raw argument values, and where its block sits in `content`. */
export type ReplyCall = { name: string; args: Record<string, string>; start: number; end: number };

/**
 * `ok` and `error`: what the tool returned. `malformed`: the reply's call could not be read; `text` is the message
 * sent back to the model, and `name` is the tool the block named, or `unknown` when it names none.
 */
export type ToolStepStatus = "ok" | "error" | "malformed";

export type ChatEntry =
  /** `content`: the text as typed. `mentions`: each mention read at send time, in order. */
  | { role: "user"; content: string; mentions: MentionResult[] }
  /**
   * `reasoning`: text the model writes before its answer, shown collapsed, never sent back. `content`: the whole
   * answer, its call block included, so the history resends exactly what the model wrote; the chat hides the block by
   * `call`'s range. `haltReason`: set exactly when `status` is `halted`.
   */
  | {
      role: "assistant";
      reasoning: string;
      content: string;
      status: ReplyStatus;
      error?: ProviderError;
      call?: ReplyCall;
      haltReason?: HaltReason;
    }
  /** A tool step: one body tool call of the reply before it, or its malformed block, and the text the model got back. */
  | { role: "tool"; name: string; args: Record<string, string>; status: ToolStepStatus; text: string };

/**
 * Why the conversation shown or the user's last action on a saved conversation failed: a save, delete, or open
 * that failed (`cause`: runtime error text), or a conversation to open that is missing or unreadable. A listing
 * failure has its own field, `ChatState.listFailed`.
 */
export type StorageProblem =
  | { kind: "saveFailed" | "deleteFailed" | "openFailed"; cause: string }
  | { kind: "notFound" };

export type ChatState = {
  providers: string[];
  skipped: SkippedProvider[];
  provider: string | undefined;
  models: ModelsState;
  model: string | undefined;
  /** Id of the conversation shown; `entries` are its entries. */
  conversationId: string;
  entries: ChatEntry[];
  /** Saved conversations of the workspace, newest first; the one shown is listed once saved. */
  conversations: ConversationSummary[];
  /**
   * The list could not be read whole (`cause`: runtime error text, one line per unreadable file). Cleared only by
   * the next listing that succeeds; independent of `storageProblem`, so both can show at once.
   */
  listFailed: { cause: string } | undefined;
  storageProblem: StorageProblem | undefined;
};

/** L10n bundle as `vscode.l10n.bundle`: absent in English. */
export type L10nBundle = Record<string, string>;

export type HostMessage =
  | { type: "init"; l10n: L10nBundle | undefined; state: ChatState }
  | { type: "state"; state: ChatState }
  /**
   * Answer to the `queryFiles` of the same `id`. `capped`: the index stopped at its file limit. `failed`: the
   * workspace files could not be listed, so `items` is empty for that reason, not for lack of a match.
   */
  | { type: "fileSuggestions"; id: number; items: Suggestion[]; capped: boolean; failed: boolean };

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
  /** `id`: a conversation of `ChatState.conversations`. */
  | { type: "openConversation"; id: string }
  | { type: "deleteConversation"; id: string }
  | { type: "setApiKey"; provider: string }
  | { type: "openSettings" };

/** Chat state carried by `message`; `undefined` for a message that must leave the panel's state alone. */
export function chatStateOf(message: HostMessage): ChatState | undefined {
  return message.type === "fileSuggestions" ? undefined : message.state;
}

/**
 * True while an agent turn is in flight: its last reply is waiting, streaming, or running its call. A tool step is
 * appended together with the next reply, so the last entry is a tool step only once the turn has ended.
 */
export function isReplying(state: ChatState): boolean {
  const last = state.entries.at(-1);
  return last?.role === "assistant" && (last.status === "waiting" || last.status === "streaming");
}

/** Longest menu query the host answers; the webview asks nothing past it. */
export const MAX_QUERY_LENGTH = 1024;
/** Longest picked mention path accepted. */
export const MAX_MENTION_PATH_LENGTH = 4096;

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
    case "openConversation":
    case "deleteConversation": {
      // [!]: Ids name files in the storage directory: only the shape the host makes passes.
      return isConversationId(message.id) ? { type: message.type, id: message.id } : undefined;
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

/**
 * No count cap: `findMentions` keeps only picked paths standing as whole tokens in the text, so the text's length
 * bounds the work, and a cap would silently turn the paths past it into bogus typed tokens.
 */
function pathList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = value.every(
    (path) => typeof path === "string" && path !== "" && path.length <= MAX_MENTION_PATH_LENGTH,
  );
  return valid ? (value as string[]) : undefined;
}
