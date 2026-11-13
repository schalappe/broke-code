/**
 * @module protocol
 * Messages between extension host and chat webview, and their validation at the host boundary. Host owns state;
 * webview renders snapshots.
 */
import { type ConversationMatch, type ConversationSummary, isConversationId } from "./conversation";
import type { MentionResult } from "./mentions";
import type { ProviderError } from "./providerError";
import type { SkippedProvider } from "./providers";
import type { SlashCommand, Suggestion } from "./suggestions";

export type ModelsState =
  | { status: "noProvider" }
  | { status: "loading" }
  | { status: "loaded"; models: string[] }
  | { status: "failed"; error: ProviderError };

/**
 * `waiting`: request sent, no reasoning or answer yet (model may still be loading). `streaming`: either has started,
 * and a reply whose call is running stays `streaming` until its tool step is recorded. `halted`: the agent turn ended
 * on a limit (see `HaltReason`): after this reply's tool step, or, when the context is full, before this reply's
 * request was sent.
 */
export type ReplyStatus = "waiting" | "streaming" | "done" | "stopped" | "failed" | "halted";

/**
 * `malformedCalls`: three malformed calls in a row. `stepLimit`: the turn reached its tool step limit. `contextFull`:
 * the next request's estimate left less than one eighth of the model's context for the reply, even with every older
 * tool result that may go left out, so it was not sent.
 */
export type HaltReason = "malformedCalls" | "stepLimit" | "contextFull";

/** The body tool call a reply's answer holds: tool name, raw argument values, and where its block sits in `content`. */
export type ReplyCall = { name: string; args: Record<string, string>; start: number; end: number };

/**
 * `ok` and `error`: what the tool returned. `malformed`: the reply's call could not be read; `text` is the message
 * sent back to the model, and `name` is the tag name the block opens with, a known tool or not, or `unknown` when
 * no name can be read.
 */
export type ToolStepStatus = "ok" | "error" | "malformed";

/**
 * How a tool step that changes the workspace was approved: `accepted` or `rejected` by the user, or `auto` by the
 * auto-approve setting. Absent for a tool that asks nothing, such as a read.
 */
export type StepApproval = "accepted" | "rejected" | "auto";

/**
 * The approval request open in the chat: the user's Accept or Reject of the call the reply runs. `id`: the request's,
 * carried by the decision, so a decision for a request no longer open is ignored. `kind`: `write` (Accept and Reject)
 * or `command` (Run and Reject). `summary`: what it acts on, such as the file a write changes or the whole command.
 * `lines`: a write's added and removed lines. `preview`: a diff of the change opened beside the chat, which Show change
 * brings back.
 */
export type PendingApproval = {
  id: number;
  kind: "write" | "command";
  tool: string;
  summary: string;
  lines?: { added: number; removed: number };
  preview?: true;
};

/**
 * The `ask_user` question open in the chat, which the reply in flight waits on. `id`: the question's, carried by the
 * answer, so an answer for a question no longer open is ignored. `question`: its text, in full. `options`: the answers
 * the model proposes, in its order, maybe none; the user may always type another.
 */
export type PendingQuestion = { id: number; question: string; options: string[] };

/**
 * The skill a user message loads with `/<name>`: `loaded` when its text reached the model, `failed` when its `SKILL.md`
 * could not be read at send, and the model got a notice instead.
 */
export type UserSkill = { name: string; status: "loaded" | "failed" };

export type ChatEntry =
  /**
   * `content`: the text as typed. `mentions`: each mention read at send time, in order. `skill`: set when the message
   * starts with `/<name>` of a discovered skill.
   */
  | { role: "user"; content: string; mentions: MentionResult[]; skill?: UserSkill }
  /**
   * `reasoning`: text the model writes before its answer, shown collapsed, never sent back. `content`: the whole
   * answer, its call block included, so the history resends exactly what the model wrote; the chat hides the block by
   * `call`'s range. `haltReason`: set exactly when `status` is `halted`. `summary`: the reply to `/compact`, a summary
   * of the conversation before it; once it ends `done` with text, the history sent starts at it (`historyStart`).
   */
  | {
      role: "assistant";
      reasoning: string;
      content: string;
      status: ReplyStatus;
      error?: ProviderError;
      call?: ReplyCall;
      haltReason?: HaltReason;
      summary?: true;
    }
  /**
   * A tool step: one body tool call of the reply before it, or its malformed block, and the text the model got back.
   * `approval`: set when the call asked for one. `lines`: the lines a write that went through added and removed, as
   * its approval showed them. `undone`: a write step whose file "Undo changes" later restored or removed; the history
   * tells the model so, and never leaves its result out.
   */
  | {
      role: "tool";
      name: string;
      args: Record<string, string>;
      status: ToolStepStatus;
      text: string;
      approval?: StepApproval;
      lines?: { added: number; removed: number };
      undone?: true;
    };

/**
 * Why the conversation shown or the user's last action on a saved conversation failed: a save, delete, or open
 * that failed (`cause`: runtime error text), or a conversation to open that is missing or unreadable. A listing
 * failure has its own field, `ChatState.listFailed`.
 */
export type StorageProblem =
  | { kind: "saveFailed" | "deleteFailed" | "openFailed"; cause: string }
  | { kind: "notFound" };

/**
 * Why a skill was skipped. `unparsableField`: the field's value is a form the frontmatter reader does not take, such as
 * a quoted value that does not close on its line. `folderUnreadable`: a skills folder exists but cannot be listed.
 * `tooManyEntries`: a skills folder holds more than `MAX_SKILL_ENTRIES` entries (`entries`), and only the first, by
 * name, were read. `outsideSkillFolder`: the skill's `SKILL.md` resolves outside the skill's folder. `cause`: runtime error code or text.
 */
export type SkillProblem =
  | {
      kind:
        | "noFrontmatter"
        | "missingName"
        | "nameTooLong"
        | "invalidName"
        | "missingDescription"
        | "descriptionTooLong"
        | "tooLarge"
        | "binary"
        | "outsideWorkspace"
        | "outsideSkillFolder";
    }
  | { kind: "nameMismatch"; name: string; directory: string }
  | { kind: "unparsableField"; field: "name" | "description" }
  | { kind: "unreadable" | "folderUnreadable"; cause: string }
  | { kind: "tooManyEntries"; entries: number };

/** A skipped skill: `path` names its `SKILL.md`, or its skills folder, as the user sees it (`~/` for the home folder). */
export type SkillWarning = { path: string; problem: SkillProblem };

/**
 * The next request's estimated size, as it would be sent, against the selected model's context size, both in tokens.
 * `known`: the model is in `brokeCode.contextSizes`; else `size` is 32,768. `leftOut`: the older tool results that
 * request leaves out to fit the context (see `toHistory`), present only when there are any; the panel shows a notice.
 * `reported`: the usage the last chat request of the conversation shown reported, kept while the next one is in flight;
 * absent when it reported none, after a change of the conversation shown or of the model, and after a window reload.
 */
export type ContextUsage = { used: number; size: number; known: boolean; leftOut?: number; reported?: ReportedUsage };

/**
 * The token counts a provider reported for one reply (`usage.prompt_tokens`, `usage.completion_tokens`): what the
 * request's messages and the reply cost, as the provider counted them. Advisory: never checked against the estimate.
 */
export type ReportedUsage = { prompt: number; completion: number };

/**
 * What an agent turn may do: `ask` waits for Accept or Reject on each write, `autoEdit` accepts writes at once, both
 * derived from the user value of `brokeCode.autoApproveWrites`; `plan` offers the read tools and `ask_user` only, kept per workspace
 * and winning over the setting while on. Commands wait for Run in every mode that offers them.
 */
export const MODES = ["ask", "autoEdit", "plan"] as const;
export type Mode = (typeof MODES)[number];

export function isMode(value: unknown): value is Mode {
  return MODES.some((mode) => mode === value);
}

/**
 * A message the user sent while a reply was in flight, waiting in `ChatState.queue` for a turn to end `done`. `id`: the
 * controller's, unique in the session. `text`: as sent, trimmed. `mentions`: the paths picked in the menu, as `send`
 * carries them; the mentions are read when the message is sent, never when it is queued.
 */
export type QueuedMessage = { id: number; text: string; mentions: string[] };

/** Most messages the queue holds: the whole state is posted at each streamed delta. */
export const MAX_QUEUED_MESSAGES = 10;

/**
 * Why "Undo changes" left a file untouched. `changed`: it holds neither the text the writes left nor its original text
 * (edited since, removed, made a folder, or no longer text). `unsaved`: an editor holds unsaved changes to it.
 * `symlink`: it is now a symbolic link. `outsideWorkspace`: it is in no workspace folder now, or its path leads out of
 * them. `failed`: the write or the removal failed on disk, or the file could not be read (`cause`).
 */
export type RestoreRefusal = "changed" | "unsaved" | "symlink" | "outsideWorkspace" | "failed";

/**
 * What "Undo changes" did to one file of the held turn, named as the file index writes it. `restored`: it holds its
 * text from before the turn again; `removed`: the turn created it, and it is gone; `skipped`: untouched, for `reason`
 * (see `RestoreRefusal`), and still held, so the next undo retries it. `leftover`: the temporary file of the restoring
 * write could not be removed and sits beside the file as `name`.
 */
export type UndoneFile = { path: string; leftover?: { name: string; cause: string } } & UndoneStatus;

/** What an undo did to one file; see `UndoneFile`. */
export type UndoneStatus =
  | { status: "restored" | "removed" }
  | { status: "skipped"; reason: Exclude<RestoreRefusal, "failed"> }
  | { status: "skipped"; reason: "failed"; cause: string };

/**
 * "Undo changes" in the panel: the file changes of the latest turn of the conversation shown that wrote a file, held
 * in the host's memory only; never their text here. `reply`: the index in `entries` of that turn's last reply, which
 * carries the button; absent while nothing is held, or a reply is in flight. `ranCommand`: that turn ran a command,
 * which no undo reverts. `running`: an undo runs; Send does not act and no other undo starts. `outcome`: what the last
 * undo did, file by file, shown under the reply `reply` names; cleared by the next send, the next undo, and any change
 * of the conversation shown. `outcome.error`: the undo failed unexpectedly (a bug), with this message; `files` then
 * lists only the files restored or removed before the failure, and the others stay held for a retry.
 */
export type UndoState = {
  reply: number | undefined;
  ranCommand: boolean;
  running: boolean;
  outcome: { reply: number; files: UndoneFile[]; error?: string } | undefined;
};

/**
 * One row of "Changed files": a file the turn `UndoState.reply` names created or edited and still holds, named as the
 * file index writes it (else as the model wrote it), with the lines its writes added and removed since before the
 * turn (see `lineDiffCount`). Never its text.
 */
export type ChangedFile = { path: string; kind: "created" | "edited"; added: number; removed: number };

/**
 * Reasoning effort the user picked for a model, sent as the request's `reasoning_effort`. No pick ("Default") sends no
 * field, so a provider that rejects it is unaffected until the user picks one.
 */
export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.some((effort) => effort === value);
}

export type ChatState = {
  providers: string[];
  skipped: SkippedProvider[];
  /** The skills the last send skipped, refreshed at each send; empty before the first. */
  skillWarnings: SkillWarning[];
  provider: string | undefined;
  models: ModelsState;
  model: string | undefined;
  /** Picked for the selected provider and model, remembered per pair in the workspace; `undefined`: Default. */
  reasoningEffort: ReasoningEffort | undefined;
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
  /** Usage of the conversation shown under the current settings; recomputed at each update. */
  context: ContextUsage;
  /** The approval request the reply in flight waits on; at most one, since one call runs per reply. */
  approval?: PendingApproval;
  /** The question the reply in flight waits on; never beside `approval`, since one call runs per reply. */
  question?: PendingQuestion;
  /**
   * The call of the reply in flight is running: set as the call shows when its tool never asks (`ToolSpec.asks`), and
   * once its approval is accepted, by the user or auto-approve. False before a tool that asks opens its request, while
   * a request is open, after a rejection, a cancellation, or an answer, and from the moment the call ends.
   */
  callRunning: boolean;
  /**
   * `plan` while Plan is on in this workspace, else the mode the setting holds; never the one last picked: a failed
   * write leaves it as it was.
   */
  mode: Mode;
  /**
   * The mode the setting holds, whatever `mode` says: the one Plan leaves for, which the "Implement in ... mode" button
   * names. Read again whenever the setting changes.
   */
  settingMode: Exclude<Mode, "plan">;
  /**
   * A mode pick's settings write is pending: the mode selector and Send are disabled, and the host ignores `setMode`
   * and `send`, as while a reply is in flight.
   */
  modePending: boolean;
  /**
   * Messages queued while a reply was in flight, in order; the first is sent when a turn ends `done`. Kept in the
   * panel's state only: never saved, lost at a window reload. Emptied by New chat, opening another conversation, and
   * deleting the one shown, when they are asked.
   */
  queue: QueuedMessage[];
  undo: UndoState;
  /**
   * "Changed files" under the reply `undo.reply` names, in the order of each file's first write; empty whenever that
   * reply is absent.
   */
  changedFiles: ChangedFile[];
};

/**
 * Text the host puts in the message box, never sent. From an editor entry point: `caret` inserts it at the box's
 * caret, spaced from the text around it; `fillOrAppend` fills a box empty or holding only whitespace, else appends it
 * after one line break; either closes History and focuses the box. From the queue: `paragraph`, the queued texts the
 * controller took out without sending them (navigation, Edit) or refused to queue, fills a blank box, else follows its
 * text after a blank line, and closes nothing and moves no focus. `picked`: the paths its mentions name, added to the
 * box's picked paths, so a path with spaces or trailing punctuation is one mention.
 */
export type DraftInsert = { text: string; mode: "caret" | "fillOrAppend" | "paragraph"; picked: string[] };

/** L10n bundle as `vscode.l10n.bundle`: absent in English. */
export type L10nBundle = Record<string, string>;

export type HostMessage =
  | { type: "init"; l10n: L10nBundle | undefined; state: ChatState }
  | { type: "state"; state: ChatState }
  /**
   * Answer to the `queryFiles` of the same `id`. `capped`: the index stopped at its file limit. `failed`: the
   * workspace files could not be listed, so `items` is empty for that reason, not for lack of a match.
   */
  | { type: "fileSuggestions"; id: number; items: Suggestion[]; capped: boolean; failed: boolean }
  /**
   * Answer to the `querySkills` of the same `id`: every skill a send would discover, those kept from the model
   * included, by name. `failed`: the skills could not be listed, so `items` is empty for that reason.
   */
  | { type: "skillSuggestions"; id: number; items: SlashCommand[]; failed: boolean }
  /**
   * Answer to the `searchConversations` of the same `id`: every listed conversation whose messages hold the query, in
   * the list's order, each with its excerpt. `unreadableCount`: records left out because they could not be read or
   * were invalid; a record deleted meanwhile is not counted.
   */
  | { type: "conversationMatches"; id: number; items: ConversationMatch[]; unreadableCount: number }
  /**
   * "Add selection to chat" or "Fix with broke-code": edit the draft, close History, and focus the message box. Posted
   * once, after `init`.
   */
  | ({ type: "insertDraft" } & DraftInsert);

/**
 * What the panel showed when the user asked to Retry, Continue, implement a plan, or send while replacing the last
 * turn (Edit): the conversation shown (`ChatState.conversationId`) and its entries count. The host acts only on that
 * conversation with that count, so a click on a lagging panel removes or extends nothing but the turn it showed.
 */
export type ShownEntries = { conversationId: string; entries: number };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "selectProvider"; provider: string }
  | { type: "selectModel"; model: string }
  /** `undefined`: Default, which sends no `reasoning_effort`. */
  | { type: "selectReasoningEffort"; effort: ReasoningEffort | undefined }
  | { type: "retryModels" }
  /**
   * `mentions`: paths picked in the menu; see `ChatController.send`. `replaces`: sent while the panel was replacing the
   * last turn (Edit), what it showed; the host removes that turn first when it still may.
   */
  | { type: "send"; text: string; mentions: string[]; replaces?: ShownEntries }
  /** Send while a reply is in flight: queue the message, with its picked mention paths, as `send` carries them. */
  | { type: "queueMessage"; text: string; mentions: string[] }
  /** Remove queued message `id`. */
  | { type: "removeQueued"; id: number }
  /** Edit queued message `id`: the host removes it and returns its text to the message box as a `paragraph` draft. */
  | { type: "editQueued"; id: number }
  /** "Send now" on queued message `id` while the queue is paused; acts only on the first, and only when Send would. */
  | { type: "sendQueued"; id: number }
  /** `id`: grows with each query, so the webview can drop stale answers. */
  | { type: "queryFiles"; query: string; id: number }
  /** Ask once per `/` menu opening for the skills; the webview filters them as the user types. `id`: as `queryFiles`. */
  | { type: "querySkills"; id: number }
  /**
   * Search the messages of the listed conversations for `query`, a needle (`searchNeedle`). `id`: as `queryFiles`; the
   * host answers only the latest search and stops the reads of an older one.
   */
  | { type: "searchConversations"; query: string; id: number }
  /** `/model`: open the editor's model list over the selected provider's models; a pick goes as `selectModel`. */
  | { type: "chooseModel" }
  /** `/compact`: summarize the conversation shown; later requests send the summary in place of what came before. */
  | { type: "compact" }
  | { type: "stop" }
  | { type: "newChat" }
  /** `id`: a conversation of `ChatState.conversations`. */
  | { type: "openConversation"; id: string }
  | { type: "deleteConversation"; id: string }
  | { type: "setApiKey"; provider: string }
  /** Ask the user for `model`'s context size and save it to `brokeCode.contextSizes`. */
  | { type: "setContextSize"; model: string }
  | { type: "openSettings" }
  /** "broke-code: Add provider": the guided flow in the editor's Quick Pick and input boxes. */
  | { type: "addProvider" }
  /** The user's decision on approval request `id` (`ChatState.approval`); `reason`: optional, as typed. */
  | { type: "approve"; id: number }
  | { type: "reject"; id: number; reason?: string }
  /** Show change: bring back the diff of approval request `id`, opened again if the user closed it. */
  | { type: "showChange"; id: number }
  /** The user's answer to question `id` (`ChatState.question`); `text`: trimmed, never empty (`MAX_ANSWER_LENGTH`). */
  | { type: "answer"; id: number; text: string }
  /** Insert at cursor: replace every selection of the active text editor with a code block's `text`. */
  | { type: "insertCode"; text: string }
  /**
   * Pick a mode in the message box: Plan is kept in the workspace memento; Ask and Auto-edit write the user setting
   * `brokeCode.autoApproveWrites` when its value must change.
   */
  | { type: "setMode"; mode: Mode }
  /** "Undo changes": restore the files of the turn `ChatState.undo.reply` names. */
  | { type: "undoChanges" }
  /** A row of "Changed files": open the diff of the first held file the row's displayed `path` names. */
  | { type: "openChangeDiff"; path: string }
  /** Retry or Continue the last turn (see `lastTurnActions`) of what the panel showed. */
  | { type: "retry" | "continueTurn"; shown: ShownEntries }
  /**
   * "Implement in ... mode" under a plan's final answer (see `hasFinalAnswer`): leave Plan for the mode the setting
   * holds and send the message asking to carry the plan out. `shown`: what the panel showed. Carries no mode.
   */
  | { type: "implementPlan"; shown: ShownEntries };

/** Chat state carried by `message`; `undefined` for a message that must leave the panel's state alone. */
export function chatStateOf(message: HostMessage): ChatState | undefined {
  return message.type === "init" || message.type === "state" ? message.state : undefined;
}

/**
 * True while an agent turn is in flight: its last reply is waiting, streaming, or running its call. A tool step is
 * appended together with the next reply, so the last entry is a tool step only once the turn has ended.
 */
export function isReplying(state: ChatState): boolean {
  const last = state.entries.at(-1);
  return last?.role === "assistant" && (last.status === "waiting" || last.status === "streaming");
}

/**
 * Whether Send would act now: a model chosen, no reply in flight, no mode change being written, and no undo running.
 * The one check of the panel's Send, Enter, built-in commands, Send now, Retry, Continue, and "Implement in ... mode";
 * the host checks the same conditions again (`mayStartTurn`), since the panel's state may lag.
 */
export function sendWouldAct(state: ChatState): boolean {
  return state.model !== undefined && !isReplying(state) && !state.modePending && !state.undo.running;
}

/**
 * The queue waits for "Send now" or a turn that ends `done`: it holds a message and no reply is in flight, so the last
 * turn did not end `done`, or Send could not act when it did.
 */
export function isQueuePaused(state: ChatState): boolean {
  return state.queue.length > 0 && !isReplying(state);
}

/** Longest menu query the host answers; the webview asks nothing past it. */
export const MAX_QUERY_LENGTH = 1024;
/** Fewest characters (code points) a History content search needs. */
const MIN_NEEDLE_LENGTH = 3;

/**
 * The History content search's needle for the field's `text`: trimmed, lower case, whitespace runs collapsed to one
 * space. `searchable`: at least 3 characters and within `MAX_QUERY_LENGTH`, so the protocol accepts it. The webview
 * sends only a searchable needle, and the host searches only one.
 */
export function searchNeedle(text: string): { needle: string; searchable: boolean } {
  const needle = text.trim().replace(/\s+/g, " ").toLowerCase();
  const searchable = needle.length <= MAX_QUERY_LENGTH && [...needle].length >= MIN_NEEDLE_LENGTH;
  return { needle, searchable };
}
/** UTF-16 units an answer to a question may hold once trimmed; the panel's field stops typing there. */
export const MAX_ANSWER_LENGTH = 4000;
/** Longest picked mention path accepted. */
export const MAX_MENTION_PATH_LENGTH = 4096;
/**
 * Total `delta.content` plus reasoning fields of one reply, in UTF-16 code units: the client cuts a reply off past it.
 * Also the longest `insertCode` text, since a code block cannot be longer than its reply.
 */
export const REPLY_MAX_LENGTH = 4 * 1024 * 1024;

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
    case "chooseModel":
    case "compact":
    case "openSettings":
    case "addProvider":
    case "undoChanges":
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
    case "selectReasoningEffort": {
      // [>]: Default goes as a missing field: `undefined` does not survive the webview's JSON.
      const { effort } = message;
      if (effort === undefined) return { type: "selectReasoningEffort", effort: undefined };
      return isReasoningEffort(effort) ? { type: "selectReasoningEffort", effort } : undefined;
    }
    case "setContextSize": {
      // [!]: The name becomes a key of a user setting: an empty one is refused.
      const model = text("model");
      return model ? { type: "setContextSize", model } : undefined;
    }
    case "send": {
      const value = text("text");
      const mentions = pathList(message.mentions);
      const { replaces } = message;
      if (value === undefined || mentions === undefined) return undefined;
      if (replaces === undefined) return { type: "send", text: value, mentions };
      const shown = shownEntries(replaces);
      return shown ? { type: "send", text: value, mentions, replaces: shown } : undefined;
    }
    case "queueMessage": {
      const value = text("text");
      const mentions = pathList(message.mentions);
      return value === undefined || mentions === undefined
        ? undefined
        : { type: "queueMessage", text: value, mentions };
    }
    case "removeQueued":
    case "editQueued":
    case "sendQueued":
      return isRequestId(message.id) ? { type: message.type, id: message.id } : undefined;
    case "openConversation":
    case "deleteConversation": {
      // [!]: Ids name files in the storage directory: only the shape the host makes passes.
      return isConversationId(message.id) ? { type: message.type, id: message.id } : undefined;
    }
    case "queryFiles": {
      const query = text("query");
      const id = message.id;
      if (query === undefined || query.length > MAX_QUERY_LENGTH) return undefined;
      if (!isRequestId(id)) return undefined;
      return { type: "queryFiles", query, id };
    }
    case "querySkills":
      return isRequestId(message.id) ? { type: "querySkills", id: message.id } : undefined;
    case "searchConversations": {
      const query = text("query");
      const id = message.id;
      if (query === undefined || query.length > MAX_QUERY_LENGTH || !isRequestId(id)) return undefined;
      return { type: "searchConversations", query, id };
    }
    case "approve":
      return isRequestId(message.id) ? { type: "approve", id: message.id } : undefined;
    case "showChange":
      return isRequestId(message.id) ? { type: "showChange", id: message.id } : undefined;
    case "reject": {
      const { id, reason } = message;
      if (!isRequestId(id) || (reason !== undefined && typeof reason !== "string")) return undefined;
      return reason === undefined ? { type: "reject", id } : { type: "reject", id, reason };
    }
    case "answer": {
      const value = text("text")?.trim();
      if (!isRequestId(message.id) || !value || value.length > MAX_ANSWER_LENGTH) return undefined;
      return { type: "answer", id: message.id, text: value };
    }
    case "insertCode": {
      const value = text("text");
      return value === undefined || value.length > REPLY_MAX_LENGTH ? undefined : { type: "insertCode", text: value };
    }
    case "retry":
    case "continueTurn":
    case "implementPlan": {
      const shown = shownEntries(message.shown);
      return shown ? { type: message.type, shown } : undefined;
    }
    case "openChangeDiff": {
      const path = text("path");
      return path && path.length <= MAX_MENTION_PATH_LENGTH ? { type: "openChangeDiff", path } : undefined;
    }
    case "setMode":
      return isMode(message.mode) ? { type: "setMode", mode: message.mode } : undefined;
    default:
      return undefined;
  }
}

/** `value` as `ShownEntries`, its unknown keys dropped; `undefined` for any other shape. */
function shownEntries(value: unknown): ShownEntries | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { conversationId, entries } = value as Record<string, unknown>;
  return isConversationId(conversationId) && isRequestId(entries) ? { conversationId, entries } : undefined;
}

function isRequestId(id: unknown): id is number {
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0;
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
