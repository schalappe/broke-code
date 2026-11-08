/**
 * @module chatController
 * Chat state owner: provider and model choice, model listing, streamed replies, stop, new chat.
 * Conversation lives in memory for extension host lifetime (persistence: #12).
 */
import type * as vscode from "vscode";
import { listModels, streamChat, type ChatMessage, type ProviderAccess } from "../core/client";
import { isReplying, type ChatEntry, type ChatState } from "../core/protocol";
import type { ParsedProviders, Provider } from "../core/providers";
import type { ApiKeys } from "./apiKeys";

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
  private reply: AbortController | undefined;
  /** Bumped per listing request; stale listings dropped. */
  private listingId = 0;

  constructor(
    private readonly apiKeys: ApiKeys,
    private readonly workspaceState: vscode.Memento,
    private readonly publish: (state: ChatState) => void,
  ) {}

  get snapshot(): ChatState {
    return this.state;
  }

  /** Apply parsed settings. Keeps current provider when still valid, else remembered one, else first. */
  setProviders(parsed: ParsedProviders): void {
    const previous = this.currentProvider();
    this.providers = parsed.providers;
    this.state.providers = parsed.providers.map((provider) => provider.name);
    this.state.skipped = parsed.skipped;

    const names = this.state.providers;
    const remembered = this.workspaceState.get<LastChoice>(LAST_CHOICE_KEY)?.provider;
    const keep = [previous?.name, remembered].find((name) => name !== undefined && names.includes(name));
    const next = this.providers.find((provider) => provider.name === (keep ?? names[0]));

    if (next?.name === previous?.name && next?.baseUrl === previous?.baseUrl) {
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
    const reply: ChatEntry & { role: "assistant" } = { role: "assistant", content: "", status: "waiting" };
    this.state.entries.push({ role: "user", content }, reply);
    this.emit();

    const abort = new AbortController();
    this.reply = abort;
    const outcome = await streamChat(await this.accessOf(provider), {
      model,
      messages: history,
      signal: abort.signal,
      onContent: (delta) => {
        reply.content += delta;
        reply.status = "streaming";
        this.emit();
      },
    });
    if (this.reply === abort) this.reply = undefined;

    if (outcome.status === "failed") {
      reply.status = "failed";
      reply.error = outcome.error;
    } else {
      reply.status = outcome.status;
    }
    this.emit();
  }

  stop(): void {
    this.reply?.abort();
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

/** Conversation sent to model: user messages plus assistant replies with text (stopped and cut-off partials included). */
function toHistory(entries: ChatEntry[]): ChatMessage[] {
  return entries
    .filter((entry) => entry.role === "user" || entry.content !== "")
    .map((entry) => ({ role: entry.role, content: entry.content }));
}
