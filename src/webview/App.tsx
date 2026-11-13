import * as l10n from "@vscode/l10n";
import {
  type ComponentProps,
  createContext,
  Fragment,
  type KeyboardEvent,
  memo,
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
import remarkGfm from "remark-gfm";
import {
  type ConversationMatch,
  type ConversationSummary,
  filterConversations,
  shownAnswer,
} from "../core/conversation";
import { historyStart, isAutomaticSummary, sentEntries } from "../core/history";
import { hasFinalAnswer, type LastTurnActions, lastTurnActions, unrevertedEffects } from "../core/lastTurn";
import { codeBlockText, FENCE_CLOSED, hasTextAfter, remarkFenceClosed } from "../core/markdownCode";
import { emptyModelsLabel } from "../core/modelList";
import {
  type ChangedFile,
  type ChatEntry,
  type ChatState,
  type ContextUsage,
  type DraftInsert,
  type HostMessage,
  isMode,
  isQueuePaused,
  isReasoningEffort,
  isReplying,
  MAX_ANSWER_LENGTH,
  MAX_QUEUED_MESSAGES,
  MODES,
  type Mode,
  type PendingApproval,
  type PendingQuestion,
  type QueuedMessage,
  REASONING_EFFORTS,
  type ReasoningEffort,
  type ReplyCall,
  type ShownEntries,
  searchNeedle,
  sendWouldAct,
  type TextRange,
  type UndoState,
} from "../core/protocol";
import type { ProviderError } from "../core/providerError";
import { isNothingToAttach, type ReservedMention, reservedMention } from "../core/reservedMentions";
import { BUILT_IN_COMMANDS, type BuiltInCommand, builtInCommand } from "../core/suggestions";
import {
  applyDraft,
  composerKeyAction,
  type Draft,
  editDraft,
  type MentionRow,
  type MenuAnswer,
  type MenuToken,
  mentionPick,
  menuToken,
  menuView,
  openMenuToken,
  pickedInText,
  pickKeepsToken,
  quoteDraft,
  type RecallPlace,
  recallHolds,
  replaceToken,
  type SkillAnswer,
  type SlashRow,
  slashMenuView,
  slashPick,
  stillReplacing,
} from "./composer";
import { moveHighlight, optionId, SuggestionMenu } from "./SuggestionMenu";
import {
  describeAnnouncement,
  describeContextTitle,
  describeContextUsage,
  describeEmptySummary,
  describeFold,
  describeHalt,
  describeListFailure,
  describeMention,
  describeProviderError,
  describeRowDetails,
  describeSkillWarning,
  describeSkippedProvider,
  describeStorageProblem,
  describeToolStep,
  describeUndoFailure,
  describeUndoneFile,
  describeUndoOutcome,
  describeWaiting,
  type ErrorText,
  mainArgument,
  splitInlineCode,
  stepNote,
} from "./text";
import { type ConversationPart, type FoldCounts, foldTurns } from "./turns";
import { post } from "./vscodeApi";

/**
 * `language`: BCP 47 tag of the VS Code display language, for dates. `drafts`: host drafts not yet applied, which the
 * message box applies and `takeDrafts` removes. An editor draft closes History; without a message box it is taken
 * unapplied, never held for a box that may never come. Queued texts the host returns (`paragraph` drafts) close
 * nothing, and wait for the message box when it is absent, since the user typed them: they are never dropped.
 * Edit on the last user message starts the replacing state (what the panel showed then), held here because the conversation shows
 * its mark and the composer's Send carries it; it ends on Cancel and once `stillReplacing` fails. Quote's text travels
 * from an answer to the message box the same way as Edit's draft, and only while the panel has a message box.
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
  takeDrafts?: (taken: readonly DraftInsert[]) => void;
}) {
  const configured = state.providers.length > 0;
  const composerShown = configured || isReplying(state);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButton = useRef<HTMLButtonElement>(null);
  const [replacing, setReplacing] = useState<ShownEntries>();
  const [replacementsSent, setReplacementsSent] = useState(0);
  /** Edit's draft until the message box has applied it, once: a composer mounted later never applies it again. */
  const [editing, setEditing] = useState<DraftInsert>();
  /** Text Quote read from an answer until the message box has applied it, once. */
  const [quoting, setQuoting] = useState<string>();
  const replacingNow = replacing && stillReplacing(replacing, state) ? replacing : undefined;
  const { spoken, announce } = useAnnouncer(state);
  useDecisionKeys(state.approval !== undefined);

  // [>]: Once it fails, the state ends for good: a later snapshot that matches again (a Retry ending on as many
  // entries) must not bring the mark back.
  useEffect(() => {
    if (replacing && !replacingNow) setReplacing(undefined);
  }, [replacing, replacingNow]);

  const startNewChat = () => {
    setHistoryOpen(false);
    post({ type: "newChat" });
  };

  const edit = (entry: ChatEntry & { role: "user" }) => {
    setReplacing({ conversationId: state.conversationId, entries: state.entries.length });
    setEditing(editDraft(entry));
  };

  useEffect(() => {
    if (drafts.length === 0) return;
    const fromTheEditor = drafts.filter(fromEditor);
    if (fromTheEditor.length === 0) return;
    setHistoryOpen(false);
    if (!composerShown) takeDrafts(fromTheEditor);
  }, [drafts, composerShown, takeDrafts]);
  return (
    <main className="panel">
      <Announcer spoken={spoken} />
      {/* Saved conversations are local: History works without a provider; only the composer needs one. */}
      <Header
        state={state}
        language={language}
        historyOpen={historyOpen}
        toggleHistory={() => setHistoryOpen(!historyOpen)}
        historyButton={historyButton}
      />
      {!configured && <EmptyState />}
      <Warnings state={state} />
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
          dismiss={() => {
            setHistoryOpen(false);
            historyButton.current?.focus();
          }}
        />
      )}
      {/* Without providers, an earlier conversation stays readable and a reply in flight keeps its Stop. */}
      {(configured || state.entries.length > 0) && (
        // [>]: Keyed by conversation: another one starts with fresh scroll and collapsed reasoning blocks. Hidden, not
        // unmounted, while History shows, so the reason typed for an open approval, or the answer typed to an open
        // question, survives.
        <QuoteTarget.Provider value={composerShown ? setQuoting : undefined}>
          <Announce.Provider value={announce}>
            <Conversation
              key={state.conversationId}
              conversationId={state.conversationId}
              entries={state.entries}
              approval={state.approval}
              question={state.question}
              undo={state.undo}
              changedFiles={state.changedFiles}
              // [>]: On a full context that halts, Retry, Continue, Edit, and "Implement in ... mode" would start a turn
              // that ends at once, as a new message would.
              canAct={sendWouldAct(state) && !turnHalts(state.context)}
              implementIn={state.mode === "plan" ? state.settingMode : undefined}
              hidden={historyOpen}
              replacing={replacingNow !== undefined}
              replacementsSent={replacementsSent}
              edit={edit}
              cancelEdit={() => setReplacing(undefined)}
            />
          </Announce.Provider>
        </QuoteTarget.Provider>
      )}
      {composerShown && state.model !== undefined && (
        <ContextNotice context={state.context} canAct={sendWouldAct(state)} />
      )}
      {composerShown && (
        <Composer
          state={state}
          historyOpen={historyOpen}
          drafts={drafts}
          takeDrafts={takeDrafts}
          editing={editing}
          takeEditing={() => setEditing(undefined)}
          quoting={quoting}
          takeQuoting={() => setQuoting(undefined)}
          replaces={replacingNow}
          sentReplacement={() => setReplacementsSent((count) => count + 1)}
          startNewChat={startNewChat}
        />
      )}
    </main>
  );
}

/** The last thing the live region said; `count` tells two equal texts apart, so the second is heard too. */
type Spoken = { count: number; text: string };

/**
 * The panel's announcements: what changed between two states posted by the host (`describeAnnouncement`), and what a
 * control reports through `announce`, such as Copy's outcome. The first state says nothing, nor does a state posted
 * again unchanged.
 */
function useAnnouncer(state: ChatState): { spoken: Spoken | undefined; announce: (text: string) => void } {
  const [spoken, setSpoken] = useState<Spoken>();
  const announce = useCallback((text: string) => setSpoken((last) => ({ count: (last?.count ?? 0) + 1, text })), []);
  const shown = useRef(state);
  useEffect(() => {
    const text = describeAnnouncement(shown.current, state);
    shown.current = state;
    if (text !== undefined) announce(text);
  }, [state, announce]);
  return { spoken, announce };
}

/**
 * The live region a screen reader hears, never seen: mounted with the panel and kept, since a region added with its text
 * already in it is often not read. Each announcement is a new child, an addition the reader reads even when the text
 * repeats. Polite: it waits for the reader to finish, and it moves no focus (DESIGN.md, "Keyboard and focus").
 */
function Announcer({ spoken }: { spoken: Spoken | undefined }) {
  return (
    <p className="announcer" role="status">
      {spoken && <span key={spoken.count}>{spoken.text}</span>}
    </p>
  );
}

/** Says a control's outcome through the panel's live region; nothing outside the panel. */
const Announce = createContext<(text: string) => void>(() => {});

/** A draft from an editor entry point, which closes History and focuses the box; queued texts returned do neither. */
function fromEditor(draft: DraftInsert): boolean {
  return draft.mode !== "paragraph";
}

/** No provider: add one in the editor's guided flow, or write the settings by hand. */
export function EmptyState() {
  return (
    <section className="empty">
      <p>{l10n.t("No provider is configured.")}</p>
      <p>{l10n.t("A provider is an OpenAI-compatible service: its base URL, and an API key if it asks for one.")}</p>
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
 * Provider and model pickers (with a provider configured), the context usage of the selected model, with Set context
 * size when its size is unknown, New chat, and the History toggle. `language`: BCP 47 tag for the usage numbers. `historyButton`: the toggle, which takes the focus
 * back when Escape closes History.
 */
export function Header({
  state,
  language,
  historyOpen,
  toggleHistory,
  historyButton,
}: {
  state: ChatState;
  language: string;
  historyOpen: boolean;
  toggleHistory: () => void;
  historyButton?: Ref<HTMLButtonElement>;
}) {
  return (
    <header className="header">
      {state.providers.length > 0 && <Pickers state={state} />}
      {state.model !== undefined && (
        <span className={usageClass(state.context)} title={describeContextTitle(state.context, language)}>
          {describeContextUsage(state.context, language)}
        </span>
      )}
      {state.model !== undefined && !state.context.known && <SetContextSize model={state.model} />}
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
      {/* [>]: With one provider there is nothing to pick: the model takes the room. */}
      {state.providers.length > 1 && (
        <select
          className="provider-picker"
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
      )}
      <select
        className="model-picker"
        aria-label={l10n.t("Model")}
        // [>]: A long id may still be cut in a narrow panel; the tooltip gives it whole.
        title={state.model}
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
 * The reasoning effort of the selected model, beside the mode: both apply to the next turn. Disabled while a reply is in
 * flight, like the pickers.
 */
function EffortSelect({ state, replying }: { state: ChatState; replying: boolean }) {
  return (
    <select
      className="effort-picker"
      aria-label={l10n.t("Reasoning effort")}
      title={l10n.t(
        "How much the model reasons before it answers. Default effort sends nothing; a service that refuses the setting answers with an error, so pick Default effort again.",
      )}
      value={state.reasoningEffort ?? ""}
      disabled={replying}
      onChange={(event) => {
        const effort = event.target.value;
        post({ type: "selectReasoningEffort", effort: isReasoningEffort(effort) ? effort : undefined });
      }}
    >
      <option value="">{l10n.t("Default effort")}</option>
      {REASONING_EFFORTS.map((effort) => (
        <option key={effort} value={effort}>
          {effortLabel(effort)}
        </option>
      ))}
    </select>
  );
}

function effortLabel(effort: ReasoningEffort): string {
  switch (effort) {
    case "low":
      return l10n.t("Low effort");
    case "medium":
      return l10n.t("Medium effort");
    case "high":
      return l10n.t("High effort");
  }
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

/**
 * The selected `model` is absent from the context size table, so the usage counts against 32k: the link beside the
 * usage says so in its tooltip and asks the host for the size. In the header's line, not a line of its own, since a
 * service that never reports its size would keep it on screen for good.
 */
export function SetContextSize({ model }: { model: string }) {
  return (
    <button
      type="button"
      className="link usage-set"
      title={l10n.t("Unknown context size, using 32k")}
      onClick={() => post({ type: "setContextSize", model })}
    >
      {l10n.t("Set context size")}
    </button>
  );
}

/** The next request leaves `count` older tool results out to fit the context; derived from the state, never saved. */
function describeLeftOut(count: number): string {
  return count === 1
    ? l10n.t("1 older tool result is left out of the request to save context.")
    : l10n.t("{0} older tool results are left out of the request to save context.", count);
}

/** The share of the context from which the usage is set in bold: some room is still left for a reply. */
const NEARLY_FULL = 3 / 4;

/**
 * The usage's look: bold once the next request nears the context size, and once it fills it; the share itself is in
 * words, so the weight is never the only cue.
 */
function usageClass(context: ContextUsage): string {
  return context.full || isNearlyFull(context) ? "usage nearly-full" : "usage";
}

function isNearlyFull({ used, size }: ContextUsage): boolean {
  return used >= size * NEARLY_FULL;
}

/** A full context on which a new turn would halt before sending (`ContextUsage.full`), with or without a summary way out. */
function turnHalts(context: ContextUsage): boolean {
  return context.full === "halts" || context.full === "summaryHalts";
}

/**
 * What the panel says about a context near or past its size, over the message box. Full, when a turn would halt on it
 * (`ContextUsage.full`), one warning line and the summary (`/compact`), the one way out that keeps the conversation;
 * New chat stays in the header, and the message box sends nothing else until then. Full, when even the summary would
 * halt, one warning line that names New chat, the only way out, and no summary button. Full, when the turn summarizes
 * first (`brokeCode.autoCompact`), one notice line. Nearly full, one notice line that points at the summary before the
 * wall. Older tool results left out (`ContextUsage.leftOut`) lead the notice line, or make one of their own, so the
 * context speaks in one place. No live region: a halt is announced as the reply ends, and these lines change with the
 * usage at every delta. `canAct`: Send would act, which the summary needs too.
 */
function ContextNotice({ context, canAct }: { context: ContextUsage; canAct: boolean }) {
  const leftOut = context.leftOut === undefined ? undefined : describeLeftOut(context.leftOut);
  if (context.full === "compacts") {
    return (
      <p className="notice">{l10n.t("The context is full: the next message summarizes the conversation first.")}</p>
    );
  }
  if (context.full === "summaryHalts") {
    return (
      <section className="warning context-full">
        <p>
          {l10n.t("The conversation fills the model's context, even for a summary. Start a new chat with New chat.")}
        </p>
      </section>
    );
  }
  if (context.full === "halts") {
    return (
      <section className="warning context-full">
        <p>{l10n.t("The conversation fills the model's context.")}</p>
        <button type="button" className="secondary" disabled={!canAct} onClick={() => post({ type: "compact" })}>
          {l10n.t("Summarize (/compact)")}
        </button>
      </section>
    );
  }
  const nearlyFull = isNearlyFull(context)
    ? l10n.t("The context is nearly full: /compact summarizes the conversation to free it.")
    : undefined;
  const lines = [leftOut, nearlyFull].filter((line) => line !== undefined);
  if (lines.length === 0) return null;
  return <p className="notice">{lines.join(" ")}</p>;
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
        {(error.kind === "certificate" || error.kind === "caFileInvalid" || error.kind === "unreachable") && (
          <button type="button" className="link" onClick={() => post({ type: "openSettings" })}>
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
 * Delete deletes. `dismiss`: Escape in an empty search field, which closes History and focuses its toggle.
 */
export function HistoryPanel({
  state,
  language,
  close,
  dismiss,
}: {
  state: ChatState;
  language: string;
  close: () => void;
  dismiss: () => void;
}) {
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
      onDismiss={dismiss}
    />
  );
}

/** How long a searchable needle must stay the same before History asks the host to search the conversations. */
const SEARCH_WAIT_MS = 300;

/**
 * Last content search request id, for the whole panel: History unmounts when closed, so an id kept per mount would be
 * reused by the next opening and take a late answer to the earlier one.
 */
let lastSearchId = 0;

/** The host's answer to the content search the webview asked last. */
type ContentAnswer = { items: ConversationMatch[]; unreadableCount: number };

/**
 * History's content search for the field's `query`. Once its needle (`searchNeedle`) is searchable and has stayed the
 * same for 300 ms, asks the host to search the conversations. Each change of the needle takes a new request id and
 * drops the earlier answer at once, so only an answer to the latest needle shows; unmounting cancels the wait.
 * `changeQuery` must carry every change of the field, so the drop lands in the same render as the new text.
 */
function useContentSearch(): {
  query: string;
  changeQuery: (next: string) => void;
  answer: ContentAnswer | undefined;
  awaited: boolean;
} {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<ContentAnswer>();
  // [>]: -1 is no request id, so no answer counts before this opening's first needle change.
  const latest = useRef({ id: -1, needle: "" });
  const { needle, searchable } = searchNeedle(query);

  const changeQuery = (next: string) => {
    setQuery(next);
    const nextNeedle = searchNeedle(next).needle;
    if (nextNeedle === latest.current.needle) return;
    lastSearchId += 1;
    latest.current = { id: lastSearchId, needle: nextNeedle };
    setAnswer(undefined);
  };

  useEffect(() => {
    if (!searchable) return;
    const { id } = latest.current;
    const timer = setTimeout(() => post({ type: "searchConversations", query: needle, id }), SEARCH_WAIT_MS);
    return () => clearTimeout(timer);
  }, [needle, searchable]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      if (message.type !== "conversationMatches" || message.id !== latest.current.id) return;
      setAnswer({ items: message.items, unreadableCount: message.unreadableCount });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return { query, changeQuery, answer, awaited: searchable && answer === undefined };
}

/**
 * Saved conversations of the workspace, in the order given (newest first), under a search field when there is one.
 * The rows whose title holds the field's text (`filterConversations`) come first, at once; then the rows the host's
 * content search found and the title did not, in the order given, each with its excerpt (`useContentSearch`). A row's
 * title reopens it; the one shown is marked `aria-current`. Mounted only while History is open, so the field starts
 * empty at each opening and takes the focus then (a focus move DESIGN.md allows); it keeps its text while the list
 * changes. In the field, Enter opens the first row shown; Escape clears the text, or calls `onDismiss` when there is
 * none.
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
  const { query, changeQuery, answer, awaited } = useContentSearch();
  // [>]: A delete cannot be undone, so Delete asks first, as Retry does when it would leave changes behind.
  const [confirming, setConfirming] = useState<string>();
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
  const byTitle = filterConversations(conversations, query);
  const titled = new Set(byTitle.map((conversation) => conversation.id));
  const excerpts = new Map(answer?.items.map((item) => [item.id, item.excerpt]));
  const byContent = conversations.filter(({ id }) => excerpts.has(id) && !titled.has(id));
  const listed = [...byTitle, ...byContent];
  const unreadable = answer?.unreadableCount ?? 0;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (listed[0]) onOpen(listed[0].id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (query === "") onDismiss();
      else changeQuery("");
    }
  };
  return (
    <section id={HISTORY_ID} className="history" aria-label={l10n.t("History")}>
      <input
        ref={field}
        type="text"
        className="history-filter"
        value={query}
        placeholder={l10n.t("Search conversations")}
        aria-label={l10n.t("Search conversations")}
        onChange={(event) => changeQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {unreadable > 0 && (
        <ul className="warnings" role="status">
          <li>
            {unreadable === 1
              ? l10n.t("1 conversation could not be searched")
              : l10n.t("{0} conversations could not be searched", unreadable)}
          </li>
        </ul>
      )}
      {listed.length === 0 ? (
        awaited ? (
          <p className="loading history-searching" role="status">
            {l10n.t("Searching…")}
          </p>
        ) : (
          <p className="history-none">{l10n.t("No match")}</p>
        )
      ) : (
        <ul className="history-rows">
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
                  {!titled.has(conversation.id) && excerpts.has(conversation.id) && (
                    <span className="history-excerpt">{excerpts.get(conversation.id)}</span>
                  )}
                  <span className="history-date">{describeRowDetails(conversation, language)}</span>
                </button>
                {/* [>]: The same button asks, then confirms, so the focus stays on it between the two clicks. */}
                <button
                  type="button"
                  className={
                    confirming === conversation.id ? "secondary history-delete confirming" : "secondary history-delete"
                  }
                  aria-label={confirming === conversation.id ? undefined : l10n.t("Delete {0}", conversation.title)}
                  onClick={() => {
                    if (confirming !== conversation.id) return setConfirming(conversation.id);
                    setConfirming(undefined);
                    onDelete(conversation.id);
                  }}
                >
                  {confirming === conversation.id ? l10n.t("Confirm delete") : l10n.t("Delete")}
                </button>
                {confirming === conversation.id && (
                  <button
                    type="button"
                    className="secondary history-delete confirming"
                    onClick={() => setConfirming(undefined)}
                  >
                    {l10n.t("Cancel")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * `approval` and `question`: the request open, an approval or a question, shown on the last reply, the one in flight.
 * `undo`: "Undo changes", shown under the
 * reply it names, with "Changed files" (`changedFiles`), and the last undo's outcome under the reply it undid. Retry and Continue show under the last turn's
 * reply (`lastTurnActions`), enabled when `canAct` (Send would act). `implementIn`: Plan is on, and this is the mode
 * it leaves for, so the final answer (`hasFinalAnswer`) also offers "Implement in ... mode". `hidden`: History shows
 * instead. Edit sits under the last turn's user message when Retry is offered, enabled when `canAct`, and calls `edit`;
 * while `replacing`, it goes, and the last turn (that message and every entry after it) sits in one group under
 * the line saying that sending replaces it, with Retry's warning when the removal leaves files or commands behind, and
 * Cancel (`cancelEdit`), which gives the focus back to Edit, since the button it was on goes.
 */
function Conversation({
  conversationId,
  entries,
  approval,
  question,
  undo,
  changedFiles,
  canAct,
  implementIn,
  hidden,
  replacing,
  replacementsSent,
  edit,
  cancelEdit,
}: {
  conversationId: string;
  entries: ChatEntry[];
  approval?: PendingApproval;
  question?: PendingQuestion;
  undo: UndoState;
  changedFiles: ChangedFile[];
  canAct: boolean;
  implementIn?: SettingMode;
  hidden: boolean;
  replacing: boolean;
  replacementsSent: number;
  edit: (entry: ChatEntry & { role: "user" }) => void;
  cancelEdit: () => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const focusEdit = useRef(false);
  // [>]: The host names no reply while one is in flight; a snapshot that lags behind never shows the button either.
  const last = entries.at(-1);
  const replying = last?.role === "assistant" && (last.status === "waiting" || last.status === "streaming");
  const [pinned, setPinned] = useState(true);
  const lastTurn = lastTurnActions(entries);
  const turnActions: TurnActionsProps | undefined = lastTurn && {
    actions: lastTurn,
    shown: { conversationId, entries: entries.length },
    turn: entries.slice(lastTurn.user),
    canAct,
    implementIn: hasFinalAnswer(entries) ? implementIn : undefined,
    // [>]: Retry reverts nothing: it asks first when the removed entries changed files or ran commands, or when
    // "Undo changes" is offered for the turn it removes.
    asks: hasEffects(unrevertedEffects(entries, lastTurn.user + 1)) || (undo.reply ?? -1) > lastTurn.user,
  };

  useEffect(() => {
    if (!focusEdit.current || replacing) return;
    focusEdit.current = false;
    editButton.current?.focus();
  });

  // Follow stream only while user stays at bottom. Unpinned, nothing moves the view: see `overflow-anchor` in the CSS.
  // A message the user sends, typed or from the queue, takes them back to the bottom, where its reply comes.
  const latestUser = entries.findLastIndex((shown) => shown.role === "user");
  const seenUser = useRef(latestUser);
  const seenReplacements = useRef(replacementsSent);
  useLayoutEffect(() => {
    // [>]: Sending through Edit replaces the last user entry at the same index, so only the host's count shows it.
    const sent = latestUser > seenUser.current || replacementsSent > seenReplacements.current;
    seenUser.current = latestUser;
    seenReplacements.current = replacementsSent;
    if (!pinned && !sent) return;
    end.current?.scrollIntoView({ block: "end" });
    if (!pinned) setPinned(true);
  });
  const waiting = describeWaiting({ approval, question });
  const jumpToLatest = () => {
    end.current?.scrollIntoView({ block: "end" });
    setPinned(true);
    // [>]: The row goes once the view is at the bottom; the focus it held goes to the message box, the panel's home,
    // from which Shift+Tab reaches the decision block.
    document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
  };

  // [>]: Keyed by index, and another conversation remounts the list. Retry and Edit remove the last turn's entries, and
  // the new turn reuses their indexes: the host posts its first reply `waiting`, with no reasoning, answer, or call,
  // before any read or request, so a removed entry's opened blocks unmount before the new reply fills that index.
  // An entry moving into a fold remounts, so a row opened inside comes back closed. The open request goes to the last
  // entry, never folded, since only an ended turn folds.
  const entry = (index: number) => {
    const shown = entries[index]!;
    const rendered = (
      <Entry
        key={index}
        entry={shown}
        earlier={index < latestUser}
        previous={entries[index - 1]}
        next={entries[index + 1]}
        approval={index === entries.length - 1 ? approval : undefined}
        question={index === entries.length - 1 ? question : undefined}
        undo={index === undo.reply && !replying ? undo : undefined}
        changedFiles={index === undo.reply && !replying && changedFiles.length > 0 ? changedFiles : undefined}
        undone={index === undo.outcome?.reply ? undo.outcome : undefined}
        turnActions={index === lastTurn?.reply ? turnActions : undefined}
      />
    );
    if (index !== lastTurn?.user || replacing || shown.role !== "user") return rendered;
    return (
      <Fragment key={index}>
        {rendered}
        <div className="user-actions">
          <button ref={editButton} type="button" className="secondary" disabled={!canAct} onClick={() => edit(shown)}>
            {l10n.t("Edit")}
          </button>
        </div>
      </Fragment>
    );
  };

  // [>]: Derived, never stored: the entries before the summary the history starts at are no longer sent, except the
  // turn's message an automatic summary quotes word for word, which says so in a line of its own. A summary is a
  // fold boundary, so no fold straddles it, and a user message is never folded.
  const start = historyStart(entries);
  // [>]: `sentEntries` leads with the quoted message when there is one, else with the entry the history starts at.
  const first = sentEntries(entries)[0];
  const quoted = first !== entries[start] ? first : undefined;
  const render = (part: ConversationPart) =>
    part.kind === "entry" ? (
      entries[part.index] === quoted ? (
        <div key={part.index} className="still-sent">
          {entry(part.index)}
          <p className="still-sent-note">{l10n.t("Still sent with the summary")}</p>
        </div>
      ) : (
        entry(part.index)
      )
    ) : (
      <Fold key={`fold-${part.start}`} counts={part.counts}>
        {Array.from({ length: part.end - part.start }, (_, offset) => entry(part.start + offset))}
      </Fold>
    );
  const at = (part: ConversationPart) => (part.kind === "entry" ? part.index : part.start);
  // [>]: A user message is never folded and no fold crosses one, so the replaced turn starts a part of its own.
  const parts = foldTurns(entries);
  const cut = replacing && lastTurn ? lastTurn.user : entries.length;
  const kept = parts.filter((part) => at(part) < cut);
  const replaced = parts.slice(kept.length);
  const unsent = kept.filter((part) => at(part) < start);
  const sent = kept.slice(unsent.length);

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
      {unsent.length > 0 && (
        <div className="unsent">
          <p className="unsent-note">
            {l10n.t("Earlier messages are no longer sent to the model: the summary below replaces them.")}
          </p>
          {unsent.map(render)}
        </div>
      )}
      {sent.map(render)}
      {replaced.length > 0 && (
        <div className="replacing">
          <div className="replacing-head">
            <p className="replacing-note" role="status">
              {turnActions?.asks
                ? l10n.t(
                    "Sending replaces this message and its replies. It does not revert the files this turn wrote or the commands it ran. To get the files back, use Undo changes first.",
                  )
                : l10n.t("Sending replaces this message and its replies.")}
            </p>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                focusEdit.current = true;
                cancelEdit();
              }}
            >
              {l10n.t("Cancel")}
            </button>
          </div>
          {replaced.map(render)}
        </div>
      )}
      {!pinned && (
        // [>]: Scrolled up, what came in below would go unseen: a decision waiting would hold the turn with nothing on
        // screen saying so. The row names it; it never takes the focus by itself.
        <div className="jump-row">
          <button type="button" className={waiting ? "jump waiting" : "jump"} onClick={jumpToLatest}>
            {waiting ?? l10n.t("Jump to latest")}
          </button>
        </div>
      )}
      <div ref={end} />
    </section>
  );
}

/**
 * An ended turn's steps under one row that says what they did, then which failed, in the error color and on an error
 * node: the turn's final reply may claim success, and the failure must not hide in a closed fold. Uncontrolled, as the
 * reasoning block: the user's choice holds while the conversation stays shown.
 */
function Fold({ counts, children }: { counts: FoldCounts; children: ReactNode }) {
  const { done, failed } = describeFold(counts);
  return (
    <details className="turn-fold">
      <summary className={failed ? "turn-fold-row failed" : "turn-fold-row"}>
        <span>
          {done}
          {failed && (
            <>
              {", "}
              <span className="fold-failed">{failed}</span>
            </>
          )}
        </span>
      </summary>
      <div className="turn-fold-entries">{children}</div>
    </details>
  );
}

/**
 * One entry of the conversation, with its neighbours: a tool step shows inside the reply before it. `approval` and
 * `question`: the request open, given to the last entry only. `undo`, `changedFiles`, and `undone`: "Undo changes", "Changed files",
 * and the last undo's files, given to the reply they belong to. `turnActions`: Retry and Continue, given to the last turn's reply. `earlier`: a user
 * message a later one follows, which keeps only the outline of the latest one's block.
 */
function Entry({
  entry,
  earlier,
  previous,
  next,
  approval,
  question,
  undo,
  changedFiles,
  undone,
  turnActions,
}: {
  entry: ChatEntry;
  earlier: boolean;
  previous?: ChatEntry;
  next?: ChatEntry;
  approval?: PendingApproval;
  question?: PendingQuestion;
  undo?: UndoState;
  changedFiles?: ChangedFile[];
  undone?: UndoOutcomeState;
  turnActions?: TurnActionsProps;
}) {
  switch (entry.role) {
    case "user":
      return (
        <div className={earlier ? "message user earlier" : "message user"}>
          {entry.content}
          {(entry.mentions.length > 0 || entry.skill) && <Mentions entry={entry} />}
        </div>
      );
    case "assistant":
      return entry.summary ? (
        <>
          <p className="summary-separator">{describeSummary(entry, isAutomaticSummary(entry, next))}</p>
          <Reply
            entry={entry}
            approval={approval}
            question={question}
            undo={undo}
            changedFiles={changedFiles}
            undone={undone}
            turnActions={turnActions}
          />
        </>
      ) : (
        <Reply
          entry={entry}
          step={next?.role === "tool" ? next : undefined}
          approval={approval}
          question={question}
          undo={undo}
          changedFiles={changedFiles}
          undone={undone}
          turnActions={turnActions}
        />
      );
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
 * (`step`: the entry after it), the decision or the answer its call waits on (`approval` or `question`, the request
 * open, given while this is the last reply), in one `decision` block with the call's row, how the turn ended when it ended here, the files the held
 * turn changed (`changedFiles`), what the last undo did (`undone`), then one row of the turn's actions: Retry and Continue (`turnActions`) when this is the last turn's
 * reply, and "Undo changes" (`undo`) when this is the last reply of the turn whose writes are held.
 */
function Reply({
  entry,
  step,
  approval,
  question,
  undo,
  changedFiles,
  undone,
  turnActions,
}: {
  entry: ChatEntry & { role: "assistant" };
  step?: ChatEntry & { role: "tool" };
  approval?: PendingApproval;
  question?: PendingQuestion;
  undo?: UndoState;
  changedFiles?: ChangedFile[];
  undone?: UndoOutcomeState;
  turnActions?: TurnActionsProps;
}) {
  const { call } = entry;
  const answer = shownAnswer(entry);
  const inFlight = entry.status === "waiting" || entry.status === "streaming";
  const waitsOnUser = inFlight && call !== undefined && step === undefined;
  const deciding = waitsOnUser ? approval : undefined;
  const asked = waitsOnUser ? question : undefined;
  const unfinished: PendingCall["outcome"] = inFlight ? "running" : entry.status === "stopped" ? "stopped" : "noResult";
  return (
    <div className="message assistant">
      {entry.reasoning !== "" && <Reasoning key="reasoning" entry={entry} />}
      {entry.malformedCall ? (
        <MalformedAnswer content={entry.content} block={entry.malformedCall} />
      ) : (
        answer !== "" && <Answer answer={answer} ended={!inFlight} />
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
      ) : asked && call ? (
        // [>]: The same block as a decision: a question also holds the turn until the user acts.
        <div className="decision">
          <ToolStep call={call} outcome="asking" />
          {/* [>]: Keyed by question, so a new question starts with an empty field. */}
          <Question key={asked.id} question={asked} />
        </div>
      ) : (
        call && <ToolStep call={call} outcome={unfinished} />
      )}
      {/* [>]: Text still arriving: a breathing mark after it, so a stalled stream and a live one look different. Not a
      live region: the reply's end is announced. */}
      {entry.status === "streaming" && answer !== "" && !call && <span className="streaming-mark" aria-hidden="true" />}
      {entry.status === "waiting" && (
        <p className="loading" role="status">
          {l10n.t("Waiting for the reply…")}
        </p>
      )}
      {entry.status === "stopped" && <p className="mark">{l10n.t("Stopped")}</p>}
      {/* [>]: Every halt, a full context's included, is a past ending: the block over the message box says while the
      context is still full, with its way out, so the warning shows once. */}
      {entry.status === "halted" && entry.haltReason && (
        <p className="mark">{describeHalt(entry.haltReason, entry.summary)}</p>
      )}
      {entry.summary && entry.status === "done" && entry.content.trim() === "" && (
        <p className="mark">{describeEmptySummary()}</p>
      )}
      {entry.error && <ErrorBlock error={entry.error} />}
      {changedFiles && <ChangedFiles files={changedFiles} />}
      {undone && <UndoOutcome outcome={undone} />}
      {(turnActions || undo) && <TurnActions turnActions={turnActions} undo={undo} />}
    </div>
  );
}

/**
 * An answer whose call could not be read: the text before and after the block as Markdown, and the block itself as
 * the model wrote it, in the editor font with its line breaks, since it is code the user reads to see what went wrong.
 * The reply has ended: its malformed step follows it.
 */
function MalformedAnswer({ content, block }: { content: string; block: TextRange }) {
  const before = content.slice(0, block.start).trim();
  const after = content.slice(block.end).trim();
  return (
    <>
      {before !== "" && <Answer answer={before} ended />}
      <pre className="malformed-block">
        <code>{content.slice(block.start, block.end)}</code>
      </pre>
      {after !== "" && <Answer answer={after} ended />}
    </>
  );
}

/** Ask or Auto-edit: the mode the setting holds, which "Implement in ... mode" names. */
type SettingMode = ChatState["settingMode"];

/**
 * Retry and Continue of the last turn. `actions`: where they apply and whether Continue is offered. `shown`: the
 * conversation and entries count the requests carry, so the host ignores a click on a lagging panel. `turn`: the last
 * turn's entries, from its user message on, which the confirmation is bound to. `canAct`: Send would act. `asks`:
 * Retry would leave files or commands it does not revert, so its first click asks. `implementIn`: Plan is on and the
 * turn ended on the final answer, so "Implement in ... mode" is offered, named after this mode, the one the setting
 * holds.
 */
type TurnActionsProps = {
  actions: LastTurnActions;
  shown: ShownEntries;
  turn: readonly ChatEntry[];
  canAct: boolean;
  implementIn?: SettingMode;
  asks: boolean;
};

function hasEffects(effects: { writes: number; commands: number }): boolean {
  return effects.writes > 0 || effects.commands > 0;
}

/**
 * The actions row under a reply: Retry, Continue, "Implement in ... mode", then "Undo changes", each a secondary
 * button, wrapping when narrow. "Implement in ... mode" posts no mode: the host leaves Plan for the mode the setting
 * holds then.
 * When Retry asks, its first click shows the line saying what it does not revert, renames the same button "Retry
 * anyway", so the focus stays on it, and adds Cancel after it; the second click retries. Cancel, and any change of the
 * turn's entries (one added or removed, a status, an `undone` mark), drop the confirmation; Cancel gives the focus back to Retry, since the button it was on goes. "Undo
 * changes" is disabled, and worded so, while the undo runs, and a line says commands are neither listed in "Changed
 * files" nor undone when its turn ran one.
 */
function TurnActions({ turnActions, undo }: { turnActions?: TurnActionsProps; undo?: UndoState }) {
  const retryButton = useRef<HTMLButtonElement>(null);
  // [>]: The whole state is posted again for unrelated reasons, each time as new objects: the turn's entries are
  // compared by their text, and only while a confirmation is open.
  const [askedAt, setAskedAt] = useState<string>();
  const confirming =
    turnActions?.asks === true && askedAt !== undefined && askedAt === JSON.stringify(turnActions.turn);
  const retry = () => {
    if (!turnActions) return;
    if (turnActions.asks && !confirming) return setAskedAt(JSON.stringify(turnActions.turn));
    setAskedAt(undefined);
    post({ type: "retry", shown: turnActions.shown });
  };
  const cancel = () => {
    setAskedAt(undefined);
    retryButton.current?.focus();
  };
  return (
    <div className="turn-actions">
      {confirming && (
        <p className="retry-warning" role="status">
          {l10n.t(
            "Retry does not revert the files this turn wrote or the commands it ran. To get the files back, use Undo changes first.",
          )}
        </p>
      )}
      {turnActions && (
        <>
          {/* [>]: First and in weight 600: after a plan, carrying it out is the step the user came for. Still
          secondary, since the conversation's one primary button belongs to the decision block. */}
          {turnActions.implementIn && (
            <button
              type="button"
              className="secondary next-step"
              disabled={!turnActions.canAct}
              onClick={() => post({ type: "implementPlan", shown: turnActions.shown })}
            >
              {turnActions.implementIn === "autoEdit"
                ? l10n.t("Implement in Auto-edit mode")
                : l10n.t("Implement in Ask mode")}
            </button>
          )}
          <button ref={retryButton} type="button" className="secondary" disabled={!turnActions.canAct} onClick={retry}>
            {confirming ? l10n.t("Retry anyway") : l10n.t("Retry")}
          </button>
          {confirming && (
            <button type="button" className="secondary" onClick={cancel}>
              {l10n.t("Cancel")}
            </button>
          )}
          {turnActions.actions.continues && (
            <button
              type="button"
              className="secondary"
              disabled={!turnActions.canAct}
              onClick={() => post({ type: "continueTurn", shown: turnActions.shown })}
            >
              {l10n.t("Continue")}
            </button>
          )}
        </>
      )}
      {undo && (
        <button
          type="button"
          className="secondary"
          disabled={undo.running}
          onClick={() => post({ type: "undoChanges" })}
        >
          {undo.running ? l10n.t("Undoing changes…") : l10n.t("Undo changes")}
        </button>
      )}
      {undo?.ranCommand && <p className="undo-hint">{l10n.t("Commands this turn ran are not listed or undone.")}</p>}
    </div>
  );
}

/**
 * `path` as one unbreakable piece per folder and file name, its "/" kept at the end of each, with a line break
 * opportunity between them: a long path wraps between its folders, never inside a name (even at a hyphen), unless one
 * name alone is wider than the row (`.path-segment`).
 */
function breakAfterSlashes(path: string): ReactNode {
  const segments = path.split("/");
  return segments.map((segment, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the segments of one path never move.
    <Fragment key={index}>
      {index > 0 && <wbr />}
      <span className="path-segment">{index < segments.length - 1 ? `${segment}/` : segment}</span>
    </Fragment>
  ));
}

/**
 * "Changed files": one row per file the held turn created or edited, its path in the editor font, then "created" or
 * "edited" and its line counts. Each row is a button that opens the file's diff in the editor, which keeps the focus
 * where it is.
 */
function ChangedFiles({ files }: { files: ChangedFile[] }) {
  return (
    <section className="changed-files">
      <p className="changed-files-head">{l10n.t("Changed files")}</p>
      <ul>
        {files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className="changed-file"
              onClick={() => post({ type: "openChangeDiff", path: file.path })}
            >
              <code className="changed-path">{breakAfterSlashes(file.path)}</code>
              <span className="changed-kind">{file.kind === "created" ? l10n.t("created") : l10n.t("edited")}</span>
              <span className="changed-counts">{`+${file.added} \u2212${file.removed}`}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

type UndoOutcomeState = NonNullable<UndoState["outcome"]>;

/**
 * What the last undo did, file by file: a notice when every file is back, a warning block when some or all were
 * skipped, since those stay changed until the next undo, and an error block, with the files undone before it, when the
 * undo failed unexpectedly.
 */
function UndoOutcome({ outcome: { files, error } }: { outcome: UndoOutcomeState }) {
  const failure = error === undefined ? undefined : describeUndoFailure(error);
  const skipped = files.some((file) => file.status === "skipped");
  const look = failure ? "undo-outcome failed" : skipped ? "undo-outcome skipped" : "undo-outcome";
  return (
    <div className={look} role={failure ? "alert" : "status"}>
      <p>{failure ? failure.message : describeUndoOutcome(files)}</p>
      {failure && <pre className="detail">{failure.detail}</pre>}
      {files.length > 0 && (
        <ul>
          {files.map((file) => (
            <li key={file.path}>
              {describeUndoneFile(file).map((part) =>
                "path" in part ? (
                  <code key={part.path === file.path ? "file" : "leftover"} className="undo-path">
                    {part.path}
                  </code>
                ) : (
                  part.text
                ),
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Puts the text selected in an answer into the message box, for Quote; absent while the panel has no message box, so
 * no Quote shows then.
 */
const QuoteTarget = createContext<((selected: string) => void) | undefined>(undefined);

/**
 * An answer's rendered Markdown, then Quote in a row of its own while the page's selected text lies in it
 * (`holdsSelection`). The check runs on every selection change and after every render, since a removed node changes
 * the selection without an event. Quote reads the selected text at the click, as rendered, and hands it to the message
 * box; it moves no focus when it goes.
 */
function Answer({ answer, ended }: { answer: string; ended: boolean }) {
  const quote = useContext(QuoteTarget);
  const block = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(false);

  useEffect(() => {
    const check = () =>
      setSelected(
        quote !== undefined &&
          block.current !== null &&
          holdsSelection(block.current, row.current, document.getSelection()),
      );
    check();
    document.addEventListener("selectionchange", check);
    return () => document.removeEventListener("selectionchange", check);
  });

  const onQuote = () => {
    const selection = document.getSelection();
    // [>]: The selection can have gone without an event since the last check: a click with nothing left does nothing.
    if (!quote || !block.current || !selection || !holdsSelection(block.current, row.current, selection)) return;
    quote(selection.toString());
  };

  return (
    <>
      {/* [>]: The Markdown rules of the stylesheet apply inside this block only, never to the rows and blocks beside it. */}
      <div className="answer" ref={block}>
        <AnswerMarkdown source={answer} ended={ended} />
      </div>
      {/* [!]: Before the reply's tool step and approval, so nothing focusable comes between those and the message box. */}
      {selected && (
        <div className="quote-row" ref={row}>
          <button type="button" className="secondary" onClick={onQuote}>
            {l10n.t("Quote")}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Whether `selection` is text of the answer `block`: not collapsed, more than whitespace, starting inside `block`, and
 * covering only whitespace outside it, as a triple click on its last paragraph does by ending in the next block.
 * Quote's own `row` is skipped, so its showing cannot hide it again. A selection in a text field reports collapsed.
 */
function holdsSelection(block: Element, row: Element | null, selection: Selection | null): boolean {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  if (selection.toString().trim() === "") return false;
  const range = selection.getRangeAt(0);
  if (!block.contains(range.startContainer)) return false;
  const end = range.endContainer;
  if (block.contains(end) || row?.contains(end)) return true;
  const outside = document.createRange();
  outside.setStartAfter(row ?? block);
  outside.setEnd(end, range.endOffset);
  return outside.toString().trim() === "";
}

/**
 * The answer the Markdown renderer draws, for its code blocks: `source`, the Markdown, which their positions point
 * into; `ended`, the reply is no longer in flight, so its text is final.
 */
const AnswerSource = createContext<{ source: string; ended: boolean }>({ source: "", ended: false });

/**
 * The answer's Markdown, drawn again only when its text or `ended` changes. The host posts the whole state on every
 * streamed delta, so without this each delta parsed every earlier answer of the conversation again.
 */
const AnswerMarkdown = memo(function AnswerMarkdown({ source, ended }: { source: string; ended: boolean }) {
  return (
    <AnswerSource.Provider value={{ source, ended }}>
      <Markdown components={ANSWER_COMPONENTS} remarkPlugins={ANSWER_PLUGINS}>
        {source}
      </Markdown>
    </AnswerSource.Provider>
  );
});

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
// [>]: GitHub Flavored Markdown, as models write it: tables, strikethrough, task lists, and bare links.
const ANSWER_PLUGINS = [remarkGfm, remarkFenceClosed];

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
  const announce = useContext(Announce);
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
    // [>]: A label changed in place is rarely read, so the outcome is also announced.
    announce(outcome === "copied" ? l10n.t("Copied") : l10n.t("Copy failed"));
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
 * Reject. `asking`: it waits for the user's answer to its question. `stopped`: Stop came while it ran, so its result was dropped; the tool may have finished. `noResult`: the
 * turn ended otherwise before a result came.
 */
type PendingCall = { call: ReplyCall; outcome: "running" | "deciding" | "asking" | "stopped" | "noResult" };

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
          {/* [>]: A question shows whole right under its row, so the row names the tool only. */}
          <StepHead name={call.name} args={outcome === "asking" ? {} : call.args} />
          {outcome === "running" ? (
            // [>]: Not a live region: the panel's announcer says which tool runs, and on what.
            <span className="step-status loading">{l10n.t("running…")}</span>
          ) : outcome === "deciding" || outcome === "asking" ? (
            // [>]: Not a live region: the panel's announcer says what waits, with the tool and its argument.
            <span className="step-status waiting">
              {outcome === "deciding" ? l10n.t("waiting for your decision") : l10n.t("waiting for your answer")}
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
  const note = stepNote(result);
  const rejected = result.approval === "rejected";
  return (
    <>
      <details className="step">
        <summary className={stepRowClass(result.name)}>
          {malformed ? <span className="step-tool">{l10n.t("malformed call")}</span> : <StepHead {...result} />}
          {/* [>]: A rejection is the user's own decision, not a failure: no error color, but the full foreground, since
        the reply after it may claim the change was made. */}
          <span
            className={
              rejected ? "step-status rejected" : result.status === "ok" ? "step-status" : "step-status failed"
            }
          >
            {describeToolStep(result)}
          </span>
        </summary>
        <pre className="step-result">
          <code>{result.text}</code>
        </pre>
      </details>
      {/* [>]: Under the row, open or closed: the user's own words, wrapped, never cut. */}
      {note !== undefined && <p className="step-note">{note}</p>}
    </>
  );
}

/** The tool whose step row shows its whole command. */
const RUN_COMMAND = "run_command";

/** A step row's class: a command's row wraps, so its command block takes a line of its own. */
function stepRowClass(tool: string): string {
  return tool === RUN_COMMAND ? "step-row command" : "step-row";
}

/**
 * ⌘Enter accepts or runs, and ⌘Backspace rejects, the approval open, while the focus is in the panel and not in a field
 * holding text: in a field these keys keep their editing meaning. They click the decision block's own buttons, so a
 * rejection carries the reason typed, exactly as a click does. A held key never repeats a decision.
 */
function useDecisionKeys(open: boolean) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const decision = decisionKey(event, document.activeElement);
      if (!decision) return;
      const buttons = document.querySelectorAll<HTMLButtonElement>(".decision .approval .actions button");
      const target = buttons[decision === "approve" ? 0 : 1];
      if (!target) return;
      event.preventDefault();
      target.click();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);
}

/**
 * The decision a key press asks for: `approve` for ⌘Enter, `reject` for ⌘Backspace, with no other modifier, not
 * repeated, not composing; `undefined` when `active` is a field holding text (an input, a text area, an editable
 * element), except the message box left empty, where the focus rests while a request waits.
 */
export function decisionKey(
  event: Pick<
    globalThis.KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "isComposing"
  >,
  active: Element | null,
): "approve" | "reject" | undefined {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat || event.isComposing) {
    return undefined;
  }
  const decision = event.key === "Enter" ? "approve" : event.key === "Backspace" ? "reject" : undefined;
  if (!decision) return undefined;
  const emptyMessageBox = active instanceof HTMLTextAreaElement && active.closest(".composer") && active.value === "";
  const field =
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLElement && active.isContentEditable);
  return field && !emptyMessageBox ? undefined : decision;
}

/** The open approval request's controls, holding the reason typed until the user decides. */
function Approval({ approval }: { approval: PendingApproval }) {
  const [reason, setReason] = useState("");
  return <ApprovalControls approval={approval} reason={reason} setReason={setReason} />;
}

/**
 * A write's line counts and Show change, which brings its diff back, then Accept, Reject, and the optional reason sent
 * with a rejection, for `approval`. Each decision carries the request's id, so the host ignores one for a request
 * already closed; a blank reason is left out. Only the buttons decide: no key in the reason field does.
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
      {(approval.lines || approval.preview) && (
        <div className="approval-change">
          {approval.lines && (
            <span className="changed-counts">{`+${approval.lines.added} \u2212${approval.lines.removed}`}</span>
          )}
          {approval.preview && (
            // [>]: The diff tab may have been closed: Accept must never be a blind write.
            <button type="button" className="link" onClick={() => post({ type: "showChange", id })}>
              {l10n.t("Show change")}
            </button>
          )}
        </div>
      )}
      <input
        type="text"
        className="approval-reason"
        value={reason}
        placeholder={l10n.t("Reason for rejecting (optional)")}
        aria-label={l10n.t("Reason for rejecting (optional)")}
        // [!]: No key decides here: Enter after a note is a form habit, and a rejection must be a deliberate click
        // (or ⌘Backspace outside the field).
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="actions">
        <button
          type="button"
          title={command ? l10n.t("Run (⌘Enter)") : l10n.t("Accept (⌘Enter)")}
          aria-keyshortcuts="Meta+Enter"
          onClick={() => post({ type: "approve", id })}
        >
          {command ? l10n.t("Run") : l10n.t("Accept")}
        </button>
        <button
          type="button"
          className="secondary"
          title={l10n.t("Reject (⌘Backspace)")}
          aria-keyshortcuts="Meta+Backspace"
          onClick={reject}
        >
          {l10n.t("Reject")}
        </button>
      </div>
      {/* [>]: The keys in words, where the decision is: a tooltip is never seen from the keyboard. Hidden from screen
      readers, which read `aria-keyshortcuts` on the buttons. */}
      <p className="approval-keys" aria-hidden="true">
        {command ? l10n.t("⌘Enter runs, ⌘Backspace rejects") : l10n.t("⌘Enter accepts, ⌘Backspace rejects")}
      </p>
    </fieldset>
  );
}

/** The open question's controls, holding the answer typed until the user sends it. */
function Question({ question }: { question: PendingQuestion }) {
  const [text, setText] = useState("");
  return <QuestionControls question={question} text={text} setText={setText} />;
}

/**
 * `question` in full, one button per option in the model's order, then the field and Answer, in the DOM as on screen.
 * An option answers with its text; Answer, or Enter in the field, with the field's `text`, trimmed, and neither while
 * it is blank. Each answer carries the question's id, so the host ignores one for a question already closed.
 */
export function QuestionControls({
  question,
  text,
  setText,
}: {
  question: PendingQuestion;
  text: string;
  setText: (text: string) => void;
}) {
  const { id } = question;
  const typed = text.trim();
  const answer = () => {
    if (typed !== "") post({ type: "answer", id, text: typed });
  };
  return (
    <fieldset className="question" aria-label={l10n.t("Answer the agent's question")}>
      <p className="question-text">
        {splitInlineCode(question.question).map((part, index) =>
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed text, never reordered.
          part.code ? <code key={index}>{part.text}</code> : part.text,
        )}
      </p>
      {question.options.length > 0 && (
        <div className="question-options">
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              className="secondary question-option"
              onClick={() => post({ type: "answer", id, text: option })}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <div className="actions">
        <input
          type="text"
          className="question-field"
          value={text}
          maxLength={MAX_ANSWER_LENGTH}
          placeholder={l10n.t("Your answer")}
          aria-label={l10n.t("Your answer")}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            answer();
          }}
        />
        <button type="button" disabled={typed === ""} onClick={answer}>
          {l10n.t("Answer")}
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
  const argument = mainArgument(name, args);
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
  items: SlashRow[];
  failed: boolean;
  highlighted: number;
  onPick: (index: number) => void;
}) {
  // [>]: The built-in commands lead; the first skill under them starts a group of its own, so a long list of skills
  // never hides them.
  const firstSkill = items.findIndex((item) => !item.builtIn);
  const grouped = firstSkill > 0 ? firstSkill : -1;
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
      items={items.map((item, index) => ({
        key: `${index}`,
        label: item.name,
        description: item.description,
        ...(index === grouped ? { group: l10n.t("Skills") } : {}),
      }))}
      highlighted={highlighted}
      onPick={onPick}
      notices={notices}
    />
  );
}

/**
 * The separator above a summary: in flight, sent (done with text), or not summarized (any other end). `automatic`: the
 * turn ran it itself (`isAutomaticSummary`), worded so once sent.
 */
function describeSummary(entry: ChatEntry & { role: "assistant" }, automatic: boolean): string {
  if (entry.status === "waiting" || entry.status === "streaming") return l10n.t("Summarizing the conversation…");
  if (entry.status !== "done" || entry.content.trim() === "") return l10n.t("Conversation not summarized");
  return automatic ? l10n.t("Conversation summarized automatically") : l10n.t("Conversation summarized");
}

/** The `/` menu's built-in rows, in `BUILT_IN_COMMANDS` order. */
function builtInRows(): SlashRow[] {
  const descriptions: Record<BuiltInCommand, string> = {
    new: l10n.t("Start a new conversation"),
    model: l10n.t("Choose the model"),
    compact: l10n.t("Summarize the conversation to free context"),
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
 * Picking a built-in row, or sending exactly `/new`, `/model`, or `/compact`, runs it when Send would act (`startNewChat`,
 * the editor's model list through `chooseModel`, or the summary request `compact`) and empties the box; otherwise, or with text after the token, the pick
 * inserts `/<name> `. When a reply ends, the message box takes the focus, unless History is open (`historyOpen`): the
 * focus then stays where the user has it, so typing keeps going to the History search. `drafts` from the editor are
 * applied in order (`applyDraft`), whatever the reply's state, then taken, and the message box takes the focus.
 * While a reply is in flight, Send and Enter queue the message instead (`queueMessage`), up to `MAX_QUEUED_MESSAGES`,
 * a built-in command excepted, which stays text in the box; the queue shows under the box (`QueuedMessages`). Queued
 * texts the host returns arrive as `paragraph` drafts, applied like the editor's but without moving the focus.
 * ArrowUp in a blank box recalls the earlier user messages of the conversation shown, and ArrowDown goes back
 * (`composerKeyAction`); the box remembers the place recalled until a send, a draft, a quote, or another conversation ends it.
 */
function Composer({
  state,
  historyOpen,
  startNewChat,
  drafts,
  takeDrafts,
  editing,
  takeEditing = () => {},
  quoting,
  takeQuoting = () => {},
  replaces,
  sentReplacement = () => {},
}: {
  state: ChatState;
  historyOpen: boolean;
  startNewChat: () => void;
  drafts: readonly DraftInsert[];
  takeDrafts: (taken: readonly DraftInsert[]) => void;
  editing?: DraftInsert;
  takeEditing?: () => void;
  quoting?: string;
  takeQuoting?: () => void;
  replaces?: ShownEntries;
  sentReplacement?: () => void;
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
  /** Place of the message recalled with ArrowUp; forgotten for good once it no longer holds (`recallHolds`). */
  const [recalled, setRecalled] = useState<RecallPlace>();
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

  // [>]: Another conversation shown, or the message recalled gone, ends the recall for good: coming back does not
  // resume it, and the text stays in the box as a plain draft.
  useEffect(() => {
    if (recalled && !recallHolds(recalled, state)) setRecalled(undefined);
  }, [recalled, state]);

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

  /** Put `next` in the message box: its text, its picked paths, and its caret, placed once the box has rendered it. */
  const setDraft = (next: Draft) => {
    setText(next.text);
    setCaret(next.caret);
    setPicked([...next.picked]);
    nextCaret.current = next.caret;
  };

  // [>]: An editor draft focuses the box, since the user asked for it from the editor; queued texts the host returns
  // came from a request made in the panel, so the focus stays where the user has it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a draft applies to the box as it stands when it arrives.
  useEffect(() => {
    if (drafts.length === 0) return;
    setDraft(drafts.reduce(applyDraft, { text, caret, picked }));
    setRecalled(undefined);
    takeDrafts(drafts);
    if (!drafts.some(fromEditor)) return;
    input.current?.focus();
    draftFocus.current = true;
  }, [drafts]);

  // [>]: Edit on the last message puts its text in the box as a returned text lands, and focuses the box, since the
  // user asked to edit there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Edit's draft applies once, to the box as it stands.
  useEffect(() => {
    if (!editing) return;
    takeEditing();
    const next = applyDraft({ text, caret, picked }, editing);
    setDraft(next);
    setRecalled(undefined);
    // [>]: A message ending on a mention puts the caret on its token: its menu stays closed until the user types on.
    setDismissed(menuToken(next.text, next.caret, next.picked));
    input.current?.focus();
  }, [editing]);

  // [>]: Quote puts the selected text in the box on Edit's path and focuses it, since the user asked to quote there.
  // The quote ends with a blank line, so the caret follows whitespace and no menu opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a quote applies once, to the box as it stands.
  useEffect(() => {
    if (quoting === undefined) return;
    takeQuoting();
    setDraft(quoteDraft({ text, caret, picked }, quoting));
    setRecalled(undefined);
    input.current?.focus();
  }, [quoting]);

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

  useLayoutEffect(() => {
    if (nextCaret.current === undefined) return;
    input.current?.setSelectionRange(nextCaret.current, nextCaret.current);
    nextCaret.current = undefined;
  });

  // [!]: The one check of whether Send would act: Send, Enter, the built-in commands, and Send now all go through it.
  // An undo running blocks it as a mode change does: the host refuses a turn until the files are back.
  const canSend = sendWouldAct(state);
  // [>]: Only a reply in flight queues; with no model or a mode change pending, Send does nothing either way.
  const canQueue = ready && replying && !state.modePending && state.queue.length < MAX_QUEUED_MESSAGES;
  // [>]: A message would end its turn at once on a full context: only the built-in commands, `/compact` and `/new`
  // among them, still go. The block over the box says why.
  const contextFull = turnHalts(state.context);
  const blocked = (draft: string) => contextFull && !builtInCommand(draft);

  const clear = () => {
    setDraft({ text: "", caret: 0, picked: [] });
    setRecalled(undefined);
  };

  const run = (command: BuiltInCommand) => {
    if (command === "new") startNewChat();
    else if (command === "model") post({ type: "chooseModel" });
    else post({ type: "compact" });
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
    const path = mention?.picked;
    const paths = path === undefined || picked.includes(path) ? picked : [...picked, path];
    setDraft({ ...replaceToken(text, token, caret, inserted), picked: paths });
  };

  /** Send the box; `typedPath`: a path typed whole whose menu row Enter skipped, sent as if picked. */
  const send = (typedPath?: string) => {
    if (text.trim() === "") return;
    const command = builtInCommand(text);
    if (canSend && command) return run(command);
    if (blocked(text)) return;
    // [>]: A built-in is never queued: during a reply it stays text in the box.
    const type = canSend ? "send" : canQueue && !command ? "queueMessage" : undefined;
    if (!type) return;
    const all = typedPath === undefined || picked.includes(typedPath) ? picked : [...picked, typedPath];
    const mentions = pickedInText(all, text);
    // [>]: Only a send replaces: a queued message waits behind a reply, which ended the replacing state.
    post(type === "send" && replaces !== undefined ? { type, text, mentions, replaces } : { type, text, mentions });
    if (type === "send" && replaces !== undefined) sentReplacement();
    clear();
  };

  // [>]: The host takes the message out and returns its text, so a message sent meanwhile never lands in the box too.
  // The user asked to edit it, and the row they clicked goes: the message box takes the focus now.
  const edit = (message: QueuedMessage) => {
    post({ type: "editQueued", id: message.id });
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // [!]: An empty box hands ⌘Enter and ⌘Backspace to the decision keys (`useDecisionKeys`) while a request is
    // open; otherwise ⌘Enter sends, as Enter does.
    if (state.approval && decisionKey(event.nativeEvent, event.currentTarget)) return;
    const pressed = {
      key: event.key,
      shift: event.shiftKey,
      alt: event.altKey,
      control: event.ctrlKey,
      meta: event.metaKey,
      composing: event.nativeEvent.isComposing,
    };
    // [!]: The selection is read from the box itself: a caret set by `setSelectionRange` fires no `onSelect`.
    const { selectionStart, selectionEnd } = event.currentTarget;
    const { conversationId, entries } = state;
    const box = { text, selectionStart, selectionEnd, conversationId, entries, recalled, replying };
    const action = composerKeyAction(pressed, rows, box);
    if (action.type === "none") return;
    event.preventDefault();
    event.stopPropagation();
    switch (action.type) {
      case "move":
        setHighlighted((current) => moveHighlight(current, action.step, rows ?? 0));
        return;
      case "pick": {
        // [>]: The path typed whole is what the row would insert: Enter sends it, as it would without the menu.
        const row = mentionMenu?.items[highlighted];
        if (event.key === "Enter" && row && token && pickKeepsToken(row, token)) return send(mentionPick(row).picked);
        return pick(highlighted);
      }
      case "dismiss":
        return setDismissed(token);
      case "send":
        return send();
      case "stop":
        return post({ type: "stop" });
      case "recall":
        setDraft(action.draft);
        setRecalled(action.place);
        // [>]: A text ending on a `/` or `@` token opens no menu, so the next ArrowUp still recalls.
        setDismissed(menuToken(action.draft.text, action.draft.caret, action.draft.picked));
        return;
      case "keep":
        return;
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
            ready ? l10n.t("Describe a task. @ attaches a file, / runs a command.") : l10n.t("Choose a model to start.")
          }
          aria-label={l10n.t("Message")}
          aria-autocomplete="list"
          aria-controls={menuId}
          aria-activedescendant={menuId && rows ? optionId(menuId, highlighted) : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
          }}
          onSelect={(event) => {
            // [!]: React's `onSelect` also fires on keydown, after the key handler, with the selection the key found.
            // A draft set by that key (a pick, a recall) waits for its caret: the stale one would close the token.
            if (nextCaret.current === undefined) setCaret(event.currentTarget.selectionStart);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
        />
        {/* [!]: After the message box, so Shift+Tab from it still reaches an open request's controls first. */}
        <ModeSelect mode={state.mode} disabled={replying || state.modePending} hintId={MODE_HINT_ID} />
        {state.model !== undefined && <EffortSelect state={state} replying={replying} />}
        {/* [>]: During a reply Send queues, so it stays beside Stop, secondary: Stop is the region's primary button. */}
        <button
          type="button"
          className={replying ? "secondary" : undefined}
          disabled={!(canSend || canQueue) || text.trim() === "" || blocked(text)}
          onClick={() => send()}
        >
          {l10n.t("Send")}
        </button>
        {replying && (
          <button
            type="button"
            title={l10n.t("Stop (Escape)")}
            aria-keyshortcuts="Escape"
            onClick={() => post({ type: "stop" })}
          >
            {l10n.t("Stop")}
          </button>
        )}
        <ModeHint mode={state.mode} id={MODE_HINT_ID} />
      </footer>
      {state.queue.length > 0 && <QueuedMessages state={state} canSend={canSend && !contextFull} edit={edit} />}
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
          {l10n.t(
            "The queue is paused: it moves on only after a turn that completes. Send now sends the next message.",
          )}
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

/** What each mode does to the next turn, in the selector's tooltip and, away from Ask, in a line under it. */
function describeMode(mode: Mode): string {
  switch (mode) {
    case "ask":
      return l10n.t("Each change waits for Accept or Reject.");
    case "autoEdit":
      return l10n.t("Changes are written without asking. Commands still wait for Run.");
    case "plan":
      return l10n.t("The agent reads files and answers with a plan. It changes no file and runs no command.");
  }
}

const MODE_HINT_ID = "mode-hint";

/**
 * The line under the composer that says what Auto-edit or Plan does, so a mode that writes without asking, or never
 * writes, is never only a word in a selector. Nothing in Ask, the default, where each change asks anyway.
 */
function ModeHint({ mode, id }: { mode: Mode; id: string }) {
  if (mode === "ask") return null;
  return (
    <p className="mode-hint" id={id}>
      {describeMode(mode)}
    </p>
  );
}

/**
 * Ask, Auto-edit, or Plan, as the host reads them: Plan from the workspace, the others from the setting. Controlled by
 * the state, so a pick shows only once the host has applied it; a failed write leaves the mode as it was.
 */
function ModeSelect({ mode, disabled, hintId }: { mode: Mode; disabled: boolean; hintId: string }) {
  const labels: Record<Mode, string> = { ask: l10n.t("Ask"), autoEdit: l10n.t("Auto-edit"), plan: l10n.t("Plan") };
  return (
    <select
      className="mode"
      aria-label={l10n.t("Mode")}
      aria-describedby={mode === "ask" ? undefined : hintId}
      title={describeMode(mode)}
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
