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
and come back to past conversations. The model also sees the name and description of each of your skills, and loads a
skill's instructions when your task matches it. Slash commands come next.

## Requirements

- macOS. Version 1 supports macOS only; Windows and Linux are planned for version 2.
- VS Code 1.101 or later, or a compatible editor such as VSCodium.
- An LLM service with an OpenAI-compatible API: streaming `POST /v1/chat/completions` and `GET /v1/models`.
  Ollama works.

## Configure a provider

A provider is an LLM service broke-code talks to. List your providers in your **user** settings
(`settings.json`) under `brokeCode.providers`. Each entry has a unique `name` and a `baseUrl`, the API root:

```json
"brokeCode.providers": [
  { "name": "Ollama", "baseUrl": "http://localhost:11434/v1" },
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

broke-code asks for the key of each new provider. To set, replace, or clear a key later, run
**broke-code: Set API key** from the Command Palette and pick the provider. Leave the box empty for a provider
that needs no key, such as Ollama.

Keys live in the editor's secret storage (the macOS Keychain), never in `settings.json`. broke-code sends a key
only to its own provider, as a bearer token.

## Mention files and folders

Type `@` in the message box to attach a workspace file or folder. A menu lists up to 20 files and folders whose
path contains what you type after `@`, ignoring case, shortest paths first; folders end with `/`. Move with the
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

## How the agent works

Each message starts an agent turn. The model may answer at once, or write a tool call in its reply; broke-code runs
the tool, sends the result back, and asks again, until the model answers with text and no call. The agent has three read
tools, which run without asking you, inside the workspace folders and the folders of the skills loaded in the
conversation (see [Skills](#skills)):

- **read_file** reads a file, with the same limits as a mention: binary files and files over 1 MiB are refused, and
  a file over 2,000 lines is cut to its first 2,000.
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

To apply changes without asking, set `brokeCode.autoApproveWrites` to `true` in your **user** settings: no diff opens,
and each such step is marked auto-approved. A workspace `settings.json` cannot turn it on. Commands always ask.

The agent can also run a shell command with **run_command**, which always asks you first; no setting changes that. The
chat shows the whole command under the call, line breaks kept, and the folder it runs in when the model names one,
with **Run** and **Reject** and an optional reason.
**Reject** runs nothing, and the model reads that you rejected the command, with your reason when you gave one.
**Run** starts it with your shell (the one of your default terminal profile, else `$SHELL`, else `/bin/sh`, as
`<shell> -c <command>`, not a login shell), without a terminal, in the first workspace folder unless the model names
another folder of the workspace. The command cannot read input: it gets end of file at once. The model receives the
exit code, then stdout and stderr, each cut to its first 2,000 lines and 1 MiB; a command that exits with a code other
than 0, or is killed, is reported as an error. A command stops after 120 seconds: broke-code sends SIGTERM to it and to
every process it started, then SIGKILL two seconds later, and the model gets the output so far. Change that limit with
`brokeCode.commandTimeoutSeconds` (at least 1) in your **user** settings; a workspace `settings.json` cannot change
it. **Stop**, **New chat**, or opening another conversation while a command waits runs nothing, and while it runs stops
it the same way. Processes a command leaves running in the background are stopped once it ends, and the model is told
so: to keep a server running, start it in your own terminal.

Each tool call shows as a compact row under the model's text: the tool, its main argument (a path, a search pattern,
or the whole command), and whether it worked with the size of its result, or for a command, its exit code. Click the row to see the result the model received.
A path outside the workspace, and outside the folders of the loaded skills, is refused, and the model is told why.

The agent turn ends when the model answers with text and no tool call. It also ends when you click **Stop**, at any step;
after three malformed tool calls in a row, with a message saying so; after 50 tool steps (or the limit you set), with
a message saying the step limit was reached; and before a request that would fill the model's context, with a
message asking you to start a new chat. A malformed call is sent back to the model with what is wrong, so it can try
again; so is an empty reply, which counts as a malformed call.

## Context size and step limit

The panel header shows, next to the model picker, how much of the model's context the next request would use, in
tokens and as a percentage. It is an estimate: the characters of everything the request sends (the instructions,
your messages with their attachments, the model's answers, and the tool results, but not its reasoning) divided by
4. Before each request of an agent turn, broke-code checks that estimate: when it leaves less than one eighth of the
context for the reply, the turn stops without sending the request, and the chat asks you to start a new chat with
**New chat**. broke-code never shortens or summarizes the conversation by itself.

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
- `disable-model-invocation: true` keeps a skill out of the list the model sees, and the model cannot load it.

When a task matches a skill's description, the model calls **load_skill** with its name and receives the
instructions, without the frontmatter, cut to their first 2,000 lines, together with the real path of the skill's
folder. From then on, for the rest of the conversation, the model may read the files of that folder with
**read_file**, **list_files**, and **search**, by that absolute path, even for a personal skill outside the workspace.
It cannot change the files of a skill outside the workspace, and before the load it cannot read them; there, a file
that is a symbolic link to somewhere outside the skill's folder is refused. A workspace skill's folder is part of the
workspace: the usual rules apply, so the model can change its files with your approval. A skill loaded in a past conversation is loaded again when you reopen it, as long as it is still
there. `load_skill` is offered to the model only while a skill is listed to it.

A skill whose `SKILL.md` is invalid, unreadable, or over 1 MiB is skipped, and the chat shows a warning naming the
file and the problem; the other skills still count. broke-code reads at most 200 entries of each skills folder, the
first by name, and shows one warning naming a folder that holds more. The list counts in the context usage like the
rest of the instructions.

## Past conversations

broke-code saves each conversation of a workspace, so closing or reloading the window keeps it. **History** in the
panel header lists the workspace's conversations, newest first, each with its first message and the date of its
last change; the one shown is marked. Click a conversation to reopen it and continue where you left off, or
**Delete** it. **New chat** starts a new conversation and keeps the previous one in the list. History works
without a provider too; sending a message needs one. A workspace keeps its 50 most recent conversations; older ones
are deleted.

A reopened conversation resends your earlier messages as they were sent, with the files and folders attached then,
and the tool results the model received; broke-code does not read them again. A reply that was still streaming when the window closed comes back stopped,
with the text received so far. Conversations stay on your machine, in the editor's storage for that workspace, and
never hold an API key. A window with no folder open keeps its conversation in memory only.

## Tested models

broke-code's tool calls are measured on local models with Ollama: `qwen3.8:27b` and `gemma4:26b-a4b-it-qat`, ten
runs of each task, with the bar at nine. The bench has five tasks:

- **Read**: answer with the value of a setting that only a file holds.
- **Edit**: rename a function in a source file, changing nothing else.
- **Create**: create a file whose text holds double quotes, backslashes, tags, and a code block, exactly as asked.
- **Skill**: answer a question that a personal skill covers, by loading the skill and reading a file in its folder.
- **Command**: count the files of a folder and its subfolders, by running a shell command.

Both models pass the five tasks: 10 runs of 10 each, except `gemma4:26b-a4b-it-qat` at 9 of 10 on the skill task. When a model thinks, then stops without a
word, broke-code tells it so and asks again. Contributors run the bench with `bun run eval`.

## Privacy

broke-code collects no telemetry. It contacts only the providers you configure.

## Credits

The chat panel's visual style and the `@` token detection of the mention menu follow
[twinny](https://github.com/twinnydotdev/twinny), released under the MIT license.

## License

MIT. See [LICENSE](LICENSE).
