# Harness

This file specifies the agent loop: the body tool calls, the tools, the approvals, the history sent to the model, and the context budget. ADR 0001, 0002, 0003, and 0005 in `docs/adr/` record the decisions behind it.

## Body tool calls

- Tool calls are XML tags in the reply text, with argument values written raw. Starting parsing rules: one
  call per reply, calls inside code fences are ignored, a malformed call goes back to the model as a precise
  error, three malformed calls in a row stop the agent turn, and a reply with text but no call is the final answer. An
  empty reply (no text once trimmed, reasoning excluded) is no final answer: it is handled as a malformed call
  (maintainer decision, ADR 0001). Change these rules only on evidence from the eval (local Ollama, or a rented vLLM
  for the employer's models, #58).
- A call may sit inside a wrapper tag, `<tool_call>` or `<tool_code>` (`CALL_WRAPPERS`), as Gemma writes on vLLM: a
  wrapper starting a line outside code, whose content starts (after whitespace) with a known tool's opening tag, is
  that call, its block spanning the wrapper when the wrapper's closing tag follows the call after whitespace; the
  closing tag is optional. A wrapper around anything else stays "not a known tool" (ADR 0001, 2026-11-12).
- A tool result the model wrote itself (`<tool_result` then a space or `>`, starting a line, outside code; never itself
  a call-shaped block, `<tool_result>` included) before the reply's first call-shaped block, or in a reply with no
  call, makes the reply malformed (`forged`): the answer is cut where the result opens, so the chat and the history
  never hold the invented result, and the model gets a message saying only the extension writes results. Accepted
  cost: a final answer that quotes a raw result opening at a line start, outside code, is refused once.
- A known tool's call ends at the `</tool_name>` after its last argument value, not at the first one. A value ends at
  the first `</argument>` that closes no `<argument>` opened inside the value and is followed by nothing but
  whitespace and then another argument tag of the tool or the call's closing tag: an inner `<argument>` …
  `</argument>` pair is kept, so a value can hold a whole example call. When the tags never balance, the value ends
  at the first `</argument>` so followed, pairs ignored; failing that, at the last `</argument>` before the next
  `</tool_name>`. A value may therefore hold `</write_file>`, `</content>`, other tools' tags, and code fences. Known
  cost, kept by maintainer decision: a value holding an unpaired `<argument>` pairs it with the real closing tag, so
  it runs on into the text after the call when that text holds `</argument>` then `</tool_name>`. The parser drops
  one leading and one trailing line break of a value that sits on its own lines (both or neither); an argument marked
  `oneLine` in its `ToolSpec` (each `path`, `cwd`, the `search` pattern, the `load_skill` name) loses every leading
  and trailing line break instead (ADR 0001, 2026-11-10). `write_file` then
  drops every trailing line break of its content (`\n` or `\r\n`) and ends the file with exactly one, of the kind its
  last line break is; content left empty writes an empty file. Accepted cost, by maintainer decision (ADR 0001):
  `write_file` cannot create a file ending with an empty line; `edit_file` can.
- The v1 tools are `read_file`, `list_files`, `search` (ripgrep), `write_file`, `edit_file`, `run_command`,
  and `load_skill`.
- `read_file(path, start_line?, end_line?)` reads a file under the mention caps (binary or over 1 MiB refused whole)
  and shows lines `start_line` to `end_line`, 1-based and inclusive, at most 2,000 of them (#100). Left out,
  `start_line` is 1 and `end_line` the last line; either may come alone, and an `end_line` past the end reads to it.
  Lines are counted as the 2,000-line cut counts them (`\n`, `\r\n`, and `\r` each end one; a final break ends the last
  line, not a new one), each kept with its break as written.
  - A read that shows the whole file is today's mention block, byte for byte: `@<path> (file, N lines)` and the fenced
    text. A read that shows part of it, by its range or by the 2,000-line cut, has the header
    `@<path> (file, lines A-B of T)` (`line A of T` for one line), `A` and `B` the lines shown and `T` the file's
    count. When the cut stopped before the line asked for (`end_line`, or the last line), the result ends with
    `[truncated: N more lines not shown; read on with start_line B+1]`, `N` the lines from `B+1` to that line; a range
    that ended where asked has no notice. Mentions, `list_files`, `search`, `load_skill`, and the reserved mentions
    keep `[truncated: N more lines not shown]`.
  - Errors, as `error` results. Before any read: a value that, trimmed, is not digits only, at least 1, and a safe
    integer (`read_file: start_line "2,001" is not a whole number of 1 or more.`, the value cut like other excerpts);
    `end_line` before `start_line`. After the read: `start_line` past the last line, giving the line count
    (`read_file: big.log: start_line 3001 is past the last line; the file has 3000 lines.`); an empty file reads from
    line 1 as without a range and refuses a later `start_line` with 0 lines. A folder and every refusal of a path
    (missing, outside, binary, over 1 MiB, unreadable) answer as without a range.
  - The chat's step row shows the range after the path as the model wrote it: `big.log 2001-4000`, `big.log 2001-`
    without `end_line`, `big.log 1-50` without `start_line`.
- `edit_file` replaces exact text only, compared byte for byte, line endings included. If the text matches zero
  times or more than once (overlapping matches count), return an error to the model. Never guess the location.

## Write tools, atomic writes, and recorded changes

- The write tools plan a change and never write; the host's applier writes it. The path resolves like a mention, a
  path that exists nowhere going to the first workspace folder that may hold it. The deepest existing folder above
  the file must resolve inside a workspace folder; missing folders are created at apply. The file itself must not
  be a symlink, and an existing one must be a UTF-8 text file within the read caps (binary or over 1 MiB refused, as
  for reads); content over 1 MiB is refused. The applier checks the path again and writes only when the file still
  holds the planned text (already holding the new text is a success, so applying twice is harmless).
- A write is atomic: the file holds its old text or the new one, never a mix or nothing, even after a crash. The new
  text goes to a temporary file `.<name>.broke-code-<random>.tmp` in the target's own folder (at most 226 bytes of
  the file name, cut between characters, so the name fits in 255 bytes), flushed to disk. For an existing file it is
  created readable by its owner only (`0600`); for a new file, with the default bits. A last check then reads the
  target again: its folder must still resolve to the same place inside the workspace, the target must not be a
  symlink, and it must still hold the planned text (or already the new text: a success). Only then does the
  temporary file get the old file's permission bits (`rwx` for owner, group, and others) and take its place:
  `rename(2)` over an existing file, `link(2)` for a new one, which fails rather than replace a file created meanwhile
  (refused as changed since planned). On any failure the file stays byte-identical and the temporary file is
  removed; when that removal fails, the result names the temporary file and its cause. The error result keeps the
  cause ("the file was not written (ENOSPC)"), and folders created for the write stay. Accepted costs: a hard link to the file keeps the old text; its owner, extended attributes, and ACLs
  are not kept; the folder must be writable; a crash before the swap, or a folder renamed during the write, leaves
  the temporary file behind. Residual races, accepted as for reads, since such a writer already runs with the user's
  rights: a write landing between the last read and the rename is overwritten (Node has no compare-and-swap on a
  path), and a missing parent folder swapped for a symlink out after the check makes `mkdir` create an empty folder
  outside before the write is refused.
- A recording applier (`recordingApplier`, opt-in: the extension wraps `fileApplier` in it, inside `approvalApplier`,
  recording into the turn's `ToolContext.changes`; the eval bench's `fileApplier` runs record nothing) wraps another and records each change written, told by the applier's `written` result, never by its
  text: a change that found the file already holding the new text (`alreadyWritten`), and a rejected, refused, or
  failed one, record nothing, since an undo could otherwise revert a change the turn never made, such as the user's
  own identical edit. A file is keyed by the real path of its folder plus its name, as the write resolved it, so two
  spellings of one file are one entry; the entry keeps the text before its first recorded write (or that it did not
  exist) and the text its last recorded write left. The set lives in memory only.
- `RecordedChanges.restore(roots, host)` handles each file on its own, in first-write order, with the workspace folders
  as they are then (their real paths). A file `host.hasUnsavedChanges` reports dirty in an editor is skipped
  (`unsaved`) before anything else. A file that still holds the text the writes left gets its original text back
  through the atomic write above (planned text: the written one), byte for byte, a BOM included, or is removed when
  the writes created it (`removeWorkspaceFile`); folders created for the writes stay. A file that already holds its
  original text, or is already gone when the writes created it, counts as `restored` or `removed`. Anything else is
  `skipped` and untouched: `changed` (other text, missing, a folder, no longer text), `symlink`, `outsideWorkspace`, or
  `failed` with the disk's cause (a technical failure, apart from the refusals). A temporary file the restoring write
  could not remove is named on the outcome (`leftover`). Restored and removed files leave the set; skipped ones stay,
  so a second run retries only them. Each file holds its old text or the written one at every moment, so running
  twice, or again after a crash halfway, damages nothing and reports the same files.
- `removeWorkspaceFile(roots, path, expected)` mirrors the write's last check: the folder resolves inside a workspace
  folder, the target is a regular file and not a symlink, the open handle is that file (device and inode), and it holds
  `expected` byte for byte; then the folder is checked to still lead where it did, and only then is the file unlinked.
  A missing file is `alreadyRemoved`, a success; other text is `changed`; a disk failure is `notRemoved` with its cause;
  the boundary's refusals are as for the write. Each refusal leaves the file as it is. Residual race, accepted as for
  the write: a write landing between the last read and the unlink is lost with the file.

## Workspace boundary

- The file tools (`read_file`, `list_files`, `search`, `write_file`, `edit_file`, and `load_skill`) act inside the open
  workspace only. `run_command` is not confined: its `cwd` must be a workspace folder, but an approved command runs
  with the user's rights and can read, change, or delete anything the user can, outside the workspace too; the
  approval is the only guard. The one exception to the file tools' boundary is read-only access to the directories of
  skills loaded in the current conversation that lie outside the workspace (ADR 0003):
  - A skill is loaded when the conversation holds an `ok` `load_skill` step for its name, or a user entry whose
    `skill` is `loaded` (a `/<name>` message); an `error` step, a step dropped by Stop, a malformed call, and a
    `failed` user skill load nothing. Before each call the controller maps those names to folders through the current
    send's discovery (`ToolContext.skillRoots`, beside `ToolContext.skills`, the send's skills), so a load earlier in
    the turn counts at the next call, a reopened conversation keeps its loaded skills, and a skill gone since is no
    longer readable. The read roots come from the whole record, so a skill loaded before a summary (`/compact`) stays
    readable after it; `ToolContext.sentSkillRoots`, the same mapping over the entries the history sends
    (`sentEntries`: from the last `done` summary on, and the turn's message an automatic summary quotes), decides `load_skill`'s "already loaded" (`docs/spec/skills.md`).
  - `read_file`, `list_files`, and `search` also accept an absolute path inside a loaded skill's real folder, the path
    its load result gives. The shared read boundary (`readWorkspaceEntry`, `locateWorkspacePath`) takes the folders
    as read-only roots. An absolute path written inside one is read as written, never rerouted through a multi-root
    folder name (a folder named `/private` included). For a folder outside the workspace, the path must resolve inside
    the deepest loaded folder that holds it, symlinks resolved, and the open handle must match it by device and
    inode, as for workspace reads. A symlink out of it, into another loaded folder (its outer one included) or the
    workspace, is `outsideWorkspace`. The folder is matched by the real path discovery gave, never resolved again.
    `search` with a `path` in such a folder prints absolute paths.
  - Mentions never get the exception, and the write boundary never takes the read-only roots: a planned write into a
    skill folder outside the workspace is refused `outsideWorkspace`. A workspace skill's folder is ordinary
    workspace (maintainer decision): writable with approval, its symlinks may resolve anywhere in the workspace, and
    `search` prints its paths relative to the workspace.

## Approvals, modes, "Undo changes", and "Changed files"

- Approvals (ADR 0002):
  - Reads run without asking.
  - A tool asks through its run context: `ToolContext.requestApproval(request)` settles with Accept, Reject (with the
    reason typed, trimmed, left out when blank), or Cancel. While the request is open, the reply stays `streaming` and
    `ChatState.approval` holds `{ id, kind, tool, summary }`; the chat renders the step row "waiting for your decision",
    Accept (Run for a command), Reject, and a reason field from that state alone, in one block, and never moves the
    focus when the request opens: from the message box, Shift+Tab reaches Reject, then Accept or Run, then the reason
    field. The webview's `approve { id }` and
    `reject { id, reason? }` are validated like the other messages, and a decision for a request no longer open is
    ignored. One request at a time, since one call runs per reply.
  - A write opens the native VS Code diff editor beside the chat, titled with the path: the planned `before` text on
    the left (empty for a new file), the proposed text on the right, both from a content provider. Accept writes with
    the atomic applier below, never through `WorkspaceEdit`; the diff tab closes on Accept, Reject, and Cancel. Closing
    the tab by hand changes nothing: the request stays open, Accept and Reject still work, and the diff cannot be
    reopened. A file
    open in an editor with unsaved changes is refused before the request and again right before the write, with
    auto-approve too, as an `error` result saying so; a file changed on disk since the plan is refused by the
    applier's planned-text check.
  - A rejection goes back to the model as an `error` tool result: "The user rejected this change." ("The user rejected
    this command." for a command), then the reason on its own line when given. It is a tool step like any other and counts toward the step limit. The step records how it
    was approved (`approval`: `accepted`, `rejected`, or `auto`), and the row says rejected or auto-approved.
  - Stop, New chat, opening another conversation, deleting the one shown, and deactivation cancel the open request:
    the diff tab closes, nothing is written, the reply ends `stopped`. An open request is never saved; a record saved
    while one waits reloads `stopped` by the in-flight rule of `docs/spec/conversations.md`.
  - `run_command` always waits for a click: it asks with a request of kind `command`, its summary the whole command,
    which the step row shows whole, line breaks kept, with the `cwd` when given ("in <cwd>"), Run, and Reject. Nothing runs before Run, and one Run runs
    the command once.
  - `brokeCode.autoApproveWrites` (boolean, default false, `application` scope, read from `globalValue` like the
    providers) accepts writes at once, without a diff, and is read at each write's request. The controller applies it
    to requests of kind `write` only: nothing auto-approves commands.
  - The mode selector shows and writes that setting (#79), and offers Plan (#80, ADR 0005, below). `ChatState.mode` is `ask` (user value false or absent) or
    `autoEdit` (true), read from the user value by `ChatController.modeChanged`, which the host calls at activation
    (the state says `ask` before) and on each change of the setting (the configuration listener), and after each pick. A pick posts `setMode
    { mode }`, validated like the other messages (an unknown mode is dropped); `ChatController.setMode` ignores it while
    a reply is in flight or an earlier pick's settings write is pending, writes nothing when the setting already holds that mode, and otherwise writes the user value
    (`ConfigurationTarget.Global`) through the `writeAutoApproveWrites` port. The selector is controlled by the state,
    so it follows the setting, not the click: a failed write is logged and shown as an error notification, and the
    mode stays the one the setting holds. A user setting: Auto-edit in one window applies to every window. One pick
    at a time: while its settings write is pending, `ChatState.modePending` is true, and the selector and Send are
    disabled (Enter and the built-in `/new`, `/model`, and `/compact` too, through the composer's one "Send would act" check), as
    while a reply is in flight; the controller ignores `setMode` meanwhile and returns a `send`'s text to the box (see
    "Queued messages" in `docs/spec/chat-panel.md`), so no turn starts on a mode about to change. A Plan pick writes no setting and never pends. Navigation (New chat, open, delete) is unaffected.
    The selector is disabled while a reply is in flight or a mode change is being written, like the pickers, and sits after the message box in the DOM, so
    Shift+Tab from the message box still reaches an open request's controls first. The conversation record and the
    eval bench know nothing of the mode; the system prompt knows only Plan.
  - Plan (#80, ADR 0005): `ChatState.mode` is `plan` while the workspace memento key `brokeCode.plan` is `true`, a key
    of its own, since `brokeCode.lastChoice` is rewritten whole and cleared without a provider. The controller reads it
    at construction (restored at each window load, kept across provider changes) and Plan wins over the setting while
    on: a change of the setting elsewhere leaves the selector on Plan. `setMode { mode: "plan" }` writes no setting;
    it sets the key. Leaving Plan for Ask or Auto-edit writes the setting first, only when its value must change, and
    clears the key only once that write succeeded: a failed write keeps Plan and is shown as for the other modes
    (`failed`). A failed memento write is logged only, as for `brokeCode.lastChoice`: Plan applies for the session
    and is lost at the next load. Plan is not part of a conversation: reopening one changes no mode. While leaving Plan
    writes the setting, the mode change is pending as above, and no send or other pick is taken.
  - "Undo changes" (#93, ADR 0002, 2026-11-12): neither the editor's Undo nor Local History sees an accepted write,
    which goes to disk outside the editor, so the chat offers the way back. Each agent turn gets a `RecordedChanges`
    (`ToolContext.changes`, set per call like `requestApproval`); the host's applier records into it. The controller
    holds one turn (`heldTurn`): the latest turn of the conversation shown that wrote a file, the turn becoming held at
    its first recorded write, in place of the one held so far; a turn that writes nothing (Plan, a rejection, reads
    only) leaves the held one as it is. A write lands even after Stop (Stop does not wait for a running write; its
    step is dropped) and is still held while its turn is the latest of the conversation shown (`lastTurn`); New chat,
    opening another conversation, and deleting the one shown (`show`) drop the held turn, its outcome, and `lastTurn`,
    so a write landing after that is not held. Memory only: the original texts are never saved, never in `ChatState`
    (the whole state is posted at each delta), and lost at a window reload. Without the `undo` port (`UndoHost`: the
    workspace roots and the write approval's `hasUnsavedChanges`), as in the eval bench, nothing is held.
    `ChatState.undo` holds, derived at each emit: `reply`, the index in `entries` of the held turn's last reply (the
    entry its turn ended on, summary or not, whatever its status), while it has files left and no reply is in flight;
    `ranCommand`, the user ran one of its commands (Run clicked), which the panel says no undo reverts; `running`; and
    `outcome`, `{ reply, files }`, each `UndoneFile` named as the file index writes it (`workspacePath` over the real
    roots, else the model's spelling). The webview's `undoChanges` is validated like `newChat`; `undoChanges()` ignores
    it while a reply is in flight, while an undo runs, or when no button shows. It clears the outcome, sets `running`,
    and runs in the navigation queue, so New chat, open, and delete asked meanwhile wait for it; `RecordedChanges.restore`
    then runs over the roots as they are, restored and removed files leave the held turn, skipped ones stay for the next
    click, and once none is left the turn is no longer held and the button goes. While it runs, `mayStartTurn` refuses a
    turn (a `send` goes back to the box, `/compact` and the queue wait) and the composer's "Send would act" check is
    false. The outcome is cleared by the next send, the next undo, and a change of the conversation shown. An undo that
    throws despite its contract (a bug) is logged with its stack and shown as an error block under the reply, its
    message as detail (`outcome.error`), with the files restored or removed before it (those that left the set, as
    restored, or removed when the writes created them); the files left stay held, so the button stays and retries
    them, and Send is unlocked. Restore per file, the button for every end status, and skipped files retryable are
    maintainer decisions (#69).
  - Undone steps (#94): each write step is tied, when it is recorded, to the file its write recorded (`onRecord`
    reports the `RecordedFile`; the turn keeps the steps by real path), never by resolving its `path` argument again;
    a write recorded without a step (it landed after Stop) ties none. After the restore, every step of a file that left
    the held turn (restored or removed) gets `undone: true`; a skipped file's steps stay unmarked until a later undo
    puts it back. Only the held turn's steps are marked: an earlier turn's writes to the same file are not. An
    `alreadyWritten` result records nothing and is never marked. The record is then saved, after the restore and
    before the outcome shows, so the mark never claims a change is gone before the file is back; a crash between the
    restore and the save leaves the steps unmarked (accepted: the held turn is memory only, so nothing retries it),
    and marking again is harmless. The step row says "undone" before its status, its line count unchanged (the line
    the model gets is not part of the step's text), also inside a folded turn, whose row counts are unchanged.
  - "Changed files" (#99, ADR 0002, 2026-11-12): the held turn's files, as rows under the reply `ChatState.undo.reply`
    names, so the list shows exactly when "Undo changes" does (never during a reply, never while nothing is held) and
    has no state of its own: it follows the held turn's lifetime above (replaced by a later turn's first write, dropped
    by New chat, open, delete, Retry, Edit's send, and a window reload; after an undo, restored and removed files leave
    it and skipped ones stay). `ChatState.changedFiles` holds one `ChangedFile { path, kind, added, removed }` per file
    still held, in the order of its first write, empty whenever `undo.reply` is absent: `path` as the file index
    writes it (`workspacePath` over the real roots, else the model's spelling, as the undo's outcome names a file),
    `kind` `created` (its original is `undefined`) or `edited`. The rows are named when the held turn records a write
    (`nameRows`: the real roots are async, so not at each emit; a naming overtaken by a later one is dropped) and
    filtered at each emit to the files still held. No file text reaches `ChatState` or the record, and the record is
    unchanged. Plan writes nothing, so it never shows the list; writes made by commands are not listed, and the hint
    under "Undo changes" says "Commands this turn ran are not listed or undone." when the turn ran one.
  - Line counts (`lineDiffCount`, `src/core/lineDiff.ts`): the line diff between the file's text before the turn
    and the text its last recorded write left, never the disk. A line is the text up to and including its line break,
    the last one maybe without, compared byte for byte, so a changed line ending and a changed final line break each
    count as one line removed and one added; a created file is `+N −0`; an empty created file, and a file edited back
    to its first text, are `+0 −0` and still listed. The counts are those of a minimal line diff (Myers' forward pass
    over the lines left after the common first and last lines), computed once per recorded write (cached by
    `RecordedFile` identity), never at each state update. Work bound: `LINE_DIFF_WORK_LIMIT`, 4 million steps (one
    per diagonal visited and per line matched), tens of milliseconds, enough for a minimal diff of up to about 2,800
    changed lines whatever the file's size; two 1 MiB texts can hold a million lines each, which would otherwise take
    minutes. Past it the lines left after the common first and last lines count as all removed and all added: still
    a true diff, no longer the smallest.
  - A row's diff: the webview's `openChangeDiff { path }` carries the row's displayed path, validated as a non-empty
    string within `MAX_MENTION_PATH_LENGTH`; `ChatController.openChangeDiff` opens the first row shown under that path
    through the `changeDiffs` port (`ChangeDiffHost`, beside `UndoHost`) with its file's text before the turn
    (`HeldFileDiff { path, realPath, original }`, `original` `undefined` for a created file), and does nothing for a
    path no longer shown or without the port (tests, the eval bench: the rows still show). The port
    (`TurnDiffs`, `src/core/turnDiffs.ts`, over the editor the host wires in `src/extension/turnDiffs.ts`) opens VS Code's diff editor beside the chat, the focus kept in the panel, titled
    "<path> (changes of this turn)": on the left the text before the turn, read-only, from a content provider on
    `BEFORE_TURN_SCHEME` (empty for a created file); on the right the real file, so it shows what the file holds now,
    unsaved editor changes included, and a hand edit since the turn shows what an undo would skip. A file no longer on
    disk opens no diff: an error notification says so. A diff editor that fails to open is shown as an error
    notification. A row's diff tab lives as long as its row: the controller tells the port to close the diffs of the
    files that left the held turn (put back by an undo, or the turn no longer held), checked at each emit, the one
    place every such change passes; the host closes them by their left side (`closeTurnDiffs`), and closes every one
    at deactivation, so a reloaded window never restores one with an empty left side. A close also cancels an open
    still in flight for that file: one closed during its existence check opens nothing and shows no error, and one
    closed while the diff editor opens closes the tab it opened once it is open, so no tab outlives its row.

## Commands

- The system prompt's `run_command` rule, shown only when the tool is offered, also says that one command covers a
  whole folder tree in one step where `list_files` takes one per folder: Qwen 3.8 on vLLM otherwise walked `logs/`
  folder by folder until the step limit (#120).
- `run_command(command, cwd?)` runs `<shell> -c <command>` in a hidden child process, no login shell, the shell being
  `vscode.env.shell`, else `$SHELL`, else `/bin/sh`. `cwd` resolves like a read tool's path and must be an existing
  folder inside the workspace; left out, the command runs in the first workspace folder. Without a workspace folder,
  an empty command, or a refused `cwd`, the call is an `error` before any approval. The child is spawned `detached`, so
  it leads a process group of its own, with stdin closed (`ignore`, so a read gets end of file at once) and the host's
  environment.
  - The result's first line is `exit code N`, `killed by <signal>`, or `stopped after N seconds`, then a `stdout:` and
    a `stderr:` section (`stdout: (empty)` when nothing came), each cut to its first 2,000 lines and 1 MiB (cut
    between UTF-8 characters) with the mention truncation notice. It is `ok` only on exit code 0; a non-zero code, a
    signal, a timeout, a spawn failure, and a rejection are `error`. The step row shows the command, then the exit code
    (or signal, or timeout) and the result's line count.
  - `brokeCode.commandTimeoutSeconds` (integer, default 120, at least 1, `application` scope, read from `globalValue`
    at each command; capped at the longest timer delay, about 24 days). At the timeout, or on Stop, New chat, the other
    navigation, and deactivation during the run, the group gets SIGTERM (`process.kill(-pid)`), then SIGKILL two
    seconds later unless the group is gone by then (checked every 20 ms). The result waits until the group is gone or
    SIGKILL was sent, so it never claims a stop that has not happened, and then for the output pipes, at most half a
    second more, since a process that left the group may hold them. A stop during the run ends the reply `stopped`.
  - Once the shell exits, the output gets 200 ms to drain. A process still in the group then (a background job, its
    output redirected or not) is stopped the same way, and the result ends with a line saying what is true when it
    settles: "were stopped" (the group is gone), "did not stop on SIGTERM; they were sent SIGKILL after 2 seconds",
    "were sent SIGKILL as the extension shut down" (deactivation, below), or "could not be stopped; they may still be
    running" (the signals failed). A process that left the group (`setsid`, a
    daemon) is not stopped, and the result stops waiting for the pipes it holds. A Stop after the shell exited keeps
    its exit code. macOS answers EPERM for a group of zombies, so only a group a signal 0 reaches counts as alive.
  - A signal that fails with ESRCH (the group is gone) or EPERM (zombies, or processes that changed user and could not
    be stopped anyway) is ignored. Any other failure adds a line `Sending <signal> to the command's processes failed
    (<code>).` to the result, whose status still follows the exit code. When SIGKILL itself fails, the result never
    says the command stopped: a timeout's first line is `timed out after N seconds; its processes could not be stopped
    and may still be running` (the step row then shows the generic error status), a Stop's is `run_command: Stop could
    not end the command; its processes may still be running.`.
  - Deactivation also calls `killRunningCommands` synchronously from `deactivate`: SIGKILL at once to every group still
    running or in its grace, since the host may exit before a scheduled SIGKILL fires. Ownership is per run, not per
    group id (`ownCommandGroup`): a run claims its group at spawn and releases its own claim, by identity, once the
    group is gone, got SIGKILL, or the run settled, so a later run that gets the same id keeps its claim. Deactivation
    releases every claim and tells each run, which cancels its pending SIGKILL and probes: once released, a run never
    signals that id again, since the system may reuse it. A SIGKILL that fails there for another reason than ESRCH or
    EPERM is logged and reaches that run's result as a failed-signal line, so the run never says it stopped; a run not
    yet stopping ends as stopped, a timeout or a leftover cleanup keeps its reason. Accepted limit: a host that crashes never calls it, so a process that ignores SIGTERM can then
    outlive it.

## Replies, history, and the agent turn

- Reasoning output (`<think>` tags, `reasoning`, or `reasoning_content`) shows collapsed in the chat. The parser
  never looks for tool calls in it, and the conversation history sent back to the model drops it. A reply with no
  reasoning yet whose content holds a bare `</think>` line (alone on its line, no `<think>` before it) reasoned as
  content: a chat template opened `<think>` in the prompt, as Qwen 3.8 on vLLM without a reasoning parser does (#58).
  Once that line streams in, the text before it moves to the reasoning and the answer starts after it (`lateReasoning`);
  until then the reasoning shows as answer text. The commit message drops it the same way. Accepted cost: an answer
  holding a bare `</think>` line loses the text before it.
- Each request of an agent turn sends a `system` message first, then the history: each user entry's composed text,
  each assistant answer verbatim with its call block (reasoning never), and each tool step as a `user` message
  `<tool_result tool="<name>" status="ok|error">`, the text, then `</tool_result>`, never the OpenAI `tool` role
  (ADR 0001). A malformed call's message goes back the same way with `status="error"`, with `tool` the tag name the block
  opens with, a known tool or not, and `tool="unknown"` only when no tool name can be read, as for an empty reply. A
  reply without text is left out of the history, unless a tool step follows it: an empty reply goes back as an
  assistant message with `content: ""` before its step. The roles alternate, since Gemma's chat template requires it
  (ADR 0001, 2026-11-12): in every history sent, a turn's request and the summary request alike, a `user` message that
  would follow another `user` message (a tool result, a user message whose reply was left out, the summary's message,
  `SUMMARY_REQUEST`) joins it after a blank line, its text unchanged and in order, so a message typed after a
  `stepLimit` or `malformedCalls` halt, or after a reply that failed or stopped without text, goes in the same `user`
  message as the one before it. A request with no such pair is byte-identical to one without the rule. An undone write step (#94) goes back with one more line after its text, inside the same wrapper: `The user undid
  this change afterwards.`, so the model does not answer from a change that no longer stands. An undone step before the
  summary the history starts at is no longer sent, so its own line never reaches the model: after the summary's text
  comes, per such step in order, a blank line then one line each, `The user undid this change, which the summary above may still describe: <tool> <path>`, the path being
  the step's `path` argument as the model wrote it (maintainer decision, 2026-11-12), before any text joined after the
  summary; derived from the entries at each build, never stored, counted by the estimate, and in `/compact`'s request
  too. A step still sent gets its own line only. `toHistory`
  (`history.ts`) builds it, and leaves the oldest tool results out of a request that would fill the context (below). After a summary (`/compact`, below), the history starts at it.
- While a reply streams, a `<tool_result` the model writes after a complete call, or the opening tag of another call (a
  known tool or a wrapper, starting a line) after it (`replyCut`), cancels the request, and the reply ends `done` at the
  end of that call (ADR 0001, 2026-11-10 and 2026-11-12): models forge results of calls that never ran, and Gemma on
  vLLM once repeated one call for 24 minutes. An opening with no complete call before it stops nothing.
- When a reply ends, its answer goes through the parser. Text and no call: the turn ends. A call: the answer is cut
  at the end of the call block, so the chat and the history never hold the text after it, then the tool runs with the
  turn's context (`ToolRunner.run(call, { signal, requestApproval })`, the abort signal and the approval request), a tool step entry records its name, arguments, status, text, and approval, and the loop requests again.
  A malformed call or an empty reply: a step entry with the message (for an empty reply, "Your reply was empty. Call a
  tool, or write your answer to the user."), and the loop requests again. In a Plan turn, a closed block of
  `write_file`, `edit_file`, or `run_command` (`PLAN_BLOCKED_TOOLS`), which the parser reads as "not a known tool"
  since those tools are not offered, is no malformed call: the answer is cut at the block's end as after a call, and an
  `error` step named after the tool, with no arguments, says "<tool> is not available in Plan mode." Nothing is
  planned, written, or run, and no approval opens (ADR 0005). Any other unknown tag stays malformed, and so does a
  tool not offered outside Plan (`load_skill` without a listed skill). The reply stays `streaming` while its
  call runs, and the step and the next reply are appended together, so `isReplying` holds across the whole turn.
- An agent turn has a Stop button and stops after `brokeCode.maxToolSteps` tool steps (a user setting, `application`
  scope, default 50, at least 1; calls, Plan's refused calls, and malformed calls alike) as `halted` with reason `stepLimit`; three malformed calls in a row (`MAX_MALFORMED_IN_A_ROW`) halt it with reason
  `malformedCalls`, and a call that parses, or a call Plan refuses, resets that count. Known cost, accepted: a model
  that insists on writing in Plan uses requests up to the step limit. Stop ends the turn at once, during a reply or a tool
  run: the step in flight is dropped, nothing later runs, and the record is saved as it stands. A failed reply ends
  the turn `failed`; so does an unexpected exception inside the turn (a bug), with an `internal` error giving its
  message, logged with its stack, so the composer never stays locked. Truncate tool results longer than about 2,000 lines and say so in the result.

## Notifications

- When a turn ends or waits for a decision while the chat is not in view, a VS Code notification says so (#101). The
  chat is in view when the chat view is visible and the VS Code window has the focus, both read once, at the event. A
  view never opened in this window is not visible. The focus in an editor of the same window, the view still visible,
  keeps the chat in view. Nothing is notified later for an event that happened while the chat was in view, and no
  notification is withdrawn or repeated when the view shows again or the window regains the focus: VS Code cannot
  withdraw a notification, so one may outlive its event.
- The controller reports the events through an optional port, `ChatPorts.turnEvents` (`TurnEvent` in
  `notifications.ts`); the eval bench passes none. The core decides the events; the host decides whether to notify
  (`notifyTurnEvent`, over the view's visibility, the window's focus, and the setting). A port that throws is logged
  and changes nothing in the turn.
  - `approvalRequested`: one per approval request that opens, a write in Ask or a command, with the request's kind and
    summary, reported once `ChatState.approval` holds it. A write accepted at once (Auto-edit) opens no request and
    reports nothing.
  - `turnEnded`: one per turn that ends `done`, `failed`, or `halted`, reported once the published state holds the
    final status, with the status, the halt reason or the failure, whether the reply that ended it is a summary entry
    (a `/compact`, or an automatic summary that failed and so ended its turn), and whether that reply's text is empty
    once trimmed. A `/compact` is a turn of its own. An automatic summary reports nothing of its own: its turn reports
    once, when it ends. Each turn of a queue reports its own end, and a queued message starting reports nothing.
  - A turn that ends `stopped` reports nothing, whatever stopped it: Stop, New chat, opening or deleting a
    conversation, a provider removed or changed in the settings, deactivation.
- One notification per event, each with one button, "Show chat":

  | Event | Severity | Text |
  |---|---|---|
  | Write approval | information | `broke-code is waiting for your decision: {0}`, the request's summary (the path), never cut |
  | Command approval | information | the same text with the command cut (below) |
  | Turn `done` | information | `broke-code finished its turn.` |
  | `/compact` `done` with a summary text | information | `broke-code summarized the conversation.` |
  | `/compact` `done` with no text | warning | the chat's sentence, `The model's reply held no summary.` |
  | `failed`, a summary or not | warning | `broke-code failed: {0}`, the chat's message for that failure (`describeProviderError`), without its technical detail |
  | `halted` | warning | the chat's sentence for that halt reason (`describeHalt`, the summary variant for a `/compact` halted on a full context) |

- A command is cut to its first line: leading whitespace and line breaks are dropped, then the first line is kept,
  without the whitespace that ends it. When that line is longer than 80 UTF-16 units, or a line that is not blank
  follows it, it is cut to at most 79 units, never inside a surrogate pair, and `…` is added.
- "Show chat" focuses the chat view with the view's focus command, as the editor entry points do, whatever conversation
  it shows by then, and does nothing else: the decision stays in the chat, and an approval answered or cancelled
  meanwhile is no longer there. A view that cannot be focused shows the error "Could not open the chat". A notification
  that cannot show is logged.
- `brokeCode.notifications` (boolean, default true, `application` scope, read from `globalValue` at each event):
  notifications are off only when the user value is `false`. A value set only in a workspace, or one that is not a
  boolean, leaves them on.
- The halt sentences and the empty summary's sentence live in the core (`turnEndText.ts`), each taking a translator as
  `describeProviderError` does, so the panel and the host share one wording and one set of English keys.
- Not notified: the commit message command, which shows its own progress. No sound, no notification outside VS Code,
  no unread badge.

## Context budget and summaries

- Before each request of an agent turn, the first included, the controller estimates its size as the characters of the
  system prompt and of each history message's content (as `toHistory` builds it, joins included, reasoning excluded) divided by
  the model's characters per token (its ratio, next item), rounded up. Above `floor(size * 7 / 8)` of the model's context size (`fillsContext`, never a copy of its arithmetic),
  the history sent replaces the text of tool steps, oldest first over the whole conversation as sent (earlier turns
  included), with one line inside the same `<tool_result>` wrapper, same `tool` and `status`, leaving any text joined
  to that message whole:
  `[result left out to save context: N lines]` (`1 line` for one), N being the step row's line count
  (`resultLineCount`: a trailing line break dropped, then split; 0 for an empty text). It replaces the fewest steps
  that make the estimate fit, rounded up to the next multiple of 4 (`LEFT_OUT_BLOCK`) and capped at the steps that
  may be replaced: the count changes about once every 4 new steps, so the requests in between only add to the prompt
  of the one before and a provider's prompt cache holds. Never replaced: the system prompt, user messages (a `/<name>` skill message included),
  assistant answers, the last 3 tool steps sent (`KEPT_RECENT_STEPS`), whatever turn they belong to,
  every `load_skill` step, whatever its status (a second load answers "already loaded" without the body), every undone
  step (a left-out line would tell the model the change stands; the estimate and the usage display count its added
  line), and a step whose replacement line is not shorter than its text; a malformed-call step follows the same rule as the others. The
  choice is a pure function of the entries, the system prompt, the context size, and the ratio, linear in the entries, since the
  usage display runs it at each streamed delta. Only what is sent changes: the record and the chat keep every result
  whole, and the loaded skills are still derived from the entries. When the estimate is still over with every eligible
  result replaced, the history goes whole, no request is sent, and the reply that would have carried it ends `halted`
  with reason `contextFull`, saved like the other halts; it is never a `ProviderError`, which means a request was sent.
  The usage display (`ChatState.context`) counts the request as it would be sent, and its optional `leftOut` counts the
  results left out; while it is set, the panel shows "N older tool results are left out of the request to save
  context." in the place and look of the unknown-size notice, derived from the state, never saved or sent. Its
  optional `reported` holds the counts the last chat request of the conversation shown reported (a turn's request or
  a summary request; the commit message's never reaches the chat's state, see `docs/spec/provider.md`), which the
  header's tooltip shows. While a request is in flight it keeps the counts of the request before it; when the request
  ends, its counts replace them, or it is cleared when the request ended without reported usage (stopped, cut,
  failed, or a reply that reported none). It is cleared too when the conversation shown changes (New chat, an open, a
  delete of the conversation shown) and whenever the selected model is set or reset, even to the same model (a model
  picked, a provider changed, a model list loaded again). Never saved: after a window reload there is none until the
  next reply. The estimate does not read it. Known cost,
  accepted: when fewer steps may be replaced than the rounded count, every one of them is replaced and the count
  grows with the next step, which changes the prompt's prefix and defeats a provider's prompt cache for that request.
  A context that keeps 3 or more replaceable results whole beside the last 3 steps never gets there; with 2, 1, or 0,
  about 2, 3, or 4 requests in every 4 do, and a long turn drifts there as it nears a full context. Nothing is
  remembered between requests but the model's ratio: an undo, a new context size, a mode change, a loaded skill, a new
  summary, or a lower ratio recomputes the count and may change the prefix once. A turn reads the step limit, the context sizes, `brokeCode.autoCompact`, and Plan once, when it starts; a
  settings change reaches the usage display at once (`limitsChanged`) and the turns from the next send. The ratio is
  not read once: each request of a turn, and each estimate of the usage display, reads the model's ratio as it is then. A mode change
  cannot land during a turn (the selector is disabled and `setMode` ignored while a reply is in flight), and the
  usage display follows it at the next send, which composes the prompt of the new mode. The display counts the
  system prompt the last send composed, in any conversation shown, since instruction files and skills are the
  workspace's; before the first send of the session, the one without instruction files or skills. It updates once a send has composed it, before the
  request goes.
  Leaving results out is a deterministic cut, with no model call; a summary is asked for with `/compact` (below), or,
  with `brokeCode.autoCompact` on, by the turn itself (below).
- The ratio (#137, ADR 0006): for each model of each provider (the provider's name and base URL and the model's name
  together), `ProviderSupport` keeps one number of characters per token, in memory for the life of the extension host,
  beside the usage field's state (`docs/spec/provider.md`). It starts at 4 (`DEFAULT_RATIO`) and only goes down. A
  sample comes from a chat completion request whose reply completed (`done`) and reported `prompt_tokens` of at least
  1,000 (`MIN_SAMPLE_TOKENS`): the request's characters (`charactersOf`: the UTF-16 lengths of the contents of every
  message sent, what the estimate counts) divided by `prompt_tokens`, rounded down to one decimal. The ratio becomes
  the smaller of itself and the sample, never under 2 (`MIN_RATIO`). `streamChat` takes the sample, so a turn's
  requests, the summary requests of `/compact` and of automatic compaction, and the commit message's request all teach
  it; a stopped, cut, or failed reply teaches nothing. Since it never goes up, a server that truncates an oversized
  request without an error (it reports too few tokens, a high sample) changes nothing. The estimate of a text is
  `ceil(characters * 10 / t)` and the most characters that fit a room of tokens are `floor(room * t / 10)`
  (`largestFittingCharacters`), with `t` the ratio times 10, an integer from 20 to 40, so they are exact; the size
  functions take the ratio as an input. A lower ratio takes effect at the next computation, inside a running turn too,
  so the usage display and the request use the same ratio at the same moment. When a reply lowers the ratio of the
  selected model, the controller publishes its state at once, with the same entries, so the header's estimate moves
  before the reply settles. A lower ratio never puts back a result that was left out; when the request does not fit
  even with every eligible result left out, the history goes whole and the turn ends on a full context or a summary,
  as above. Selecting another model uses that model's ratio, or 4; a provider whose base URL was edited is another
  provider and starts at 4. Nothing is saved: the record and the protocol are unchanged, the webview computes no
  estimate, and after a window reload every ratio is 4 again.
- `/compact` (#90) asks the model for a summary of the conversation shown. `ChatController.compact` sends one request,
  registered as a reply like `send`'s, so Stop, saving, navigation, and "a reply is in flight" (Send queues, the
  pickers and the mode selector are disabled) treat it as any reply. It returns `ignored` when Send would not act,
  and `nothingToSummarize`, which the host shows as an information notification ("Nothing to summarize: the
  conversation is empty or was just summarized."), when the conversation has no entries or its last entry is already
  the summary the history starts at; nothing is sent then. The request: a system prompt of its own
  (`composeSummaryPrompt`: a role sentence saying the model summarizes a conversation between a user and a coding
  agent, then the instruction files read now; no call format, rules, tools, or skills), then `summaryHistory`: the
  history as sent (from the last summary), with every tool result the leave-out rule may replace replaced, the last 3
  included (maintainer decision, 2026-11-12; cost: the summary sees the calls and answers, not the files read), then
  `SUMMARY_REQUEST`, a user message asking for the goal, the decisions, the files read or changed with their paths, and
  what remains to do, joined after a blank line to the history's last message when that one is a user message (a
  tool result, or a user message whose reply was left out), by the history's one join rule. When its estimate, at the
  model's ratio, still fills the context (`fillsContext`), no request is sent and the entry ends `halted` with `contextFull`, its wording "Not
  summarized: …". Known cost: a prefix of its own defeats a provider's prompt cache for that request. The reply is an
  assistant entry with `summary: true`, streamed under a separator ("Summarizing the conversation…", then
  "Conversation summarized", or "Conversation not summarized" when it ended otherwise than `done` with text); it is
  never parsed for a call (a call-shaped block runs nothing), and reasoning is handled as for any reply. As after a
  send, a summary that ends `done` sends the first queued message.
- From then on the history sent starts at the last summary entry that ended `done` with text (`historyStart`): the
  system prompt, one user message `Summary of the conversation so far:`, a blank line, and the summary (then the lines of
  the undone steps it replaces, see the history above), then the entries after it; when the next entry sent is a user message, its composed text joins the summary's message after a
  blank line, by the history's one join rule. A summary that failed, was stopped, halted, or came
  back empty (only whitespace) changes nothing and is never sent; its error shows as for any reply, and a `done` empty
  one says "The model's reply held no summary.". The leave-out rule, its last 3 steps, and the usage display count
  only what is sent, so after a summary the header's usage drops. Entries before it stay in the record and the chat,
  dimmed as one group under the line "Earlier messages are no longer sent to the model: the summary below replaces
  them.", derived from the entries, never stored; a high-contrast theme drops the dimming, since the line says it. The record keeps version 2: `summary` is an optional field of the
  assistant entry (ADR 0003's rule); an older build shows the summary as an ordinary answer and resends the whole
  history, which is harmless. The `contextFull` halt of an agent turn names `/compact` beside New chat.
- Automatic compaction (#91): `brokeCode.autoCompact` (boolean, default false, `application` scope, read from
  `globalValue` like the providers through `userLimits`, once when a turn starts; `TurnLimits.autoCompact`, false when
  the source passes none, as the eval bench does, so the bench never compacts). Off, or set only in a workspace
  `settings.json`, nothing changes. On: before a request of an agent turn, when the estimate still fills the context
  after the leave-out rule, the controller builds `/compact`'s summary request (`summaryMessages`: the summary system
  prompt with the send's instruction files, then `summaryHistory`); when that request fills the context too, at the
  same ratio, nothing is
  sent and the waiting reply ends `halted` (`contextFull`), with no summary entry. Otherwise the summary entry
  (`summary: true`) takes the waiting reply's place and streams in the same turn: the turn stays in flight (Stop
  shows, `isReplying` holds, Send queues as during any reply), it is no tool step and counts nothing toward the step limit. Ended `done` with text, it
  is followed at once, in the same update, by a new waiting reply, and the loop builds the request again. At most one
  automatic summary per request: still over the threshold, the reply ends `halted` (`contextFull`), as before. A
  summary that fails ends the turn `failed` with the provider's error on the summary entry; stopped, the turn ends
  `stopped` with the summary as its last entry, and the history is unchanged; `done` but empty, the reply after it
  ends `halted` (`contextFull`). The history sent from an automatic summary: the system prompt, then one user message,
  `Summary of the conversation so far:`, a blank line, the summary (and the undone steps' lines), a blank line, and the turn's user message as
  composed when it was sent (mentions and a `/<name>` skill text included), word for word, so the model keeps the
  request it is working on (scouting decision, 2026-11-12); then the entries after the summary. A later request of the
  same turn may compact again, quoting the same message. No record field tells an automatic summary from a manual
  one: it is derived (`isAutomaticSummary`): the turn's next reply follows an automatic summary, while after
  `/compact` only a user message or another summary can, since a reply only ever follows a user message or a tool
  step; the quoted message is the nearest user message before it, since `/compact` never runs inside a turn. A failed
  or stopped automatic summary has nothing after it and reads as a manual one, which changes nothing, since neither is
  sent. Its separator says "Conversation summarized automatically" once sent ("Summarizing the conversation…" and
  "Conversation not summarized" as for `/compact`). The turn's message the request quotes sits in the group before
  the summary but is not dimmed: it shows at full opacity with the dim line "Still sent with the summary" (maintainer
  decision, 2026-11-12), derived from the entries (`sentEntries`), never stored.

## System prompt

- After the tools, the system prompt has a "Skills" section, one `- <name>: <description>` line per skill listed to
  the model, telling it to call `load_skill` first; without such a skill the section is absent, and so are the
  `load_skill` tool and its rule (reading a loaded skill's files by the absolute path the result gives, read-only
  outside the workspace): the
  controller offers the runner's tools less `load_skill` (`offeredTools`), so its call is then malformed.
- In a Plan turn, `offeredTools` also leaves out `write_file`, `edit_file`, and `run_command`, so their rules drop with
  them, and `composeSystemPrompt(tools, instructions, skills, mode)` replaces the role sentence with one saying the
  agent reads files, followed by a "Plan mode" paragraph: read what it needs, answer with a plan of the changes, file
  by file, in order, change no file and run no command. Without a mode, or in Ask or Auto-edit, the prompt is
  byte-identical to the one before Plan; the eval bench passes no mode. A `/<name>` message loads its skill in Plan
  as in any mode; a skill that asks to write meets the refused-call step.
- The system prompt includes `~/.agents/AGENTS.md`, then each workspace folder's `AGENTS.md` (labelled with its
  folder name in a multi-root workspace), read at each send under the mention caps (1 MiB, 2,000 lines). A missing
  file is left out; an unreadable one is logged and left out. The home file follows symlinks; a workspace file is
  held to the workspace boundary. `CLAUDE.md` is not read.
