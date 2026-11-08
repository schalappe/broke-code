/**
 * @module chatController
 * Chat state owner: provider and model choice, model listing, streamed replies, stop, new chat.
 * Conversation lives in memory for window (extension host) lifetime; survives view being hidden (persistence: #12).
 * vscode-free: host passes key store and workspace memento through ports below.
 */
import { listModels, streamChat, type ChatMessage, type ProviderAccess } from "./client";
import { isReplying, type ChatEntry, type ChatState } from "./protocol";
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

  constructor(
    private readonly apiKeys: KeyStore,
    private readonly workspaceState: ChoiceStore,
    private readonly publish: (state: ChatState) => void,
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
    if (replyProvider && !parsed.providers.some((p) => p.name === replyProvider.name && p.baseUrl === replyProvider.baseUrl)) {
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
    if (isReplying(this.state) || this.state.models.status !== "loaded" || !this.state.models.models.includes(model)) return;
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
    this.state.model = preferred.find((model) => model !== undefined && listing.models.includes(model)) ?? listing.models[0];
    this.remember();
    this.emit();
  }

  /** Send user message and stream reply. Ignored while replying or without provider and model. */
  async send(text: string): Promise<void> {
    const provider = this.currentProvider();
    const model = this.state.model;
    const content = text.trim();
    if (!provider || !model || !content || isReplying(this.state)) return;

    const history = toHistory(this.state.entries);
    history.push({ role: "user", content });
    const reply: ChatEntry & { role: "assistant" } = { role: "assistant", reasoning: "", content: "", status: "waiting" };
    this.state.entries.push({ role: "user", content }, reply);
    this.emit();

    const abort = new AbortController();
    this.reply = { abort, provider };
    const outcome = await streamChat(await this.accessOf(provider), {
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

/**
 * Conversation sent to model: user messages plus assistant answers with text (stopped and cut-off partials
 * included). Reasoning never sent; a reply with reasoning only is left out.
 */
function toHistory(entries: ChatEntry[]): ChatMessage[] {
  return entries
    .filter((entry) => entry.role === "user" || entry.content !== "")
    .map((entry) => ({ role: entry.role, content: entry.content }));
}
