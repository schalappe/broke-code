/**
 * @module commitMessage
 * The generated commit message: the request (its system prompt, the staged diff cut to the model's context threshold),
 * the cleaning of the reply before it goes to the commit input box, and `CommitMessageGenerator`, the
 * `broke-code.generateCommitMessage` command over its ports (git, provider request, user interface). No `vscode` import.
 */
import type { ChatMessage, ChatOutcome, ProviderAccess, StreamChatOptions } from "./client";
import { fillsContext } from "./limits";
import type { Translator } from "./modelList";
import { describeProviderError, type ErrorText } from "./providerError";

export const COMMIT_MESSAGE_PROMPT = [
  "You write git commit messages. The user's message is the staged diff of a git repository.",
  "Answer with the commit message only, nothing before or after it, and never wrap it in a code block or quotes.",
  "Write it in English and follow Conventional Commits:",
  "- A subject line `<type>(<optional scope>): <description>`, type one of feat, fix, docs, style, refactor, perf, test, build, ci, chore, or revert, in the imperative mood, without a final period, at most 72 characters.",
  "- When the change needs it, a blank line, then a body saying why the change was made, wrapped at 72 characters.",
].join("\n");

/** Ends the diff the model receives when it was cut. Model-facing, so English, never localized. */
export const CUT_NOTICE =
  "[The staged diff was cut here to fit the model's context; the changes after this point are not shown.]";

/**
 * The request for a commit message: `messages` to send, `partial` when the diff was cut. `contextTooSmall` when the
 * model's context cannot hold the system prompt and any of the diff.
 */
export type CommitRequest = { kind: "ok"; messages: ChatMessage[]; partial: boolean } | { kind: "contextTooSmall" };

/**
 * The request for `diff` (a `git diff --cached`) under a model context of `contextSize` tokens. Its estimate
 * (`estimateTokens`) stays within the chat's threshold (`fillsContext`): for 32,768 tokens, 28,672 tokens, so 114,688
 * characters for the system prompt and the diff together. A diff over that is cut between files, on the lines starting
 * with `diff --git `: whole files in order while they fit. When the first file alone exceeds the room, it is cut to
 * it, between characters. A cut diff ends with `CUT_NOTICE`.
 */
export function composeCommitRequest(diff: string, contextSize: number): CommitRequest {
  const budget = largestFittingCharacters(contextSize);
  const room = budget - COMMIT_MESSAGE_PROMPT.length;
  if (diff.length <= room) return { kind: "ok", messages: messagesOf(diff), partial: false };

  const cutRoom = room - `\n\n${CUT_NOTICE}`.length;
  if (cutRoom <= 0) return { kind: "contextTooSmall" };
  const files = splitFiles(diff);
  let kept = "";
  for (const file of files) {
    if (kept.length + file.length > cutRoom) break;
    kept += file;
  }
  if (kept === "") kept = cutText(files[0] ?? "", cutRoom);
  const content = `${kept.replace(/\n+$/, "")}\n\n${CUT_NOTICE}`;
  return { kind: "ok", messages: messagesOf(content), partial: true };
}

/** Most characters a request may hold under `fillsContext`: every character counts a quarter token, rounded up. */
function largestFittingCharacters(contextSize: number): number {
  const tokens = Math.floor((contextSize * 7) / 8);
  // [>]: Ties the arithmetic to the chat's rule, so a change to `fillsContext` cannot silently pass this budget.
  return fillsContext(tokens, contextSize) ? 0 : tokens * 4;
}

function messagesOf(diff: string): ChatMessage[] {
  return [
    { role: "system", content: COMMIT_MESSAGE_PROMPT },
    { role: "user", content: diff },
  ];
}

/** `diff` split before each line starting with `diff --git `; text before the first such line is its own part. */
function splitFiles(diff: string): string[] {
  return diff.split(/(?=^diff --git )/m).filter((part) => part !== "");
}

/** The start of `text` within `room` UTF-16 units, never ending on the first half of a surrogate pair. */
function cutText(text: string, room: number): string {
  if (text.length <= room) return text;
  const slice = text.slice(0, room);
  const last = slice.charCodeAt(slice.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? slice.slice(0, -1) : slice;
}

/** Quote pairs that may wrap a whole reply. */
const QUOTES: readonly [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["`", "`"],
];

/**
 * The commit message in `reply` (the answer, reasoning already dropped by the client): any `<think>` text dropped
 * (one never closed, to the end), a code fence or a pair of quotes wrapping the whole of it removed, trimmed.
 * `undefined` when nothing is left.
 */
export function cleanCommitMessage(reply: string): string | undefined {
  let text = reply
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
    .trim();
  const fenced = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1$/.exec(text);
  if (fenced && !fenced[2]!.includes(fenced[1]!)) text = fenced[2]!.trim();
  const quotes = QUOTES.find(([open, close]) => text.length >= 2 && text.startsWith(open) && text.endsWith(close));
  if (quotes) {
    const inner = text.slice(1, -1);
    if (!inner.includes(quotes[0]) && !inner.includes(quotes[1])) text = inner.trim();
  }
  return text === "" ? undefined : text;
}

/**
 * A git repository as the command uses it. `root`: its root folder's path, which tells two repositories apart.
 * `name`: the root folder's name, for messages. The input box is the Source Control view's commit message box.
 * `stagedDiff`: the staged changes as `git diff --cached` prints them.
 */
export type CommitRepository = {
  root: string;
  name: string;
  readInputBox(): string;
  writeInputBox(message: string): void;
  stagedDiff(): Promise<string>;
};

/**
 * The repository a run works on, or why there is none: the Git extension is missing or did not start
 * (`gitUnavailable`), the Git extension runs without git, turned off by `git.enabled` or not found (`gitDisabled`), no repository is open (`noRepository`), or the user dismissed
 * the repository pick (`dismissed`, which says nothing).
 */
export type RepositoryLookup =
  | { kind: "found"; repository: CommitRepository }
  | { kind: "gitUnavailable" }
  | { kind: "gitDisabled" }
  | { kind: "noRepository" }
  | { kind: "dismissed" };

/** The provider and model selected in the chat, and that model's context size in tokens. */
export type CommitSelection = { access: ProviderAccess; model: string; contextSize: number };

/**
 * What the command needs from the host. `selection`: the chat's provider and model, `undefined` when either is not
 * chosen. `stream`: `streamChat`. `confirmReplace`: asks whether to replace the text in the input box, true to replace.
 * `withProgress`: runs `task` under a cancellable progress notification, whose Cancel aborts the signal it gets.
 * `showError` and `showWarning`: native notifications.
 */
export type CommitMessagePorts = {
  selection(): Promise<CommitSelection | undefined>;
  stream(access: ProviderAccess, options: StreamChatOptions): Promise<ChatOutcome>;
  confirmReplace(repository: CommitRepository): Promise<boolean>;
  withProgress<T>(task: (cancelled: AbortSignal) => Promise<T>): Promise<T>;
  showError(text: ErrorText): void;
  showWarning(message: string): void;
};

/** How a run's request ended, inside the progress notification. */
type RequestResult =
  | { kind: "written"; partial: boolean }
  | { kind: "stopped" }
  | { kind: "nothingStaged" }
  | { kind: "error"; text: ErrorText };

/**
 * The `broke-code.generateCommitMessage` command. A run finds its repository, asks before replacing text in its input
 * box, reads the staged diff, sends one streaming request to the chat's provider and model, and writes the cleaned
 * reply to the box once, when the reply has ended, asking again when the user changed the box meanwhile. Each failure is a notification and writes nothing. One run per
 * repository at a time; `dispose` (deactivation) aborts every run, which then writes nothing. Never stages, commits,
 * or pushes, and touches no conversation.
 */
export class CommitMessageGenerator {
  /** Runs in flight, by repository root. */
  private readonly running = new Map<string, AbortController>();
  private disposed = false;

  /** @param l10n - Translates the messages: `vscode.l10n` in the host. */
  constructor(
    private readonly ports: CommitMessagePorts,
    private readonly l10n: Translator,
  ) {}

  /** One run on the repository `lookup` finds. Never rejects: an unexpected failure is logged and shown. */
  async run(lookup: () => Promise<RepositoryLookup>): Promise<void> {
    if (this.disposed) return;
    const { l10n } = this;
    let found: RepositoryLookup;
    try {
      found = await lookup();
    } catch (error) {
      this.showUnexpected(error);
      return;
    }
    if (this.disposed) return;
    if (found.kind !== "found") {
      this.showLookupFailure(found);
      return;
    }
    const { repository } = found;
    if (this.running.has(repository.root)) {
      this.ports.showError({
        message: l10n.t("A commit message is already being generated for {0}.", repository.name),
      });
      return;
    }
    const run = new AbortController();
    this.running.set(repository.root, run);
    try {
      await this.runOn(repository, run.signal);
    } catch (error) {
      this.showUnexpected(error);
    } finally {
      this.running.delete(repository.root);
    }
  }

  /** Deactivation: abort every run; none writes after this, and later runs do nothing. */
  dispose(): void {
    this.disposed = true;
    for (const run of this.running.values()) run.abort();
  }

  private async runOn(repository: CommitRepository, stopped: AbortSignal): Promise<void> {
    const { l10n, ports } = this;
    if (repository.readInputBox().trim() !== "" && !(await ports.confirmReplace(repository))) return;
    if (stopped.aborted) return;
    // [>]: The text the user agreed to replace, or the empty box; any other text found before the write is asked about.
    const agreed = repository.readInputBox();
    const selection = await ports.selection();
    if (stopped.aborted) return;
    if (!selection) {
      ports.showError({ message: l10n.t("Choose a provider and a model in the broke-code chat first.") });
      return;
    }
    const result = await ports.withProgress((cancelled) =>
      this.request(repository, selection, agreed, AbortSignal.any([stopped, cancelled])),
    );
    switch (result.kind) {
      case "written":
        if (result.partial) {
          ports.showWarning(
            l10n.t(
              "The commit message covers only part of the staged changes: the diff did not fit the model's context.",
            ),
          );
        }
        return;
      case "stopped":
        return;
      case "nothingStaged":
        ports.showError({
          message: l10n.t("Nothing is staged in {0}. Stage the changes to describe first.", repository.name),
        });
        return;
      case "error":
        ports.showError(result.text);
        return;
    }
  }

  /**
   * Read the diff, send the request, and write the message, unless `signal` aborts first. When the box no longer holds
   * `agreed`, the text the run was allowed to replace, the replace question is asked again; a refusal writes nothing.
   */
  private async request(
    repository: CommitRepository,
    selection: CommitSelection,
    agreed: string,
    signal: AbortSignal,
  ): Promise<RequestResult> {
    const { l10n } = this;
    let diff: string;
    try {
      diff = await repository.stagedDiff();
    } catch (error) {
      return {
        kind: "error",
        text: {
          message: l10n.t("The staged changes of {0} could not be read.", repository.name),
          detail: String(error),
        },
      };
    }
    if (signal.aborted) return { kind: "stopped" };
    if (diff.trim() === "") return { kind: "nothingStaged" };
    const request = composeCommitRequest(diff, selection.contextSize);
    if (request.kind === "contextTooSmall") {
      return {
        kind: "error",
        text: {
          message: l10n.t(
            "The context size of {0} is too small for a commit message request. Set a larger one in brokeCode.contextSizes.",
            selection.model,
          ),
        },
      };
    }
    let reply = "";
    const outcome = await this.ports.stream(selection.access, {
      model: selection.model,
      messages: request.messages,
      signal,
      onContent: (text) => {
        reply += text;
      },
      // [>]: Reasoning never reaches the message.
      onReasoning: () => {},
    });
    if (signal.aborted || outcome.status === "stopped") return { kind: "stopped" };
    if (outcome.status === "failed") return { kind: "error", text: describeProviderError(outcome.error, l10n) };
    const message = cleanCommitMessage(reply);
    if (message === undefined) {
      return { kind: "error", text: { message: l10n.t("The model's reply held no commit message.") } };
    }
    if (repository.readInputBox() !== agreed) {
      const replace = await this.ports.confirmReplace(repository);
      if (!replace || signal.aborted) return { kind: "stopped" };
    }
    repository.writeInputBox(message);
    return { kind: "written", partial: request.partial };
  }

  private showLookupFailure(lookup: Exclude<RepositoryLookup, { kind: "found" }>): void {
    const { l10n, ports } = this;
    switch (lookup.kind) {
      case "dismissed":
        return;
      case "noRepository":
        ports.showError({ message: l10n.t("No git repository is open in this window.") });
        return;
      case "gitUnavailable":
        ports.showError({
          message: l10n.t("The Git extension is not available. Check that the built-in Git extension is enabled."),
        });
        return;
      case "gitDisabled":
        ports.showError({
          message: l10n.t(
            "The Git extension is disabled: git is turned off in the settings (git.enabled), or git was not found.",
          ),
        });
        return;
    }
  }

  private showUnexpected(error: unknown): void {
    console.error("broke-code: could not generate the commit message", error);
    this.ports.showError({ message: this.l10n.t("Could not generate the commit message."), detail: String(error) });
  }
}
