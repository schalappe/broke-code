import * as l10n from "@vscode/l10n";
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type { ConversationSummary } from "../core/conversation";
import { type ChatEntry, type ChatState, type HostMessage, isReplying } from "../core/protocol";
import type { ProviderError } from "../core/providerError";
import type { MentionToken, Suggestion } from "../core/suggestions";
import { composerKeyAction, type MenuAnswer, menuToken, menuView, openMenuToken, pickedInText } from "./composer";
import { moveHighlight, optionId, SuggestionMenu } from "./SuggestionMenu";
import {
  describeListFailure,
  describeMention,
  describeProviderError,
  describeSkippedProvider,
  describeStorageProblem,
  type ErrorText,
  formatConversationDate,
} from "./text";
import { post } from "./vscodeApi";

/** `language`: BCP 47 tag of the VS Code display language, for dates. */
export function App({ state, language }: { state: ChatState; language: string }) {
  const configured = state.providers.length > 0;
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <main className="panel">
      {/* Saved conversations are local: History works without a provider; only the composer needs one. */}
      <Header state={state} historyOpen={historyOpen} toggleHistory={() => setHistoryOpen(!historyOpen)} />
      {!configured && <EmptyState />}
      <Warnings state={state} />
      {state.listFailed && <TextBlock text={describeListFailure(state.listFailed)} />}
      {state.storageProblem && <TextBlock text={describeStorageProblem(state.storageProblem)} />}
      {state.models.status === "failed" && (
        <ErrorBlock error={state.models.error} retry={() => post({ type: "retryModels" })} />
      )}
      {historyOpen ? (
        <HistoryPanel state={state} language={language} close={() => setHistoryOpen(false)} />
      ) : (
        // Without providers, an earlier conversation stays readable and a reply in flight keeps its Stop.
        (configured || state.entries.length > 0) && (
          // [>]: Keyed by conversation: another one starts with fresh scroll and collapsed reasoning blocks.
          <Conversation key={state.conversationId} entries={state.entries} />
        )
      )}
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

const HISTORY_ID = "history";

/** Provider and model pickers (with a provider configured), New chat, and the History toggle. */
export function Header({
  state,
  historyOpen,
  toggleHistory,
}: {
  state: ChatState;
  historyOpen: boolean;
  toggleHistory: () => void;
}) {
  return (
    <header className="header">
      {state.providers.length > 0 && <Pickers state={state} />}
      <div className="actions">
        <button
          type="button"
          className="secondary"
          disabled={state.entries.length === 0}
          onClick={() => {
            if (historyOpen) toggleHistory();
            post({ type: "newChat" });
          }}
        >
          {l10n.t("New chat")}
        </button>
        <button
          type="button"
          className="secondary"
          aria-expanded={historyOpen}
          aria-controls={historyOpen ? HISTORY_ID : undefined}
          onClick={toggleHistory}
        >
          {l10n.t("History")}
        </button>
      </div>
    </header>
  );
}

function Pickers({ state }: { state: ChatState }) {
  const replying = isReplying(state);
  const { models } = state;
  return (
    <div className="pickers">
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
    </div>
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

/** Alert with a message and its optional technical detail. */
function TextBlock({ text, children }: { text: ErrorText; children?: ReactNode }) {
  return (
    <div className="error" role="alert">
      <p>{text.message}</p>
      {text.detail && <pre className="detail">{text.detail}</pre>}
      {children}
    </div>
  );
}

function ErrorBlock({ error, retry }: { error: ProviderError; retry?: () => void }) {
  return (
    <TextBlock text={describeProviderError(error)}>
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
    </TextBlock>
  );
}

/**
 * History list wired to the host: a pick closes it and asks to open that conversation, even the one shown, since a
 * pending open may be about to replace it; the controller skips an open of the conversation shown when it runs.
 * Delete deletes.
 */
export function HistoryPanel({ state, language, close }: { state: ChatState; language: string; close: () => void }) {
  return (
    <ConversationList
      conversations={state.conversations}
      currentId={state.conversationId}
      language={language}
      onOpen={(id) => {
        close();
        post({ type: "openConversation", id });
      }}
      onDelete={(id) => post({ type: "deleteConversation", id })}
    />
  );
}

/**
 * Saved conversations of the workspace, in the order given (newest first). A row's title reopens it; the one shown
 * is marked `aria-current`.
 */
export function ConversationList({
  conversations,
  currentId,
  language,
  onOpen,
  onDelete,
}: {
  conversations: ConversationSummary[];
  currentId: string;
  language: string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (conversations.length === 0) {
    return (
      <section id={HISTORY_ID} className="history empty">
        <p>{l10n.t("No past conversations.")}</p>
      </section>
    );
  }
  return (
    <section id={HISTORY_ID} className="history" aria-label={l10n.t("History")}>
      <ul>
        {conversations.map((conversation) => {
          const current = conversation.id === currentId;
          return (
            <li key={conversation.id} className={current ? "current" : undefined}>
              <button
                type="button"
                className="history-open"
                aria-current={current ? "true" : undefined}
                onClick={() => onOpen(conversation.id)}
              >
                <span className="history-title">{conversation.title}</span>
                <span className="history-date">{formatConversationDate(conversation.updatedAt, language)}</span>
              </button>
              <button type="button" className="secondary" onClick={() => onDelete(conversation.id)}>
                {l10n.t("Delete")}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
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
          // biome-ignore lint/suspicious/noArrayIndexKey: a conversation's entries are only appended; another one remounts the list.
          <div key={index} className="message user">
            {entry.content}
            {entry.mentions.length > 0 && <Mentions entry={entry} />}
          </div>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a conversation's entries are only appended; another one remounts the list.
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

/** One chip per mention of a user message: kind, path, and status; failed ones stand out. */
function Mentions({ entry }: { entry: ChatEntry & { role: "user" } }) {
  return (
    <ul className="mentions" aria-label={l10n.t("Mentions")}>
      {entry.mentions.map((mention) => {
        const attached = mention.status === "attached" || mention.status === "truncated";
        return (
          <li key={mention.path} className={attached ? "chip" : "chip failed"}>
            <span className={`kind ${mention.kind}`} aria-hidden="true" />
            <span className="chip-path">@{mention.path}</span>
            <span className="chip-status">{describeMention(mention)}</span>
          </li>
        );
      })}
    </ul>
  );
}

const MENTION_MENU_ID = "mention-menu";

/**
 * Mention menu rows for `items`, with a "No match" line when empty, a failure line instead when the files could not
 * be listed, and a last line when the index is capped.
 */
export function MentionMenu({
  items,
  capped,
  failed,
  highlighted,
  onPick,
}: {
  items: Suggestion[];
  capped: boolean;
  failed: boolean;
  highlighted: number;
  onPick: (index: number) => void;
}) {
  const notices = [
    ...(failed ? [l10n.t("Could not list the workspace files")] : []),
    ...(!failed && items.length === 0 ? [l10n.t("No match")] : []),
    ...(capped ? [l10n.t("Index limited to 5,000 files")] : []),
  ];
  return (
    <SuggestionMenu
      id={MENTION_MENU_ID}
      trigger="@"
      label={l10n.t("Files and folders")}
      items={items.map((item) => ({ key: item.path, label: item.path, icon: item.kind }))}
      highlighted={highlighted}
      onPick={onPick}
      notices={notices}
    />
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

/**
 * Message box with the mention menu. Typing `@` and a query asks the host for matching paths; a pick replaces the
 * token with `@<path> ` and records the path, so a path with spaces still counts as one mention. Picked paths are
 * sent while their `@<path>` text is still in the message.
 */
function Composer({ state }: { state: ChatState }) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [answer, setAnswer] = useState<MenuAnswer>();
  const [highlighted, setHighlighted] = useState(0);
  /** Token closed with Escape; typing on reopens the menu. */
  const [dismissed, setDismissed] = useState<MentionToken>();
  /** Latest file query; an answer counts only for it. */
  const latest = useRef<{ id: number; query: string | undefined }>({ id: 0, query: undefined });
  const nextCaret = useRef<number>(undefined);
  const replying = isReplying(state);
  const ready = state.model !== undefined;
  const input = useRef<HTMLTextAreaElement>(null);

  const token = menuToken(text, caret, picked);
  const query = token?.query;
  const open = openMenuToken(token, focused, dismissed);
  const menu = open && menuView(answer, open.query);

  useEffect(() => {
    if (!replying) input.current?.focus();
  }, [replying]);

  // [>]: Each query gets a new id and an answer counts only for the latest one; leaving the token also bumps it, so
  // an answer still in flight cannot reopen the menu.
  useEffect(() => {
    const id = latest.current.id + 1;
    latest.current = { id, query };
    setHighlighted(0);
    if (query === undefined) {
      setAnswer(undefined);
      setDismissed(undefined);
      return;
    }
    post({ type: "queryFiles", query, id });
  }, [query]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      const { id, query } = latest.current;
      if (message.type !== "fileSuggestions" || message.id !== id || query === undefined) return;
      setAnswer({ query, items: message.items, capped: message.capped, failed: message.failed });
      setHighlighted(0);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useLayoutEffect(() => {
    if (nextCaret.current === undefined) return;
    input.current?.setSelectionRange(nextCaret.current, nextCaret.current);
    nextCaret.current = undefined;
  });

  const pick = (index: number) => {
    const item = menu?.items[index];
    if (!item || !token) return;
    const inserted = `@${item.path} `;
    const end = token.start + inserted.length;
    setText(text.slice(0, token.start) + inserted + text.slice(caret));
    setCaret(end);
    nextCaret.current = end;
    setPicked((paths) => (paths.includes(item.path) ? paths : [...paths, item.path]));
  };

  const send = () => {
    if (!ready || replying || text.trim() === "") return;
    post({ type: "send", text, mentions: pickedInText(picked, text) });
    setText("");
    setCaret(0);
    setPicked([]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const pressed = { key: event.key, shift: event.shiftKey, composing: event.nativeEvent.isComposing };
    const action = composerKeyAction(pressed, menu?.items.length);
    if (action.type === "none") return;
    event.preventDefault();
    event.stopPropagation();
    switch (action.type) {
      case "move":
        setHighlighted((current) => moveHighlight(current, action.step, menu?.items.length ?? 0));
        return;
      case "pick":
        return pick(highlighted);
      case "dismiss":
        return setDismissed(token);
      case "send":
        return send();
    }
  };

  return (
    <footer className="composer">
      {menu && (
        <MentionMenu
          items={menu.items}
          capped={menu.capped}
          failed={menu.failed}
          highlighted={highlighted}
          onPick={pick}
        />
      )}
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
        aria-autocomplete="list"
        aria-controls={menu ? MENTION_MENU_ID : undefined}
        aria-activedescendant={menu && menu.items.length > 0 ? optionId(MENTION_MENU_ID, highlighted) : undefined}
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
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
