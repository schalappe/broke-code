/**
 * @module chatController
 * Chat state owner: provider and model choice, model listing, streamed replies, stop, and the workspace's saved
 * conversations (new chat, reopen, delete). The conversation shown is saved when a message is sent, at most every
 * 500 ms while its reply streams, and when the reply ends, so a reload or crash loses at most the reply streaming.
 * vscode-free: host passes key store, workspace memento, mention reader, and conversation store through ports.
 */
import { type ChatMessage, listModels, type ProviderAccess, streamChat } from "./client";
import {
  type ConversationRecord,
  type ConversationSummary,
  conversationsOverLimit,
  isConversationId,
  newConversationId,
  type StoredEntry,
  summarize,
} from "./conversation";
import type { ConversationStore } from "./conversationStore";
import { composeUserMessage, findMentions, type MentionReader, type MentionResult, type ReadMention } from "./mentions";
import { type ChatEntry, type ChatState, isReplying, type ReplyStatus, type StorageProblem } from "./protocol";
import type { ParsedProviders, Provider } from "./providers";

/** API key lookup. `undefined` = no key; must not reject. */
export type KeyStore = { get(provider: string): Promise<string | undefined> };

/** Per-workspace storage; `vscode.Memento` fits. */
export type ChoiceStore = {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
};

const LAST_CHOICE_KEY = "brokeCode.lastChoice";
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
  /** In-flight reply: its abort handle and the provider it streams from. */
  private reply: { abort: AbortController; provider: Provider } | undefined;
  /** Bumped per listing request; stale listings dropped. */
  private listingId = 0;
  /**
   * Bumped by each switch of the conversation shown and each open asked: a restore or open whose read settles after
   * another navigation is dropped, its entries and its error alike.
   */
  private switchId = 0;
  /**
   * Conversations whose reply has not settled yet. Reopening one shows the object itself: its last save is still to
   * come, so the file is older than it.
   */
  private readonly settling = new Map<string, Conversation>();
  /** Ids deleted, or being deleted, in this session. An open of one is dropped, so a deleted one is never shown. */
  private readonly gone = new Set<string>();
  /** Id of the conversation an open is reading. Pruning spares it, since it is about to be shown. */
  private opening: string | undefined;
  /**
   * Model-facing text of each user entry: typed text plus mention blocks, composed once at send time and resent
   * verbatim on later turns, also after a reload: it is saved beside the entry. Kept out of `ChatState`, which is
   * posted to the webview on every streamed delta.
   */
  private readonly modelText = new WeakMap<ChatEntry, string>();

  /** `now`: clock for record times, in milliseconds since the epoch. */
  constructor(
    private readonly apiKeys: KeyStore,
    private readonly workspaceState: ChoiceStore,
    private readonly publish: (state: ChatState) => void,
    private readonly mentions: MentionReader,
    private readonly store: ConversationStore,
    private readonly now: () => number = Date.now,
  ) {
    this.conversation = this.freshConversation();
    this.state = {
      providers: [],
      skipped: [],
      provider: undefined,
      models: { status: "noProvider" },
      model: undefined,
      conversationId: this.conversation.id,
      entries: this.conversation.entries,
      conversations: [],
      storageProblem: undefined,
    };
  }

  get snapshot(): ChatState {
    return this.state;
  }

  /**
   * Window load: list the saved conversations and show the one shown last, if it can still be read; else keep a
   * new one. In-flight replies in it come back stopped (see `parseConversation`).
   */
  async restore(): Promise<void> {
    const switchId = this.switchId;
    try {
      const { conversations, unreadable } = await this.store.list();
      const known = new Set(this.state.conversations.map((summary) => summary.id));
      this.setConversations([
        ...this.state.conversations,
        ...conversations.filter((summary) => !known.has(summary.id)),
      ]);
      if (unreadable.length > 0) {
        const cause = unreadable.map((file) => `${file.id}: ${file.cause}`).join("\n");
        this.report({ kind: "listFailed", cause }, "could not read saved conversations", unreadable);
      }
    } catch (error) {
      this.report({ kind: "listFailed", cause: String(error) }, "could not list saved conversations", error);
    }

    const id = this.workspaceState.get<unknown>(CURRENT_CONVERSATION_KEY);
    const untouched = () => switchId === this.switchId && this.conversation.entries.length === 0;
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
    if (switchId === this.switchId) this.rememberConversation();
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
   * Send user message with its mentions read now, and stream reply. Ignored while replying or without provider
   * and model. `picked`: paths chosen in the menu, mentions while their `@<path>` is still in the text. A mention
   * that cannot be read is reported to the model and in the entry; the message still goes.
   */
  async send(text: string, picked: readonly string[] = []): Promise<void> {
    const provider = this.currentProvider();
    const model = this.state.model;
    const content = text.trim();
    if (!provider || !model || !content || isReplying(this.state)) return;

    const history = this.toHistory();
    const conversation = this.conversation;
    conversation.provider = provider.name;
    conversation.model = model;
    const user: ChatEntry & { role: "user" } = { role: "user", content, mentions: [] };
    const reply: ChatEntry & { role: "assistant" } = {
      role: "assistant",
      reasoning: "",
      content: "",
      status: "waiting",
    };
    // [>]: Published before the reads, so the panel shows a reply in flight (Stop, composer locked) while they run;
    // published again once the mentions are known.
    conversation.entries.push(user, reply);
    const abort = new AbortController();
    this.reply = { abort, provider };
    this.settling.set(conversation.id, conversation);
    this.emit();
    /** Last status and save of the reply; it has settled after this. */
    const settle = (status: ReplyStatus) => {
      if (this.reply?.abort === abort) this.reply = undefined;
      reply.status = status;
      this.emit();
      void this.save(conversation);
      this.settling.delete(conversation.id);
    };

    // [>]: The message is on disk before the request goes, so a crash keeps it. A failed save is shown and the reply
    // still goes. Stop ends the wait at once, even if a read, the key lookup, or the save never settles.
    const prepared = await unlessAborted(
      Promise.all([this.readMentions(content, picked), this.accessOf(provider), this.save(conversation)]),
      abort.signal,
    );
    if (!prepared) return settle("stopped");
    const [mentions, access] = prepared;
    user.mentions = mentions.map(toResult);
    const composed = composeUserMessage(content, mentions);
    this.modelText.set(user, composed);
    history.push({ role: "user", content: composed });
    if (mentions.length > 0) {
      this.emit();
      const saved = await unlessAborted(
        this.save(conversation).then(() => true),
        abort.signal,
      );
      if (!saved) return settle("stopped");
    }

    const outcome = await streamChat(access, {
      model,
      messages: history,
      signal: abort.signal,
      onContent: (delta) => {
        reply.content += delta;
        reply.status = "streaming";
        this.emit();
        this.saveSoon(conversation);
      },
      onReasoning: (delta) => {
        reply.reasoning += delta;
        reply.status = "streaming";
        this.emit();
        this.saveSoon(conversation);
      },
    });
    if (outcome.status === "failed") reply.error = outcome.error;
    settle(outcome.status);
  }

  stop(): void {
    this.reply?.abort.abort();
  }

  /**
   * Show a new, empty conversation; the one shown stays listed if it has entries. A reply in flight is stopped and
   * saved in its own record. The one method behind the New chat button and `/new`.
   */
  newChat(): void {
    this.stop();
    this.show(this.freshConversation());
  }

  /**
   * Show saved conversation `id`, stopping a reply in flight first. Missing, unreadable, or deleted -> `notFound`.
   * Dropped if another navigation comes before its read settles, or if `id` is deleted meanwhile.
   */
  async openConversation(id: string): Promise<void> {
    if (id === this.conversation.id) return;
    this.stop();
    const switchId = ++this.switchId;
    const live = this.settling.get(id);
    if (this.gone.has(id)) return this.notFound(id);
    if (live) return this.show(live);

    this.opening = id;
    let record: ConversationRecord | undefined;
    try {
      record = await this.store.load(id);
    } catch (error) {
      if (switchId !== this.switchId) return;
      return this.report({ kind: "openFailed", cause: String(error) }, "could not open a conversation", error);
    } finally {
      if (this.opening === id) this.opening = undefined;
    }
    if (switchId !== this.switchId || this.gone.has(id)) return;
    if (!record) return this.notFound(id);
    // [>]: A send may have started while the file was read; stop it too, it is saved in its own record.
    this.stop();
    this.show(this.fromRecord(record));
  }

  /**
   * Delete saved conversation `id` from disk and list. The one shown -> its reply stopped and a new one shown at
   * once, so no conversation being deleted is ever shown. If the delete fails, it stays listed and is reported.
   */
  async deleteConversation(id: string): Promise<void> {
    if (id === this.conversation.id) this.newChat();
    await this.remove(id);
  }

  /** Each mention of `text`, read in parallel. A reader that rejects despite its contract yields `unreadable`. */
  private readMentions(text: string, picked: readonly string[]): Promise<ReadMention[]> {
    return Promise.all(
      findMentions(text, picked).map((path) =>
        this.mentions.read(path).catch((error: unknown): ReadMention => {
          console.error("broke-code: could not read mention", path, error);
          const kind = path.endsWith("/") ? "folder" : "file";
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
      if (stored.role === "assistant") return stored;
      const { modelText, ...entry } = stored;
      this.modelText.set(entry, modelText);
      return entry;
    });
    return { id: record.id, createdAt: record.createdAt, entries };
  }

  /** `id` cannot be shown: drop its row and say so. */
  private notFound(id: string): void {
    this.setConversations(this.state.conversations.filter((summary) => summary.id !== id));
    this.report({ kind: "notFound" }, "saved conversation not found, unreadable, or deleted", id);
  }

  private toRecord(conversation: Conversation): ConversationRecord {
    const entries = conversation.entries.map(
      (entry): StoredEntry =>
        entry.role === "user" ? { ...entry, modelText: this.modelText.get(entry) ?? entry.content } : { ...entry },
    );
    const { id, createdAt, provider, model } = conversation;
    return {
      version: 1,
      id,
      createdAt,
      updatedAt: this.now(),
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      entries,
    };
  }

  /**
   * Put `conversation` in front, as the one shown and reopened at the next window load. A failed open is over once
   * another conversation shows.
   */
  private show(conversation: Conversation): void {
    this.switchId += 1;
    this.conversation = conversation;
    this.state.conversationId = conversation.id;
    this.state.entries = conversation.entries;
    const problem = this.state.storageProblem?.kind;
    if (problem === "notFound" || problem === "openFailed") this.state.storageProblem = undefined;
    this.rememberConversation();
    this.emit();
  }

  /** Save `conversation` within 500 ms, unless a save is already pending. */
  private saveSoon(conversation: Conversation): void {
    if (conversation.saveTimer !== undefined) return;
    conversation.saveTimer = setTimeout(() => void this.save(conversation), SAVE_INTERVAL_MS);
  }

  /**
   * Save `conversation` now, replacing a pending throttled save. Then list it and delete those past the 50 kept,
   * sparing the one shown and the one being opened. Not written: no entries, no storage directory, or deleted
   * meanwhile (the store drops it). Settles once the write has; never rejects, a failure is reported.
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
        const keep = [this.conversation.id, ...(this.opening ? [this.opening] : [])];
        for (const id of conversationsOverLimit(this.state.conversations, keep)) void this.remove(id);
      },
      (error: unknown) =>
        this.report({ kind: "saveFailed", cause: String(error) }, "could not save the conversation", error),
    );
  }

  /** Delete `id` from disk, then from the list. A failed delete is reported, and `id` can be opened again. */
  private async remove(id: string): Promise<void> {
    this.gone.add(id);
    try {
      await this.store.remove(id);
    } catch (error) {
      this.gone.delete(id);
      return this.report({ kind: "deleteFailed", cause: String(error) }, "could not delete a conversation", error);
    }
    if (this.state.storageProblem?.kind === "deleteFailed") this.state.storageProblem = undefined;
    this.setConversations(this.state.conversations.filter((summary) => summary.id !== id));
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

  /**
   * Conversation sent to model: user messages as composed at send time, plus assistant answers with text (stopped
   * and cut-off partials included). Reasoning never sent; a reply with reasoning only is left out.
   */
  private toHistory(): ChatMessage[] {
    return this.state.entries
      .filter((entry) => entry.role === "user" || entry.content !== "")
      .map((entry) => ({ role: entry.role, content: this.modelText.get(entry) ?? entry.content }));
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

  private emit(): void {
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

/** What the chat shows and keeps of a read mention: no content. */
function toResult({ path, kind, status, lines }: ReadMention): MentionResult {
  return { path, kind, status, ...(lines !== undefined ? { lines } : {}) };
}
