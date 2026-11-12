import * as l10n from "@vscode/l10n";
import {
  type ComponentProps,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import { type ConversationSummary, filterConversations } from "../core/conversation";
import { codeBlockText, FENCE_CLOSED, hasTextAfter, remarkFenceClosed } from "../core/markdownCode";
import { emptyModelsLabel } from "../core/modelList";
import {
  type ChatEntry,
  type ChatState,
  type DraftInsert,
  type HostMessage,
  isMode,
  isQueuePaused,
  isReplying,
  MAX_QUEUED_MESSAGES,
  MODES,
  type Mode,
  type PendingApproval,
  type QueuedMessage,
  type ReplyCall,
  type WebviewMessage,
} from "../core/protocol";
import type { ProviderError } from "../core/providerError";
import { isNothingToAttach, type ReservedMention, reservedMention } from "../core/reservedMentions";
import { BUILT_IN_COMMANDS, type BuiltInCommand, builtInCommand, type SlashCommand } from "../core/suggestions";
import {
  applyDraft,
  composerKeyAction,
  type MentionRow,
  type MenuAnswer,
  type MenuToken,
  mentionPick,
  menuToken,
  menuView,
  openMenuToken,
  pickedInText,
  queueReturnedBy,
  replaceToken,
  restoreQueued,
  type SkillAnswer,
  type SlashRow,
  slashMenuView,
  slashPick,
} from "./composer";
import { moveHighlight, optionId, SuggestionMenu } from "./SuggestionMenu";
import {
  describeContextUsage,
  describeFold,
  describeHalt,
  describeListFailure,
  describeMention,
  describeProviderError,
  describeSkillWarning,
  describeSkippedProvider,
  describeStorageProblem,
  describeToolStep,
  type ErrorText,
  formatConversationDate,
  mainArgument,
} from "./text";
import { foldTurns } from "./turns";
import { post } from "./vscodeApi";

/**
 * `language`: BCP 47 tag of the VS Code display language, for dates. `drafts`: editor drafts not yet applied, which the
 * message box applies and `takeDrafts` removes; one closes History. Without a message box they are taken unapplied:
 * a draft is never held for a box that may never come. A navigation request that empties the queue returns its texts
 * to the message box (`queueReturnedBy`); they wait for the box when it is not shown, since they were typed.
 */
export function App({
  state,
  language,
  drafts = [],
  takeDrafts = () => {},
}: {
  state: ChatState;
  language: string;
  drafts?: readonly DraftInsert[];
  takeDrafts?: (count: number) => void;
}) {
  const configured = state.providers.length > 0;
  const composerShown = configured || isReplying(state);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButton = useRef<HTMLButtonElement>(null);
  /** Queued messages returned by navigation and not yet back in the message box, in request order. */
  const [returned, setReturned] = useState<(readonly QueuedMessage[])[]>([]);
  const takeReturned = useCallback((count: number) => setReturned((pending) => pending.slice(count)), []);
  const navigate = (request: WebviewMessage) => {
    const messages = queueReturnedBy(request, state);
    if (messages.length > 0) setReturned((pending) => [...pending, messages]);
    post(request);
  };

  useEffect(() => {
    if (drafts.length === 0) return;
    setHistoryOpen(false);
    if (!composerShown) takeDrafts(drafts.length);
  }, [drafts, composerShown, takeDrafts]);
  return (
    <main className="panel">
      {/* Saved conversations are local: History works without a provider; only the composer needs one. */}
      <Header
        state={state}
        language={language}
        historyOpen={historyOpen}
        toggleHistory={() => setHistoryOpen(!historyOpen)}
        historyButton={historyButton}
        navigate={navigate}
      />
      {!configured && <EmptyState />}
      <Warnings state={state} />
      {state.model !== undefined && !state.context.known && <ContextNotice model={state.model} />}
      {state.model !== undefined && state.context.leftOut !== undefined && (
        <LeftOutNotice count={state.context.leftOut} />
      )}
      {state.listFailed && <TextBlock text={describeListFailure(state.listFailed)} />}
      {state.storageProblem && <TextBlock text={describeStorageProblem(state.storageProblem)} />}
      {state.models.status === "failed" && (
        <ErrorBlock error={state.models.error} retry={() => post({ type: "retryModels" })} />
      )}
      {historyOpen && (
        <HistoryPanel
          state={state}
          language={language}
          close={() => setHistoryOpen(false)}
          navigate={navigate}
          dismiss={() => {
            setHistoryOpen(false);
            historyButton.current?.focus();
          }}
        />
      )}
      {/* Without providers, an earlier conversation stays readable and a reply in flight keeps its Stop. */}
      {(configured || state.entries.length > 0) && (
        // [>]: Keyed by conversation: another one starts with fresh scroll and collapsed reasoning blocks. Hidden, not
        // unmounted, while History shows, so the reason typed for an open approval survives.
        <Conversation
          key={state.conversationId}
          entries={state.entries}
          approval={state.approval}
          hidden={historyOpen}
        />
      )}
      {composerShown && (
        <Composer
          state={state}
          historyOpen={historyOpen}
          drafts={drafts}
          takeDrafts={takeDrafts}
          returned={returned}
          takeReturned={takeReturned}
          startNewChat={() => {
            setHistoryOpen(false);
            navigate({ type: "newChat" });
          }}
        />
      )}
    </main>
  );
}

/** No provider: add one in the editor's guided flow, or write the settings by hand. */
export function EmptyState() {
  return (
    <section className="empty">
      <p>{l10n.t("No provider is configured.")}</p>
      <div className="actions">
        <button type="button" onClick={() => post({ type: "addProvider" })}>
          {l10n.t("Add provider")}
        </button>
        <button type="button" className="link" onClick={() => post({ type: "openSettings" })}>
          {l10n.t("Open provider settings")}
        </button>
      </div>
    </section>
  );
}

const HISTORY_ID = "history";

/**
 * Provider and model pickers (with a provider configured), the context usage of the selected model, New chat, and the
 * History toggle. `language`: BCP 47 tag for the usage numbers. `historyButton`: the toggle, which takes the focus
 * back when Escape closes History. `navigate`: posts New chat, returning the queue to the message box.
 */
export function Header({
  state,
  language,
  historyOpen,
  toggleHistory,
  historyButton,
  navigate = post,
}: {
  state: ChatState;
  language: string;
  historyOpen: boolean;
  toggleHistory: () => void;
  historyButton?: Ref<HTMLButtonElement>;
  navigate?: (request: WebviewMessage) => void;
}) {
  return (
    <header className="header">
      {state.providers.length > 0 && <Pickers state={state} />}
      {state.model !== undefined && (
        <span className="usage" title={l10n.t("Estimated size of the next request")}>
          {describeContextUsage(state.context, language)}
        </span>
      )}
      <div className="actions">
        <button
          type="button"
          className="secondary"
          disabled={state.entries.length === 0}
          onClick={() => {
            if (historyOpen) toggleHistory();
            navigate({ type: "newChat" });
          }}
        >
          {l10n.t("New chat")}
        </button>
        <button
          ref={historyButton}
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
          <option value="">{emptyModelsLabel(models, l10n, "blank")}</option>
        )}
      </select>
    </div>
  );
}

/**
 * Skipped providers, from the settings, then skipped skills, from the last send. Under skipped providers, Add provider,
 * unless the empty state above already offers it.
 */
export function Warnings({ state }: { state: ChatState }) {
  if (state.skipped.length === 0 && state.skillWarnings.length === 0) return null;
  return (
    <>
      <ul className="warnings" role="status">
        {state.skipped.map((skipped) => (
          <li key={`provider-${skipped.position}`}>{describeSkippedProvider(skipped)}</li>
        ))}
        {state.skillWarnings.map((warning) => (
          <li key={`skill-${warning.path}`}>{describeSkillWarning(warning)}</li>
        ))}
      </ul>
      {state.skipped.length > 0 && state.providers.length > 0 && (
        <div className="actions">
          <button type="button" className="secondary" onClick={() => post({ type: "addProvider" })}>
            {l10n.t("Add provider")}
          </button>
        </div>
      )}
    </>
  );
}

/** The selected `model` is absent from the context size table: 32k is used, and the link asks the host for its size. */
export function ContextNotice({ model }: { model: string }) {
  return (
    <p className="notice" role="status">
      {l10n.t("Unknown context size, using 32k")}{" "}
      <button type="button" className="link" onClick={() => post({ type: "setContextSize", model })}>
        {l10n.t("Set context size")}
      </button>
    </p>
  );
}

/** The next request leaves `count` older tool results out to fit the context; derived from the state, never saved. */
function LeftOutNotice({ count }: { count: number }) {
  return (
    <p className="notice" role="status">
      {count === 1
        ? l10n.t("1 older tool result is left out of the request to save context.")
        : l10n.t("{0} older tool results are left out of the request to save context.", count)}
    </p>
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
 * Delete deletes. `dismiss`: Escape in an empty filter field, which closes History and focuses its toggle.
 * `navigate`: posts the open and delete requests, returning the queue to the message box when they empty it.
 */
export function HistoryPanel({
  state,
  language,
  close,
  dismiss,
  navigate = post,
}: {
  state: ChatState;
  language: string;
  close: () => void;
  dismiss: () => void;
  navigate?: (request: WebviewMessage) => void;
}) {
  return (
    <ConversationList
      conversations={state.conversations}
      currentId={state.conversationId}
      language={language}
      onOpen={(id) => {
        close();
        navigate({ type: "openConversation", id });
      }}
      onDelete={(id) => navigate({ type: "deleteConversation", id })}
      onDismiss={dismiss}
    />
  );
}

/**
 * Saved conversations of the workspace, in the order given (newest first), under a filter field when there is one.
 * A row's title reopens it; the one shown is marked `aria-current`. Mounted only while History is open, so the filter
 * starts empty at each opening and takes the focus then (a focus move DESIGN.md allows); it keeps its text while
 * the list changes. In the field, Enter opens the first row listed; Escape clears the text, or calls `onDismiss` when
 * there is none.
 */
export function ConversationList({
  conversations,
  currentId,
  language,
  onOpen,
  onDelete,
  onDismiss,
}: {
  conversations: ConversationSummary[];
  currentId: string;
  language: string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onDismiss: () => void;
}) {
  const [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement>(null);
  // [>]: On mount only: a field that shows later, when a first conversation is saved, never takes the focus.
  useEffect(() => field.current?.focus(), []);

  if (conversations.length === 0) {
    return (
      <section id={HISTORY_ID} className="history empty">
        <p>{l10n.t("No past conversations.")}</p>
      </section>
    );
  }
  const listed = filterConversations(conversations, query);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (listed[0]) onOpen(listed[0].id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (query === "") onDismiss();
      else setQuery("");
    }
  };
  return (
    <section id={HISTORY_ID} className="history" aria-label={l10n.t("History")}>
      <input
        ref={field}
        type="text"
        className="history-filter"
        value={query}
        placeholder={l10n.t("Filter by title")}
        aria-label={l10n.t("Filter by title")}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {listed.length === 0 ? (
        <p className="history-none">{l10n.t("No match")}</p>
      ) : (
        <ul>
          {listed.map((conversation) => {
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
      )}
    </section>
  );
}

/** `approval`: the request open, shown on the last reply, the one in flight. `hidden`: History shows instead. */
function Conversation({
  entries,
  approval,
  hidden,
}: {
  entries: ChatEntry[];
  approval?: PendingApproval;
  hidden: boolean;
}) {
  const end = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLElement>(null);
  const [pinned, setPinned] = useState(true);

  // Follow stream only while user stays at bottom. Unpinned, nothing moves the view: see `overflow-anchor` in the CSS.
  useLayoutEffect(() => {
    if (pinned) end.current?.scrollIntoView({ block: "end" });
  });

  // [>]: Keyed by index: a conversation's entries are only appended, and another one remounts the list. An entry moving
  // into a fold remounts, so a row opened inside comes back closed. The open request goes to the last entry, never
  // folded, since only an ended turn folds.
  const entry = (index: number) => (
    <Entry
      key={index}
      entry={entries[index]!}
      previous={entries[index - 1]}
      next={entries[index + 1]}
      approval={index === entries.length - 1 ? approval : undefined}
    />
  );

  if (entries.length === 0) {
    return (
      <section className="conversation start" hidden={hidden}>
        <p>{l10n.t("Send a message to start.")}</p>
      </section>
    );
  }
  return (
    <section
      className="conversation"
      hidden={hidden}
      ref={list}
      onScroll={() => {
        const element = list.current;
        if (element) setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
      }}
    >
      {foldTurns(entries).map((part) =>
        part.kind === "entry" ? (
          entry(part.index)
        ) : (
          // [>]: Uncontrolled, as the reasoning block: the user's choice holds while the conversation stays shown.
          <details key={`fold-${part.start}`} className="turn-fold">
            <summary className="turn-fold-row">{describeFold(part.counts)}</summary>
            <div className="turn-fold-entries">
              {Array.from({ length: part.end - part.start }, (_, offset) => entry(part.start + offset))}
            </div>
          </details>
        ),
      )}
      <div ref={end} />
    </section>
  );
}

/**
 * One entry of the conversation, with its neighbours: a tool step shows inside the reply before it. `approval`: the
 * request open, given to the last entry only.
 */
function Entry({
  entry,
  previous,
  next,
  approval,
}: {
  entry: ChatEntry;
  previous?: ChatEntry;
  next?: ChatEntry;
  approval?: PendingApproval;
}) {
  switch (entry.role) {
    case "user":
      return (
        <div className="message user">
          {entry.content}
          {(entry.mentions.length > 0 || entry.skill) && <Mentions entry={entry} />}
        </div>
      );
    case "assistant":
      return <Reply entry={entry} step={next?.role === "tool" ? next : undefined} approval={approval} />;
    case "tool":
      // [>]: A step without a reply before it is still shown, never lost.
      return previous?.role === "assistant" ? null : (
        <div className="message assistant">
          <ToolStep result={entry} />
        </div>
      );
  }
}

/**
 * One reply of an agent turn: its reasoning, its answer as Markdown less its call block, the row of its tool step
 * (`step`: the entry after it), the decision its call waits on (`approval`, the request open, given while this is the
 * last reply), in one `decision` block with the call's row, and how the turn ended when it ended here.
 */
function Reply({
  entry,
  step,
  approval,
}: {
  entry: ChatEntry & { role: "assistant" };
  step?: ChatEntry & { role: "tool" };
  approval?: PendingApproval;
}) {
  const { call } = entry;
  const answer = call ? (entry.content.slice(0, call.start) + entry.content.slice(call.end)).trim() : entry.content;
  const inFlight = entry.status === "waiting" || entry.status === "streaming";
  const deciding = inFlight && call !== undefined && step === undefined ? approval : undefined;
  const unfinished: PendingCall["outcome"] = inFlight ? "running" : entry.status === "stopped" ? "stopped" : "noResult";
  return (
    <div className="message assistant">
      {entry.reasoning !== "" && <Reasoning key="reasoning" entry={entry} />}
      {answer !== "" && (
        // [>]: The Markdown rules of the stylesheet apply inside this block only, never to the rows and blocks beside it.
        <div className="answer">
          <AnswerSource.Provider value={{ source: answer, ended: !inFlight }}>
            <Markdown components={ANSWER_COMPONENTS} remarkPlugins={ANSWER_PLUGINS}>
              {answer}
            </Markdown>
          </AnswerSource.Provider>
        </div>
      )}
      {step ? (
        <ToolStep result={step} />
      ) : deciding && call ? (
        // [>]: One block for the call and its controls: the decision is the one element that asks for attention.
        <div className="decision">
          <ToolStep call={call} outcome="deciding" />
          {/* [>]: Keyed by request, so a new request starts with an empty reason. */}
          <Approval key={deciding.id} approval={deciding} />
        </div>
      ) : (
        call && <ToolStep call={call} outcome={unfinished} />
      )}
      {entry.status === "waiting" && (
        <p className="loading" role="status">
          {l10n.t("Waiting for the reply…")}
        </p>
      )}
      {entry.status === "stopped" && <p className="mark">{l10n.t("Stopped")}</p>}
      {entry.status === "halted" && entry.haltReason && <p className="mark">{describeHalt(entry.haltReason)}</p>}
      {entry.error && <ErrorBlock error={entry.error} />}
    </div>
  );
}

/**
 * The answer the Markdown renderer draws, for its code blocks: `source`, the Markdown, which their positions point
 * into; `ended`, the reply is no longer in flight, so its text is final.
 */
const AnswerSource = createContext<{ source: string; ended: boolean }>({ source: "", ended: false });

/** How long Copy shows its outcome in place of its label. */
const COPY_FEEDBACK_MS = 2000;

/**
 * A code block of the answer, with Copy and Insert at cursor in a header above the code once its text is final: its
 * closing fence read by the parser (`remarkFenceClosed`), rendered text after it (`hasTextAfter`: an indented block, or
 * a fenced block whose container ended), or its reply ended. A block still growing renders bare.
 * [>]: One component for every render, so a block keeps its Copy outcome while the answer streams on.
 */
function CodeBlock({ node, ...props }: ComponentProps<"pre"> & ExtraProps) {
  const { source, ended } = useContext(AnswerSource);
  const end = node?.position?.end.offset;
  const code = node ? textOf(node) : "";
  const child = node?.children[0];
  const fenceClosed = child?.type === "element" && child.properties[FENCE_CLOSED] === true;
  const final = ended || fenceClosed || (end !== undefined && hasTextAfter(source, end));
  if (!final) return <pre {...props} />;
  return (
    <div className="code-block">
      <CodeActions text={codeBlockText(code)} />
      <pre {...props} />
    </div>
  );
}

const ANSWER_COMPONENTS: Components = { pre: CodeBlock };
const ANSWER_PLUGINS = [remarkFenceClosed];

/** The text of a rendered node: its own value, or its children's, in order. */
function textOf(node: { value?: unknown; children?: unknown[] }): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map((child) => textOf(child as { value?: unknown; children?: unknown[] })).join("");
}

/**
 * Copy and Insert at cursor for a code block's `text`, disabled when it is empty. Copy writes the webview's clipboard
 * and shows Copied or Copy failed in its place for `COPY_FEEDBACK_MS`; Insert at cursor asks the host, which says
 * itself when it fails. Neither moves the focus.
 */
function CodeActions({ text }: { text: string }) {
  const [copied, setCopied] = useState<"copied" | "failed">();
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  const copy = async () => {
    let outcome: "copied" | "failed" = "copied";
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error("broke-code: could not copy the code block", error);
      outcome = "failed";
    }
    clearTimeout(reset.current);
    setCopied(outcome);
    reset.current = setTimeout(() => setCopied(undefined), COPY_FEEDBACK_MS);
  };
  return (
    <div className="code-actions">
      <button type="button" className="code-action" disabled={text === ""} onClick={() => void copy()}>
        {copied === "copied" ? l10n.t("Copied") : copied === "failed" ? l10n.t("Copy failed") : l10n.t("Copy")}
      </button>
      <button
        type="button"
        className="code-action"
        disabled={text === ""}
        onClick={() => post({ type: "insertCode", text })}
      >
        {l10n.t("Insert at cursor")}
      </button>
    </div>
  );
}

/**
 * A call whose step was never recorded. `running`: its tool runs now. `deciding`: it waits for the user's Accept or
 * Reject. `stopped`: Stop came while it ran, so its result was dropped; the tool may have finished. `noResult`: the
 * turn ended otherwise before a result came.
 */
type PendingCall = { call: ReplyCall; outcome: "running" | "deciding" | "stopped" | "noResult" };

/**
 * A compact tool step row: tool name, main argument, and the result's status and size. The result text, or a
 * malformed call's whole message, shows once the row is expanded; a malformed step shows its first line in the row.
 * Uncontrolled `<details>`, as the reasoning block, so the user's choice survives re-renders. Given a pending call
 * instead of a `result`, the row says the tool runs, or that the turn ended with no result.
 */
function ToolStep(props: { result: ChatEntry & { role: "tool" } } | PendingCall) {
  if (!("result" in props)) {
    const { call, outcome } = props;
    return (
      <div className="step">
        <div className={stepRowClass(call.name)}>
          <StepHead name={call.name} args={call.args} />
          {outcome === "running" ? (
            <span className="step-status loading" role="status">
              {l10n.t("running…")}
            </span>
          ) : outcome === "deciding" ? (
            <span className="step-status" role="status">
              {l10n.t("waiting for your decision")}
            </span>
          ) : (
            <span className="step-status">
              {outcome === "stopped" ? l10n.t("stopped, no result") : l10n.t("no result")}
            </span>
          )}
        </div>
      </div>
    );
  }
  const { result } = props;
  const malformed = result.status === "malformed";
  return (
    <details className="step">
      <summary className={stepRowClass(result.name)}>
        {malformed ? <span className="step-tool">{l10n.t("malformed call")}</span> : <StepHead {...result} />}
        <span className={result.status === "ok" ? "step-status" : "step-status failed"}>
          {describeToolStep(result)}
        </span>
      </summary>
      <pre className="step-result">
        <code>{result.text}</code>
      </pre>
    </details>
  );
}

/** The tool whose step row shows its whole command. */
const RUN_COMMAND = "run_command";

/** A step row's class: a command's row wraps, so its command block takes a line of its own. */
function stepRowClass(tool: string): string {
  return tool === RUN_COMMAND ? "step-row command" : "step-row";
}

/** The open approval request's controls, holding the reason typed until the user decides. */
function Approval({ approval }: { approval: PendingApproval }) {
  const [reason, setReason] = useState("");
  return <ApprovalControls approval={approval} reason={reason} setReason={setReason} />;
}

/**
 * Accept, Reject, and the optional reason sent with a rejection, for `approval`. Each decision carries the request's
 * id, so the host ignores one for a request already closed; a blank reason is left out.
 */
export function ApprovalControls({
  approval,
  reason,
  setReason,
}: {
  approval: PendingApproval;
  reason: string;
  setReason: (reason: string) => void;
}) {
  const { id } = approval;
  const command = approval.kind === "command";
  const reject = () => {
    const trimmed = reason.trim();
    post(trimmed === "" ? { type: "reject", id } : { type: "reject", id, reason: trimmed });
  };
  return (
    <fieldset
      className="approval"
      aria-label={
        command ? l10n.t("Run or reject this command") : l10n.t("Approve {0} on {1}", approval.tool, approval.summary)
      }
    >
      <input
        type="text"
        className="approval-reason"
        value={reason}
        placeholder={l10n.t("Reason for rejecting (optional)")}
        aria-label={l10n.t("Reason for rejecting (optional)")}
        onChange={(event) => setReason(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          reject();
        }}
      />
      <div className="actions">
        <button type="button" onClick={() => post({ type: "approve", id })}>
          {command ? l10n.t("Run") : l10n.t("Accept")}
        </button>
        <button type="button" className="secondary" onClick={reject}>
          {l10n.t("Reject")}
        </button>
      </div>
    </fieldset>
  );
}

/**
 * The tool name and its main argument, at the start of a step row. A command shows whole, its line breaks kept, on
 * its own line under the row's first line (`stepRowClass`), since the user approves exactly that text, and the folder
 * it runs in when the model named one.
 */
function StepHead({ name, args }: { name: string; args: Record<string, string> }) {
  if (name === RUN_COMMAND && args.command !== undefined) {
    return (
      <>
        <span className="step-tool">{name}</span>
        {args.cwd && <span className="step-arg">{l10n.t("in {0}", args.cwd)}</span>}
        <code className="step-command">{args.command}</code>
      </>
    );
  }
  const argument = mainArgument(args);
  return (
    <>
      <span className="step-tool">{name}</span>
      {argument !== undefined && <span className="step-arg">{argument}</span>}
    </>
  );
}

/**
 * The chips of a user message: the skill it loaded with `/<name>`, then one per mention, with kind, path, and status;
 * failed ones stand out, a partial `@diff` among them, and one that found nothing to attach without failing is neutral.
 */
function Mentions({ entry }: { entry: ChatEntry & { role: "user" } }) {
  const { skill } = entry;
  return (
    <ul className="mentions" aria-label={skill ? l10n.t("Skill and mentions") : l10n.t("Mentions")}>
      {skill && (
        <li className={skill.status === "loaded" ? "chip" : "chip failed"}>
          <span className="chip-path">{l10n.t("Skill {0}", skill.name)}</span>
          <span className="chip-status">
            {skill.status === "loaded" ? l10n.t("loaded") : l10n.t("could not be loaded")}
          </span>
        </li>
      )}
      {entry.mentions.map((mention) => {
        const attached = mention.status === "attached" || mention.status === "truncated";
        // [>]: A partial success (some folders of a `@diff` failed) takes the error color: part is missing.
        const whole = attached && !mention.failedFolders;
        const look = whole ? "chip" : attached || !isNothingToAttach(mention.status) ? "chip failed" : "chip neutral";
        return (
          <li key={mention.path} className={look}>
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
  items: MentionRow[];
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
      label={l10n.t("Mentions")}
      items={items.map((item) => {
        const reserved = reservedMention(item.kind);
        // [>]: Keyed by kind and path: a reserved row and a file of the same name never share a key.
        const row = { key: `${item.kind}:${item.path}`, label: item.path, icon: item.kind };
        return reserved ? { ...row, description: reservedDescription(reserved) } : row;
      })}
      highlighted={highlighted}
      onPick={onPick}
      notices={notices}
    />
  );
}

/** The one-line description of a reserved mention's row in the `@` menu. */
function reservedDescription(name: ReservedMention): string {
  switch (name) {
    case "problems":
      return l10n.t("Errors and warnings of the workspace files");
    case "diff":
      return l10n.t("Uncommitted changes of the tracked files");
    case "selection":
      return l10n.t("Selected text of the active editor");
  }
}

const SLASH_MENU_ID = "slash-menu";

/**
 * Slash command menu rows for `items`, each with its description, with a "No match" line when empty, a failure line
 * instead when the skills could not be listed.
 */
export function SlashMenu({
  items,
  failed,
  highlighted,
  onPick,
}: {
  items: SlashCommand[];
  failed: boolean;
  highlighted: number;
  onPick: (index: number) => void;
}) {
  const notices = [
    ...(failed ? [l10n.t("Could not list the skills")] : []),
    ...(!failed && items.length === 0 ? [l10n.t("No match")] : []),
  ];
  return (
    <SuggestionMenu
      id={SLASH_MENU_ID}
      trigger="/"
      label={l10n.t("Commands and skills")}
      // [>]: Keyed by position: a skill may share a built-in's name, and the rows only change as a whole.
      items={items.map((item, index) => ({ key: `${index}`, label: item.name, description: item.description }))}
      highlighted={highlighted}
      onPick={onPick}
      notices={notices}
    />
  );
}

/** The `/` menu's built-in rows, in `BUILT_IN_COMMANDS` order. */
function builtInRows(): SlashRow[] {
  const descriptions: Record<BuiltInCommand, string> = {
    new: l10n.t("Start a new conversation"),
    model: l10n.t("Choose the model"),
  };
  return BUILT_IN_COMMANDS.map((name) => ({ name, description: descriptions[name], builtIn: name }));
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
 * Message box with the mention and slash menus. Typing `@` and a query asks the host for matching paths; a pick replaces
 * the token with `@<path> ` and records the path, so a path with spaces still counts as one mention. Picked paths are
 * sent while their `@<path>` text is still in the message. A `/` at the start of the message asks the host once for the
 * skills and lists them after the built-in commands, filtered as the user types; picking a skill inserts `/<name> `.
 * Picking a built-in row, or sending exactly `/new` or `/model`, runs it when Send would act (`startNewChat`, or the
 * editor's model list through `chooseModel`) and empties the box; otherwise, or with text after the token, the pick
 * inserts `/<name> `. When a reply ends, the message box takes the focus, unless History is open (`historyOpen`): the
 * focus then stays where the user has it, so typing keeps going to the History filter. `drafts` from the editor are
 * applied in order (`applyDraft`), whatever the reply's state, then taken, and the message box takes the focus.
 * While a reply is in flight, Send and Enter queue the message instead (`queueMessage`), up to `MAX_QUEUED_MESSAGES`,
 * a built-in command excepted, which stays text in the box; the queue shows under the box (`QueuedMessages`).
 * `returned` queued messages, which navigation emptied, go back in the box (`restoreQueued`), then are taken; neither
 * moves the focus.
 */
function Composer({
  state,
  historyOpen,
  startNewChat,
  drafts,
  takeDrafts,
  returned,
  takeReturned,
}: {
  state: ChatState;
  historyOpen: boolean;
  startNewChat: () => void;
  drafts: readonly DraftInsert[];
  takeDrafts: (count: number) => void;
  returned: readonly (readonly QueuedMessage[])[];
  takeReturned: (count: number) => void;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [answer, setAnswer] = useState<MenuAnswer>();
  const [skillAnswer, setSkillAnswer] = useState<SkillAnswer>();
  const [highlighted, setHighlighted] = useState(0);
  /** Token closed with Escape; typing on reopens the menu. */
  const [dismissed, setDismissed] = useState<MenuToken>();
  /** Latest file query; an answer counts only for it. */
  const latest = useRef<{ id: number; query: string | undefined }>({ id: 0, query: undefined });
  /** Latest skill query; an answer counts only for it, while its menu stays open. */
  const latestSkills = useRef(0);
  const nextCaret = useRef<number>(undefined);
  /** A draft focused the box and the user has not acted in the panel since. */
  const draftFocus = useRef(false);
  const replying = isReplying(state);
  const ready = state.model !== undefined;
  const input = useRef<HTMLTextAreaElement>(null);

  const token = menuToken(text, caret, picked);
  const fileQuery = token?.trigger === "@" ? token.query : undefined;
  const slashQuery = token?.trigger === "/" ? token.query : undefined;
  const open = openMenuToken(token, focused, dismissed);
  const slashOpen = open?.trigger === "/";
  const mentionMenu = open?.trigger === "@" ? menuView(answer, open.query) : undefined;
  const slashMenu = open?.trigger === "/" ? slashMenuView(builtInRows(), skillAnswer, open.query) : undefined;
  const rows = mentionMenu?.items.length ?? slashMenu?.items.length;
  const menuId = mentionMenu ? MENTION_MENU_ID : slashMenu ? SLASH_MENU_ID : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a reply's end moves the focus; History closing must not.
  useEffect(() => {
    if (!replying && !historyOpen) input.current?.focus();
  }, [replying]);

  // [>]: Each query gets a new id and an answer counts only for the latest one; leaving the token also bumps it, so
  // an answer still in flight cannot reopen the menu.
  useEffect(() => {
    const id = latest.current.id + 1;
    latest.current = { id, query: fileQuery };
    setHighlighted(0);
    if (fileQuery === undefined) {
      setAnswer(undefined);
      return;
    }
    post({ type: "queryFiles", query: fileQuery, id });
  }, [fileQuery]);

  // [>]: One skill query per opening: a discovery reads every `SKILL.md`, too much per keystroke. Closing the menu
  // (Escape, blur, or leaving the token) bumps the id too, so an answer to an earlier opening is dropped.
  useEffect(() => {
    latestSkills.current += 1;
    if (!slashOpen) {
      setSkillAnswer(undefined);
      return;
    }
    post({ type: "querySkills", id: latestSkills.current });
  }, [slashOpen]);

  useEffect(() => {
    if (slashQuery !== undefined) setHighlighted(0);
  }, [slashQuery]);

  const hasToken = token !== undefined;
  useEffect(() => {
    if (!hasToken) setDismissed(undefined);
  }, [hasToken]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      if (message.type === "skillSuggestions") {
        // [>]: Built-in rows come first and stay, so the highlighted row stays the same as the skills join.
        if (message.id === latestSkills.current) setSkillAnswer({ items: message.items, failed: message.failed });
        return;
      }
      const { id, query } = latest.current;
      if (message.type !== "fileSuggestions" || message.id !== id || query === undefined) return;
      setAnswer({ query, items: message.items, capped: message.capped, failed: message.failed });
      setHighlighted(0);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a draft applies to the box as it stands when it arrives.
  useEffect(() => {
    if (drafts.length === 0) return;
    const next = drafts.reduce(applyDraft, { text, caret, picked });
    setText(next.text);
    setCaret(next.caret);
    setPicked([...next.picked]);
    nextCaret.current = next.caret;
    takeDrafts(drafts.length);
    input.current?.focus();
    draftFocus.current = true;
  }, [drafts]);

  // [!]: The view's focus command settles before the workbench has focused the webview, so a draft can land first:
  // the workbench's focus then blurs the box and gives the panel back its focus with nothing focused inside (#68,
  // seen live). Until the user acts in the panel, the box takes that focus back.
  useEffect(() => {
    const refocus = () => {
      if (draftFocus.current && (document.activeElement === null || document.activeElement === document.body)) {
        input.current?.focus();
      }
    };
    const release = () => {
      draftFocus.current = false;
    };
    window.addEventListener("focus", refocus);
    window.addEventListener("pointerdown", release, true);
    window.addEventListener("keydown", release, true);
    return () => {
      window.removeEventListener("focus", refocus);
      window.removeEventListener("pointerdown", release, true);
      window.removeEventListener("keydown", release, true);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: returned texts apply to the box as it stands when they arrive.
  useEffect(() => {
    if (returned.length === 0) return;
    const next = returned.reduce(restoreQueued, { text, caret, picked });
    setText(next.text);
    setCaret(next.caret);
    setPicked([...next.picked]);
    nextCaret.current = next.caret;
    takeReturned(returned.length);
  }, [returned]);

  useLayoutEffect(() => {
    if (nextCaret.current === undefined) return;
    input.current?.setSelectionRange(nextCaret.current, nextCaret.current);
    nextCaret.current = undefined;
  });

  // [!]: The one check of whether Send would act: Send, Enter, the built-in commands, and Send now all go through it.
  const canSend = ready && !replying && !state.modePending;
  // [>]: Only a reply in flight queues; with no model or a mode change pending, Send does nothing either way.
  const canQueue = ready && replying && !state.modePending && state.queue.length < MAX_QUEUED_MESSAGES;

  const clear = () => {
    setText("");
    setCaret(0);
    setPicked([]);
  };

  const run = (command: BuiltInCommand) => {
    if (command === "new") startNewChat();
    else post({ type: "chooseModel" });
    clear();
  };

  const pick = (index: number) => {
    const row = slashMenu?.items[index];
    const item = mentionMenu?.items[index];
    const action = row ? slashPick(row, canSend, text.slice(caret)) : undefined;
    if (action?.type === "run") return run(action.command);
    const mention = item ? mentionPick(item) : undefined;
    const inserted = action ? action.text : mention?.text;
    if (!token || inserted === undefined) return;
    const next = replaceToken(text, token, caret, inserted);
    setText(next.text);
    setCaret(next.caret);
    nextCaret.current = next.caret;
    const path = mention?.picked;
    if (path !== undefined) setPicked((paths) => (paths.includes(path) ? paths : [...paths, path]));
  };

  const send = () => {
    if (text.trim() === "") return;
    const command = builtInCommand(text);
    if (canSend && command) return run(command);
    // [>]: A built-in is never queued: during a reply it stays text in the box.
    const type = canSend ? "send" : canQueue && !command ? "queueMessage" : undefined;
    if (!type) return;
    post({ type, text, mentions: pickedInText(picked, text) });
    clear();
  };

  const edit = (message: QueuedMessage) => {
    post({ type: "removeQueued", id: message.id });
    const next = restoreQueued({ text, caret, picked }, [message]);
    setText(next.text);
    setCaret(next.caret);
    setPicked([...next.picked]);
    nextCaret.current = next.caret;
    // [>]: The user asked to edit it, and the row they clicked is gone: the message box takes the focus.
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const pressed = { key: event.key, shift: event.shiftKey, composing: event.nativeEvent.isComposing };
    const action = composerKeyAction(pressed, rows);
    if (action.type === "none") return;
    event.preventDefault();
    event.stopPropagation();
    switch (action.type) {
      case "move":
        setHighlighted((current) => moveHighlight(current, action.step, rows ?? 0));
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
    <>
      <footer className="composer">
        {mentionMenu && (
          <MentionMenu
            items={mentionMenu.items}
            capped={mentionMenu.capped}
            failed={mentionMenu.failed}
            highlighted={highlighted}
            onPick={pick}
          />
        )}
        {slashMenu && (
          <SlashMenu items={slashMenu.items} failed={slashMenu.failed} highlighted={highlighted} onPick={pick} />
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
          aria-controls={menuId}
          aria-activedescendant={menuId && rows ? optionId(menuId, highlighted) : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
        />
        {/* [!]: After the message box, so Shift+Tab from it still reaches an open request's controls first. */}
        <ModeSelect mode={state.mode} disabled={replying || state.modePending} />
        {/* [>]: During a reply Send queues, so it stays beside Stop, secondary: Stop is the region's primary button. */}
        <button
          type="button"
          className={replying ? "secondary" : undefined}
          disabled={!(canSend || canQueue) || text.trim() === ""}
          onClick={send}
        >
          {l10n.t("Send")}
        </button>
        {replying && (
          <button type="button" onClick={() => post({ type: "stop" })}>
            {l10n.t("Stop")}
          </button>
        )}
      </footer>
      {state.queue.length > 0 && <QueuedMessages state={state} canSend={canSend} edit={edit} />}
    </>
  );
}

/**
 * The queued messages under the message box, in order, after Send and Stop in the tab order, so nothing focusable
 * comes between an approval's controls and the message box. Each has Edit and Remove; while the queue is paused
 * (`isQueuePaused`), a line says so and the first has Send now, enabled when Send would act (`canSend`). A line says
 * when the queue is full.
 */
function QueuedMessages({
  state,
  canSend,
  edit,
}: {
  state: ChatState;
  canSend: boolean;
  edit: (message: QueuedMessage) => void;
}) {
  const paused = isQueuePaused(state);
  return (
    <section className="queue" aria-label={l10n.t("Queued messages")}>
      {paused && (
        <p className="notice" role="status">
          {l10n.t("The queue is paused.")}
        </p>
      )}
      {state.queue.length >= MAX_QUEUED_MESSAGES && (
        <p className="notice" role="status">
          {l10n.t("The queue is full: {0} messages at most.", MAX_QUEUED_MESSAGES)}
        </p>
      )}
      <ol>
        {state.queue.map((message, index) => (
          <li key={message.id}>
            <span className="queued-text" title={message.text}>
              {message.text}
            </span>
            <div className="actions">
              {paused && index === 0 && (
                <button
                  type="button"
                  className="secondary"
                  disabled={!canSend}
                  onClick={() => post({ type: "sendQueued", id: message.id })}
                >
                  {l10n.t("Send now")}
                </button>
              )}
              <button type="button" className="secondary" onClick={() => edit(message)}>
                {l10n.t("Edit")}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => post({ type: "removeQueued", id: message.id })}
              >
                {l10n.t("Remove")}
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Ask, Auto-edit, or Plan, as the host reads them: Plan from the workspace, the others from the setting. Controlled by
 * the state, so a pick shows only once the host has applied it; a failed write leaves the mode as it was.
 */
function ModeSelect({ mode, disabled }: { mode: Mode; disabled: boolean }) {
  const labels: Record<Mode, string> = { ask: l10n.t("Ask"), autoEdit: l10n.t("Auto-edit"), plan: l10n.t("Plan") };
  const hints: Record<Mode, string> = {
    ask: l10n.t("Each change waits for Accept or Reject."),
    autoEdit: l10n.t("Changes are written without asking. Commands still wait for Run."),
    plan: l10n.t("The agent reads files and answers with a plan. It changes no file and runs no command."),
  };
  return (
    <select
      className="mode"
      aria-label={l10n.t("Mode")}
      title={hints[mode]}
      value={mode}
      disabled={disabled}
      onChange={(event) => {
        if (isMode(event.target.value)) post({ type: "setMode", mode: event.target.value });
      }}
    >
      {MODES.map((option) => (
        <option key={option} value={option}>
          {labels[option]}
        </option>
      ))}
    </select>
  );
}
