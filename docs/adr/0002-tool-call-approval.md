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
still holds the planned text, then a `rename(2)` over it (see AGENTS.md, "A write is atomic"). A file that changed on
disk since the plan is refused, and the model is told to read it again. Before the write, and before the request, a
file open in an editor with unsaved changes is refused, also when auto-approve is on: the model gets an `error`
result saying so. An editor without unsaved changes reloads the new text from disk by itself.

## Auto-approve

One user setting, `brokeCode.autoApproveWrites` (default off), accepts writes at once, without a diff. It has the
`application` scope and is read from the user value only, like the providers, so a workspace `settings.json` cannot
weaken approval. The controller reads it at each write's request, so turning it off reaches the next write of a turn
in flight. The controller is the one place it applies, and only to requests of kind `write`: nothing auto-approves a
command, which always waits for a click.

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
- `run_command` (#9) reuses the seam with kind `command`, which the setting never accepts.
- An open request does not survive a window reload, and the proposed side cannot be edited before Accept.
- Residual race, accepted: text typed into an editor between the last unsaved check and the rename is not lost, but
  that editor then holds unsaved text over a file that changed on disk, which VS Code reports when it saves.
