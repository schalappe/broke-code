# broke-code

A VS Code chat extension that runs a coding agent against LLM services without native tool calling. The model
writes its tool calls in the text of its reply, and the extension reads and runs them.

## Agent loop

**Native tool call**:
A tool call carried by the API's dedicated tool fields, outside the reply text. broke-code never uses it.
_Avoid_: function calling, tool mode

**Body tool call**:
A tool call the model writes inside the text of its reply, in the format the harness prescribes.
_Avoid_: simulated tool call, text tool call, fake agentic mode

**Harness**:
The loop that sends the prompt, reads body tool calls from the reply, runs the tools, and feeds the results
back to the model.
_Avoid_: agent mode, simulated agentic mode, runner

**Agent turn**:
One user request and every tool call and tool result it triggers, up to the model's final answer: a reply with text
and no call. An empty reply is no final answer.
_Avoid_: run, task, iteration

**Tool step**:
One body tool call inside an agent turn and the result sent back to the model; a malformed call, or an empty reply, and
the message saying what is wrong count as a step too. The chat shows each step as a compact row. When a request would
fill the model's context, the oldest steps' results go to the model as one line saying they were left out; the chat and
the saved conversation keep them whole. Once an agent turn has ended, the steps and replies before its last reply fold
under one row ("3 steps, 1 failed, 1 rejected") when they hold at least two steps; the last reply, and a step after it,
stay in view.
_Avoid_: tool use, action, iteration

**Approval**:
The user's Accept (Run, for a command) or Reject of a tool call that changes the workspace or runs a command, given in
the chat while the agent turn waits; a rejection, with its optional reason, goes back to the model as the call's
result. A setting can approve writes without asking, never commands.
_Avoid_: confirmation, permission, consent

**Mode**:
What an agent turn may do, shown and picked in the message box: **Ask** waits for the user's approval of each write;
**Auto-edit** approves writes without asking; **Plan** offers the read tools only, so the model answers with a plan and
nothing is written or run. Ask and Auto-edit are the user setting `brokeCode.autoApproveWrites`, so they apply to every
window; Plan is kept per workspace and wins over the setting while on. A turn reads Plan when it starts. Commands wait
for Run in every mode that offers them.
_Avoid_: agent mode, approval mode, permission mode

**Queued message**:
A message the user sends while an agent turn is in flight. It waits, under the message box, and is sent as if typed
then when a turn ends with a final answer, its mentions read and its skill loaded at that moment; one turn each, in
order, at most 10. A turn that ends any other way pauses the queue until "Send now" or a turn that ends with a final
answer. Edit puts it back in the message box; New chat and leaving the conversation shown put every queued message
back there. Never saved, and lost at a window reload.
_Avoid_: pending message, steering, follow-up

**Conversation**:
One thread of messages in the chat panel, saved per workspace and listed in its history; a new chat starts a new
one.
_Avoid_: session, thread, task, history item

**Reasoning**:
The text a model writes before its answer to work the problem out, shown collapsed in the chat, never sent back
to the model, and never read for body tool calls.
_Avoid_: thoughts, chain of thought, thinking

**Code block**:
A block of code in an assistant answer's Markdown, fenced or indented. Once its text is final it has Copy and Insert
at cursor, which take its code without the fence lines and its final line break. The call block, a tool step's result,
reasoning, and a user's message are not code blocks.
_Avoid_: snippet, code fence (for the whole block)

## Connection

**Provider**:
An LLM service broke-code talks to, identified by a base URL and an optional API key, that serves one or more
models through the OpenAI chat contract. Configured in the user settings, by hand or with "Add provider", which also
stores its key.
_Avoid_: profile, endpoint, backend, connection

## Commands and skills

**Mention**:
A reference to a workspace file or folder typed as `@path` in a chat message, whose content is attached to
that message. A reserved mention is one whose path is exactly a reserved name, such as `@problems` (the errors and
warnings VS Code holds for the workspace files), `@diff` (the uncommitted changes of their tracked files), or
`@selection` (the selected text of the active editor, with its file and line range): it is read from the editor, never
from a path, and a file of that name is mentioned as `@./<name>`.
_Avoid_: context item, attachment, reference

**Draft**:
The text in the chat's message box, not sent yet, with the paths picked in it. "Add selection to chat" and the quick fix
"Fix with broke-code" edit it from the editor and never send it.
_Avoid_: prompt, input

**Skill**:
A named set of instructions, stored as a `SKILL.md` file, that the model or the user can load into the
conversation.
_Avoid_: plugin, prompt template, custom command

**Loaded skill**:
A skill the model or the user loaded in this conversation, the model with `load_skill`, the user with `/<name>`: the
conversation holds its instructions, and the read tools may read its folder until the conversation ends. After a
summary, a skill loaded before it keeps its folder readable, but its instructions are no longer sent, so the model's
next `load_skill` of it returns them again. A folder outside the workspace stays read-only to the file tools (an
approved command is held to no folder); a workspace skill's folder follows the workspace rules.
_Avoid_: active skill, enabled skill

**Personal skill**:
A skill in `~/.agents/skills/`, available in every workspace; a workspace skill of the same name hides it.
_Avoid_: global skill, user skill

**Workspace skill**:
A skill in a workspace folder's `.agents/skills/`, shared with the repository; the first workspace folder wins
over a later one with the same name.
_Avoid_: project skill, local skill

**Slash command**:
A word starting with `/` typed in the chat box: either a built-in action or the name of a skill to load.
_Avoid_: command, shortcut

**Summary**:
A reply in which the model summarizes the conversation so far: the user asks for it with `/compact`, or, with
automatic compaction on, an agent turn asks for it itself when its next request would not fit the context. Once it
ends with text, every later request sends the summary in place of everything before it, an automatic one followed by
the turn's user message; the earlier entries stay in the chat and the saved conversation, marked as no longer sent. A
summary that fails, is stopped, or comes back empty changes nothing.
_Avoid_: compaction (for the reply itself), recap, condensed history

**Automatic compaction**:
The opt-in user setting `brokeCode.autoCompact`: an agent turn that would stop on a full context asks for a summary
instead, at most once per request, and goes on.
_Avoid_: auto-summarization, auto-compact mode

## Source control

**Generated commit message**:
A commit message the model writes from the staged diff of a git repository, at the user's click in the Source Control
view, with the provider and model selected in the chat. It is written to the commit input box once the reply has
ended; it is no agent turn and belongs to no conversation.
_Avoid_: AI commit, commit suggestion, auto-commit
