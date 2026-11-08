import * as l10n from "@vscode/l10n";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import type { ProviderError } from "../core/providerError";
import { isReplying, type ChatEntry, type ChatState } from "../core/protocol";
import { describeProviderError, describeSkippedProvider } from "./text";
import { post } from "./vscodeApi";

export function App({ state }: { state: ChatState }) {
  if (state.providers.length === 0) {
    return (
      <main className="panel">
        <Warnings state={state} />
        <section className="empty">
          <p>{l10n.t("No provider is configured.")}</p>
          <button type="button" className="link" onClick={() => post({ type: "openSettings" })}>
            {l10n.t("Open provider settings")}
          </button>
        </section>
      </main>
    );
  }
  return (
    <main className="panel">
      <Header state={state} />
      <Warnings state={state} />
      {state.models.status === "failed" && (
        <ErrorBlock error={state.models.error} retry={() => post({ type: "retryModels" })} />
      )}
      <Conversation entries={state.entries} />
      <Composer state={state} />
    </main>
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
          <div key={index} className="message user">
            {entry.content}
          </div>
        ) : (
          <div key={index} className="message assistant">
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
        placeholder={ready ? l10n.t("Ask anything. Enter to send, Shift+Enter for a new line.") : l10n.t("Choose a model to start.")}
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
