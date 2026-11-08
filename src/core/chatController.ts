/**
 * @module chatController
 * Chat state owner: provider and model choice, model listing, streamed replies, stop, new chat.
 * Conversation lives in memory for window (extension host) lifetime; survives view being hidden (persistence: #12).
 * vscode-free: host passes key store, workspace memento, and mention reader through ports below.
 */
import { type ChatMessage, listModels, type ProviderAccess, streamChat } from "./client";
import { composeUserMessage, findMentions, type MentionReader, type MentionResult, type ReadMention } from "./mentions";
import { type ChatEntry, type ChatState, isReplying } from "./protocol";
import type { ParsedProviders, Provider } from "./providers";

/** API key lookup. `undefined` = no key; must not reject. */
export type KeyStore = { get(provider: string): Promise<string | undefined> };

/** Per-workspace storage; `vscode.Memento` fits. */
export type ChoiceStore = {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
};

const LAST_CHOICE_KEY = "brokeCode.lastChoice";

type LastChoice = { provider: string; model?: string };

export class ChatController {
  private providers: Provider[] = [];
  private state: ChatState = {
    providers: [],
    skipped: [],
    provider: undefined,
    models: { status: "noProvider" },
    model: undefined,
    entries: [],
  };
  /** In-flight reply: its abort handle and the provider it streams from. */
  private reply: { abort: AbortController; provider: Provider } | undefined;
  /** Bumped per listing request; stale listings dropped. */
  private listingId = 0;
  /**
   * Model-facing text of each user entry: typed text plus mention blocks, composed once at send time and resent
   * verbatim on later turns. Kept out of `ChatState`, which is posted to the webview on every streamed delta.
   * Persistence (#12) must save it beside the entries.
   */
  private readonly modelText = new WeakMap<ChatEntry, string>();

  constructor(
    private readonly apiKeys: KeyStore,
    private readonly workspaceState: ChoiceStore,
    private readonly publish: (state: ChatState) => void,
    private readonly mentions: MentionReader,
  ) {}

  get snapshot(): ChatState {
    return this.state;
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
    const user: ChatEntry & { role: "user" } = { role: "user", content, mentions: [] };
    const reply: ChatEntry & { role: "assistant" } = {
      role: "assistant",
      reasoning: "",
      content: "",
      status: "waiting",
    };
    // [>]: Published before the reads, so the panel shows a reply in flight (Stop, composer locked) while they run;
    // published again once the mentions are known.
    this.state.entries.push(user, reply);
    const abort = new AbortController();
    this.reply = { abort, provider };
    this.emit();

    // [>]: Stop ends the wait at once, even if a read or the key lookup never settles; their late results are dropped.
    const prepared = await unlessAborted(
      Promise.all([this.readMentions(content, picked), this.accessOf(provider)]),
      abort.signal,
    );
    if (!prepared) {
      if (this.reply?.abort === abort) this.reply = undefined;
      reply.status = "stopped";
      this.emit();
      return;
    }
    const [mentions, access] = prepared;
    user.mentions = mentions.map(toResult);
    const composed = composeUserMessage(content, mentions);
    this.modelText.set(user, composed);
    history.push({ role: "user", content: composed });
    if (mentions.length > 0) this.emit();

    const outcome = await streamChat(access, {
      model,
      messages: history,
      signal: abort.signal,
      onContent: (delta) => {
        reply.content += delta;
        reply.status = "streaming";
        this.emit();
      },
      onReasoning: (delta) => {
        reply.reasoning += delta;
        reply.status = "streaming";
        this.emit();
      },
    });
    if (this.reply?.abort === abort) this.reply = undefined;

    if (outcome.status === "failed") {
      reply.status = "failed";
      reply.error = outcome.error;
    } else {
      reply.status = outcome.status;
    }
    this.emit();
  }

  stop(): void {
    this.reply?.abort.abort();
  }

  newChat(): void {
    this.stop();
    this.state.entries = [];
    this.emit();
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
