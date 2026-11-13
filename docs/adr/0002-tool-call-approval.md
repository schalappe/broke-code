---
status: accepted
---

# A tool call that changes the workspace waits for the user's approval inside the agent turn

The write tools (`write_file`, `edit_file`) plan a change and never write it themselves. Something must decide
whether the change lands. The user must see the change before it touches the disk, a repository must not be able to
turn that check off, and Stop must stay instant: today a Stop ends the turn at once, whatever the tool is doing.

The approval is a wait inside the tool run. The controller gives each run a `requestApproval` function beside its
abort signal. A tool calls it with what it is about to do and gets back Accept, Reject with the optional reason the
user typed, or Cancel. While the request is open, the reply stays `streaming`, the panel state carries the request
(`ChatState.approval`, with its id), and the chat shows Accept, Reject, and a reason field from that state alone. A
decision carries the request id; one for a request no longer open is ignored. One call runs per reply, so at most one
request is open.

For a write, the request opens the native diff editor beside the chat: the planned text on the left, the one Accept
checks the file against (empty for a new file), and the proposed text on the right, both served from memory, so the
diff never touches the file. The tab closes when the request ends, whatever ended it. Closing the tab by hand changes
nothing (maintainer decision, 2026-11-09): the request stays open, Accept and Reject in the chat still work, and the
diff cannot be reopened.

A rejection goes back to the model as an `error` tool result: "The user rejected this change.", then the reason on
its own line when the user gave one. It is an ordinary tool step, so it counts toward the step limit, and the record
keeps no new status, only how the step was approved (`accepted`, `rejected`, or `auto`) for the chat to show.

## Accept writes with the core's atomic applier

On Accept the change is written by the same applier as everywhere else: a temporary file, a last check that the file
still holds the planned text, then a `rename(2)` over it (see `docs/spec/harness.md`, "A write is atomic"). A file that changed on
disk since the plan is refused, and the model is told to read it again. Before the write, and before the request, a
file open in an editor with unsaved changes is refused, also when auto-approve is on: the model gets an `error`
result saying so. An editor without unsaved changes reloads the new text from disk by itself.

## Auto-approve

One user setting, `brokeCode.autoApproveWrites` (default off), accepts writes at once, without a diff. It has the
`application` scope and is read from the user value only, like the providers, so a workspace `settings.json` cannot
weaken approval. The controller reads it at each write's request, so turning it off reaches the next write of a turn
in flight. The controller is the one place it applies, and only to requests of kind `write`: nothing auto-approves a
command, which always waits for a click.

2026-11-11 (#79): the panel writes the setting too. The mode selector of the message box shows **Ask** (off) or
**Auto-edit** (on), writes the user value on a pick, and follows the setting, not the click; the reading rules above
are unchanged.

## Cancellation

Stop, New chat, opening another conversation, deleting the conversation shown, and the extension's deactivation all
abort the reply in flight. The abort cancels the open request: the request leaves the panel state at once, the diff
tab closes, nothing is written, and the reply ends `stopped`. A preview that finishes opening after the abort is
closed at once. An open request is never saved: a record saved while one waits holds the reply `streaming` with its
call, which reloads as `stopped` by the existing rule, with nothing written.

## Considered options

- **Write through the editor layer (`WorkspaceEdit` and save).** Rejected (maintainer decision, 2026-11-09). The
  edit applies to the editor's buffer, so on a file with unsaved changes it overwrites the user's unsaved edits, then
  saves the result; and an edit plus a save loses the atomic guarantee: a crash between them, or a failed save, leaves
  the editor and the disk apart. Refusing the file with unsaved changes keeps the user's text untouched and the write
  atomic.
- **The live file on the left of the diff.** Rejected. The file can change while the diff is open, so the diff would
  then show a change other than the one Accept checks; the planned text is exactly what Accept requires.
- **Approval outside the turn, as a step status the model is told about later.** Rejected. The model needs the
  decision before its next request, and a separate pending state would need its own save, reload, and Stop rules.
- **Auto-approve per workspace.** Rejected. A repository could ship it and write without the user's click.

## Consequences

- A tool that changes the workspace must ask through `requestApproval`; the extension wires the write tools only
  behind it, so no build writes without a click unless the user turned auto-approve on.
- `run_command` (#9) reuses the seam with kind `command`, which the setting never accepts. The chat labels its Accept
  **Run** and shows the whole command; a rejection reads "The user rejected this command.", then the reason.
- An open request does not survive a window reload, and the proposed side cannot be edited before Accept.
- Residual race, accepted: text typed into an editor between the last unsaved check and the rename is not lost, but
  that editor then holds unsaved text over a file that changed on disk, which VS Code reports when it saves.

## Addendum (2026-11-12): the way back from an approved write

An approved or auto-approved write goes to disk outside the editor, so neither the editor's Undo nor Local History
sees it: VS Code's working copy history records a save made from an editor and has no file-watcher listener (verified
at the scouting of #93, `workingCopyHistoryTracker.ts`). The chat therefore offers "Undo changes" (#69, #92, #93).

- The approval seam carries the record. Each tool run gets the turn's `RecordedChanges` on its run context
  (`ToolContext.changes`), set per call beside `requestApproval`; the extension wraps its `fileApplier` in
  `recordingApplier` inside `approvalApplier`, so only a change that reached the disk is recorded, never a rejected,
  cancelled, or refused one. The eval bench's applier ignores it and records nothing.
- Memory only, one turn: the latest turn of the conversation shown that wrote a file, held from its first recorded
  write, replaced when a later turn writes its first file, dropped when the conversation shown changes and at a window
  reload (maintainer decision, 2026-11-11). Not on the steps or in the panel state: the record is rewritten whole at
  each save and the state is posted at each delta, so megabytes of file text would ride on both.
- Stop does not wait for a write already running. Such a write is still held while its turn is the latest of the
  conversation shown, since that is when an undo is most needed (scouting decision, 2026-11-12); one landing after the
  conversation changed is not.
- The undo restores file by file with the write's own checks and the same unsaved-editor refusal: a file changed since
  the turn wrote it, or unsaved in an editor, is skipped untouched and stays held, so the next click retries it. The
  button shows whatever the turn's end status. It runs in the navigation queue, so New chat, open, and delete wait for
  it, and while it runs no turn starts (the one Send check). Commands are not undone, and the chat says so.
- The write steps of each file put back are marked `undone` in the record, an optional field (ADR 0003's rule), tied
  to their file when recorded, never by resolving the path again; the history tells the model with one more line in
  the step's result, and never leaves such a step out to save context (#94, scouting decision, 2026-11-12). A step a
  summary replaces is no longer sent: the summary's message then names it on a line of its own after the summary's
  text, so an undo after `/compact` or an automatic summary still reaches the model (maintainer decision,
  2026-11-12).

## Addendum (2026-11-12): the diff of a changed file

"Changed files" (#99) lists the held turn's files above "Undo changes" and is the second use of the diff editor. A row
opens its file's diff beside the chat, the focus kept in the panel: the held text before the turn on the left, served
from memory by a content provider of its own scheme (`BEFORE_TURN_SCHEME`), read-only, empty for a created file; the
real file on the right, not a snapshot, so the diff shows what the file holds now, unsaved editor changes included,
and a hand edit since the turn shows what an undo would skip (scouting decision). A file gone from disk opens no diff:
an error notification says so, since the diff editor would show it as an empty file (scouting decision).

- The tab lives as long as its row: it closes when its file leaves the held turn (put back by an undo, or the turn no
  longer held: a later turn's first write, Retry or Edit removing it, New chat, open, delete) and at deactivation, the
  approval diff's rule, so a reloaded window never restores one with an empty left side (maintainer decision,
  2026-11-12). The controller checks at each state update which opened diffs lost their file and tells the host's port
  to close them.
- The right side is a `file:` URI shared with every editor of that file, so these tabs are found by their left side's
  scheme and URI (`closeTurnDiffs`), never by their right side as the approval's are.
- The counts come from a minimal line diff written in the core with a fixed work bound (`LINE_DIFF_WORK_LIMIT`), no
  diff library (scouting decision): past the bound, the lines left after the common first and last lines count as all
  removed and all added.

## Addendum (2026-11-13): a question request beside the approval request

`ask_user` (#142) asks the user one question inside a turn and gives the answer to the model. It approves nothing, so
it does not reuse `requestApproval`, whose answers are Accept, Reject, and Cancel: the run context gains a second kind
of request beside it, `ToolContext.requestAnswer`, which takes the question and its options and settles with the
answer text, `unanswerable` (no one can answer where the turn runs), or a cancellation.

- The wait follows this record's rules: it is a wait inside the tool run, the reply stays `streaming`, the result is
  an ordinary tool step that counts toward the step limit, and an abort of the turn cancels it at once, also while
  the request is being made, so Stop stays instant.
- Who answers is the caller's business, as for approvals. The eval bench answers by wrapping the run context, as it
  decides command approvals. The controller's own request has no interface behind it yet and settles at once as
  `unanswerable`; the extension does not offer the tool, through the runner's `offerAskUser` switch, until the panel
  can answer (#143).
- The tool was kept on eval evidence: without it, both bench models passed 0 of 10 runs of the `ask` scenario,
  renaming without asking which function was meant; with it, 10/10 on both, and the other eight scenarios kept 10/10
  (`docs/eval.md`, pull request #147).
