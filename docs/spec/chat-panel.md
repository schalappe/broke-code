# Chat panel behavior

This file specifies what the chat panel does around a turn: folding, code block actions, Quote, the question block, queued messages, Retry, Continue, "Implement in ... mode", Edit, and the recall of earlier messages. `DESIGN.md` holds the look; `docs/spec/harness.md` holds the turn itself.

## Turn folding

- A turn runs from a user message to the entry before the next one or the next summary (`/compact`); it has ended unless it is the last turn and a
  reply is in flight. An ended turn keeps its last reply, and any tool step after it (a `stepLimit` or `malformedCalls`
  halt), in view, and folds every entry between its user message and that reply under one row when the fold holds at
  least 2 tool steps (`foldTurns`); any other turn renders as before, with no wrapper. The row is an uncontrolled
  `<details>`, closed when the turn ends, like the reasoning block, whose row says what the steps did (below). The turn in flight never folds, so a running step and
  an open approval always show; a row opened inside comes back closed once its turn folds, since its entries remount.
  Entries before the first user message, and a turn with no reply, never fold. A summary entry is a boundary of its
  own: always rendered, never inside a fold, and never a turn's final reply, so the turn before it folds by the usual
  rule and keeps its own final reply. An automatic summary (`docs/spec/harness.md`) splits its turn the same way: the part before it
  folds as an ended turn, and the part after it, from the summary to the turn's final reply, folds once the turn has
  ended. Rendering only: the state, the record,
  and the history sent to the model are unchanged.
- The fold's row (`describeFold`) says what the tool steps inside did, counted in one pass (`foldTurns`). A rejected
  step counts only as rejected and a failed one (any status but `ok`, a `malformed` call included) only as failed, so a
  kind counts what really happened: "changed 1 file" means a file changed (maintainer decision, 2026-11-13). Each other
  step has exactly one kind, checked in this order: **other** for a `read_file`,
  `write_file`, or `edit_file` whose `path` is missing or empty once cleaned, a `run_command` without `command` (a call
  Plan refused is recorded so), and a tool of none of the kinds below; then **read** (`read_file`), **listed**
  (`list_files`), **searched** (`search`), **loaded** (`load_skill`), **edited** (`write_file`, `edit_file`), **ran**
  (`run_command`); an undone write counts, since it did change the file. Read,
  listed, and edited show distinct paths; searched, loaded, ran, and other show steps. Paths are cleaned lexically and
  nothing more: empty and `.` segments are dropped, `..` removes the segment before it, a `..` with nothing before it
  stays, and a leading `/` is kept, so `a.ts`, `./a.ts`, and `src/../a.ts` are one file, while `../a.ts` and `a.ts`,
  `/a.ts` and `a.ts`, or two letter cases are two. A `list_files` without a path, `.`, and `./` are the workspace root.
  The row names at most three kinds: edited (written "changed N files", the word of "Changed files") and ran whenever not zero, the places left to read, listed, searched, and
  loaded by largest number shown (a tie to the earlier one), written in that fixed order; then "N other steps", the
  other steps plus the steps of every kind not named; then ", K rejected" (`approval` `rejected`) when not zero. A fold
  with no step of a kind and no other step (every step failed or was rejected, or the other steps alone) says "N steps". The first letter is upper case: "Read 3 files, changed 1 file, ran 1 command";
  in French the number comes first ("3 fichiers lus, 1 fichier modifié, 1 commande exécutée"). Last, apart
  (`describeFold`'s `failed`), the failed steps (status `error` or `malformed`, not rejected) when not zero, with the
  tools that failed, each once in the order it first failed (`FoldCounts.failedTools`; a malformed call's tag name):
  "1 failed (search)", "2 failed (run_command, edit_file)". That part is in the error color, and the row's node is an
  error ring (`.turn-fold-row.failed`), since the final reply may claim a success a failed step contradicts. The row wraps in a narrow panel; it is never cut. The conversation follows its bottom while the user is within 24px of
  it, and a user message added to it (sent from the message box, including a send that replaces the last turn through Edit, or from the queue) brings the view back to the bottom.
  Scrolled up, a row stays at the bottom of the view (`.jump-row`, sticky): "Jump to latest", or, while the reply waits
  on the user, what it waits on, in the live region's words ("Waiting for your decision: edit_file on src/a.ts", "The
  agent asks: ..."; `describeWaiting`). It appears only on the user's own scroll and never takes the focus; a click
  scrolls to the bottom, the row goes, and the focus goes to the message box, from which Shift+Tab reaches the
  decision. While it shows, it is the first control Shift+Tab meets from the message box. Scrolled up, scrolled up, a turn that folds keeps its question row (its user message) in place on screen, because nothing
  above it changes and the browser's scroll anchoring is off (`overflow-anchor: none`), which would otherwise re-anchor
  on a visible entry under the row (maintainer decision, 2026-11-11). Known limit: a fold that leaves too little
  content under the view makes the browser lower the scroll position, moving the row down. It moves no focus.

## Code blocks of an answer

- An answer's Markdown is GitHub Flavored Markdown (`remark-gfm`): tables, strikethrough, task lists (their boxes
  disabled), and bare links render. A wide table scrolls inside itself.
- A code block of an assistant answer (fenced or indented, rendered by the answer's Markdown) has Copy and Insert at
  cursor laid over its top right corner, before its code in the DOM, once its text is final: its closing fence was written, rendered text follows it
  (the parser closed it), or its reply has ended (done, stopped, failed, halted, or cut off). While its reply is
  waiting or streaming, a block still open has none. React-markdown renders an open fence like a closed one, so
  the parser itself says it: `remarkFenceClosed`, a remark plugin on the answer's renderer only, adds an enter handler
  for `codeFencedFence` to mdast-util-from-markdown (which has none of its own), marks the nearest `code` node when that
  fence is the closing one (`flowCodeInside` already set), and the mark reaches the `pre`'s `code` element as the
  `dataFenceClosed` property, which `CodeBlock` reads. Rendered text after the block, read from the answer's source past
  the block's `node.position` end (`hasTextAfter`), counts only past whitespace and `>`, since a stream may end on a
  container prefix; it completes an indented block and a fenced block whose container ended. The call block, tool step
  rows, reasoning, and user messages are not Markdown and get no controls. The block's text is its code as rendered,
  without the fence lines and its final line break; an empty block's buttons are disabled. Copy writes it with the
  webview's `navigator.clipboard` and shows "Copied", or "Copy failed" when the write is refused, in the button's
  place for 2 seconds, and says the same through the panel's live region (see "Announcements"). Insert at cursor posts `insertCode { text }` (dropped unless `text` is a string of at most
  `REPLY_MAX_LENGTH` characters, since a block cannot be longer than its reply); the host replaces every selection of
  `window.activeTextEditor` with it, inserting at each caret, in one `editor.edit`, so one Undo restores it. No active
  text editor, an edit the editor refuses (a read-only document, such as the write approval's diff), and an edit that
  throws each show a native error notification and change nothing. VS Code's `edit` settles `true` on a read-only
  document although nothing applied, so an edit counts as refused when it settles `false`, or when the document's
  version did not change and some selection does not already hold the text (then nothing needed changing: `done`). A
  success shows nothing, and neither button moves the focus. The buttons take no room in the block, sit on the panel's opaque ground so
  the code under them never shows through, and are not selectable (`user-select: none`), so their labels are never part of selected text, in a quote or in a plain copy.

## Quote

- A "Quote" button (French "Citer", its accessible name) shows under an answer while the page's selected text lies in
  that answer's rendered Markdown, code blocks included (`Answer`, `holdsSelection`). All of this must hold: the
  selection is not collapsed and holds more than whitespace (a selection in the message box or another text field
  reports collapsed); it starts inside one answer's `.answer` block; whatever it covers outside that block is whitespace
  only, so a triple click on an answer's last paragraph, which ends at the start of the next block, counts; and the
  panel has a message box (a provider is configured or a reply is in flight). The Quote row is skipped by that check
  and is not selectable, so its label never joins the selected text and its showing cannot hide it again. Every
  rendered answer counts: a final reply, the text before a tool call, a reply inside an opened fold, a summary. A
  selection in a user message, a tool step, reasoning, or one that covers text of two entries shows nothing.
- The check runs on every `selectionchange` and after every render, since removing the selected node changes the
  selection without an event. The button goes when the selected text collapses, leaves the answer, or loses its text
  because the answer's content was replaced; an unrelated render that leaves the selected text in place keeps it. So
  Quote works for an older answer, or a finished paragraph, while a reply is in flight.
- The button is a secondary `<button>` in a row of its own directly under the answer's Markdown, before that reply's
  tool step and approval controls, so nothing focusable comes between the approval controls and the message box. No
  room is kept for it: when it shows, what is under the answer moves down by one row, and the conversation's rule for
  following its bottom applies unchanged. Tab from the selection reaches it; Enter or Space activates it, and the
  selection survives until the quote is read. Escape does nothing new. When the button goes while it holds the focus,
  no focus is moved.
- A click reads the selected text as rendered (`Selection.toString`: no list markers, backticks, or emphasis marks)
  and does nothing when no text of the answer is selected any more. `quoteDraft` trims it, prefixes each line with
  `> `, writes a line that is empty or whitespace only as `>` alone, and ends the quote with a blank line. A blank
  message box is filled with it; otherwise the box's text loses its trailing whitespace, then a blank line and the
  quote follow. The message box takes the focus with the caret at the end, no menu opens, the picked paths stay, and
  nothing is posted to the host: the text travels as webview state beside Edit's draft (`App`'s `quoting`), not as a
  `DraftInsert`.
- A quote is ordinary text of the draft: sent or queued as typed, a line starting with `> ` is no command, and the
  host trims the trailing blank line at send. Mentions in it are read at send like any typed text (`@path` attaches,
  a quoted `@dataclass` shows a failed chip). With Edit's replacing mark on, the quote is appended and Send still
  replaces the last turn.

## The question block

- The question block (#143): while `ChatState.question` is set, the reply in flight whose `ask_user` call has no step
  yet shows the call's row and the question's controls in one block, where an approval's decision block renders
  (`DESIGN.md`, "The decision block"). The state, the `answer` message, and the cancellation are specified in
  `docs/spec/harness.md` ("Approvals, modes, ...").
- The row shows the tool name, the first line of the question (`mainArgument`: the `question` argument trimmed, whatever
  order the model wrote the arguments in, and nothing when it has none), and "waiting for your answer". The block then
  shows the question in full with its line breaks, a span between two backticks on one line as inline code
  (`splitInlineCode`; no other Markdown, so the model's line breaks stay), one button per option in the order given,
  then a free-text field
  ("Your answer") with an Answer button. A question without options shows the field and Answer only.
- An option click posts `answer { id, text }` with that option's text. Answer, and Enter in the field (not while an
  IME composes), post it with the field's text, trimmed; neither posts while the field is empty after trimming, and
  Answer is then disabled. The field takes at most 4,000 UTF-16 units (`maxLength`, `MAX_ANSWER_LENGTH`).
- The DOM order is the visual order: the options, the field, Answer. Nothing focusable sits between the block and the
  message box: from the message box, Shift+Tab reaches Answer (when enabled), then the field, then the options from
  last to first. The focus does not move when the block opens.
- The text typed is the block's own state, keyed by the question's id: it survives opening and closing History, a new
  question starts with an empty field, and when the view is hidden and shown again the question is still open but the
  text typed and not yet sent is lost, like an unsent approval reason.
- While the question is open, its row names the tool only, since the question shows whole under it. Once answered,
  the step is an ordinary row: the first line of the question, then "you answered", the answer on a line of its own
  under the row (`stepNote`); the
  expanded row shows the result, `The user answered: <text>`. A folded turn counts an `ask_user` step among the "other
  steps", and History's content search does not search tool results, so an answer is not found by it (both accepted,
  #143).

## Queued messages

- Queued messages (#70): while a reply is in flight, Send and Enter post `queueMessage { text, mentions }` (validated
  like `send`) instead of `send`, and the box clears; with no model, or a mode change pending, Send does nothing, as
  before. `ChatController.queueMessage` appends `{ id, text, mentions }` (`QueuedMessage`, the id the controller's, the
  text trimmed) to `ChatState.queue` while a reply is in flight. The host decides, not the webview, whose box is
  already cleared and whose state may lag (maintainer decision, 2026-11-12): a message it does not queue goes back to
  the message box through the `returnDraft` port, never dropped: exactly a built-in command (`builtInCommand`; the
  webview leaves one as text in the box during a reply), and a message past `MAX_QUEUED_MESSAGES` (10, since the whole
  state is posted at each delta; the panel also says the queue is full and leaves the text in the box). A
  `queueMessage` that arrives with no reply in flight is sent at once as `send` would when a turn may start and the
  queue is empty, and otherwise goes back to the box, so no message waits paused because of a late request. Blank text
  is dropped. A `send` that arrives while a reply is in flight goes through `queueMessage` the same way: the panel may
  have posted it on a stale snapshot, such as the `done` of a turn whose end has already started the next queued
  message. A `send` that cannot start a turn otherwise (a mode write pending, no provider or model) goes back to the
  box. `send` runs the turn (`runTurn`, which returns its last status) and, only once it has fully settled
  (after `runReply`'s `finally`, which clears `this.reply` for a turn and a summary alike, never inside `settle`, since navigation awaits `reply.settled`) and
  only when it ended `done`, sends the first queued message (`sendNextQueued`): it peeks, checks `mayStartTurn`
  (provider and model chosen, no reply in flight, no mode write pending, no undo running; the one check `send` and
  `/compact` share), then takes it
  off the queue and calls `send` in the same step, so it is never shown in both places, and the message goes as if
  typed then (mentions read, a `/<name>` skill loaded, provider, model, mode, and limits of that moment). The next
  waits for that turn. When the check fails (the model gone after a failed listing), nothing is sent and it stays
  first. A turn ending `stopped`, `failed`, or `halted` sends nothing. The queue is paused when it holds a message and
  no reply is in flight (`isQueuePaused`, derived, never stored): the panel says so, with the rule (it moves on only
  after a turn that completes) and the way on (Send now), and the first message has "Send
  now", `sendQueued { id }`, which acts only on the first message and only when Send would; its turn ending `done`
  resumes the queue. A message sent normally while paused goes first, and its `done` resumes the queue too.
  `removeQueued { id }` removes one; `editQueued { id }` (Edit) removes it and returns its text and picked paths to the
  box; for either, an id no longer queued (sent meanwhile) does nothing, so a sent message never lands in the box too.
  Edit focuses the message box at the click (the third focus move DESIGN.md allows). Returned texts are one
  `insertDraft` of mode `paragraph` (`DraftInsert`) per request, the texts in queue order joined by a blank line, the
  picked paths each once: `applyDraft` fills a blank box with it, else appends it after a blank line. The host queues
  it in the `DraftQueue` without showing the view (`ChatView.returnDraft`, `DraftQueue.queue`), since the request came
  from the panel, so a hidden panel gets it at its next `ready`; the webview applies it like an editor draft, but it
  closes no History and moves no focus, and it is never dropped: while the panel has no message box (no valid provider)
  it waits in Root's list and lands, in order, when the box comes back. The extension always wires the port; one that
  is absent (a controller built without it, as in the tests and the eval) or throws logs the text as lost. The rows sit under the
  message box, after the mode selector, Send, and Stop in the tab order (DESIGN.md: nothing focusable between the
  approval controls and the box), each with Edit and Remove; queuing moves no focus. The queue lives in `ChatState`
  only: never in the record, kept while the panel is hidden, lost at a window reload. Deactivation calls
  `ChatController.dispose`, which empties it without returning anything and stops the reply, so nothing is sent.
  Steering (a message inside the running turn) is out of scope: it would put a user message next to a tool result.

## Retry, Continue, and Edit

- Retry and Continue (#111, parent #73): the last turn is the last user entry and every entry after it.
  `lastTurnActions(entries)` (`lastTurn.ts`, loaded by the webview and the controller alike) says whether it offers
  them and under which reply they show: nothing while a reply is in flight, without a user entry or an entry after it,
  or when a completed `/compact` summary follows the user entry (`historyStart` past it at a summary that is not
  automatic; maintainer decision: that summary is kept, so nothing is offered); otherwise Retry, under the turn's last
  reply that is not a summary (else the summary that took its only reply), whatever its status, and Continue too when
  the last entry is no summary and that reply ended `stopped`, or `halted` on `stepLimit` or `malformedCalls`
  (`contextFull` would halt again: it keeps pointing to `/compact` and New chat). The panel renders them before "Undo
  changes" in one row, after "Changed files" and the undo's outcome (see `docs/spec/harness.md`), enabled when Send would act (`sendWouldAct`, the composer's one check). Each request carries
  what the panel showed (`ShownEntries`: `retry { shown }`, `continueTurn { shown }`, `shown` being `{ conversationId,
  entries }`, the id validated like `openConversation`'s, the count like a request id); the controller
  (`lastTurnNow`) ignores it unless that is the conversation shown with its current count, `mayStartTurn` passes, and
  `lastTurnActions` (with Continue's condition for Continue) holds as the host sees it, so a click on a lagging panel
  removes nothing, also when the host has meanwhile shown another conversation with as many entries. Within the
  conversation shown the count is the only check (no turn revision): a request posted before a Retry that ended on as
  many entries acts on the turn that Retry ran (accepted).
  `ChatController.retry` removes every entry after the user entry (`removeFrom`: replies, tool steps, the turn's
  automatic summary, and an unsent summary) and runs the turn again from that same entry object (`TurnStart`
  `retry`), so its model text of then is resent: mentions and `SKILL.md` are not read again, a skill it loaded stays
  loaded, and an entry never composed (Stop during its mention read) goes as typed. Everything else is read as for a
  send (provider, model, Plan, limits, key, instruction files, skills and their warnings). The removal is synchronous
  with the turn start and saved by the turn's first save, before the request; a crash before it keeps the
  conversation whole. `removeFrom` drops the held turn, `lastTurn`, and the undo outcome when their reply is in the
  removed range, so "Undo changes" and "Changed files" for the removed attempt go, with their diff tabs, and a write of it that lands after its Stop is not
  held; a turn held from before the user entry stays held. `ChatController.continueTurn(shown, label)` removes
  nothing: it appends a user entry whose typed text is `label` (the host passes `l10n.t("Continue")`, since the
  controller imports nothing from `vscode`) and whose model text is `CONTINUE_TEXT` (`Continue from where you
  stopped.`), no mention, no skill, and runs it as a send (`TurnStart` `continue`: a new step budget). After a
  `stepLimit` or `malformedCalls` halt, the last tool result and `CONTINUE_TEXT` go as one `user` message, joined after
  a blank line, as a typed message there does. Both go through `startTurn`, `send`'s turn start: Stop, saving, folding, and the queue (Send
  queues meanwhile; ending `done` sends the first queued message, so a Retry resumes a paused queue) work as for any
  turn. Files written and commands run by the removed steps are not reverted: when `unrevertedEffects(entries, user +
  1)` counts a write step that applied and is not undone (`write_file` or `edit_file`, `ok`) or a `run_command` the
  user ran (`accepted`), or "Undo changes" is offered for that turn (`ChatState.undo.reply` past the user entry), the
  panel's first click on Retry posts nothing: a line says what is not reverted and that "Undo changes" gets the files
  back first, the same button reads "Retry anyway" (the focus stays on it), and Cancel follows it; the second click
  posts `retry`, and Cancel, or any change of the turn's entries (one added or removed, a status, an `undone` mark,
  compared as their JSON text while the confirmation is open, since unrelated posts resend the whole state), drops the
  confirmation (scouting decision, 2026-11-12: in the chat, no native modal). Accepted gap: a command whose step Stop dropped, in a turn that wrote nothing, is not
  warned about. `ChatState` and the record are unchanged.
- "Implement in ... mode" (#102, ADR 0005, addendum of 2026-11-13): while Plan is on (`ChatState.mode` is `plan`), the
  conversation's final answer shows one more secondary button in the last turn's actions, first in the row, in weight
  600, since carrying the plan out is the step the user came for: before Retry (and before "Retry anyway" and Cancel
  while Retry's confirmation is open) and "Undo changes". `hasFinalAnswer(entries)`
  (`lastTurn.ts`, loaded by the webview and the controller alike) decides "the final answer": the last entry is an
  assistant entry that is not a summary, ended `done`, with text that is not empty after trimming. So no button
  during a reply, after a turn that ended `failed`, `stopped`, or `halted`, after a `/compact` (its summary is then
  the last entry), or on an empty conversation; an automatic summary earlier in the turn changes nothing. The
  conversation does not record the mode of its turns, so the button shows under any such answer while Plan is on,
  also in a conversation opened from History (accepted). Its label names the mode Plan leaves for,
  `ChatState.settingMode`: "Implement in Ask mode" or "Implement in Auto-edit mode", following a change of the
  setting at once. It is disabled when Send would not act (`sendWouldAct`), and absent, not disabled, during a
  reply; while Edit's replacing state holds it acts as usual, as Retry does. A click posts `implementPlan { shown }`,
  validated like `retry`, and carries no mode. `ChatController.implementPlan(shown, label)` (see
  `docs/spec/harness.md`, modes) leaves Plan without writing the setting and starts an ordinary turn through
  `startTurn`: the host passes `l10n.t("Implement the plan above.")` as the entry's typed text, and the model gets
  the fixed English `IMPLEMENT_PLAN_TEXT`, as for Continue. The plan is in the history already and is not quoted
  again. A second click cannot act: Plan is off and a reply is in flight. Ending `done`, the turn sends the first
  queued message, in the mode then in force, as after any send. The record is unchanged.
- Edit (#112, parent #73): the last user entry has Edit when the last turn offers Retry (`lastTurnActions`, the same
  conditions), enabled when Send would act. A click changes nothing on the host or on disk and posts nothing: the
  message's text as typed goes into the message box as a returned text does (`editDraft` through `applyDraft`, mode
  `paragraph`: it fills a blank box, else follows the draft after a blank line), with the paths of its file and folder
  mentions as picked paths, so a path with spaces stays one mention (the entry does not say which were picked; a picked
  path counts only while its `@<path>` stands in the text, so giving them all is safe), a reserved mention staying
  typed text; the mention menu stays closed on a token the caret ends on; and the message box takes the focus. The
  panel then holds the replacing state (a `ShownEntries`: the conversation id and entries count at the click), in `App`
  only, never in `ChatState` (scouting decision, 2026-11-12: the webview is not retained while hidden, so the box's text
  is lost there too, and the host keeps nothing in step). While it holds, Edit goes, and the last turn (that message and
  every entry after it) renders in one group (`.replacing`) under the line "Sending replaces this message and its
  replies.", with Retry's warning added when Retry would ask (`unrevertedEffects`, or "Undo changes" offered for the
  turn), and Cancel. The group is not dimmed, like the entries no longer sent. That line is the confirmation; Send
  is the consent (no extra click, scouting decision). It ends, removing nothing, on Cancel (the box keeps its text,
  the focus goes back to Edit), and for good once `stillReplacing` fails: another conversation shown, another entries
  count, a reply in flight, or Edit no longer offered; it is lost with the box's text when the panel is hidden or the
  window reloads. Retry, Continue, Send now, and the built-in `/new`, `/model`, and `/compact` act as usual and never
  replace. A Send while it holds posts `send { text, mentions, replaces }`, `replaces` that `ShownEntries` (validated
  as for Retry; absent, the send is the ordinary one; a `queueMessage` never carries it). `ChatController.send(text,
  picked, replaces)` then, in one synchronous step before the first save: checks `mayStartTurn` and `lastTurnNow`
  (the conversation and the count are the current ones and the last turn still offers Retry), removes the last user entry and every entry
  after it (`removeFrom`, which drops the held turn, `lastTurn`, and the undo outcome with it, a turn held from before
  staying held), and starts an ordinary send (mentions read now, a `/<name>` skill loaded now, the settings of now).
  The turn's first save, before its request, writes the record without the removed entries: they are gone for good; a
  crash before it keeps the conversation whole. A failed check removes nothing and returns the text to the box
  (`giveBack`), as for any send that cannot start a turn; during a reply the message is queued as an ordinary one;
  blank text is dropped. A completed `/compact` summary after the last user entry is kept, so Edit is not offered
  there (maintainer decision). `ChatState` and the record are unchanged.

## Recall of earlier messages

- Recall (#108): in the message box, ArrowUp and ArrowDown walk the user messages of the conversation shown, in the
  webview only (`composerKeyAction` decides, `Composer` holds the place; no host message, no protocol or record
  change). The list is every user entry of `ChatState.entries` in order, its text as stored for display (`content`,
  never the composed text): a message with mentions, a `/<skill> args` message, a Continue entry (its label), messages
  before a summary, and the message of the turn in flight. Consecutive entries with the same text count once, the
  newest of them giving the mentions. `/new`, `/model`, `/compact`, a queued message, and a message Edit replaced have
  no user entry, so they are not in it.
- Start: ArrowUp with no input method composing, no menu showing rows, no Shift, Alt, Control, or Meta, a collapsed
  selection, a blank box (whitespace only counts as blank), and a non-empty list puts the newest message in the box,
  replacing that whitespace. Otherwise, and for ArrowDown in a blank box, the key keeps its default.
- The recall remembers one thing (`RecallPlace`): the conversation, the index among the entries, and the text of the
  message recalled. It is in progress while that conversation is shown, the entry at that index is still a user
  message with that text (`recallHolds`), and the box's text is exactly that text: any edit suspends it, and undoing
  the edit resumes it. With the same conditions on composition, menu, modifiers, and selection, ArrowUp with the caret
  on the first line goes to the next older message, and at the oldest is consumed and changes nothing (no wrap);
  ArrowDown with the caret on the last line goes to the next newer one, and past the newest empties the box. Lines are
  logical lines, cut at line breaks (wrapped lines are not considered); with the caret elsewhere the arrows move it as
  usual. Example with `A`, `b1⏎b2`, `C`: ArrowUp gives `C`, then `b1⏎b2`, then moves the caret into `b1`, then gives
  `A`, then does nothing; ArrowDown gives `b1⏎b2`, `C`, then an empty box.
- Every recall puts the caret at the end, and replaces the box's picked paths with those Edit computes for the message
  (`editDraft`), the mentions the entry holds at that moment (the turn in flight may hold none yet: accepted); emptying
  the box clears them. A text ending on a `/` or `@` token opens no menu (its token is dismissed, as after Edit), so the
  next ArrowUp still recalls; the file query the box posts for an `@` token at the caret may still go.
- The place is forgotten for good when the conversation shown changes (coming back does not resume; the text stays
  as a plain draft), when a send or a built-in command clears the box, when ArrowDown empties it, when a draft is
  applied (an editor entry point, a returned queued message, Edit, Quote), and when the entry at that index is gone
  or holds another text. Erasing the box by hand does not forget it: ArrowUp in the blank box starts again from the newest
  message. Sending a recalled message is an ordinary send (mentions read again, a `/<skill>` loaded again, a recalled
  Continue sent as plain text, queued during a reply); while Edit's replacing state holds, Send still replaces.

## Announcements

The focus never moves to report a change (DESIGN.md, "Keyboard and focus"), so the panel keeps one polite live region
for screen readers. `describeAnnouncement` (`src/webview/text.ts`) compares each state the host posts with the one
before, in the same conversation, and says at most one thing:

- a new approval request: "Waiting for your decision: run {command}" or "Waiting for your decision: {tool} on {path}";
- a new question: "The agent asks: {question}", then the count of its options when it has any ("(1 option)", "(3
  options)"), since the reader hears nothing of its buttons until reaching them (the jump row says the question alone);
- a call that starts running, as the host marks it (`ChatState.callRunning`, `docs/spec/harness.md`): "Running
  {command}" for `run_command`, else "Running {tool} on {argument}" (`mainArgument`), or "Running {tool}" without
  one. A call that asks is named only once its approval is accepted, never as it shows nor after Reject, Stop, or an
  answer to a question;
- the reply in flight ending: "Reply finished." when it ends `done` without a call, "Stopped", or the halt's reason.

It says nothing for a failed reply (its error block is an alert), a reply that ends on a call (its step follows),
another conversation shown, or the first state. Copy adds its outcome, "Copied" or "Copy failed".
