/**
 * @module editSelection
 * "Edit selection": the request (its system prompt, the lines around the selection cut to the model's context
 * threshold), the cleaning of the reply into the text that replaces the selection, and `SelectionEditor`, the
 * `broke-code.editSelection` command over its ports (provider request, documents, diff, user interface). No `vscode`
 * import.
 */
import { basename, relative, sep } from "node:path";
import {
  type ChatMessage,
  type ChatModel,
  type ChatOutcome,
  lateReasoning,
  type ProviderAccess,
  type StreamChatOptions,
} from "./client";
import { charactersOf, largestFittingCharacters } from "./limits";
import type { Translator } from "./modelList";
import { describeProviderError, type ErrorText } from "./providerError";
import type { ProviderSupport } from "./providerSupport";
import { isInside, type WorkspaceRoot } from "./workspaceFiles";

export const EDIT_SELECTION_PROMPT = [
  "You rewrite a selection of code as the user's instruction asks.",
  "The user's message gives the file's path and language, the lines before the selection, the selection, the lines after it, and the instruction.",
  "The lines before and after the selection are read-only context: never repeat them and never change them. When the selection starts or ends inside a line, the rest of that line is the last line before it or the first line after it.",
  "Answer with the rewritten selection only: no explanation, no code fence, nothing before or after it.",
].join("\n");

/** Starts the lines before the selection when earlier lines were left out. Model-facing, so English, never localized. */
export const EARLIER_NOT_SHOWN = "[Earlier lines of the file are not shown.]";
/** Ends the lines after the selection when later lines were left out. Model-facing, so English, never localized. */
export const LATER_NOT_SHOWN = "[Later lines of the file are not shown.]";

const CONTEXT_LABEL = "read-only context, never part of the answer";

/**
 * The document a run edits, as it was when the command ran. `uri`: the document's URI, which tells two documents apart.
 * `name`: its file name, for the diff's title and the messages. `path`: its name in the request, the path relative to
 * its workspace folder, the file name outside a workspace, `untitled` for an untitled document (`requestPath`).
 * `eol`: the document's line break. `text`: its whole text. `start` and `end`: the primary selection's offsets in
 * `text`, `start` before `end`.
 */
export type EditDocument = {
  uri: string;
  name: string;
  path: string;
  languageId: string;
  eol: "\n" | "\r\n";
  text: string;
  start: number;
  end: number;
};

/** The request to send, or `tooLarge` when its fixed part alone exceeds the model's threshold. */
export type EditRequest = { kind: "ok"; messages: ChatMessage[] } | { kind: "tooLarge" };

/**
 * The request for `document`'s selection and `instruction`, under a model context of `contextSize` tokens at `ratio`
 * characters per token. It fits the chat's threshold (`largestFittingCharacters`). The fixed part is the whole request
 * without any context line but with both notices (`EARLIER_NOT_SHOWN`, `LATER_NOT_SHOWN`); the room is the threshold
 * minus it, and a negative room is `tooLarge`. Each side gets half the room and takes whole lines, nearest the
 * selection first, while the next line with its line break fits its share; what both left is then offered line by
 * line to the lines before, then to the lines after. A side that does not reach the document's start or end carries
 * its notice. Line breaks are sent as LF.
 */
export function composeEditRequest(
  document: EditDocument,
  instruction: string,
  contextSize: number,
  ratio: number,
): EditRequest {
  const { before, selection, after } = splitAroundSelection(document);
  const compose = (shownBefore: string[], shownAfter: string[], earlier: boolean, later: boolean) =>
    composeMessages(document, selection, instruction, {
      before: earlier ? [EARLIER_NOT_SHOWN, ...shownBefore] : shownBefore,
      after: later ? [...shownAfter, LATER_NOT_SHOWN] : shownAfter,
    });
  const fixed = charactersOf(compose([], [], true, true));
  const room = largestFittingCharacters(contextSize, ratio) - fixed;
  if (room < 0) return { kind: "tooLarge" };

  // [>]: Nearest the selection first: the lines before are walked from their end.
  const nearestBefore = [...before].reverse();
  const half = Math.floor(room / 2);
  const takenBefore = takeLines(nearestBefore, 0, half);
  const takenAfter = takeLines(after, 0, room - half);
  let left = room - takenBefore.used - takenAfter.used;
  const moreBefore = takeLines(nearestBefore, takenBefore.count, left);
  left -= moreBefore.used;
  const moreAfter = takeLines(after, takenAfter.count, left);

  const beforeCount = takenBefore.count + moreBefore.count;
  const afterCount = takenAfter.count + moreAfter.count;
  const shownBefore = before.slice(before.length - beforeCount);
  const shownAfter = after.slice(0, afterCount);
  return {
    kind: "ok",
    messages: compose(shownBefore, shownAfter, beforeCount < before.length, afterCount < after.length),
  };
}

/** How many of `lines` from `from` on fit `room`, each with its line break, and the characters they use. */
function takeLines(lines: readonly string[], from: number, room: number): { count: number; used: number } {
  let used = 0;
  let index = from;
  while (index < lines.length && used + lines[index]!.length + 1 <= room) {
    used += lines[index]!.length + 1;
    index++;
  }
  return { count: index - from, used };
}

/**
 * The lines before the selection, the selection, and the lines after it, line breaks as LF. A selection starting
 * inside a line makes that line's start the last line before it; one ending inside a line makes that line's rest the
 * first line after it. The empty line after the document's last line break is not a line.
 */
function splitAroundSelection(document: EditDocument): { before: string[]; selection: string; after: string[] } {
  const { text, start, end } = document;
  const before = toLf(text.slice(0, start)).split("\n");
  if (before.at(-1) === "") before.pop();
  const after = toLf(text.slice(end)).split("\n");
  if (after.at(-1) === "") after.pop();
  const endsAtLineStart = end === 0 || text[end - 1] === "\n";
  if (!endsAtLineStart && after[0] === "") after.shift();
  return { before, selection: toLf(text.slice(start, end)), after };
}

function composeMessages(
  document: EditDocument,
  selection: string,
  instruction: string,
  context: { before: string[]; after: string[] },
): ChatMessage[] {
  const user = [
    `File: ${document.path}`,
    `Language: ${document.languageId}`,
    "",
    `Lines before the selection, ${CONTEXT_LABEL}:`,
    "<before>",
    ...context.before,
    "</before>",
    "",
    "The selection to rewrite:",
    "<selection>",
    // [>]: Its closing tag starts the next line; the trailing line break the selection may have is restored after.
    selection.replace(/\n$/, ""),
    "</selection>",
    "",
    `Lines after the selection, ${CONTEXT_LABEL}:`,
    "<after>",
    ...context.after,
    "</after>",
    "",
    "Instruction:",
    instruction,
  ].join("\n");
  return [
    { role: "system", content: EDIT_SELECTION_PROMPT },
    { role: "user", content: user },
  ];
}

/**
 * What the cleaning needs of the selection a reply replaces: its text as the document holds it, whether it starts
 * inside a line, the document's line break, and whether the document is Markdown, where no fence is unwrapped.
 */
export type EditedSelection = { selection: string; startsInsideLine: boolean; eol: "\n" | "\r\n"; markdown: boolean };

/** A fence line: at most three spaces, then three backticks. */
const FENCE_LINE = /^ {0,3}```/;

/**
 * The text that replaces the selection, from the model's `reply`; `undefined` when nothing is left.
 * 1. A leading `<think>` block is dropped, then late reasoning up to a bare `</think>` line (`lateReasoning`); the same
 *    characters further down are code and stay.
 * 2. Outside Markdown, when the text holds exactly one closed fenced block opening on its first non-blank line or
 *    closing on its last one (a whole-reply fence, or prose on one side), the block's content is taken; otherwise
 *    the whole text (two blocks, an unclosed fence, a block in the middle of the code).
 * 3. Leading and trailing blank lines are dropped.
 * 4. The common leading whitespace of the reply's non-blank lines is replaced by the selection's, as the same
 *    characters. When the selection starts inside a line, both first lines are left out of either common whitespace
 *    and the reply's first line is kept as it is. A selection with no line to measure leaves the reply's indentation
 *    as it is.
 * 5. Line breaks become the document's; the result ends with one exactly when the selection did.
 */
export function cleanEditReply(reply: string, edited: EditedSelection): string | undefined {
  const withoutThink = toLf(reply).replace(/^\s*<think>[\s\S]*?<\/think>/, "");
  const answer = lateReasoning(withoutThink)?.answer ?? withoutThink;
  const lines = trimBlankLines(edited.markdown ? answer.split("\n") : unfenced(answer.split("\n")));
  if (lines.length === 0) return undefined;
  const rebased = rebase(lines, toLf(edited.selection).split("\n"), edited.startsInsideLine);
  const ending = /\n$/.test(edited.selection) ? edited.eol : "";
  return rebased.join(edited.eol) + ending;
}

/** The content of the one fenced block that opens on the first non-blank line or closes on the last; else `lines`. */
function unfenced(lines: string[]): string[] {
  const fences = lines.flatMap((line, index) => (FENCE_LINE.test(line) ? [index] : []));
  if (fences.length !== 2) return lines;
  const [open, close] = fences as [number, number];
  const visible = lines.flatMap((line, index) => (isBlank(line) ? [] : [index]));
  const opensFirst = open === visible[0];
  const closesLast = close === visible.at(-1);
  return opensFirst || closesLast ? lines.slice(open + 1, close) : lines;
}

function trimBlankLines(lines: string[]): string[] {
  const first = lines.findIndex((line) => !isBlank(line));
  if (first === -1) return [];
  const last = lines.findLastIndex((line) => !isBlank(line));
  return lines.slice(first, last + 1);
}

/** `lines` with their common indentation replaced by the selection's (see `cleanEditReply`, step 4). */
function rebase(lines: string[], selection: string[], startsInsideLine: boolean): string[] {
  const skip = startsInsideLine ? 1 : 0;
  const target = commonIndentation(selection.slice(skip));
  const current = commonIndentation(lines.slice(skip));
  if (target === undefined || current === undefined) return lines;
  return lines.map((line, index) => (index < skip || isBlank(line) ? line : target + line.slice(current.length)));
}

/** The leading whitespace all non-blank `lines` share; `undefined` when none is non-blank. */
function commonIndentation(lines: readonly string[]): string | undefined {
  let common: string | undefined;
  for (const line of lines) {
    if (isBlank(line)) continue;
    const indentation = /^[ \t]*/.exec(line)![0];
    if (common === undefined) {
      common = indentation;
      continue;
    }
    let length = 0;
    while (length < common.length && length < indentation.length && common[length] === indentation[length]) length++;
    common = common.slice(0, length);
  }
  return common;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * A document's name in the request: `untitled` for an untitled document; for a file, its path relative to the deepest
 * of `roots` that holds it, with `/` separators and no folder name, or its file name outside every root.
 */
export function requestPath(scheme: string, path: string, roots: readonly WorkspaceRoot[]): string {
  if (scheme === "untitled") return "untitled";
  const root = roots
    .filter((candidate) => isInside(candidate.path, path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const rest = root ? relative(root.path, path).split(sep).join("/") : "";
  return rest === "" ? basename(path) : rest;
}

/** The URI scheme of both sides of an edit's diff, not the approval diffs' (`CHANGE_SCHEME`). */
export const EDIT_SCHEME = "broke-code-edit";

/** The URI schemes a run edits in. */
const EDITABLE_SCHEMES: ReadonlySet<string> = new Set(["file", "untitled"]);

/**
 * The active editor as the host reads it when the command runs: its document's scheme, whether that document can be
 * written (its file system is writable and its permissions are not read-only; true for an untitled document), and
 * the document with its primary selection. `undefined` without an active text editor.
 */
export type EditorState = { scheme: string; writable: boolean; document: EditDocument };

/**
 * The edited document as it is now. `text`: its whole text, read synchronously. `replace`: replaces the text between
 * two offsets in one edit of the document, never of the file on disk and without saving, and resolves to whether
 * VS Code applied it.
 */
export type LiveDocument = {
  text(): string;
  replace(start: number, end: number, text: string): PromiseLike<boolean>;
};

/**
 * What the command needs from the host. `chatModel`: the chat's provider and model, `undefined` when either is not
 * chosen. `stream`: `streamChat`. `providerSupport`: the memory the chat's requests share; the context is cut at the
 * model's ratio there, and a reply's usage teaches that ratio to the chat. `withProgress`: runs `task` under a
 * cancellable progress notification, whose Cancel aborts the signal it gets. `showDiff`: opens the diff of
 * `document`'s text, left, and `proposed`, right, both read-only, and resolves to its id, which `accept`, `reject`,
 * and `diffClosed` receive. `closeDiff` closes that diff's tab when it is open; `closeAllDiffs` every such tab,
 * including those a crashed host left. `openDocument`: the document now, opened again from its URI for a closed file;
 * `undefined` when it no longer exists (a closed untitled document, a deleted file). `showError`: a notification.
 */
export type SelectionEditPorts = {
  chatModel(): Promise<ChatModel | undefined>;
  stream(access: ProviderAccess, options: StreamChatOptions): Promise<ChatOutcome>;
  providerSupport: ProviderSupport;
  withProgress<T>(task: (cancelled: AbortSignal) => Promise<T>): Promise<T>;
  showDiff(document: EditDocument, proposed: string): Promise<string>;
  closeDiff(id: string): Promise<void>;
  closeAllDiffs(): Promise<void>;
  openDocument(document: EditDocument): Promise<LiveDocument | undefined>;
  showError(text: ErrorText): void;
};

/** A run: its abort, and once its diff shows, the diff's id and the text that replaces the selection. */
type Run = { document: EditDocument; stop: AbortController; diff?: { id: string; replacement: string } };

/** How a run's request ended, inside the progress notification. */
type RequestResult = { kind: "reply"; text: string } | { kind: "stopped" } | { kind: "error"; text: ErrorText };

/**
 * The `broke-code.editSelection` command. A run checks the active editor's selection and document, that no run is in
 * progress on that document, and the chat's provider and model; then it asks the caller's instruction, checks the
 * budget, sends one streaming request, cleans the reply, and shows it as a diff. The run lasts until Accept
 * (`accept`), Reject (`reject`), the diff's tab closing (`diffClosed`), Cancel, or an error; one run per document.
 * Accept applies one edit to the document, only when the range sent still holds the text sent. `dispose`
 * (deactivation) aborts every request and closes the diffs. Touches no conversation.
 */
export class SelectionEditor {
  /** Runs in progress, by document URI. */
  private readonly runs = new Map<string, Run>();
  /** Runs whose diff shows, by diff id. */
  private readonly diffs = new Map<string, Run>();
  private disposed = false;

  /** @param l10n - Translates the messages: `vscode.l10n` in the host. */
  constructor(
    private readonly ports: SelectionEditPorts,
    private readonly l10n: Translator,
  ) {}

  /**
   * One run on the editor `lookup` reads, with the instruction `instruction` gives once the checks pass: the input
   * box of the command, `undefined` or blank to end the run with nothing sent. Never rejects: an unexpected failure is
   * logged and shown.
   */
  async run(
    lookup: () => Promise<EditorState | undefined>,
    instruction: (document: EditDocument) => Promise<string | undefined>,
  ): Promise<void> {
    if (this.disposed) return;
    const { l10n, ports } = this;
    let state: EditorState | undefined;
    try {
      state = await lookup();
    } catch (error) {
      this.showUnexpected(error);
      return;
    }
    if (this.disposed) return;
    if (!state || state.document.start >= state.document.end) {
      ports.showError({ message: l10n.t("Select the code to edit first.") });
      return;
    }
    if (!EDITABLE_SCHEMES.has(state.scheme) || !state.writable) {
      ports.showError({
        message: l10n.t("broke-code can edit a selection only in a writable file or an untitled document."),
      });
      return;
    }
    const { document } = state;
    if (this.runs.has(document.uri)) {
      ports.showError({ message: l10n.t("An edit is already in progress for {0}.", document.name) });
      return;
    }
    const run: Run = { document, stop: new AbortController() };
    this.runs.set(document.uri, run);
    try {
      await this.runOn(run, instruction);
    } catch (error) {
      this.showUnexpected(error);
    } finally {
      // [>]: A run whose diff shows lasts until Accept, Reject, or the tab closing.
      if (!run.diff) this.end(run);
    }
  }

  /**
   * Accept on the diff `id`: one edit of the document when the range sent still holds the text sent, else a
   * notification; the diff closes in every case. A diff with no run (left by a crashed host) only closes.
   */
  async accept(id: string): Promise<void> {
    const run = this.diffs.get(id);
    if (!run?.diff) {
      await this.closeDiff(id);
      return;
    }
    const { document, diff } = run;
    this.end(run);
    try {
      const live = await this.ports.openDocument(document);
      const sent = document.text.slice(document.start, document.end);
      // [!]: No await between the comparison and the edit, so nothing can change the document in between.
      if (!live || live.text().slice(document.start, document.end) !== sent) {
        this.ports.showError({ message: this.l10n.t("The text changed since the request. Nothing was edited.") });
      } else if (!(await live.replace(document.start, document.end, diff.replacement))) {
        this.ports.showError({ message: this.l10n.t("The document could not be edited.") });
      }
    } catch (error) {
      this.showUnexpected(error);
    } finally {
      await this.closeDiff(id);
    }
  }

  /** Reject on the diff `id`: ends its run, edits nothing, and closes the diff. */
  async reject(id: string): Promise<void> {
    const run = this.diffs.get(id);
    if (run) this.end(run);
    await this.closeDiff(id);
  }

  /** The tab of the diff `id` closed: a Reject. Called by the host for every such tab, also those the run closed. */
  diffClosed(id: string): void {
    const run = this.diffs.get(id);
    if (run) this.end(run);
  }

  /** Deactivation: abort every request and close every diff; later runs do nothing. */
  dispose(): void {
    this.disposed = true;
    for (const run of this.runs.values()) run.stop.abort();
    this.runs.clear();
    this.diffs.clear();
    void this.ports
      .closeAllDiffs()
      .then(undefined, (error: unknown) => console.error("broke-code: could not close the edit diffs", error));
  }

  private async runOn(run: Run, instruction: (document: EditDocument) => Promise<string | undefined>): Promise<void> {
    const { l10n, ports } = this;
    const { document, stop } = run;
    const model = await ports.chatModel();
    if (stop.signal.aborted) return;
    if (!model) {
      ports.showError({ message: l10n.t("Choose a provider and a model in the broke-code chat first.") });
      return;
    }
    const asked = (await instruction(document))?.trim();
    if (stop.signal.aborted || !asked) return;
    const ratio = ports.providerSupport.ratio(model.access.provider, model.model);
    const request = composeEditRequest(document, asked, model.contextSize, ratio);
    if (request.kind === "tooLarge") {
      ports.showError({ message: l10n.t("The selection does not fit the model's context.") });
      return;
    }
    const result = await ports.withProgress((cancelled) =>
      this.request(model, request.messages, AbortSignal.any([stop.signal, cancelled])),
    );
    if (result.kind === "stopped") return;
    if (result.kind === "error") {
      ports.showError(result.text);
      return;
    }
    const sent = document.text.slice(document.start, document.end);
    const startsInsideLine = document.start > 0 && document.text[document.start - 1] !== "\n";
    const replacement = cleanEditReply(result.text, {
      selection: sent,
      startsInsideLine,
      eol: document.eol,
      markdown: document.languageId === "markdown",
    });
    if (replacement === undefined) {
      ports.showError({ message: l10n.t("The model returned no code.") });
      return;
    }
    const proposed = document.text.slice(0, document.start) + replacement + document.text.slice(document.end);
    const id = await ports.showDiff(document, proposed);
    if (stop.signal.aborted) {
      await this.closeDiff(id);
      return;
    }
    run.diff = { id, replacement };
    this.diffs.set(id, run);
  }

  private async request(model: ChatModel, messages: ChatMessage[], signal: AbortSignal): Promise<RequestResult> {
    let reply = "";
    const outcome = await this.ports.stream(model.access, {
      model: model.model,
      messages,
      signal,
      support: this.ports.providerSupport,
      onContent: (text) => {
        reply += text;
      },
      // [>]: Reasoning never reaches the edit.
      onReasoning: () => {},
    });
    if (signal.aborted || outcome.status === "stopped") return { kind: "stopped" };
    if (outcome.status === "failed") return { kind: "error", text: describeProviderError(outcome.error, this.l10n) };
    return { kind: "reply", text: reply };
  }

  private end(run: Run): void {
    if (this.runs.get(run.document.uri) === run) this.runs.delete(run.document.uri);
    if (run.diff) this.diffs.delete(run.diff.id);
  }

  private async closeDiff(id: string): Promise<void> {
    try {
      await this.ports.closeDiff(id);
    } catch (error) {
      console.error("broke-code: could not close the edit diff", error);
    }
  }

  private showUnexpected(error: unknown): void {
    console.error("broke-code: could not edit the selection", error);
    this.ports.showError({ message: this.l10n.t("Could not edit the selection."), detail: String(error) });
  }
}
