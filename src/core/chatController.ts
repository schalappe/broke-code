/**
 * @module chatController
 * Chat state owner: provider and model choice, model listing, agent turns (streamed replies, body tool calls, tool
 * steps, their approval requests, step limit, context budget), the queue of messages sent during a turn, context
 * usage, stop, and the workspace's saved
 * conversations (new chat, reopen, delete). The conversation shown is saved when a message is sent, at most every 500 ms while a reply streams, when a
 * call starts, after each tool step, and when the turn ends, so a reload or crash loses at most the reply streaming.
 * vscode-free: host passes key store, workspace memento, mention reader, conversation store, tool runner, instruction
 * file reader, skill reader, limits source, and the auto-approve setting's reader and writer through ports.
 */
import type { ApprovalRequest, Decision, Preview } from "./approval";
import { type ChatMessage, listModels, type ProviderAccess, streamChat } from "./client";
import {
  CONVERSATION_VERSION,
  type ConversationRecord,
  type ConversationSummary,
  conversationsOverLimit,
  isConversationId,
  newConversationId,
  type StoredEntry,
  summarize,
} from "./conversation";
import type { ConversationStore } from "./conversationStore";
import { type HistoryBudget, toHistory } from "./history";
import { contextOf, estimateTokens, fillsContext, parseLimits, type TurnLimits } from "./limits";
import { composeUserMessage, findMentions, type MentionReader, type MentionResult, type ReadMention } from "./mentions";
import {
  type ChatEntry,
  type ChatState,
  type ContextUsage,
  type DraftInsert,
  type HaltReason,
  isReplying,
  MAX_QUEUED_MESSAGES,
  type Mode,
  type ReplyStatus,
  type StepApproval,
  type StorageProblem,
} from "./protocol";
import type { ParsedProviders, Provider } from "./providers";
import { reservedMention } from "./reservedMentions";
import { SerialQueue } from "./serialQueue";
import { findSlashSkill, loadSkillText, type SkillDiscovery } from "./skills";
import { builtInCommand } from "./suggestions";
import {
  composeSystemPrompt,
  type InstructionFile,
  offeredTools,
  PLAN_BLOCKED_TOOLS,
  type Skill,
} from "./systemPrompt";
import { forgedResultCut, type ParsedReply, parseToolCall, type ToolSpec } from "./toolCalls";
import type { ToolCall, ToolResult } from "./tools";

/** API key lookup. `undefined` = no key; must not reject. */
export type KeyStore = { get(provider: string): Promise<string | undefined> };

/** Per-workspace storage; `vscode.Memento` fits. */
export type ChoiceStore = {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
};

/**
 * What a tool run gets from its turn. `signal`: Stop; the turn does not wait for a run that ignores it.
 * `requestApproval`: asks the user to accept or reject what the call is about to do, and settles with the decision.
 * The request shows in `ChatState.approval` with its preview open until the user decides; Stop, and the navigation
 * that stops the reply, cancel it and close the preview. A write is accepted at once, without a preview, while the
 * auto-approve setting is on; a command always waits. Rejects only when the preview cannot open, or when another
 * request of the run is still open. `skills`: the valid skills the send discovered. `skillRoots`: the real folders of
 * the skills loaded in the conversation, the ones the read tools may also read, derived at each call (see
 * `loadedSkillRoots`), so a load earlier in the turn counts.
 */
export type ToolContext = {
  signal: AbortSignal;
  requestApproval: (request: ApprovalRequest) => Promise<Decision>;
  skills: readonly Skill[];
  skillRoots: readonly string[];
};

/**
 * Runs body tool calls. `tools`: what the system prompt lists and the parser accepts, but `load_skill`, offered only
 * while a skill is listed to the model (see `offeredTools`). `run` must not reject.
 */
export type ToolRunner = {
  tools: readonly ToolSpec[];
  run(call: ToolCall, context: ToolContext): Promise<ToolResult>;
};

/**
 * Reads the instruction files for the system prompt, in prompt order, at each send. A missing file is left out; one
 * that cannot be read is logged and left out. Must not reject.
 */
export type InstructionReader = { read(): Promise<InstructionFile[]> };

/**
 * Discovers the skills at each send: the valid ones for the system prompt, a warning per skipped one for the panel.
 * Must not reject.
 */
export type SkillReader = { read(): Promise<SkillDiscovery> };

/** The current turn limits, from the user settings. Must not throw. */
export type LimitsSource = { read(): TurnLimits };

/**
 * What the controller needs from the host. `limits`: absent gives the defaults (50 steps, 32,768 tokens for every
 * model). `autoApproveWrites`: the auto-approve setting, read at each write's approval request, so turning it off
 * reaches the next write of a turn in flight; absent or throwing means off. It also gives `ChatState.mode`, read at
 * `modeChanged` and after each `setMode`.
 * `writeAutoApproveWrites`: writes the user value of that setting; rejects when the write fails; absent, every write
 * fails. `returnDraft`: puts a `paragraph` draft in the message box, delivered when the panel can take it: the queued
 * texts the controller takes out without sending them, or refuses to queue, so nothing typed is lost; absent, each is
 * logged as lost. `now`: clock for record times, in milliseconds since the epoch.
 */
export type ChatPorts = {
  apiKeys: KeyStore;
  workspaceState: ChoiceStore;
  publish: (state: ChatState) => void;
  mentions: MentionReader;
  store: ConversationStore;
  tools: ToolRunner;
  instructions: InstructionReader;
  skills: SkillReader;
  limits?: LimitsSource;
  autoApproveWrites?: () => boolean;
  writeAutoApproveWrites?: (on: boolean) => Promise<void>;
  returnDraft?: (draft: DraftInsert) => void;
  now?: () => number;
};

/**
 * What a mode pick did: `written`, the mode changed (the setting written, Plan turned on or off, or both);
 * `unchanged`, it was already the mode; `ignored`, a reply is in flight; `failed`, the setting's write rejected with
 * `cause`, logged, and the mode shown is still the one before (Plan stays on).
 */
export type ModeChange = { kind: "written" | "unchanged" | "ignored" } | { kind: "failed"; cause: string };

/** Malformed calls in a row that halt an agent turn; a call that parses resets the count. */
export const MAX_MALFORMED_IN_A_ROW = 3;

const LAST_CHOICE_KEY = "brokeCode.lastChoice";
/**
 * `true` while Plan is on in this workspace. A key of its own: the provider and model choice is rewritten whole and
 * cleared without a provider, and Plan must survive both.
 */
const PLAN_KEY = "brokeCode.plan";
/** Id of the conversation shown, reopened at the next window load. */
const CURRENT_CONVERSATION_KEY = "brokeCode.currentConversation";
/** Shortest time between two saves of a streaming reply. */
const SAVE_INTERVAL_MS = 500;

type LastChoice = { provider: string; model?: string };

/**
 * One conversation in memory. `entries` is the array `ChatState.entries` holds while it is shown; a reply keeps
 * the conversation it was sent in, so its saves land in that record even after another one is shown.
 */
type Conversation = {
  id: string;
  createdAt: number;
  /** Provider and model of the last send in this session; a reopened conversation gets them at its next send. */
  provider?: string;
  model?: string;
  entries: ChatEntry[];
  /** Pending throttled save while a reply streams. */
  saveTimer?: ReturnType<typeof setTimeout>;
};

export class ChatController {
  private providers: Provider[] = [];
  private conversation: Conversation;
  private state: ChatState;
  /**
   * In-flight agent turn: its abort handle, the provider it streams from, and `settled`, which resolves once the turn
   * has ended and its last save has been handed to the store. After Stop it waits neither for `streamChat` nor for a
   * tool run to return.
   */
  private reply: { abort: AbortController; provider: Provider; settled: Promise<void> } | undefined;
  /** Bumped per listing request; stale listings dropped. */
  private listingId = 0;
  /** Last id given to a queued message. */
  private queuedId = 0;
  /** Bumped per approval request shown; a decision counts only for the request open. */
  private approvalId = 0;
  /** The approval request open, mirrored in `ChatState.approval`, and how to settle it. */
  private openApproval: { id: number; settle: (decision: Decision) => void } | undefined;
  /**
   * Navigation (restore, New chat, open, delete, pruning) runs one operation at a time, in request order, so the
   * conversation shown is always the result of the last request and never one deleted or pruned before it. The
   * operations that change the conversation shown (New chat, open, deleting the one shown) stop the reply in flight
   * at request time and wait for it to settle; the store queue then orders every later read after that reply's last
   * save. Deleting another row and pruning leave the reply running. A request waits behind a slow disk operation
   * already queued.
   */
  private readonly navigation = new SerialQueue();
  /**
   * Model-facing text of each user entry: typed text, or the text of the skill it loads, plus mention blocks, composed
   * once at send time and resent verbatim on later turns, also after a reload: it is saved beside the entry. Kept out
   * of `ChatState`, which is posted to the webview on every streamed delta.
   */
  private readonly modelText = new WeakMap<ChatEntry, string>();

  private readonly apiKeys: KeyStore;
  private readonly workspaceState: ChoiceStore;
  private readonly publish: (state: ChatState) => void;
  private readonly mentions: MentionReader;
  private readonly store: ConversationStore;
  private readonly tools: ToolRunner;
  private readonly instructions: InstructionReader;
  private readonly skills: SkillReader;
  private readonly limitsSource: LimitsSource;
  private readonly autoApproveWrites: () => boolean;
  private readonly writeAutoApproveWrites: (on: boolean) => Promise<void>;
  private readonly returnDraft: (draft: DraftInsert) => void;
  private readonly now: () => number;
  /** Limits the usage display reads, refreshed at each send and by `limitsChanged`. */
  private limits: TurnLimits;
  /** Plan is on in this workspace: restored from the workspace memento, winning over the setting while on. */
  private plan: boolean;
  /**
   * System prompt the usage display counts, for every conversation shown: the last one a send composed, since the
   * instruction files are the workspace's, not a conversation's; before the first send, the one without them.
   */
  private systemPrompt: string;

  constructor(ports: ChatPorts) {
    this.apiKeys = ports.apiKeys;
    this.workspaceState = ports.workspaceState;
    this.publish = ports.publish;
    this.mentions = ports.mentions;
    this.store = ports.store;
    this.tools = ports.tools;
    this.instructions = ports.instructions;
    this.skills = ports.skills;
    this.limitsSource = ports.limits ?? {
      read: () => parseLimits({ maxToolSteps: undefined, contextSizes: undefined }),
    };
    this.limits = this.limitsSource.read();
    this.autoApproveWrites = ports.autoApproveWrites ?? (() => false);
    this.writeAutoApproveWrites =
      ports.writeAutoApproveWrites ??
      (async () => {
        throw new Error("no settings writer");
      });
    this.returnDraft =
      ports.returnDraft ??
      ((draft) => console.error("broke-code: no message box to return queued text to; it is lost", draft.text));
    this.now = ports.now ?? Date.now;
    this.plan = this.workspaceState.get<unknown>(PLAN_KEY) === true;
    // [>]: Instruction files and skills are read only at a send, never just to refresh the display.
    this.systemPrompt = composeSystemPrompt(offeredTools(this.tools.tools, []), [], []);
    this.conversation = this.freshConversation();
    this.state = {
      providers: [],
      skipped: [],
      skillWarnings: [],
      provider: undefined,
      models: { status: "noProvider" },
      model: undefined,
      conversationId: this.conversation.id,
      entries: this.conversation.entries,
      conversations: [],
      listFailed: undefined,
      storageProblem: undefined,
      context: this.contextUsage(undefined),
      // [>]: The setting is read at `modeChanged`, which the host calls at activation as it applies the providers; the
      // constructor reads no setting.
      mode: "ask",
      modePending: false,
      queue: [],
    };
  }

  get snapshot(): ChatState {
    return this.state;
  }

  /**
   * Window load: list the saved conversations and show the one shown last, if it can still be read; else keep a
   * new one. In-flight replies in it come back stopped (see `parseConversation`). Stops no reply: none exists at
   * activation, and one sent meanwhile keeps its conversation in front.
   */
  restore(): Promise<void> {
    return this.navigate(async () => {
      await this.restoreNow();
      // [>]: A stop between the 51st save and its queued prune would leave 51 files for good.
      await this.prune();
    });
  }

  private async restoreNow(): Promise<void> {
    try {
      const { conversations, unreadable } = await this.store.list();
      const known = new Set(this.state.conversations.map((summary) => summary.id));
      this.setConversations([
        ...this.state.conversations,
        ...conversations.filter((summary) => !known.has(summary.id)),
      ]);
      // [>]: A listing error is about the list: only a listing that succeeds clears it.
      this.state.listFailed = undefined;
      if (unreadable.length > 0) {
        const cause = unreadable.map((file) => `${file.id}: ${file.cause}`).join("\n");
        this.reportList(cause, "could not read saved conversations", unreadable);
      }
    } catch (error) {
      this.reportList(String(error), "could not list saved conversations", error);
    }

    // [>]: `send` is not navigation: a message sent before the read settles keeps its conversation in front.
    const id = this.workspaceState.get<unknown>(CURRENT_CONVERSATION_KEY);
    const untouched = () => this.conversation.entries.length === 0;
    if (isConversationId(id) && untouched()) {
      let record: ConversationRecord | undefined;
      try {
        record = await this.store.load(id);
      } catch (error) {
        // [>]: The new conversation shown takes its place as the one to reopen; it stays in the list if listed.
        this.report({ kind: "openFailed", cause: String(error) }, "could not open the last conversation", error);
      }
      if (record && untouched()) return this.show(this.fromRecord(record));
    }
    this.rememberConversation();
    this.emit();
  }

  /**
   * Apply parsed settings. Keeps current provider when still valid, else remembered one, else first.
   * Reply in flight whose provider was removed or got another base URL -> stopped first, partial text kept.
   */
  setProviders(parsed: ParsedProviders): void {
    const replyProvider = this.reply?.provider;
    if (
      replyProvider &&
      !parsed.providers.some((p) => p.name === replyProvider.name && p.baseUrl === replyProvider.baseUrl)
    ) {
      this.stop();
    }
    const previous = this.currentProvider();
    this.providers = parsed.providers;
    this.state.providers = parsed.providers.map((provider) => provider.name);
    this.state.skipped = parsed.skipped;

    const names = this.state.providers;
    const remembered = this.workspaceState.get<LastChoice>(LAST_CHOICE_KEY)?.provider;
    const keep = [previous?.name, remembered].find((name) => name !== undefined && names.includes(name));
    const next = this.providers.find((provider) => provider.name === (keep ?? names[0]));

    // [>]: A CA file change relists too: the last listing may have failed on the old trust. A reply in flight keeps
    // running, since its connection is already verified.
    if (next?.name === previous?.name && next?.baseUrl === previous?.baseUrl && next?.caFile === previous?.caFile) {
      this.emit();
      return;
    }
    this.state.provider = next?.name;
    this.state.model = undefined;
    void this.loadModels();
  }

  selectProvider(name: string): void {
    if (isReplying(this.state) || name === this.state.provider || !this.state.providers.includes(name)) return;
    this.state.provider = name;
    this.state.model = undefined;
    this.remember();
    void this.loadModels();
  }

  selectModel(model: string): void {
    if (isReplying(this.state) || this.state.models.status !== "loaded" || !this.state.models.models.includes(model))
      return;
    this.state.model = model;
    this.remember();
    this.emit();
  }

  /**
   * The step limit or context sizes changed in the settings: the usage display reads the new values at once. A turn
   * in flight keeps the limits it started with; the next send reads the new ones.
   */
  limitsChanged(): void {
    this.limits = this.limitsSource.read();
    this.emit();
  }

  /**
   * Read the mode into `ChatState.mode`: Plan while on, else the auto-approve setting. At activation, and whenever the
   * setting changes, here or elsewhere (the settings editor, another window).
   */
  modeChanged(): void {
    this.state.mode = this.readMode();
    this.emit();
  }

  /**
   * The user picks `mode` in the message box. One pick at a time: ignored while a reply is in flight or an earlier
   * pick's settings write is pending (`ChatState.modePending`, which also locks the composer, so `send` is ignored
   * meanwhile and no turn starts on a mode about to change). Plan writes no setting, so it never pends: it turns
   * Plan on in the workspace memento. Ask or Auto-edit writes the setting's user value first, only when it must
   * change, then turns Plan off, only once that write succeeded: a failed write keeps the mode as it was. The mode
   * shown is read back from the setting after the write, whether it succeeded or not, since the settings change event
   * may come before the write settles. Never rejects.
   */
  async setMode(mode: Mode): Promise<ModeChange> {
    if (isReplying(this.state) || this.state.modePending) return { kind: "ignored" };
    if (mode === "plan") {
      const change: ModeChange = { kind: this.plan ? "unchanged" : "written" };
      this.rememberPlan(true);
      this.modeChanged();
      return change;
    }
    const on = mode === "autoEdit";
    const writes = this.readAutoApprove() !== on;
    if (writes) {
      this.state.modePending = true;
      this.emit();
      try {
        await this.writeAutoApproveWrites(on);
      } catch (error) {
        console.error("broke-code: could not write the auto-approve setting", error);
        this.state.modePending = false;
        this.modeChanged();
        return { kind: "failed", cause: String(error) };
      }
      this.state.modePending = false;
    }
    const leavesPlan = this.plan;
    this.rememberPlan(false);
    this.modeChanged();
    return { kind: writes || leavesPlan ? "written" : "unchanged" };
  }

  /**
   * Turn Plan `on` or off, kept in the workspace memento. A failed memento write is logged only, as for the provider
   * and model choice: Plan applies in this session and is lost at the next load.
   */
  private rememberPlan(on: boolean): void {
    if (this.plan === on) return;
    this.plan = on;
    this.workspaceState.update(PLAN_KEY, on ? true : undefined).then(undefined, (error: unknown) => {
      console.error("broke-code: could not remember Plan mode", error);
    });
  }

  private readMode(): Mode {
    if (this.plan) return "plan";
    return this.readAutoApprove() ? "autoEdit" : "ask";
  }

  /** Key of `provider` changed -> relist its models, since listing may have failed on old key. */
  keyChanged(provider: string): void {
    if (provider === this.state.provider) void this.loadModels();
  }

  async loadModels(): Promise<void> {
    const provider = this.currentProvider();
    const id = ++this.listingId;
    if (!provider) {
      this.state.models = { status: "noProvider" };
      this.emit();
      return;
    }
    this.state.models = { status: "loading" };
    this.emit();

    const listing = await listModels(await this.accessOf(provider));
    if (id !== this.listingId) return;
    if (!listing.ok) {
      this.state.models = { status: "failed", error: listing.error };
      this.state.model = undefined;
      this.emit();
      return;
    }
    this.state.models = { status: "loaded", models: listing.models };
    const remembered = this.workspaceState.get<LastChoice>(LAST_CHOICE_KEY);
    const preferred = [this.state.model, remembered?.provider === provider.name ? remembered.model : undefined];
    this.state.model =
      preferred.find((model) => model !== undefined && listing.models.includes(model)) ?? listing.models[0];
    this.remember();
    this.emit();
  }

  /**
   * Send user message with its mentions read now, and run the agent turn: stream the reply, run the body tool call
   * its answer holds, record the tool step, and request again, until a reply holds no call, a limit halts the turn,
   * the reply fails, or Stop. Limits: the step limit, three malformed calls in a row, and the context budget, checked
   * before each request, the first included: the oldest tool results are left out of a request that would fill the
   * model's context (see `toHistory`), and one that fills it even so is never sent. The
   * turn reads the settings and Plan once, when it starts: in Plan it offers the read tools only, and a call to a tool
   * Plan leaves out gets an `error` step saying so, counted toward the step limit like any step. Ignored while replying, while a mode pick is written, or without provider and model. `picked`:
   * paths chosen in the menu, mentions while their `@<path>` is still in the text. A mention that cannot be read is
   * reported to the model and in the entry; the message still goes. A message starting with `/<name>` of a discovered
   * skill sends that skill's text with the arguments instead of the text as typed (see `loadSkillText`), and the entry
   * records the skill, which opens its folder to the read tools; a `SKILL.md` that cannot be read is reported the same
   * way as a mention. Once the turn has fully settled, and only when it ended `done`, the first queued message is sent
   * the same way (see `sendNextQueued`); the returned promise settles after the turns it drained.
   */
  async send(text: string, picked: readonly string[] = []): Promise<void> {
    const ended = await this.runTurn(text, picked);
    // [!]: Only once the turn has fully settled (`this.reply` cleared, navigation released), never inside `settle`.
    if (ended === "done") await this.sendNextQueued();
  }

  /**
   * Whether a send may start an agent turn now: a provider and a model chosen, no reply in flight, and no mode pick
   * being written, since the turn would start on a mode about to change. The one check `send` and the queue share.
   */
  private mayStartTurn(): boolean {
    return (
      this.currentProvider() !== undefined &&
      this.state.model !== undefined &&
      !isReplying(this.state) &&
      !this.state.modePending
    );
  }

  /**
   * Queue `text` while a reply is in flight, with its `picked` paths, to be sent as if typed when a turn ends `done`.
   * The webview clears the box before the host answers and its state may lag, so a message not queued goes back to the
   * box (`returnDraft`), never dropped: exactly a built-in command (`/new`, `/model`), which the webview runs itself, and
   * a message past `MAX_QUEUED_MESSAGES`. With no reply in flight (it ended before the request arrived), the message is
   * sent at once as `send` would, when a turn may start and nothing is queued; otherwise it goes back to the box, so no
   * message waits paused because of a late request. Blank text is dropped, as `send` drops it.
   */
  async queueMessage(text: string, picked: readonly string[]): Promise<void> {
    const content = text.trim();
    if (!content) return;
    const message = { text: content, mentions: [...picked] };
    if (!isReplying(this.state) && !builtInCommand(content) && this.mayStartTurn() && this.state.queue.length === 0) {
      return this.send(content, picked);
    }
    const queues = isReplying(this.state) && !builtInCommand(content) && this.state.queue.length < MAX_QUEUED_MESSAGES;
    if (!queues) return this.giveBack([message]);
    this.state.queue = [...this.state.queue, { id: ++this.queuedId, ...message }];
    this.emit();
  }

  /** Edit: take queued message `id` out and return its text and picked paths to the box. Ignored when not queued. */
  editQueued(id: number): void {
    const message = this.state.queue.find((queued) => queued.id === id);
    if (!message) return;
    this.removeQueued(id);
    this.giveBack([message]);
  }

  /** Remove queued message `id`. Ignored when no such message is queued. */
  removeQueued(id: number): void {
    if (!this.state.queue.some((message) => message.id === id)) return;
    this.state.queue = this.state.queue.filter((message) => message.id !== id);
    this.emit();
  }

  /**
   * "Send now" on a paused queue: send queued message `id` when it is the first and a turn may start; its turn ending
   * `done` resumes the queue. Ignored otherwise.
   */
  sendQueued(id: number): Promise<void> {
    if (this.state.queue[0]?.id !== id) return Promise.resolve();
    return this.sendNextQueued();
  }

  /**
   * Send the first queued message, as if typed now: its mentions read now, and the provider, model, mode, and limits of
   * now. When a turn may not start (the model gone after a failed listing, a mode pick written), nothing is sent and it
   * stays first. Taken off the queue in the same step as `send` shows it, so it is never in both.
   */
  private sendNextQueued(): Promise<void> {
    const next = this.state.queue[0];
    if (!next || !this.mayStartTurn()) return Promise.resolve();
    this.state.queue = this.state.queue.slice(1);
    return this.send(next.text, next.mentions);
  }

  /**
   * Navigation that changes the conversation shown, when asked: empty the queue and return its texts to the box, in
   * order, one per paragraph. Emptied once, so a second request returns nothing again.
   */
  private returnQueue(): void {
    const messages = this.state.queue;
    if (messages.length === 0) return;
    this.state.queue = [];
    this.emit();
    this.giveBack(messages);
  }

  /** `messages`' texts back in the message box as one `paragraph` draft, their picked paths each once. */
  private giveBack(messages: readonly { text: string; mentions: readonly string[] }[]): void {
    const text = messages.map((message) => message.text).join("\n\n");
    const picked = [...new Set(messages.flatMap((message) => message.mentions))];
    try {
      this.returnDraft({ text, mode: "paragraph", picked });
    } catch (error) {
      console.error("broke-code: could not return queued text to the message box; it is lost", text, error);
    }
  }

  /** Deactivation: nothing queued is sent or returned, since the panel goes too, and the reply in flight is stopped. */
  dispose(): void {
    this.state.queue = [];
    this.stop();
  }

  /** The agent turn of `send`; its last status, or `undefined` when it did not start. */
  private async runTurn(text: string, picked: readonly string[]): Promise<ReplyStatus | undefined> {
    const content = text.trim();
    if (!this.mayStartTurn() || !content) return undefined;
    const provider = this.currentProvider();
    const model = this.state.model;
    if (!provider || !model) return undefined;
    this.limits = this.limitsSource.read();
    const { maxToolSteps } = this.limits;
    // [!]: Plan is read once: the turn's tools and prompt hold until it ends. The auto-approve setting is not read
    // here: each write's request reads it (see `askApproval`).
    const mode: Mode | undefined = this.plan ? "plan" : undefined;
    const contextSize = contextOf(this.limits, model).size;

    const conversation = this.conversation;
    conversation.provider = provider.name;
    conversation.model = model;
    const user: ChatEntry & { role: "user" } = { role: "user", content, mentions: [] };
    let reply = waitingReply();
    // [>]: Published before the reads, so the panel shows a reply in flight (Stop, composer locked) while they run;
    // published again once the mentions are known.
    conversation.entries.push(user, reply);
    const abort = new AbortController();
    const signal = abort.signal;
    let markSettled: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    this.reply = { abort, provider, settled };
    this.emit();
    /** Last status of the turn, on its last reply, and its last save handed to the store. */
    const settle = (status: ReplyStatus, haltReason?: HaltReason): ReplyStatus => {
      reply.status = status;
      if (haltReason !== undefined) reply.haltReason = haltReason;
      this.emit();
      void this.save(conversation);
      return status;
    };

    try {
      // [>]: The message is on disk before the request goes, so a crash keeps it. A failed save is shown and the
      // reply still goes. Stop ends the wait at once, even if a read, the key lookup, or the save never settles.
      const prepared = await unlessAborted(
        Promise.all([
          this.readMentions(content, picked),
          this.accessOf(provider),
          this.readInstructions(),
          this.readSkills(),
          this.save(conversation),
        ]),
        signal,
      );
      if (!prepared) return settle("stopped");
      const [mentions, access, instructions, discovery] = prepared;
      this.state.skillWarnings = discovery.warnings;
      // [>]: A `/<name>` that names no discovered skill (`/new` included) goes as typed. The token is never a mention,
      // since a mention starts with `@`, so the mentions read above are the arguments'.
      const slash = findSlashSkill(content, discovery.skills);
      const loaded = slash ? await unlessAborted(loadSkillText(slash.skill, slash.args), signal) : undefined;
      if (slash && !loaded) return settle("stopped");
      user.mentions = mentions.map(toResult);
      if (slash && loaded) {
        user.skill = { name: slash.skill.name, status: loaded.status === "ok" ? "loaded" : "failed" };
      }
      this.modelText.set(user, composeUserMessage(loaded?.text ?? content, mentions));
      if (mentions.length > 0 || slash) {
        this.emit();
        const saved = await unlessAborted(
          this.save(conversation).then(() => true),
          signal,
        );
        if (!saved) return settle("stopped");
      }

      const tools = offeredTools(this.tools.tools, discovery.skills, mode);
      const system = composeSystemPrompt(tools, instructions, discovery.skills, mode);
      this.systemPrompt = system;
      // [>]: The display counts the instruction files and skills now, not at the first reply delta.
      this.emit();
      let steps = 0;
      let malformedInARow = 0;
      for (;;) {
        const { messages } = this.requestMessages(conversation, { system, contextSize });
        // [>]: Never a provider error: no request goes. The reply that would have carried it ends halted.
        if (fillsContext(estimateTokens(messages), contextSize)) {
          return settle("halted", "contextFull");
        }
        const outcome = await this.stream(access, model, messages, tools, conversation, reply, signal);
        if (!outcome) return settle("stopped");
        if (outcome.status === "failed") reply.error = outcome.error;
        if (outcome.status !== "done") return settle(outcome.status);

        // [!]: The parser reads the answer only, never the reasoning.
        const parsed = parseToolCall(reply.content, tools);
        if (parsed.kind === "none") return settle("done");
        let step: ChatEntry & { role: "tool" };
        if (parsed.kind === "call") {
          const { name, args, start, end } = parsed;
          // [!]: One call per reply. What follows it never reaches the chat or the history: a model that goes on writes
          // calls that never run and results it invented, which it would then read back as true.
          reply.content = reply.content.slice(0, end);
          // [>]: The reply stays `streaming` while its call runs, so the turn reads as in flight and a crash meanwhile
          // brings it back stopped.
          reply.call = { name, args, start, end };
          this.emit();
          void this.save(conversation);
          let approval: StepApproval | undefined;
          const context: ToolContext = {
            signal,
            requestApproval: async (request) => {
              const answer = await this.askApproval(request, signal);
              approval = answer.approval ?? approval;
              return answer.decision;
            },
            skills: discovery.skills,
            skillRoots: loadedSkillRoots(conversation.entries, discovery.skills),
          };
          const result = await unlessAborted(this.runTool({ name, args }, context), signal);
          if (!result) return settle("stopped");
          step = {
            role: "tool",
            name,
            args,
            status: result.status,
            text: result.text,
            ...(approval ? { approval } : {}),
          };
          malformedInARow = 0;
        } else if (mode === "plan" && planBlocked(reply.content, parsed)) {
          const name = malformedToolName(reply.content, parsed);
          // [>]: An ordinary tool step, like a rejection: it counts toward the step limit and resets the malformed
          // count. Nothing is planned and no approval opens. What follows the block is dropped, as after a call.
          reply.content = reply.content.slice(0, parsed.end);
          step = { role: "tool", name, args: {}, status: "error", text: `${name} is not available in Plan mode.` };
          malformedInARow = 0;
        } else {
          step = {
            role: "tool",
            name: malformedToolName(reply.content, parsed),
            args: {},
            status: "malformed",
            text: parsed.message,
          };
          malformedInARow += 1;
        }
        steps += 1;
        conversation.entries.push(step);
        if (malformedInARow >= MAX_MALFORMED_IN_A_ROW) return settle("halted", "malformedCalls");
        if (steps >= maxToolSteps) return settle("halted", "stepLimit");
        // [>]: The step and the next reply land in one update, so the turn never reads as ended between them.
        reply.status = "done";
        reply = waitingReply();
        conversation.entries.push(reply);
        this.emit();
        void this.save(conversation);
      }
    } catch (error) {
      // [!]: A bug, never the provider's failure: logged with its stack, and shown, so the composer never stays
      // locked on a reply that will not end.
      console.error("broke-code: the agent turn failed unexpectedly", error instanceof Error ? error.stack : error);
      reply.error = { kind: "internal", message: error instanceof Error ? error.message : String(error) };
      return settle("failed");
    } finally {
      // [>]: Also on an unexpected throw, so navigation waiting for this turn never hangs.
      if (this.reply?.abort === abort) this.reply = undefined;
      markSettled();
    }
  }

  /**
   * Stream one reply of a turn into `reply`. `undefined` once `signal` aborts: Stop ends the reply at once, even if a
   * step inside `streamChat` never settles (a CA file read on a FIFO), and late deltas and the late outcome are
   * dropped, so navigation never waits on work that cannot be aborted. A reply whose answer holds a complete call
   * followed by a tool result the model wrote itself (`forgedResultCut`) ends `done` there: its request is cancelled
   * and later deltas are dropped, so a model forging results costs no more time.
   */
  private async stream(
    access: ProviderAccess,
    model: string,
    messages: ChatMessage[],
    tools: readonly ToolSpec[],
    conversation: Conversation,
    reply: ChatEntry & { role: "assistant" },
    signal: AbortSignal,
  ) {
    const cut = new AbortController();
    let scanned = 0;
    const delta = (field: "content" | "reasoning") => (text: string) => {
      if (signal.aborted || cut.signal.aborted) return;
      reply[field] += text;
      reply.status = "streaming";
      if (field === "content") {
        const found = forgedResultCut(reply.content, tools, scanned);
        scanned = found.scanned;
        if (found.cut !== undefined) {
          reply.content = reply.content.slice(0, found.cut);
          cut.abort();
        }
      }
      this.emit();
      this.saveSoon(conversation);
    };
    const outcome = await unlessAborted(
      streamChat(access, {
        model,
        messages,
        signal: AbortSignal.any([signal, cut.signal]),
        onContent: delta("content"),
        onReasoning: delta("reasoning"),
      }),
      signal,
    );
    if (outcome && cut.signal.aborted) return { status: "done" as const };
    return outcome;
  }

  /** Run `call`. A runner that rejects despite its contract gives an `error` result, logged. */
  private runTool(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    return Promise.resolve()
      .then(() => this.tools.run(call, context))
      .catch((error: unknown): ToolResult => {
        console.error("broke-code: tool run failed", call.name, error);
        return { status: "error", text: `${call.name}: the tool failed (${String(error)}).` };
      });
  }

  /** The instruction files; a reader that rejects despite its contract gives none, logged. */
  private readInstructions(): Promise<InstructionFile[]> {
    return Promise.resolve()
      .then(() => this.instructions.read())
      .catch((error: unknown) => {
        console.error("broke-code: could not read the instruction files", error);
        return [];
      });
  }

  /** The skills of this send; a reader that rejects despite its contract gives none and no warning, logged. */
  private readSkills(): Promise<SkillDiscovery> {
    return Promise.resolve()
      .then(() => this.skills.read())
      .catch((error: unknown) => {
        console.error("broke-code: could not read the skills", error);
        return { skills: [], warnings: [] };
      });
  }

  /**
   * Answer `request` for the call running under `signal`, with what the step records of it. A write is accepted at
   * once while auto-approve is on; otherwise the preview opens and the request shows until the user decides or
   * `signal` aborts, which cancels it. The preview closes as the request ends, whatever ended it; one that finishes
   * opening after Stop is closed at once.
   */
  private async askApproval(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<{ decision: Decision; approval?: StepApproval }> {
    if (signal.aborted) return { decision: { kind: "cancel" } };
    // [!]: The one place the setting applies, so it can never accept a command.
    if (request.kind === "write" && this.readAutoApprove()) return { decision: { kind: "accept" }, approval: "auto" };
    if (this.openApproval) throw new Error("another approval request is still open");
    const preview = request.preview ? await request.preview() : undefined;
    if (signal.aborted) {
      closePreview(preview);
      return { decision: { kind: "cancel" } };
    }
    const id = ++this.approvalId;
    const decision = await new Promise<Decision>((resolve) => {
      // [>]: Cleared and published at once, also on Stop, so no state after the stop still shows the buttons.
      const settle = (decision: Decision) => {
        signal.removeEventListener("abort", onAbort);
        this.openApproval = undefined;
        this.state.approval = undefined;
        this.emit();
        closePreview(preview);
        resolve(decision);
      };
      const onAbort = () => settle({ kind: "cancel" });
      signal.addEventListener("abort", onAbort, { once: true });
      this.openApproval = { id, settle };
      this.state.approval = { id, kind: request.kind, tool: request.tool, summary: request.summary };
      this.emit();
    });
    const approval: StepApproval | undefined =
      decision.kind === "accept" ? "accepted" : decision.kind === "reject" ? "rejected" : undefined;
    return { decision, ...(approval ? { approval } : {}) };
  }

  /** The auto-approve setting; a reader that throws despite its contract means off, logged. */
  private readAutoApprove(): boolean {
    try {
      return this.autoApproveWrites();
    } catch (error) {
      console.error("broke-code: could not read the auto-approve setting", error);
      return false;
    }
  }

  /** The user accepts approval request `id`. Ignored unless it is the request open. */
  approve(id: number): void {
    if (this.openApproval?.id === id) this.openApproval.settle({ kind: "accept" });
  }

  /**
   * The user rejects approval request `id`, with `reason` when it holds more than whitespace. Ignored unless it is the
   * request open.
   */
  reject(id: number, reason?: string): void {
    if (this.openApproval?.id !== id) return;
    const trimmed = reason?.trim();
    this.openApproval.settle(trimmed ? { kind: "reject", reason: trimmed } : { kind: "reject" });
  }

  stop(): void {
    this.reply?.abort.abort();
  }

  /**
   * Show a new, empty conversation; the one shown stays listed if it has entries. A reply in flight is stopped at
   * once and saved in its own record. The one method behind the New chat button and `/new`.
   */
  newChat(): Promise<void> {
    this.stop();
    this.returnQueue();
    return this.navigate(async () => {
      await this.settleReply();
      this.show(this.freshConversation());
    });
  }

  /**
   * Show saved conversation `id`, stopping a reply in flight first. Missing, invalid, or deleted by an earlier
   * request -> `notFound`, and its row is dropped; a read that fails -> `openFailed`.
   */
  openConversation(id: string): Promise<void> {
    if (id !== this.conversation.id) {
      this.stop();
      this.returnQueue();
    }
    return this.navigate(async () => {
      if (id === this.conversation.id) return;
      await this.settleReply();
      let record: ConversationRecord | undefined;
      try {
        record = await this.store.load(id);
      } catch (error) {
        return this.report({ kind: "openFailed", cause: String(error) }, "could not open a conversation", error);
      }
      if (!record) return this.notFound(id);
      // [>]: A send may have started while the file was read; stop it too, it is saved in its own record.
      await this.settleReply();
      this.show(this.fromRecord(record));
    });
  }

  /**
   * Delete saved conversation `id` from disk, then from the list. The one shown -> its reply stopped at request time
   * and a new one shown first. Another row -> the reply keeps running. A failed delete keeps the row and is reported.
   */
  deleteConversation(id: string): Promise<void> {
    if (id === this.conversation.id) {
      this.stop();
      this.returnQueue();
    }
    return this.navigate(async () => {
      if (id === this.conversation.id) {
        await this.settleReply();
        this.show(this.freshConversation());
      }
      await this.remove(id);
    });
  }

  /**
   * Run `operation` after every navigation asked before it. A user request first clears the open or not-found error
   * it supersedes, never a listing error; its own failure is reported by itself.
   */
  private navigate(operation: () => Promise<void>, clearsOpenError = true): Promise<void> {
    return this.navigation.run(async () => {
      const problem = this.state.storageProblem?.kind;
      if (clearsOpenError && (problem === "notFound" || problem === "openFailed")) {
        this.state.storageProblem = undefined;
        this.emit();
      }
      await operation();
    });
  }

  /** Stop the reply in flight, if any, and wait until its last save is handed to the store. */
  private async settleReply(): Promise<void> {
    const reply = this.reply;
    if (!reply) return;
    reply.abort.abort();
    await reply.settled;
  }

  /**
   * Delete the conversations past the 50 kept, oldest first, sparing the one shown when this runs and any whose record
   * cannot be loaded and validated. Never stops the reply: the reply's own save queued this prune, and the conversation
   * shown does not change.
   */
  private async prune(): Promise<void> {
    const tried = new Set<string>();
    let lastFailure: StorageProblem | undefined;
    for (;;) {
      // [>]: A tried row is kept like the shown one, so the excess is still counted over every row and the next
      // oldest untried one is picked. Each pass adds to `tried` or settles a row's time, so the loop ends.
      const id = conversationsOverLimit(this.state.conversations, [this.conversation.id, ...tried])[0];
      if (id === undefined) {
        // [>]: A later successful delete clears a `deleteFailed` problem, which would hide an earlier failed check or
        // failed delete.
        if (lastFailure && this.state.storageProblem === undefined) {
          this.state.storageProblem = lastFailure;
          this.emit();
        }
        return;
      }
      // [>]: A listed row may come from a summary older than its record (one a build without summaries left behind),
      // so the record decides before a delete: a newer one corrects the row, and the oldest is picked again.
      let record: ConversationRecord | undefined;
      try {
        record = await this.store.load(id);
      } catch (error) {
        tried.add(id);
        lastFailure = { kind: "deleteFailed", cause: String(error) };
        this.report(lastFailure, "could not check a conversation to prune", error);
        continue;
      }
      if (!record) {
        // [>]: Only a record validated here is deleted. One that is invalid or of another version (a newer build's,
        // after a downgrade) is user data this build cannot read, so it stays on disk and in the list, where the user
        // can delete it. A missing one has nothing left to delete; the next listing drops its summary.
        tried.add(id);
        console.error("broke-code: kept a conversation to prune whose record is missing or invalid", id);
        continue;
      }
      const row = this.state.conversations.find((summary) => summary.id === id);
      if (row && record.updatedAt !== row.updatedAt) {
        const others = this.state.conversations.filter((summary) => summary.id !== id);
        this.setConversations([summarize(record), ...others]);
        continue;
      }
      tried.add(id);
      lastFailure = (await this.remove(id)) ?? lastFailure;
    }
  }

  /** Each mention of `text`, read in parallel. A reader that rejects despite its contract yields `unreadable`. */
  private readMentions(text: string, picked: readonly string[]): Promise<ReadMention[]> {
    return Promise.all(
      findMentions(text, picked).map((path) =>
        this.mentions.read(path).catch((error: unknown): ReadMention => {
          console.error("broke-code: could not read mention", path, error);
          const kind = reservedMention(path) ?? (path.endsWith("/") ? "folder" : "file");
          return { path, kind, status: "unreadable", content: "", omitted: 0, cause: String(error) };
        }),
      ),
    );
  }

  private freshConversation(): Conversation {
    return { id: newConversationId(), createdAt: this.now(), entries: [] };
  }

  private fromRecord(record: ConversationRecord): Conversation {
    const entries = record.entries.map((stored): ChatEntry => {
      if (stored.role !== "user") return stored;
      const { modelText, ...entry } = stored;
      this.modelText.set(entry, modelText);
      return entry;
    });
    return { id: record.id, createdAt: record.createdAt, entries };
  }

  /** `id` cannot be shown: drop its row and say so. */
  private notFound(id: string): void {
    this.setConversations(this.state.conversations.filter((summary) => summary.id !== id));
    this.report({ kind: "notFound" }, "saved conversation missing, invalid, or deleted", id);
  }

  private toRecord(conversation: Conversation): ConversationRecord {
    const entries = conversation.entries.map(
      (entry): StoredEntry =>
        entry.role === "user" ? { ...entry, modelText: this.modelText.get(entry) ?? entry.content } : { ...entry },
    );
    const { id, createdAt, provider, model } = conversation;
    return {
      version: CONVERSATION_VERSION,
      id,
      createdAt,
      updatedAt: this.now(),
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      entries,
    };
  }

  /** Put `conversation` in front, as the one shown and reopened at the next window load. Navigation only. */
  private show(conversation: Conversation): void {
    this.conversation = conversation;
    this.state.conversationId = conversation.id;
    this.state.entries = conversation.entries;
    this.rememberConversation();
    this.emit();
  }

  /** Save `conversation` within 500 ms, unless a save is already pending. */
  private saveSoon(conversation: Conversation): void {
    if (conversation.saveTimer !== undefined) return;
    conversation.saveTimer = setTimeout(() => void this.save(conversation), SAVE_INTERVAL_MS);
  }

  /**
   * Save `conversation` now, replacing a pending throttled save. Then list it, and past 50 kept queue a prune behind
   * the navigation asked so far. Not written: no entries, no storage directory, or deleted meanwhile (the store
   * drops it). Settles once the write has; never rejects, a failure is reported.
   */
  private save(conversation: Conversation): Promise<void> {
    clearTimeout(conversation.saveTimer);
    conversation.saveTimer = undefined;
    if (conversation.entries.length === 0) return Promise.resolve();
    const record = this.toRecord(conversation);
    return this.store.save(record).then(
      (saved) => {
        if (!saved) return;
        if (this.state.storageProblem?.kind === "saveFailed") this.state.storageProblem = undefined;
        const others = this.state.conversations.filter((summary) => summary.id !== record.id);
        this.setConversations([summarize(record), ...others]);
        if (conversationsOverLimit(this.state.conversations, [this.conversation.id]).length > 0) {
          void this.navigate(() => this.prune(), false);
        }
      },
      (error: unknown) =>
        this.report({ kind: "saveFailed", cause: String(error) }, "could not save the conversation", error),
    );
  }

  /**
   * Delete `id` from disk, then from the list. A failed delete keeps the row, is reported, and is returned; a success
   * returns nothing.
   */
  private async remove(id: string): Promise<StorageProblem | undefined> {
    try {
      await this.store.remove(id);
    } catch (error) {
      const problem: StorageProblem = { kind: "deleteFailed", cause: String(error) };
      this.report(problem, "could not delete a conversation", error);
      return problem;
    }
    if (this.state.storageProblem?.kind === "deleteFailed") this.state.storageProblem = undefined;
    this.setConversations(this.state.conversations.filter((summary) => summary.id !== id));
    return undefined;
  }

  /** Newest first. */
  private setConversations(conversations: ConversationSummary[]): void {
    this.state.conversations = conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    this.emit();
  }

  /** Log `error` and show `problem` in the panel. */
  private report(problem: StorageProblem, what: string, error: unknown): void {
    console.error(`broke-code: ${what}`, error);
    this.state.storageProblem = problem;
    this.emit();
  }

  /** Log `error` and show the listing failure in the panel, beside any `storageProblem`. */
  private reportList(cause: string, what: string, error: unknown): void {
    console.error(`broke-code: ${what}`, error);
    this.state.listFailed = { cause };
    this.emit();
  }

  /**
   * The messages of `conversation`'s next request: `budget.system`, then its history, the oldest tool results left out
   * when the whole would fill `budget.contextSize` (see `toHistory`); `leftOut` counts them.
   */
  private requestMessages(
    conversation: Conversation,
    budget: HistoryBudget,
  ): { messages: ChatMessage[]; leftOut: number } {
    const history = toHistory(conversation.entries, (entry) => this.modelText.get(entry) ?? entry.content, budget);
    return { messages: [{ role: "system", content: budget.system }, ...history.messages], leftOut: history.leftOut };
  }

  private currentProvider(): Provider | undefined {
    return this.providers.find((provider) => provider.name === this.state.provider);
  }

  private async accessOf(provider: Provider): Promise<ProviderAccess> {
    return { provider, apiKey: await this.apiKeys.get(provider.name) };
  }

  private remember(): void {
    const choice: LastChoice | undefined = this.state.provider
      ? { provider: this.state.provider, ...(this.state.model ? { model: this.state.model } : {}) }
      : undefined;
    this.workspaceState.update(LAST_CHOICE_KEY, choice).then(undefined, (error: unknown) => {
      // [>]: Losing remembered choice only costs a re-pick next session -> log, don't interrupt chat.
      console.error("broke-code: could not remember provider and model choice", error);
    });
  }

  private rememberConversation(): void {
    this.workspaceState.update(CURRENT_CONVERSATION_KEY, this.conversation.id).then(undefined, (error: unknown) => {
      // [>]: Losing the pointer only shows a new conversation at the next load; the old one stays listed.
      console.error("broke-code: could not remember the current conversation", error);
    });
  }

  /**
   * Estimate of the next request of the conversation shown, as it would be sent, against `model`'s context size, and
   * the count of tool results it leaves out, when any.
   */
  private contextUsage(model: string | undefined): ContextUsage {
    const context = contextOf(this.limits, model);
    const budget = { system: this.systemPrompt, contextSize: context.size };
    const { messages, leftOut } = this.requestMessages(this.conversation, budget);
    return { used: estimateTokens(messages), ...context, ...(leftOut > 0 ? { leftOut } : {}) };
  }

  private emit(): void {
    this.state.context = this.contextUsage(this.state.model);
    this.publish(this.state);
  }
}

/** `work`'s result, or `undefined` as soon as `signal` aborts (already aborted included). */
function unlessAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Close `preview`, if any; a failure is logged, since the request has already ended. */
function closePreview(preview: Preview | undefined): void {
  if (!preview) return;
  Promise.resolve()
    .then(() => preview.close())
    .catch((error: unknown) => console.error("broke-code: could not close an approval preview", error));
}

function waitingReply(): ChatEntry & { role: "assistant" } {
  return { role: "assistant", reasoning: "", content: "", status: "waiting" };
}

/**
 * The real folders of the skills loaded in `entries`: each `ok` `load_skill` step's name and each user entry's skill
 * loaded with `/<name>`, found in `discovered` (the send's skills). A step that failed, or was stopped, and a skill
 * whose `SKILL.md` could not be read at send loaded nothing; a skill no longer discovered is no longer readable.
 * Derived from the entries, so a reopened conversation keeps its loaded skills.
 */
function loadedSkillRoots(entries: readonly ChatEntry[], discovered: readonly Skill[]): string[] {
  const names = new Set(
    entries.flatMap((entry) => {
      if (entry.role === "user") return entry.skill?.status === "loaded" ? [entry.skill.name] : [];
      return entry.role === "tool" && entry.name === "load_skill" && entry.status === "ok" ? [entry.args.name] : [];
    }),
  );
  return discovered.filter((skill) => names.has(skill.name)).map((skill) => skill.root);
}

/**
 * The tag name a malformed block of `answer` opens with, a known tool or not, or `unknown` when none can be read.
 * [!]: The name matches the parser's tag pattern (`[a-z][a-z0-9_]*`), so it is safe inside the quoted `tool`
 * attribute; any other text gives `unknown`.
 */
function malformedToolName(answer: string, parsed: ParsedReply & { kind: "malformed" }): string {
  return /^<([a-z][a-z0-9_]*)>/.exec(answer.slice(parsed.start))?.[1] ?? "unknown";
}

/**
 * Whether a malformed block of a Plan turn's `answer` is a call to a tool Plan leaves out. The parser reads against the
 * offered tools, so such a closed block is "not a known tool"; a block of a tool Plan offers never names one of these.
 */
function planBlocked(answer: string, parsed: ParsedReply & { kind: "malformed" }): boolean {
  return PLAN_BLOCKED_TOOLS.includes(malformedToolName(answer, parsed));
}

/** What the chat shows and keeps of a read mention: no content. */
function toResult({ path, kind, status, lines, range, failedFolders }: ReadMention): MentionResult {
  return {
    path,
    kind,
    status,
    ...(lines !== undefined ? { lines } : {}),
    ...(range !== undefined ? { range } : {}),
    ...(failedFolders !== undefined ? { failedFolders } : {}),
  };
}
