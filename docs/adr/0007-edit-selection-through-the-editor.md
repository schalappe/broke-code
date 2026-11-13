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
disk, without saving: one Undo restores it, and the user's unsaved changes stay. It applies only when the document's
text from its start through the end of the range sent is still the text sent; otherwise nothing is edited and a
notification says so. The text is read again when the request is sent, with the same check, so the request and the
diff show the document as sent. A `file` document closed meanwhile
is opened again from its URI and compared the same way.

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
- The range is checked by its offsets and the text from the document's start through its end, so an edit above the
  selection refuses Accept even when identical text now sits at the old offsets. An edit after the range does not.
  The check is by text only: a copy of the selected line pasted right above it leaves that text unchanged, cannot be
  told from a copy pasted below, and Accept edits the first of the two identical lines.
