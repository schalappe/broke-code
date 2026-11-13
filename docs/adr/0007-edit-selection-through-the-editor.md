---
status: accepted
---

# "Edit selection" rewrites the selection in one request and edits the open document through the editor

To change a piece of code, a user had to start an agent turn: "Add selection to chat", then a message. The agent loop
needs several requests and well-formed body tool calls (ADR 0001), which the internal service's models get wrong more
often than a plain rewrite. "broke-code: Edit selection" (#144, part of #107) asks for an instruction, sends the
selection to the chat's model in one request, and shows the rewrite as a diff to accept or reject.

## Decision

The command is a request outside the chat, as the commit message is (ADR 0004): one streaming request through
`streamChat` to the provider and model selected in the chat, no tool, no harness, no conversation. The request holds
the selection, the lines around it cut to the chat's context threshold, and the instruction; the reply is cleaned
(reasoning, one wrapping fence, the indentation re-based on the selection's) before it is shown.

The rewrite is shown in VS Code's diff editor between two read-only virtual documents of a scheme of their own, the
document's text as sent and that text with the selection replaced, with Accept and Reject in the diff tab's title bar.
Both sides are snapshots: ADR 0002 rejected a live left side for the approval diff, for the same reason, a diff that
changes under the user is not the one they judged.

Accept edits the open document through the editor, with one `WorkspaceEdit` on the document's URI, never the file on
disk, without saving: one Undo restores it, and the user's unsaved changes stay. It applies only when nothing changed
at or above the end of the selection since the command started; otherwise nothing is edited and a notification says
so. Two checks enforce that rule. From the moment the command reads the document until the run ends, the run watches
the document's content changes (`workspace.onDidChangeTextDocument` for its URI): a change whose range starts before
the selection's end, in the document as it was before that change, marks the run changed; a change starting at or
after the end does not. And the document's text from its start through the selection's end must still be the text
read, which covers a file closed, changed on disk, and opened again, whose changes the watch may not see. The text is
read again when the request is sent, with both checks, so the request and the diff show the document as sent. A
`file` document closed meanwhile is opened again from its URI and compared the same way.

This differs from the agent's writes on purpose. The agent writes files on disk atomically, after an approval, and
refuses a file with unsaved changes in an editor (ADR 0002), since an agent turn acts on the workspace and its undo is
"Undo changes". Here the user starts an explicit editor command on the text in front of them: the editor's own undo
is the way back, and an unsaved document is the normal case.

This command is not the "inline completion" that v1 excludes (`PRODUCT.md`, AGENTS.md "Boundaries"): nothing is
suggested while the user types; the user selects code, runs a command, and writes an instruction.

## Considered options

- **An agent turn with the selection mentioned.** Rejected: that is today's path, and its several requests and tool
  calls are what fails with the internal service's models.
- **Writing the file on disk, as the agent does.** Rejected: it would refuse or race a document with unsaved changes,
  and the editor's Undo would not restore it in one step.
- **`TextEditor.edit`.** Rejected: it needs the document open in a visible editor, and reports success on a read-only
  editor (`src/core/insertCode.ts`).
- **A live left side.** Rejected, as in ADR 0002.
- **Accept and Reject in a notification.** Kept only as the fallback if the title-bar buttons cannot be scoped to the
  diff tab (maintainer decision, 2026-11-13).
- **Streaming the rewrite into the document, per-hunk accept, CodeLens.** Out of scope.

## Consequences

- broke-code now sends the selected code and the lines around it to the selected provider, at the user's command
  only. The README "Privacy" section says so.
- The provider and model lookup (`ChatModel`) is shared by the commit message and this command.
- A request the provider ended at its length limit is shown like a complete one, as in the chat; the user sees it in
  the diff.
- Any edit at or above the selection's end refuses Accept, even one that leaves the text through the end identical,
  such as a copy of the selected line pasted right above it. An edit after the selection does not. An edit above the
  selection that is undone before Accept still refuses it: the watch records that a change happened, not whether the
  text came back. A text comparison alone was rejected because it cannot tell a copy of the selected line pasted above
  it from one pasted below, and Accept would edit the upper copy.
- Each run holds one change subscription, disposed when the run ends, whichever way it ends.
