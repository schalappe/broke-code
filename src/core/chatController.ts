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
import { SerialQueue } from "./serialQueue";

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
  /**
   * In-flight reply: its abort handle, the provider it streams from, and `settled`, which resolves once the reply has
   * ended and its last save has been handed to the store. After Stop it does not wait for `streamChat` to return.
   */
  private reply: { abort: AbortController; provider: Provider; settled: Promise<void> } | undefined;
  /** Bumped per listing request; stale listings dropped. */
  private listingId = 0;
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
      listFailed: undefined,
      storageProblem: undefined,
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
    let markSettled: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    this.reply = { abort, provider, settled };
    this.emit();
    /** Last status of the reply, and its last save handed to the store. */
    const settle = (status: ReplyStatus) => {
      reply.status = status;
      this.emit();
      void this.save(conversation);
    };

    try {
      // [>]: The message is on disk before the request goes, so a crash keeps it. A failed save is shown and the
      // reply still goes. Stop ends the wait at once, even if a read, the key lookup, or the save never settles.
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

      // [>]: Stop ends the reply at once, even if a step inside `streamChat` never settles (a CA file read on a FIFO):
      // late deltas and the late outcome are dropped, so navigation never waits on work that cannot be aborted.
      const delta = (field: "content" | "reasoning") => (text: string) => {
        if (abort.signal.aborted) return;
        reply[field] += text;
        reply.status = "streaming";
        this.emit();
        this.saveSoon(conversation);
      };
      const outcome = await unlessAborted(
        streamChat(access, {
          model,
          messages: history,
          signal: abort.signal,
          onContent: delta("content"),
          onReasoning: delta("reasoning"),
        }),
        abort.signal,
      );
      if (!outcome) return settle("stopped");
      if (outcome.status === "failed") reply.error = outcome.error;
      settle(outcome.status);
    } finally {
      // [>]: Also on an unexpected throw, so navigation waiting for this reply never hangs.
      if (this.reply?.abort === abort) this.reply = undefined;
      markSettled();
    }
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
    if (id !== this.conversation.id) this.stop();
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
    if (id === this.conversation.id) this.stop();
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
    let checkFailure: StorageProblem | undefined;
    for (;;) {
      // [>]: A tried row is kept like the shown one, so the excess is still counted over every row and the next
      // oldest untried one is picked. Each pass adds to `tried` or settles a row's time, so the loop ends.
      const id = conversationsOverLimit(this.state.conversations, [this.conversation.id, ...tried])[0];
      if (id === undefined) {
        // [>]: A later successful delete clears a `deleteFailed` problem, which would hide this failed check.
        if (checkFailure && this.state.storageProblem === undefined) {
          this.state.storageProblem = checkFailure;
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
        checkFailure = { kind: "deleteFailed", cause: String(error) };
        this.report(checkFailure, "could not check a conversation to prune", error);
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
      await this.remove(id);
    }
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
    this.report({ kind: "notFound" }, "saved conversation missing, invalid, or deleted", id);
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

  /** Delete `id` from disk, then from the list. A failed delete keeps the row and is reported. */
  private async remove(id: string): Promise<void> {
    try {
      await this.store.remove(id);
    } catch (error) {
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

  /** Log `error` and show the listing failure in the panel, beside any `storageProblem`. */
  private reportList(cause: string, what: string, error: unknown): void {
    console.error(`broke-code: ${what}`, error);
    this.state.listFailed = { cause };
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
