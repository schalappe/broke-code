import * as l10n from "@vscode/l10n";
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type { ConversationSummary } from "../core/conversation";
import {
  type ChatEntry,
  type ChatState,
  type HostMessage,
  isReplying,
  type PendingApproval,
  type ReplyCall,
} from "../core/protocol";
import type { ProviderError } from "../core/providerError";
import { BUILT_IN_COMMANDS, type BuiltInCommand, type SlashCommand, type Suggestion } from "../core/suggestions";
import {
  builtInCommand,
  composerKeyAction,
  type MenuAnswer,
  type MenuToken,
  menuToken,
  menuView,
  openMenuToken,
  pickedInText,
  replaceToken,
  type SkillAnswer,
  type SlashRow,
  slashMenuView,
  slashPick,
} from "./composer";
import { moveHighlight, optionId, SuggestionMenu } from "./SuggestionMenu";
import {
  describeContextUsage,
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
import { post } from "./vscodeApi";

/** `language`: BCP 47 tag of the VS Code display language, for dates. */
export function App({ state, language }: { state: ChatState; language: string }) {
  const configured = state.providers.length > 0;
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <main className="panel">
      {/* Saved conversations are local: History works without a provider; only the composer needs one. */}
      <Header
        state={state}
        language={language}
        historyOpen={historyOpen}
        toggleHistory={() => setHistoryOpen(!historyOpen)}
      />
      {!configured && <EmptyState />}
      <Warnings state={state} />
      {state.model !== undefined && !state.context.known && <ContextNotice model={state.model} />}
      {state.listFailed && <TextBlock text={describeListFailure(state.listFailed)} />}
      {state.storageProblem && <TextBlock text={describeStorageProblem(state.storageProblem)} />}
      {state.models.status === "failed" && (
        <ErrorBlock error={state.models.error} retry={() => post({ type: "retryModels" })} />
      )}
      {historyOpen && <HistoryPanel state={state} language={language} close={() => setHistoryOpen(false)} />}
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
      {(configured || isReplying(state)) && (
        <Composer
          state={state}
          startNewChat={() => {
            setHistoryOpen(false);
            post({ type: "newChat" });
          }}
        />
      )}
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

/**
 * Provider and model pickers (with a provider configured), the context usage of the selected model, New chat, and the
 * History toggle. `language`: BCP 47 tag for the usage numbers.
 */
export function Header({
  state,
  language,
  historyOpen,
  toggleHistory,
}: {
  state: ChatState;
  language: string;
  historyOpen: boolean;
  toggleHistory: () => void;
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

/** Skipped providers, from the settings, then skipped skills, from the last send. */
function Warnings({ state }: { state: ChatState }) {
  if (state.skipped.length === 0 && state.skillWarnings.length === 0) return null;
  return (
    <ul className="warnings" role="status">
      {state.skipped.map((skipped) => (
        <li key={`provider-${skipped.position}`}>{describeSkippedProvider(skipped)}</li>
      ))}
      {state.skillWarnings.map((warning) => (
        <li key={`skill-${warning.path}`}>{describeSkillWarning(warning)}</li>
      ))}
    </ul>
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

  // Follow stream only while user stays at bottom.
  useLayoutEffect(() => {
    if (pinned) end.current?.scrollIntoView({ block: "end" });
  });

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
      {entries.map((entry, index) => (
        <Entry
          // biome-ignore lint/suspicious/noArrayIndexKey: a conversation's entries are only appended; another one remounts the list.
          key={index}
          entry={entry}
          previous={entries[index - 1]}
          next={entries[index + 1]}
          approval={index === entries.length - 1 ? approval : undefined}
        />
      ))}
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
 * last reply), and how the turn ended when it ended here.
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
  const unfinished: PendingCall["outcome"] = deciding
    ? "deciding"
    : inFlight
      ? "running"
      : entry.status === "stopped"
        ? "stopped"
        : "noResult";
  return (
    <div className="message assistant">
      {entry.reasoning !== "" && <Reasoning key="reasoning" entry={entry} />}
      {answer !== "" && <Markdown>{answer}</Markdown>}
      {step ? <ToolStep result={step} /> : call && <ToolStep call={call} outcome={unfinished} />}
      {/* [>]: Keyed by request, so a new request starts with an empty reason. */}
      {deciding && <Approval key={deciding.id} approval={deciding} />}
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
 * failed ones stand out.
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
 * inserts `/<name> `.
 */
function Composer({ state, startNewChat }: { state: ChatState; startNewChat: () => void }) {
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
  const replying = isReplying(state);
  const ready = state.model !== undefined;
  const input = useRef<HTMLTextAreaElement>(null);

  const token = menuToken(text, caret, picked);
  const fileQuery = token?.trigger === "@" ? token.query : undefined;
  const slashQuery = token?.trigger === "/" ? token.query : undefined;
  const slashOpen = slashQuery !== undefined;
  const open = openMenuToken(token, focused, dismissed);
  const mentionMenu = open?.trigger === "@" ? menuView(answer, open.query) : undefined;
  const slashMenu = open?.trigger === "/" ? slashMenuView(builtInRows(), skillAnswer, open.query) : undefined;
  const rows = mentionMenu?.items.length ?? slashMenu?.items.length;
  const menuId = mentionMenu ? MENTION_MENU_ID : slashMenu ? SLASH_MENU_ID : undefined;

  useEffect(() => {
    if (!replying) input.current?.focus();
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

  // [>]: One skill query per opening: a discovery reads every `SKILL.md`, too much per keystroke. Closing bumps the id
  // too, so an answer to an earlier opening is dropped.
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

  useLayoutEffect(() => {
    if (nextCaret.current === undefined) return;
    input.current?.setSelectionRange(nextCaret.current, nextCaret.current);
    nextCaret.current = undefined;
  });

  const canSend = ready && !replying;

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
    const inserted = action ? action.text : item ? `@${item.path} ` : undefined;
    if (!token || inserted === undefined) return;
    const next = replaceToken(text, token, caret, inserted);
    setText(next.text);
    setCaret(next.caret);
    nextCaret.current = next.caret;
    if (item) setPicked((paths) => (paths.includes(item.path) ? paths : [...paths, item.path]));
  };

  const send = () => {
    if (!canSend || text.trim() === "") return;
    const command = builtInCommand(text);
    if (command) return run(command);
    post({ type: "send", text, mentions: pickedInText(picked, text) });
    clear();
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
