---
status: accepted
---

# Plan mode offers the read tools only, refuses a write or a command with an error step, and is read once per turn

The mode selector of the message box offers Ask and Auto-edit (#79): both decide how writes are approved, and every
turn offers the write tools and `run_command`. A user who wants a plan before any change had no way to make sure that
no file changes and no command is proposed. Plan (#80) is the selector's third mode: the model reads what it needs and
answers with a plan of the changes, file by file, in order.

## The tools and the prompt

A Plan turn offers `read_file`, `list_files`, `search`, and `load_skill` (with its rule) when a skill is listed to the
model: `offeredTools(tools, skills, mode)` leaves out `write_file`, `edit_file`, and `run_command`
(`PLAN_BLOCKED_TOOLS`), and their rules drop with them, as `load_skill`'s does without a listed skill. The composer
takes the mode as an optional last parameter. In Plan, the role sentence says the agent reads files, no longer that it
changes files and runs commands, and a "Plan mode" paragraph follows it: read what you need, answer with a plan of the
changes, file by file, in order, change no file and run no command. Without a mode, or in Ask or Auto-edit, the
prompt is byte-identical to the one before Plan, so the eval bench, which passes no mode, measures what it measured.

## A call Plan leaves out is an error step

The body tool call parser (ADR 0001) is unchanged and still parses against the offered tools, so a closed
`<write_file>` block in a Plan turn is "not a known tool". The controller turns that outcome, for the three tag names
Plan leaves out only, into an `error` tool step whose text is `<tool> is not available in Plan mode.`: the answer is
cut at the end of the block, as after a call, the step records no arguments, nothing is planned, written, or run, and
no approval opens. It is an ordinary tool step, like a rejection (ADR 0002): it counts toward the step limit and, like
a call that parses, resets the count of malformed calls in a row. Any other unknown tag stays a malformed call, and so
does a tool that is not offered outside Plan (`load_skill` without a listed skill).

## What is read when

A turn reads Plan once, when it starts: its tools and its prompt hold until it ends. The selector is disabled and
`setMode` ignored while a reply is in flight, so the mode shown is the one the turn applies. The auto-approve setting
is still read at each write's request (ADR 0002); Plan offers no write. The controller holds one mode pick at a time:
while a pick's settings write is pending (`ChatState.modePending`), the selector and Send are disabled, and the
controller ignores `setMode` and starts no turn for a `send`, whose text goes back to the message box (a `send` while
a reply is in flight is queued instead, #70). Otherwise an older pick's write, settling
late, would undo a newer pick, or change the mode shown under a turn that started on the old one. A Plan pick writes
no setting and never pends. A queue of picks, with `send` waiting for it, was tried first and rejected: a send
waiting on it landed in whichever conversation was shown when the write settled, a New chat included. The usage display counts the prompt of the
last send, so it follows a mode change at the next send.

Plan is kept per workspace, in the workspace memento under its own key `brokeCode.plan`, read when the controller is
built, so it is restored at each window load. `brokeCode.lastChoice` is not used: it is rewritten whole and cleared
without a provider, and Plan must survive both. While on, Plan wins over `brokeCode.autoApproveWrites`, which keeps
its scope and its read from `globalValue`. Picking Plan writes no setting. Leaving Plan for Ask or Auto-edit writes the
setting first, only when its value must change, and clears Plan only once that write succeeded: a failed write keeps
Plan and is shown. A failed memento write is logged only, as for the provider and model choice: Plan applies for the
session and is lost at the next load. Plan is not part of a conversation: the record is unchanged, and reopening a
conversation changes no mode.

## Considered options

- Parse against every tool, then refuse in the runner. Rejected: AGENTS.md allows parsing-rule changes only on
  evidence from the eval, and the parser's "known tools" message would name `write_file` in a Plan turn.
- Report the refused call as a malformed call. Rejected (maintainer decision, 2026-11-11): three in a row would halt
  the turn as `malformedCalls`, although the call was well formed, and the model would read a format error.
- Keep Plan in the user setting, or inside `brokeCode.lastChoice`. Rejected: a setting would apply to every window
  and project, while a plan is asked for one piece of work; `lastChoice` is rewritten whole and cleared without a
  provider.
- Read the mode at each request of a turn. Rejected: the tools and the prompt would change mid-turn, and the history
  would hold calls to tools the prompt no longer lists.

## Consequences

- A Plan turn cannot change the workspace through the tools: no write is planned and no command is proposed.
- Accepted cost: a model that insists on writing uses requests up to the step limit; there is no halt reason of its
  own for repeated refusals.
- Accepted cost: the refused step records no arguments, and a `<write_file>` block never closed reads as a final
  answer, as for any unknown tag.
- A later Ask or Auto-edit turn may see "not available in Plan mode" steps in its history; its prompt lists the
  tools again, so the model can call them.
- A failed memento write loses Plan at the next load, silently but for the log.

## Addendum (2026-11-13): a second way out of Plan, from the plan's answer

After a Plan turn, carrying the plan out took two steps that nothing tied to the plan shown: leave Plan with the
selector, then type a message asking to implement it. A button under the plan's answer now does both (#102):
"Implement in Ask mode" or "Implement in Auto-edit mode", named after the mode `brokeCode.autoApproveWrites` holds.

A click leaves Plan without writing the setting. `ChatController.implementPlan` clears the Plan key only, then starts
an ordinary turn whose user message is shown as "Implement the plan above." in the display language and sent to the
model as that fixed English text (`IMPLEMENT_PLAN_TEXT`), the way Continue shows its label and sends fixed English. The
selector's way out is unchanged: it still writes the setting first when its value must change.

- The setting is never written here, so nothing pends and no write can fail: the mode after the click is the one the
  setting already holds, which the label named. `ChatState.settingMode` carries that mode while `mode` is `plan`, and
  follows each change of the setting. The click carries no mode: each write still reads the setting when it runs
  (ADR 0002), so a change of the setting between the render and a write applies, as in every turn.
- A failed memento write is still logged only: Plan is left for the session and the send goes. The cost is the one
  above, reversed: Plan is back at the next load.
- The controller acts only when the entries shown are still the conversation's, Plan is on, a turn may start
  (`mayStartTurn`), and the conversation ends on its final answer (`hasFinalAnswer`: the last entry is a reply that
  is not a summary, ended `done`, with text). Otherwise it does nothing at all, and Plan stays on. Once it acted,
  Plan stays left even when the turn fails.
- Plan is still not part of a conversation, so the button shows under any final answer while Plan is on, a
  conversation opened from History included. Accepted: recording which turns ran in Plan would change the record.
- The plan is not quoted in the message: it is in the history already. A plan that `/compact` summarized is no
  longer the last entry, so the button does not show under the summary.

Considered and rejected: a choice of mode at the click (a second selector, and a setting write that can fail between
leaving Plan and sending); carrying the label's mode in the message and applying it to the turn (writes would stop
following the setting, against ADR 0002); saving the plan to a file (out of scope).

## Addendum (2026-11-13): Plan also offers `ask_user`

The title says Plan offers the read tools only. Since #143 the extension offers `ask_user` (ADR 0002, addendum of
2026-11-13), and a Plan turn offers it too, with its rule: `PLAN_BLOCKED_TOOLS` still holds `write_file`,
`edit_file`, and `run_command` only. Plan's promise is that no file changes and no command runs, and a question
changes nothing: it brings back text from the user, like a read brings back text from a file. A plan that depends on
which of two things the user meant is better asked than guessed.

- The refused-call step is unchanged: it still covers the three tools Plan leaves out, and `ask_user` is an ordinary
  call in Plan.
- The Plan role sentence and the "Plan mode" paragraph are left as they are, although the role speaks of reading
  files only. The eval bench passes no mode, so no eval measures a Plan prompt, and rewording it was out of scope
  (#143). Accepted: the role and the tool list disagree by one tool, which the tool's own description and rule cover.
- A core test pins that the runner's switch offers the tool in Ask, Auto-edit, and Plan.

Considered and rejected: leaving `ask_user` out of Plan (a second tool list to keep in step, and Plan is where an
ambiguous request costs the least to settle before any change).
