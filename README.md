<p align="center"><img src="media/logo.png" width="128" height="128" alt="broke-code logo"></p>

# broke-code

broke-code is a VS Code extension that runs a coding agent against LLM services without native tool calling.

Some services speak the OpenAI chat API but reject the `tools` request field, so agent extensions that rely on
it fail against them. In broke-code, the model writes each tool call in the text of its reply, and the
extension reads and runs it. broke-code never sends `tools`, even to a service that supports them.

The current version is a chat agent that reads and changes your workspace: pick a model, ask a question or a change
with files and folders attached, and the model reads files, lists folders, searches the workspace, creates or edits
files, and runs shell commands until it is done. Each change opens as a diff and waits for your **Accept** or **Reject**
in the chat, unless you turn on auto-approval in your user settings; each command waits for your **Run** or **Reject**,
always. You can follow each step, stop the agent at any time, read the model's reasoning collapsed above its answer,
find a finished agent turn's steps folded under one row above its answer, and come back to past conversations. The model also sees the name and description of each of your skills, and loads a
skill's instructions when your task matches it. Type `/` at the start of a message to start a new conversation, choose
the model, summarize the conversation to free context, or pick a skill; a message `/<name> args` loads that skill itself, with your arguments. In the Source
Control view, a button writes a commit message for your staged changes.

## Requirements

- macOS. Version 1 supports macOS only; Windows and Linux are planned for version 2.
- VS Code 1.101 or later, or a compatible editor such as VSCodium.
- An LLM service with an OpenAI-compatible API: streaming `POST /v1/chat/completions` and `GET /v1/models`.
  Ollama works.

## Configure a provider

A provider is an LLM service broke-code talks to. The quickest way to add one is **broke-code: Add provider**, from
the Command Palette or the button in the chat panel:

- **Ollama on this machine** adds `ollama` at `http://localhost:11434/v1`, with no key. If a provider named
  `ollama` already exists, it is selected instead. Start Ollama first: broke-code does not check it is running, and
  the chat shows the usual error with Retry when it cannot reach it.
- **Other OpenAI-compatible service** asks for a name, the base URL (ending in its version path, such as `/v1`),
  and the API key, which you can leave empty.

The provider is added to your user settings, its key to the editor's secret storage, and the chat selects it. Press
Escape at any step to change nothing. To edit or remove a provider, or to set its `caFile`, edit the settings.

You can also list your providers by hand in your **user** settings
(`settings.json`) under `brokeCode.providers`. Each entry has a unique `name` and a `baseUrl`, the API root:

```json
"brokeCode.providers": [
  { "name": "ollama", "baseUrl": "http://localhost:11434/v1" },
  { "name": "Work", "baseUrl": "https://llm.example.com/v1" }
]
```

broke-code appends `/models` and `/chat/completions` to the base URL. It reads this list from user settings
only: a workspace `settings.json` cannot override it, so a repository cannot send your key to another URL.

## Corporate or self-signed certificates

broke-code trusts the certificates your system trusts. If a provider uses a certificate signed by a corporate
or self-signed authority that is not in the macOS Keychain, the chat reports a certificate error naming the
provider. Add a `caFile` to that provider: an absolute or `~/` path to a PEM file holding the authority's
certificate (one file can hold several).

```json
{ "name": "Work", "baseUrl": "https://llm.example.com/v1", "caFile": "~/certs/company-ca.pem" }
```

The file adds to the system certificates for that provider only; it never replaces them. Certificate
verification cannot be turned off.

## Set an API key

broke-code asks for the key of each new provider added in `settings.json`; **Add provider** asks for it as part
of the flow. To set, replace, or clear a key later, run
**broke-code: Set API key** from the Command Palette and pick the provider. Leave the box empty for a provider
that needs no key, such as Ollama.

Keys live in the editor's secret storage (the macOS Keychain), never in `settings.json`. broke-code sends a key
only to its own provider, as a bearer token.

## Mention files and folders

Type `@` in the message box to attach a workspace file or folder. A menu lists up to 20 rows in all: first the
reserved names, such as `@problems` (below), whose name starts with what you type after `@`, then the files and
folders whose path contains it, ignoring case, shortest paths first; folders end with `/`. Move with the
arrow keys, pick with Enter, Tab, or a click, and close the menu with Escape. A picked path goes into the message
as `@<path>`, spaces included. You can also type `@path` yourself; a typed path ends at the first space. An `@`
inside code, between backticks or in a fenced block, opens no menu and attaches nothing.

When you send the message, broke-code reads each mention and sends it to the model with your text:

- A file is attached whole, or cut to its first 2,000 lines with a note saying how many lines were left out.
- A folder attaches the names of its direct children, not their content and not deeper levels.
- A binary file, a file over 1 MiB, a missing path, a path outside the workspace folders (symlinks
  included), and a path that cannot be read (no permission, not a regular file) are not attached; the model gets a
  note saying why, and the message is still sent.

Each mention shows as a chip under your message with what was attached or why it was not.

The menu lists files from the workspace folders, except those hidden by your `files.exclude` setting and anything
inside `node_modules`, `.git`, `dist`, `out`, or `build` folders. It lists at most 5,000 files; past that, the
menu says the index is limited, and you can still type the path of a file it does not show. New and deleted
files show up in the menu without reloading the window.

### Mention the problems

`@problems` attaches the errors and warnings VS Code holds for the workspace files, what the Problems panel shows,
one line each with its path, line, column, severity, message, and the tool that reported it. Information and hints
are left out. A language service may report only the files open in an editor, so open a file to get its problems.
With no error or warning, the chip says so in a neutral look and the message is still sent. The menu lists
`@problems` first when what you type after `@` starts its name.

`problems` is a reserved name: `@problems` never reads a workspace path. To mention a file named `problems`, write
`@./problems`; picking it in the menu does so for you. A folder of that name is `@problems/` or `@./problems`. In a
multi-root workspace, a workspace folder named `problems` is reached by `@problems/` and `@problems/<path>`, no
longer by `@problems`.

### Mention the uncommitted changes

`@diff` attaches the changes of your tracked files that are not committed yet, staged and unstaged together, as one
diff against the last commit (`git diff HEAD`). Files git does not track yet are left out: add them with `git add`
first to include them. Each workspace folder inside a git repository gets the changes under that folder only; in a
multi-root workspace each folder's diff follows a line with its name. broke-code reads git through VS Code's built-in
Git extension, so a repository that extension has not opened, such as one above the folder it asked you about, is not
read. The menu lists `@diff` after `@problems`.

With nothing changed, the chip says so in a neutral look. When no workspace folder is in a git repository, when git
is not available in VS Code, or when the diff cannot be read (in a repository without a commit, for one), the chip
says why in the error color. In a multi-root workspace, when one folder's diff cannot be read but another folder has
changes, the changes read are attached, the model is told which folders failed and why, and the chip shows the line
count then how many folders failed ("9 lines, 1 folder failed") in the error color. In every case the message is still sent. A diff over 2,000 lines or 1 MiB is cut, with
a note saying how many lines were left out.

`diff` is a reserved name like `problems`: a file named `diff` is `@./diff`, and in a multi-root workspace a workspace
folder named `diff` is reached by `@diff/` and `@diff/<path>`, no longer by `@diff`.

### Mention the selection

`@selection` attaches the text you selected in the active editor, as it stands when you send the message, with its
file and line range: the model gets `src/app.ts lines 10-12`, and the chip shows "src/app.ts 10-12, 3 lines". Select
the lines, click in the message box, and send; the editor keeps its selection while the chat has the focus. With
several cursors, only the primary selection is attached. A selection that ends at the start of a line does not count
that line. Over 2,000 lines or 1 MiB, the text is cut and the model is told so.

Nothing is attached, the chip in the error color and the message still sent, when no text editor is active, when the
selection is empty, or when the file is outside the workspace folders, an untitled document, or not a file (such as
the diff of a change waiting for approval). `selection` is a reserved name like `problems`: a file named `selection`
is `@./selection`.

## From the editor

Two entry points fill the chat's message box from the editor. Neither sends anything: you read the draft, add to it,
and send it yourself. Both open the chat panel, close History when it is open, and put the focus in the message box;
both work while a reply is running, since they only edit the draft.

- **broke-code: Add selection to chat**, in the Command Palette and in the editor's context menu when text is
  selected, inserts `@selection ` at the cursor of the message box, with a space before it when needed. The editor
  keeps its selection: `@selection` attaches the selection as it stands when you send.
- **Fix with broke-code**, a quick fix in the light bulb of each error or warning of a file inside the workspace
  folders, puts `Fix this problem in @src/app.ts at line 12: <the message>` in the message box: the file as a mention,
  the line, and the message on one line. An empty box is filled; a box holding a draft gets it on a new line after
  that draft. The file counts as one mention even when its path holds spaces. Information and hints get no quick fix.

The extension starts once the window has started, so the quick fix is there before you first open the chat. Without a
provider, the chat opens with a notification asking you to add one, and the draft is dropped.

## How the agent works

Each message starts an agent turn. The model may answer at once, or write a tool call in its reply; broke-code runs
the tool, sends the result back, and asks again, until the model answers with text and no call. The agent has three read
tools, which run without asking you, inside the workspace folders and the folders of the skills loaded in the
conversation (see [Skills](#skills)):

- **read_file** reads a file, with the same limits as a mention: binary files and files over 1 MiB are refused, and
  at most 2,000 lines are shown. It can read a range of lines, so the agent reads on past the first 2,000: a cut read
  tells it the line to read on from, and the step's row shows the range after the path (`big.log 2001-4000`).
- **list_files** lists the direct children of a folder.
- **search** searches the workspace with ripgrep, the copy your editor ships or the `rg` on your `PATH`. It skips
  hidden files, files ignored by `.gitignore`, and symlinks, and stops after 30 seconds.

The agent also has two write tools, which ask you first, inside the workspace folders only, never in a skill folder
outside them:

- **write_file** creates a file, or replaces a whole file.
- **edit_file** replaces one exact passage of a file; a passage found zero times or more than once is refused, never
  guessed.

When the model asks to change a file, the editor opens a diff beside the chat, titled with the path: the file as the
model planned to change it on the left, the proposed text on the right. The chat shows **Accept** and **Reject** under
the call, with an optional reason. **Accept** writes the change and closes the diff; the write is atomic, so the file
holds either its old text or the new one, even after a crash. **Reject** closes the diff and writes nothing; the model
reads that you rejected the change, with your reason when you gave one. Nothing is written when the file changed on
disk since the model planned the change, or when an editor holds unsaved changes to it: save or revert them first.
**Stop**, **New chat**, or opening another conversation while a change waits closes the diff and writes nothing.

The mode selector under the message box says how changes are approved: **Ask** (the default) waits for **Accept** or
**Reject** on each change; **Auto-edit** applies changes without asking: no diff opens, and each such step is marked
auto-approved. The selector writes the user setting `brokeCode.autoApproveWrites` (Auto-edit is `true`) and follows
it, so a change made in the settings editor shows there too. It is a **user** setting: picking Auto-edit in one window
applies to every window and project. A workspace `settings.json` cannot turn it on. The selector is disabled while the
agent works. Commands always ask, in both modes.

The third mode, **Plan**, asks the agent for a plan instead of changes: it gets only the tools that read (**read_file**,
**list_files**, **search**, and **load_skill** when a skill is listed), and answers with a plan of the changes, file by
file, in order. Nothing is written and no command runs: if the model still tries to write or run a command, the chat
shows a failed step saying the tool is not available in Plan mode, and the model goes on. Plan is kept for the
workspace, also after a reload, and writes no setting. Leaving it for Ask or Auto-edit writes the setting only when it
must change; if that write fails, the error shows and Plan stays. A message sent in Plan stays a Plan turn until it
ends, so switching to Ask afterwards and sending "do it" lets the agent write the plan, with your approval.

The agent can also run a shell command with **run_command**, which always asks you first; no setting changes that. The
chat shows the whole command under the call, line breaks kept, and the folder it runs in when the model names one,
with **Run** and **Reject** and an optional reason.
**Reject** runs nothing, and the model reads that you rejected the command, with your reason when you gave one.
**Run** starts it with your shell (the one of your default terminal profile, else `$SHELL`, else `/bin/sh`, as
`<shell> -c <command>`, not a login shell), without a terminal, in the first workspace folder unless the model names
another folder of the workspace. The command cannot read input: it gets end of file at once. The model receives the
exit code, then stdout and stderr, each cut to its first 2,000 lines and 1 MiB; a command that exits with a code other
than 0, or is killed, is reported as an error. A command stops after 120 seconds: broke-code sends SIGTERM to its
process group (the shell and the processes it started that stayed in that group), then SIGKILL two seconds later, and
the model gets the output so far. Change that limit with
`brokeCode.commandTimeoutSeconds` (at least 1) in your **user** settings; a workspace `settings.json` cannot change
it. **Stop**, **New chat**, or opening another conversation while a command waits runs nothing, and while it runs stops
it the same way. Processes a command leaves running in the background in its process group are stopped once it ends,
and the model is told so: to keep a server running, start it in your own terminal. A process that leaves the group
(with `setsid`, or a daemon that detaches) is not stopped. When VS Code closes the window or reloads the extensions,
every command still running gets SIGKILL at once.

Unlike the file tools, a command is not held to the workspace: it runs with your rights, so it can read, change, or
delete anything you can, outside the workspace too. The folder it starts in is the only part broke-code checks; your
approval is the guard, so read the whole command before you click **Run**.

Each tool call shows as a compact row under the model's text: the tool, its main argument (a path, a search pattern,
or the whole command), and whether it worked with the size of its result, or for a command, its exit code. Click the row to see the result the model received.
Once an agent turn has ended, its steps fold under one row above the final answer, such as "3 steps, 1 failed, 1
rejected", so the answer sits right under your message; click the row to see the steps again. If you scrolled up to
read, your message stays where it is on screen when its turn folds, unless too little is left below to scroll. A turn
with a single step stays unfolded, and the turn in progress never folds, so a running step and a change waiting for
you always show.
A file tool's path outside the workspace, and outside the folders of the loaded skills, is refused, and the model is
told why.

The agent turn ends when the model answers with text and no tool call. It also ends when you click **Stop**, at any step;
after three malformed tool calls in a row, with a message saying so; after 50 tool steps (or the limit you set), with
a message saying the step limit was reached; and before a request that would fill the model's context even with its
older tool results left out (below), with a message asking you to start a new chat. A malformed call is sent back to the model with what is wrong, so it can try
again; so is an empty reply, which counts as a malformed call.

You can keep typing while a turn runs: **Send** (or Enter) then queues the message under the message box instead of
sending it, up to 10 messages; a message the queue cannot take comes back to the message box. When the turn ends with the model's answer, the first queued message goes out as if you
had just sent it: its mentions are read then, a `/<skill>` message loads its skill then, and the provider, model, and
mode are those of that moment. The next one waits for that turn, and so on. Each queued message has **Edit**, which
takes it out of the queue and puts it back in the message box, after what you are typing (unless it was sent
meanwhile), and **Remove**. When a turn
ends any other way (**Stop**, a failure, a limit) nothing more is sent: the panel says the queue is paused, and **Send
now** on the first message sends it. A message you send yourself while the queue is paused goes first, and the queue
resumes when its turn ends with an answer. **New chat**, `/new`, opening another conversation, and deleting the one
shown put every queued message back in the message box, one per paragraph, so nothing you typed is lost. `/new`,
`/model`, and `/compact` are never queued; a message queued while `/compact` runs is sent once the summary is done. The queue survives hiding the panel but not a window reload.

### Retry or continue a turn

Under the last reply of the conversation, once no reply is in flight, the chat shows **Retry**, and, when the turn
was stopped with **Stop** or reached the step limit or three malformed calls, **Continue**. Both are disabled while
**Send** would not act (no model, a mode change or an undo in progress).

**Retry** runs your last message again in place of its first attempt: the replies, tool steps, and any summary after
that message are removed for good, and the model receives the message exactly as it did the first time, its mentions
and its `/<skill>` text included; they are not read again. The provider, model, mode, limits, instructions, and skills
are those of now. Retry reverts nothing on disk: when the removed steps wrote a file or ran a command (or **Undo
changes** is offered for that turn), the first click only asks, saying so, and the button reads **Retry anyway**,
with **Cancel** beside it; to get the files back, click **Undo changes** first. **Continue** removes nothing: it sends
a new message, shown as "Continue", which asks the model to carry on from where it stopped, with a fresh step budget.
After a context-full stop, Continue is not offered: summarize with `/compact` or start a new chat. Neither shows once
`/compact` has summarized the conversation after your last message. Like a message you type, a turn started by Retry
or Continue that ends with an answer sends the first queued message.

### Edit your last message

Under your last message, when Retry is offered, the chat shows **Edit**. Clicking it changes nothing yet: the
message's text goes into the message box (after what you were typing, if anything, following a blank line), with its
file and folder mentions, and the box takes the focus. The last turn, your message and every reply after it, dims
under a line saying that sending replaces them, with **Cancel**; the line also says when that turn wrote files or ran
commands, which are not reverted (click **Undo changes** first to get the files back). Change the text and **Send**:
the old message and its replies are removed for good, and the new one is sent as a message you type, its mentions and
`/<skill>` read now. **Cancel** keeps the text in the box and removes nothing; so does starting a new chat, opening
another conversation, a reply starting (Retry, Continue, or a queued message sent), hiding the panel, or reloading the
window, which also clears the box. Edit is not offered once `/compact` has summarized the conversation after your last
message.

### Undo the changes of a turn

A change the agent writes goes straight to disk, outside the editor: neither the editor's **Undo** nor Local History
(the **Timeline** view) sees it. Instead, under the last reply of the latest turn that wrote a file, the chat shows
**Undo changes**, whatever way the turn ended, also after **Stop**. Click it to put each file that turn wrote back to
its text from before the turn; a file the turn created is deleted. The chat then lists each file: restored, removed, or
skipped with the reason. A file is skipped, and left exactly as it is, when it changed since the turn wrote it (an edit
of yours, for instance), when an editor holds unsaved changes to it, or when it can no longer be written; the button
stays, so you can fix that and click again to retry only the files skipped. The button stays until a later turn
writes a file (that turn's button replaces it), **Retry** or a send after **Edit** removes that turn, you start a new chat or open another
conversation, or the window reloads: the text from before the turn is kept in memory only, never on disk. After that, git is the way back.
Commands are not undone: when the turn ran one, the chat says so beside the button. While the undo runs, **Send** waits
for it. Each step that wrote a file put back then says **undone**, also after a reload, and the agent is told that you
undid the change, so it reads the file again instead of answering from the change.

## Context size and step limit

The panel header shows, next to the model picker, how much of the model's context the next request would use, in
tokens and as a percentage. It is an estimate: the characters of everything the request sends (the instructions,
your messages with their attachments, the model's answers, and the tool results, but not its reasoning) divided by
4. Before each request of an agent turn, broke-code checks that estimate: when it leaves less than one eighth of the
context for the reply, broke-code leaves the oldest tool results out of that request, one at a time, until it fits.
Each one left out goes to the model as a single line, `[result left out to save context: N lines]`. The last three
tool steps sent, every skill load, your messages, and the model's answers always go whole, and so does a
result shorter than that line. The chat and the saved conversation keep every result whole; only the request changes.
While the next request leaves results out, the panel says how many under the header, and the usage counts the request
as it would be sent. When the request still does not fit, the turn stops without sending it, and the chat asks you to
summarize the conversation with `/compact` or start a new chat with **New chat**, unless automatic compaction is on
(see [Summarizing with `/compact`](#summarizing-with-compact)).

LLM services do not report a model's context size, so broke-code reads it from the `brokeCode.contextSizes` table
in your **user** settings, by model name as the provider lists it. A model absent from the table uses 32,768 tokens,
and the chat says so with a **Set context size** link: enter the size and broke-code saves it to the table. Set the
tool step limit of an agent turn with `brokeCode.maxToolSteps` (default 50, at least 1):

```json
"brokeCode.contextSizes": { "gemma-4": 262144, "qwen3:8b": 40960 },
"brokeCode.maxToolSteps": 30
```

An entry that is not a whole number of at least 1 is ignored. A change applies from the next message; an agent turn
in flight keeps the limits it started with. Like the providers, both settings are read from user settings only.

broke-code adds your instructions to every request: `~/.agents/AGENTS.md`, then the `AGENTS.md` at the root of each
workspace folder, when they exist. Each is read under the same limits as a mention. `CLAUDE.md` is never read.

### Summarizing with `/compact`

Send `/compact` alone, or pick it in the `/` menu, to ask the model for a summary of the conversation: the goal, the
decisions, the files read or changed, and what remains to do. The summary streams in the chat under a **Conversation
summarized** separator, and from then on each request sends it in place of everything before it, so the header's usage
drops. The earlier messages stay in the chat and in the saved conversation, dimmed under a line saying they are no
longer sent. To keep the summary request small, it leaves out every tool result it can, the most recent included: the
model summarizes from the calls and the answers, not from the files it read. The request carries your `AGENTS.md`
instructions but no tool list, and the model runs no tool while it summarizes. It is a reply like any other: **Stop**
ends it, and while it runs, the messages you send are queued. When the summary fails, is stopped, comes back empty, or
the conversation does not fit the model's context even so, nothing changes: the next request sends the history as
before. `/compact` on an empty conversation, or right after a summary, sends nothing and says so. You can summarize
again later: the next summary starts from the last one.

To have an agent turn summarize by itself instead of stopping on a full context, turn on `brokeCode.autoCompact` in
your **user** settings (off by default, since it adds a request you did not ask for):

```json
"brokeCode.autoCompact": true
```

Then, when the next request of a turn would not fit even with older tool results left out, broke-code asks the model
for the same summary, shown under a **Conversation summarized automatically** separator, and the turn goes on. Its
next request sends the summary followed by your message of that turn, word for word, so the model still has your
request in front of it; that message stays undimmed above the summary, marked **Still sent with the summary**. The
summary is not a tool step and does not count toward the step limit; **Stop** ends it like any reply, and the messages
you send while it runs are queued, as during any reply. A turn summarizes at most once per request: when the request
still does not fit, when the summary request itself does not fit, or when the summary comes back empty, the turn stops
as it would without the setting; a failed summary ends the turn with its error. A turn reads the setting when it
starts, and a workspace `settings.json` cannot turn it on.

## Skills

A skill is a folder holding a `SKILL.md` file, in the [Agent Skills](https://agentskills.io/specification) format:
a frontmatter with a `name` and a `description`, then the instructions.

```markdown
---
name: release-notes
description: Write release notes from the commits since the last tag. Use when asked for a changelog.
---

# Release notes

...
```

broke-code reads skills from two places only: your personal skills in `~/.agents/skills/`, and the skills of each
workspace folder in `.agents/skills/`. It never reads `.claude/`, `.codex/`, or another tool's folder. The skills
are read again at each message, so a skill you add or edit counts from your next message. Every request lists each
skill's name and description to the model; the instructions themselves stay out until the model loads the skill.

- `name` is 1 to 64 lowercase letters, digits, and hyphens, with no hyphen at either end and no two in a row, and
  equals the skill's folder name. `description` is 1 to 1,024 characters. Other frontmatter fields are ignored.
- A workspace skill hides a personal skill of the same name; between two workspace folders, the first one wins. A
  hidden skill shows no warning. An invalid skill hides nothing: a valid skill of the same name further down counts.
- A personal skill folder may be a symbolic link anywhere. A workspace skill folder that links outside its workspace
  folder, even into another folder of the workspace, is skipped.
- Every file of a skill lives in its own folder: a skill whose `SKILL.md` is a symbolic link to somewhere outside the
  skill's folder is skipped, with a warning.
- `disable-model-invocation: true` keeps a skill out of the list the model sees, and the model cannot load it; you
  still can, with `/<name>`, and the model then sees it as loaded.

When a task matches a skill's description, the model calls **load_skill** with its name and receives the
instructions, without the frontmatter, cut to their first 2,000 lines, together with the real path of the skill's
folder. From then on, for the rest of the conversation, the model may read the files of that folder with
**read_file**, **list_files**, and **search**, by that absolute path, even for a personal skill outside the workspace.
The file tools cannot change the files of a skill outside the workspace, and before the load they cannot read them
(a command you approve can, like any file you can reach); there, a file
that is a symbolic link to somewhere outside the skill's folder is refused. A workspace skill's folder is part of the
workspace: the usual rules apply, so the model can change its files with your approval. A skill loaded in a past conversation is loaded again when you reopen it, as long as it is still
there. After a summary (`/compact`), a skill loaded before it stays readable, but its instructions are no longer sent:
the model's next **load_skill** of it returns them again. `load_skill` is offered to the model only while a skill is listed to it.

You can also load a skill yourself: start your message with `/` and the skill's name, then what you want, such as
`/release-notes since v0.3`. The model receives the skill's instructions, as **load_skill** gives them, in place of
your message, and every `$ARGUMENTS` in them is replaced by the text after the name (by nothing when there is none).
When the instructions hold no `$ARGUMENTS`, that text follows them, after a blank line. Mentions in it are attached as
usual. The chat shows your message as you typed it, with a **Skill** chip under it, and the skill counts as loaded
from that message on, its folder readable as above, even for a skill kept from the model. A `/` word that names no
skill, or a skill that was skipped, is sent as you typed it. When the skill's `SKILL.md` cannot be read at that
moment, the message still goes: the model is told the skill could not be loaded, then gets your text, and the chip
says so.

A skill whose `SKILL.md` is invalid, unreadable, or over 1 MiB is skipped, and the chat shows a warning naming the
file and the problem; the other skills still count. broke-code reads at most 200 entries of each skills folder, the
first by name, and shows one warning naming a folder that holds more. The list counts in the context usage like the
rest of the instructions.

## Slash commands

Type `/` at the start of the message box to open a menu of commands: `/new`, `/model`, `/compact`, then each of your skills, each
with its description. The menu keeps the commands whose name starts with what you type after `/`, ignoring case. Move
with the arrow keys, pick with Enter, Tab, or a click, and close the menu with Escape. Picking `/new`, `/model`, or `/compact` runs
it at once; picking a skill puts `/<name> ` in the message box, so you can type its arguments. A `/` anywhere else in a
message, as in a path, opens no menu.

- `/new`: pick it, or send it alone, to start a new conversation, as **New chat** does.
- `/model`: pick it, or send it alone, to open the editor's list of the provider's models, the current one marked. Pick
  one to switch to it, as the **Model** list in the header does; Escape keeps the current model.
- `/compact`: pick it, or send it alone, to summarize the conversation and free context (see
  [Summarizing with `/compact`](#summarizing-with-compact)).

They run only when you could send a message: with a model chosen and no reply in progress. Otherwise, or when text
follows the command in the message box, picking one only puts its name there. `/new` and `/model` send nothing to the
model. With words after them, `/new`, `/model`, and `/compact` are ordinary messages. The skills are read when the menu
opens; if they cannot be read, the menu says so and still shows the commands. A skipped skill is not listed; its warning
shows after your next message.

## Code blocks

Each code block of an answer shows **Copy** and **Insert at cursor** above its code when the pointer is over it or the
keyboard focus is inside it; Tab reaches them in reading order. A block gets them once its text is final: its fence is
closed, or the reply has ended.

- **Copy** puts the code on the clipboard, without the fence lines and its final line break, and says **Copied** for
  about two seconds (**Copy failed** when the clipboard refuses it).
- **Insert at cursor** replaces the selection of the active editor with the code, or inserts it at the cursor, and at
  every cursor when there are several. One **Undo** restores the editor. With no editor open, or one that cannot be
  edited (a read-only file, or the diff of a change waiting for your decision), a notification says so and nothing
  changes. The focus stays in the chat.
- An empty block's buttons are disabled.

## Commit messages

In the Source Control view, the **Generate commit message** button (a sparkle) in the title of a git repository asks
the model selected in the chat for a commit message describing that repository's staged changes, and writes it in the
commit message box. The command **broke-code: Generate commit message** in the Command Palette does the same for the
only repository open, or the one you pick when there are several.

- Stage the changes first: only staged changes are described. broke-code never stages, commits, or pushes.
- The message follows [Conventional Commits](https://www.conventionalcommits.org/), in English: a subject of at most
  72 characters (asked of the model, not checked), and a body saying why when the change needs one.
- When the commit message box already holds text, broke-code asks before replacing it; **Cancel** keeps your text
  and sends nothing. If you change the box while the model writes, it asks again before writing; **Cancel** then
  keeps what you typed.
- A notification shows while the model writes; its **Cancel** stops the request and leaves the box as it was. The
  message appears once the reply has ended, without the model's reasoning or a code block or quotes around it.
- The request uses the provider, model, and context size of the chat. A diff too large for the model's context is
  cut between files, keeping the first ones whole (a first file larger than the room is cut to it), and a
  notification then says the message covers only part of the changes.
- It needs the Git extension built into VS Code and VSCodium. When it is disabled, nothing is staged, no provider or
  model is chosen, or the provider fails, a notification says so and the box is left as it was. It works while the
  chat replies and adds nothing to your conversations.

## Past conversations

broke-code saves each conversation of a workspace, so closing or reloading the window keeps it. **History** in the
panel header lists the workspace's conversations, newest first, each with its first message and the date of its
last change; the one shown is marked. Click a conversation to reopen it and continue where you left off, or
**Delete** it. Type in **Filter by title** at the top of History to keep the conversations whose title holds that
text, ignoring case; Enter opens the first one listed, and Escape clears the field, then closes History. **New chat**
starts a new conversation and keeps the previous one in the list. History works
without a provider too; sending a message needs one. A workspace keeps its 50 most recent conversations; older ones
are deleted.

A reopened conversation resends your earlier messages as they were sent, with the files and folders attached then,
and the tool results the model received; broke-code does not read them again. Its finished turns show folded, as
they did when they ended. A reply that was still streaming when the window closed comes back stopped,
with the text received so far. Conversations stay on your machine, in the editor's storage for that workspace, and
never hold an API key. A window with no folder open keeps its conversation in memory only.

## Tested models

broke-code's tool calls are measured on local models with Ollama: `qwen3.8:27b` and `gemma4:26b-a4b-it-qat`, ten
runs of each task, with the bar at nine. The bench has eight tasks:

- **Read**: answer with the value of a setting that only a file holds.
- **Edit**: rename a function in a source file, changing nothing else.
- **Create**: create a file whose text holds double quotes, backslashes, tags, and a code block, exactly as asked.
- **Skill**: answer a question that a personal skill covers, by loading the skill and reading a file in its folder.
- **Command**: count the files of a folder and its subfolders, by running a shell command.
- **Slash**: answer the skill task's question sent after `/` and the skill's name, which loads the skill for the model.
- **Hidden**: the slash task with a skill kept from the model, which only you can load, beside an unrelated skill the
  model may load.
- **Range**: give the code on the last line of a 2,400-line file, by reading on past its first 2,000 lines.

Both models pass every task, 10 runs of 10 on each in the latest full run. When a model thinks, then stops without a
word, broke-code tells it so and asks again. Contributors run the bench with `bun run eval`.

## Privacy

broke-code collects no telemetry. It contacts only the providers you configure. When you generate a commit message,
the staged diff of that repository is sent to the provider selected in the chat. When a message mentions `@diff`, the
uncommitted changes of the workspace folders are sent with it.

## Credits

broke-code follows two things from [twinny](https://github.com/twinnydotdev/twinny), released under the MIT license,
and copies none of its files:

- The chat panel's look: one layer of design tokens derived from the VS Code theme, the user's message as a filled
  block with the reply flush on the panel, a tool step as one small quiet line that opens to its result, the
  VS Code UI font for prose and the editor font for code, and surfaces set apart by a fill instead of a border.
- The `@` token detection of the mention menu.

## License

MIT. See [LICENSE](LICENSE).
