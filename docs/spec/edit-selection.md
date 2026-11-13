# Edit selection

This file specifies the command "broke-code: Edit selection": one request that rewrites the editor's selection, shown
as a diff to accept or reject, and its three presets. ADR 0007 records the decision behind it; ADR 0004 is the precedent of a request outside
the chat.

## Entry points

- The command `broke-code.editSelection` ("broke-code: Edit selection") is in the Command Palette and in the
  `broke-code` submenu of the editor's context menu. It has no default keybinding.
- The submenu (`broke-code.editor`, label "broke-code") is the `editor/context` entry, group `broke-code`, shown when
  `editorHasSelection`. It holds "Add selection to chat" (`broke-code@1`), "Edit selection" (`broke-code@2`, also
  `!editorReadonly`), and the three presets (`broke-code@3` to `@5`, see Presets). "Add selection to chat" is no longer a direct entry of the context menu
  (`docs/spec/mentions.md`).
- Accept (`broke-code.acceptEdit`, `$(check)`) and Reject (`broke-code.rejectEdit`, `$(close)`) are in `editor/title`,
  group `navigation`, `when` `resourceScheme == broke-code-edit`: only on an edit's diff tab, never on an ordinary
  editor or a write approval's diff (`broke-code-change`). The Command Palette hides both (`when` `false`).

## Presets

Three commands run the same flow with a fixed instruction and no input box: the same checks, request, cleaning, diff,
Accept and Reject. `EDIT_PRESETS` (`src/core/editSelection.ts`) maps each command to its instruction, model-facing
English whatever the display language:

| Command | Title (French) | Instruction |
|---|---|---|
| `broke-code.refactorSelection` | Refactor selection (Refactoriser la sélection) | `Refactor this code to make it simpler and easier to read. Keep its behavior and its public names unchanged.` |
| `broke-code.documentSelection` | Add documentation comments (Ajouter des commentaires de documentation) | `Add documentation comments to this code, in the documentation style of its language. Change nothing else.` |
| `broke-code.typeSelection` | Add types (Ajouter les types) | `Add explicit type annotations to this code where the language allows them. Change nothing else.` |

- Each is in the Command Palette with the category `broke-code`, where the category leads the title, and in the
  `broke-code` submenu, where the title shows alone. One command has one title in both places: the context menu does
  not render a short title. None has a default keybinding.
- The submenu's five entries carry an explicit order, since VS Code otherwise sorts a group by title, differently in
  each language: Add selection to chat (`broke-code@1`), Edit selection (`@2`), Refactor selection (`@3`), Add
  documentation comments (`@4`), Add types (`@5`). The four edit entries are hidden in a read-only editor
  (`!editorReadonly`).
- A preset's run is the document's run: a preset and "Edit selection" on the same document refuse each other.
- The cleaning needs no rule of its own: a fenced example inside a documentation comment is code holding a fence, kept
  whole.

## A run

`SelectionEditor.run` (`src/core/editSelection.ts`) checks, in this order, and each refusal is a notification with
nothing sent:

1. The active text editor's primary selection and its document, read when the command runs (`readEditor` in
   `src/extension/editSelection.ts`): the text and the selection's offsets together, before the writable check
   waits. No active text editor or an empty selection: "Select the code to edit first.".
   A document of a scheme other than `file` or `untitled`, a file whose file system is not writable
   (`workspace.fs.isWritableFileSystem`), or a file the user may not write (`access(W_OK)`, `isWritableDocument`): "broke-code can edit a
   selection only in a writable file or an untitled document.". A file deleted since it was opened counts as
   writable: the edit goes to its document. Other read-only states (a session's read-only editor,
   `files.readonlyInclude`) cannot be read through the editor API: the submenu hides "Edit selection" there, and from
   the Command Palette the run proceeds; VS Code decides what happens to the edit at Accept.
2. A run in progress on the document, by URI: "An edit is already in progress for {0}.". The document is taken from
   here until the run ends.
3. The provider and model selected in the chat, read now and kept for the run (`ChatModel`, the lookup the commit
   message command shares). None: "Choose a provider and a model in the broke-code chat first.".

Then the instruction, from a function the caller passes to `run` (`editInstruction`). For "Edit selection" it is an
input box ("Edit selection", the file's name in its prompt, `ignoreFocusOut`); Escape or a blank instruction ends the
run with nothing sent and frees the document. For a preset it is the preset's text, and no input box opens.

Then the document is read again, as Accept reads it (`openDocument`). When it no longer exists or is closed, or its
text from its start through the selection's end differs from the text read in step 1: "The text changed since the
request. Nothing was edited.", nothing sent. Otherwise its whole text now is the snapshot the run keeps: the request's
context, both sides of the diff, and the text Accept compares. The selection keeps the offsets read in step 1. Then
the budget, then the request.

## The request

One streaming request through `streamChat` to the chat's provider and model, as the commit message command sends it
(ADR 0004): never `tools`, the usage field handled the same way, and a reply of at least 1,000 reported prompt tokens
teaches that model's ratio to the chat. It belongs to no conversation and saves nothing.

- The system prompt (`EDIT_SELECTION_PROMPT`) asks for the rewritten selection only: no explanation, no code fence. It
  says the lines around the selection are read-only context.
- The user message (`composeEditRequest`) holds, each part labeled: `File:` the path relative to its workspace folder
  (no folder name, `/` separators; the file name outside the workspace folders; `untitled` for an untitled document,
  `requestPath`), `Language:` the language identifier, the lines before the selection in `<before>`, the selection in
  `<selection>`, the lines after it in `<after>`, both context blocks marked read-only, and the instruction last. A
  selection starting inside a line makes that line's start the last line before it; one ending inside a line makes
  that line's rest the first line after it. Line breaks are sent as LF. Model-facing text is English.
- The budget: the request fits `largestFittingCharacters` for the model's context size and ratio, the chat's
  threshold (3,500 characters at 1,000 tokens and ratio 4). The fixed part is the whole request without any context
  line but with both notices, `EARLIER_NOT_SHOWN` and `LATER_NOT_SHOWN`, whether they end up used or not. The room is
  the threshold minus the fixed part. A negative room sends nothing: "The selection does not fit the model's
  context.". Otherwise each side gets half the room (the lines before the lower half) and takes whole lines, nearest
  the selection first, while the next line with its line break fits its share. What both sides left is pooled and
  offered line by line to the lines before, then to the lines after, each continuing while its next line fits. A side
  that does not reach the document's start or end carries its notice; a side that reaches it has none.

A progress notification ("Editing the selection…") with Cancel shows during the request. Cancel aborts it and nothing
is shown. A provider error, a stream cut before its end included, is a notification in the chat's wording
(`describeProviderError`) and nothing is shown. A reply the provider ended at its length limit is not told apart from a
complete one, here as in the chat: it is cleaned and shown like any reply.

## Cleaning the reply

`cleanEditReply`, a pure function, when the stream has ended. The reply's line breaks are read as LF.

1. A leading `<think>…</think>` block is dropped (the client already drops one from the stream), then late reasoning:
   the text up to a bare closing think line (`lateReasoning`, as the chat and the commit message apply it). The same
   characters further down are code and stay.
2. A fence line starts, after at most three spaces, with three backticks. Outside a Markdown document (language
   `markdown`): when the text holds exactly one closed fenced block, that is exactly two fence lines, and the block
   opens on the text's first non-blank line or closes on its last, the block's content is taken (a whole-reply fence,
   or prose on one side of the code). Otherwise the whole text is taken: two blocks, an unclosed fence, or one block
   in the middle of other lines, which is code holding a fence, such as an example in a documentation comment. In a
   Markdown document nothing is unwrapped.
3. Leading and trailing blank lines are dropped. Nothing left: "The model returned no code.", nothing shown.
4. The indentation is re-based: the common leading whitespace of the reply's non-blank lines is removed and the common
   leading whitespace of the selection's non-blank lines put in its place, as the same characters (tabs stay tabs).
   When the selection starts inside a line, the first line of the selection and of the reply count for neither, and
   the reply's first line is kept as it is. Blank lines are kept as they are. A selection with no line to measure (one
   line starting inside a line) leaves the reply's indentation as it is.
5. Line breaks become the document's. The result ends with a line break exactly when the selection did.

## The diff

`vscode.diff` opens two read-only virtual documents of the scheme `broke-code-edit` (`EDIT_SCHEME`), served from
memory by a content provider of their own, not the approval diffs': the document's text as sent, left, and that text
with the selection replaced, right. Their paths, `/<id>/original/<name>` and
`/<id>/proposed/<name>`, use an id never reused, so a tab a crashed host left never shows a later run's text, and the
file name gives the diff its language. The title is "{0} (edited selection)" with the file's name. The tab opens
pinned (`preview: false`) and takes the focus. The run gives the diff its id before it opens, so a tab closed while it
opens ends the run like any closed tab. A diff tab that cannot be closed: "Could not close the edit diff." with the
error.

- **Accept** reads the document now (`openDocument`): the open document of that URI, or for a `file` document no
  longer open, the document opened again from its URI (`workspace.openTextDocument`). A closed untitled document, or a
  file that cannot be opened, no longer exists. It applies one `WorkspaceEdit` replacing the range sent, by its
  offsets, to the document, never to the file on disk and without saving, so one Undo restores it. It applies only
  when the document exists, is open, and its text from its start through the end of the range sent is exactly the
  text sent, compared with no wait before the edit; an edit after the range does not count. Otherwise nothing is
  edited: "The text changed since the request. Nothing was edited."; an edit above the selection that moves it is such
  a change, even when identical text now sits at the old offsets. The comparison is by text only: a copy of the
  text just before the range's end, inserted where it leaves the text through that end unchanged (a copy of the
  selected line pasted right above it), cannot be told from an edit after the range, and Accept edits the first of
  the identical lines. When VS Code answers that the edit was not applied: "The document could
  not be edited.". In every case the diff tab closes.
- **Reject** closes the tab and edits nothing. Closing the tab is a Reject: the host watches
  `window.tabGroups.onDidChangeTabs` and `onDidChangeTabGroups` for closed edit diff tabs, and a diff no tab shows any
  more ends its run (a tab moved to another group still shows it).
- Accept or Reject on a tab with no run (left open by a crashed host) closes the tab and does nothing else. From the
  title bar the command gets the editor's resource, either side of the diff; without one, the active tab's.
- The document may hold unsaved changes throughout.

## One run per document

A run lasts from the command, "Edit selection" or a preset, until Accept, Reject, the tab closing, Cancel, or an error. Runs on different documents,
and a chat reply in flight, do not interfere. On deactivation or window reload `dispose` aborts the requests and
closes every edit diff tab, a crashed host's included; nothing is restored after a reload. An unexpected exception is
logged and shown ("Could not edit the selection.") and frees the document.
