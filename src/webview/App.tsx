import * as l10n from "@vscode/l10n";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { type ChatEntry, type ChatState, isReplying } from "../core/protocol";
import type { ProviderError } from "../core/providerError";
import { describeMention, describeProviderError, describeSkippedProvider } from "./text";
import { post } from "./vscodeApi";

export function App({ state }: { state: ChatState }) {
  const configured = state.providers.length > 0;
  return (
    <main className="panel">
      {configured ? <Header state={state} /> : <EmptyState />}
      <Warnings state={state} />
      {state.models.status === "failed" && (
        <ErrorBlock error={state.models.error} retry={() => post({ type: "retryModels" })} />
      )}
      {/* Without providers, an earlier conversation stays readable and a reply in flight keeps its Stop. */}
      {(configured || state.entries.length > 0) && <Conversation entries={state.entries} />}
      {(configured || isReplying(state)) && <Composer state={state} />}
    </main>
  );
}

function EmptyState() {
  return (
    <section className="empty">
      <p>{l10n.t("No provider is configured.")}</p>
      <button type="button" className="link" onClick={() => post({ type: "openSettings" })}>
        {l10n.t("Open provider settings")}
      </button>
    </section>
  );
}

function Header({ state }: { state: ChatState }) {
  const replying = isReplying(state);
  const { models } = state;
  return (
    <header className="header">
      <select
        aria-label={l10n.t("Provider")}
        value={state.provider ?? ""}
        disabled={replying}
        onChange={(event) => post({ type: "selectProvider", provider: event.target.value })}
      >
        {state.providers.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <select
        aria-label={l10n.t("Model")}
        value={state.model ?? ""}
        disabled={replying || models.status !== "loaded" || models.models.length === 0}
        onChange={(event) => post({ type: "selectModel", model: event.target.value })}
      >
        {models.status === "loaded" && models.models.length > 0 ? (
          models.models.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))
        ) : (
          <option value="">{modelPlaceholder(state)}</option>
        )}
      </select>
      <button
        type="button"
        className="secondary"
        disabled={state.entries.length === 0}
        onClick={() => post({ type: "newChat" })}
      >
        {l10n.t("New chat")}
      </button>
    </header>
  );
}

function modelPlaceholder(state: ChatState): string {
  switch (state.models.status) {
    case "loading":
      return l10n.t("Loading models…");
    case "failed":
      return l10n.t("Models unavailable");
    case "loaded":
      return l10n.t("No models");
    case "noProvider":
      return "";
  }
}

function Warnings({ state }: { state: ChatState }) {
  if (state.skipped.length === 0) return null;
  return (
    <ul className="warnings" role="status">
      {state.skipped.map((skipped) => (
        <li key={skipped.position}>{describeSkippedProvider(skipped)}</li>
      ))}
    </ul>
  );
}

function ErrorBlock({ error, retry }: { error: ProviderError; retry?: () => void }) {
  const text = describeProviderError(error);
  return (
    <div className="error" role="alert">
      <p>{text.message}</p>
      {text.detail && <pre className="detail">{text.detail}</pre>}
      <div className="actions">
        {error.kind === "invalidKey" && (
          <button type="button" onClick={() => post({ type: "setApiKey", provider: error.provider })}>
            {l10n.t("Set API key")}
          </button>
        )}
        {(error.kind === "certificate" || error.kind === "caFileInvalid") && (
          <button type="button" onClick={() => post({ type: "openSettings" })}>
            {l10n.t("Open provider settings")}
          </button>
        )}
        {retry && (
          <button type="button" className="secondary" onClick={retry}>
            {l10n.t("Retry")}
          </button>
        )}
      </div>
    </div>
  );
}

function Conversation({ entries }: { entries: ChatEntry[] }) {
  const end = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLElement>(null);
  const [pinned, setPinned] = useState(true);

  // New chat must not inherit the scroll-away of the conversation it replaced.
  useEffect(() => {
    if (entries.length === 0) setPinned(true);
  }, [entries.length]);

  // Follow stream only while user stays at bottom.
  useLayoutEffect(() => {
    if (pinned) end.current?.scrollIntoView({ block: "end" });
  });

  if (entries.length === 0) {
    return (
      <section className="conversation start">
        <p>{l10n.t("Send a message to start.")}</p>
      </section>
    );
  }
  return (
    <section
      className="conversation"
      ref={list}
      onScroll={() => {
        const element = list.current;
        if (element) setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
      }}
    >
      {entries.map((entry, index) =>
        entry.role === "user" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: entries are only appended or cleared, never reordered or removed.
          <div key={index} className="message user">
            {entry.content}
            {entry.mentions.length > 0 && <Mentions entry={entry} />}
          </div>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: entries are only appended or cleared, never reordered or removed.
          <div key={index} className="message assistant">
            {entry.reasoning !== "" && <Reasoning key="reasoning" entry={entry} />}
            {entry.content !== "" && <Markdown>{entry.content}</Markdown>}
            {entry.status === "waiting" && (
              <p className="loading" role="status">
                {l10n.t("Waiting for the reply…")}
              </p>
            )}
            {entry.status === "stopped" && <p className="mark">{l10n.t("Stopped")}</p>}
            {entry.error && <ErrorBlock error={entry.error} />}
          </div>
        ),
      )}
      <div ref={end} />
    </section>
  );
}

/** Each mention of a user message with its status. Plain labels: the menu and chips are #19. */
function Mentions({ entry }: { entry: ChatEntry & { role: "user" } }) {
  return (
    <ul className="mentions" aria-label={l10n.t("Mentions")}>
      {entry.mentions.map((mention) => {
        const attached = mention.status === "attached" || mention.status === "truncated";
        return (
          <li key={mention.path} className={attached ? undefined : "failed"}>
            @{mention.path} · {describeMention(mention)}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Reasoning block, collapsed until clicked. Uncontrolled `<details>` with a stable key: no `open` prop, so the
 * state the user chose survives every re-render while the answer streams. Plain text, never Markdown.
 */
function Reasoning({ entry }: { entry: ChatEntry & { role: "assistant" } }) {
  // [>]: First reasoning piece already turns `waiting` into `streaming`.
  const stillReasoning = entry.status === "streaming" && entry.content === "";
  return (
    <details className="reasoning">
      <summary>
        {stillReasoning ? (
          <span className="loading" role="status">
            {l10n.t("Thinking…")}
          </span>
        ) : (
          l10n.t("Reasoning")
        )}
      </summary>
      <div className="reasoning-text">{entry.reasoning.trim()}</div>
    </details>
  );
}

function Composer({ state }: { state: ChatState }) {
  const [text, setText] = useState("");
  const replying = isReplying(state);
  const ready = state.model !== undefined;
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!replying) input.current?.focus();
  }, [replying]);

  const send = () => {
    if (!ready || replying || text.trim() === "") return;
    post({ type: "send", text });
    setText("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <footer className="composer">
      <textarea
        ref={input}
        rows={3}
        value={text}
        placeholder={
          ready
            ? l10n.t("Ask anything. Enter to send, Shift+Enter for a new line.")
            : l10n.t("Choose a model to start.")
        }
        aria-label={l10n.t("Message")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {replying ? (
        <button type="button" onClick={() => post({ type: "stop" })}>
          {l10n.t("Stop")}
        </button>
      ) : (
        <button type="button" disabled={!ready || text.trim() === ""} onClick={send}>
          {l10n.t("Send")}
        </button>
      )}
    </footer>
  );
}
