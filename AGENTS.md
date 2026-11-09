# AGENTS.md

## Project overview

broke-code is a VS Code extension that runs a coding agent against LLM services without native tool calling.
It ships on Open VSX and the Visual Studio Marketplace. The author's employer runs an internal LLM service with
an OpenAI-compatible API. It serves Gemma, GLM, Qwen, and newer models, but it rejects the `tools` request
field. Kilo Code and similar agent extensions therefore fail against it. In broke-code, the model writes each
tool call in the text of its reply, and the extension parses and runs the call. The v1 goal is narrow. It
covers the agent loop over the reply text, skills, and slash commands, in a minimal chat panel styled after
twinny.

The code so far covers the extension skeleton, a streaming chat with a provider, and the harness with the read tools:
a message starts an agent turn that runs `read_file`, `list_files`, and `search` until the model answers without a
call. Each send discovers the skills and lists them to the model. `bun run eval` measures that loop on local Ollama
models. `write_file` and `edit_file` exist in the core and the eval, which applies each change at once; the extension
does not list them until the approval flow (#37) lands. `run_command`, `load_skill`, and slash commands are not built
yet. Read
`GLOSSARY.md` for the domain vocabulary and `docs/adr/` for the decisions behind the design, starting with
`docs/adr/0001-body-tool-calls.md`.

## Structure

- `GLOSSARY.md`: the domain terms (body tool call, harness, agent turn, tool step, provider, skill, slash command,
  mention). Code and docs use these names.
- `docs/adr/`: architecture decision records.
- `src/core/`: modules that import nothing from `vscode`: settings parsing, the API key shape check, the provider
  HTTP client, the CA trust and certificate error classification (`tls.ts`), the SSE reader, the typed provider
  errors, the chat controller (conversation state, the agent turn loop with its tool runner, instruction reader, and
  skill reader ports, its limits source and step limits, the context budget check, streaming, Stop, saving, reopen, delete), the conversation record
  (`conversation.ts`: version 2, its validation on load, title, id, the summary file's shape), its store
  (`conversationStore.ts`: a record and a summary file per conversation, the list from the summaries, reads, writes,
  and deletes in call order), and the store's file access (`conversationFiles.ts`:
  the file port, and its implementation over a local directory with `node:fs`: missing versus failed, regular files
  only, atomic writes, leftover temporary files), the dialog queue, the host-webview message
  protocol and its validation, workspace file access (`workspaceFiles.ts`: the inside-workspace check, capped reads,
  one-level listings, line truncation, the write boundary and atomic writes, with `node:fs`), mentions (`mentions.ts`: token detection, picked and typed
  mentions merged, reading, and the text the model receives), where a message holds Markdown code
  (`markdownCode.ts`), the mention menu logic (`suggestions.ts`: the `@` token at the caret, index entries,
  filtering, the index exclusions), the menu's file index (`fileIndex.ts`: one scan shared until a file
  changes, behind a scan port), the body tool call parser (`toolCalls.ts`: `ToolSpec`, the first call-shaped block,
  malformed-call messages), the system prompt composer (`systemPrompt.ts`: role, call format, rules, tools,
  skills, instruction files), the turn limits (`limits.ts`: `brokeCode.maxToolSteps` and `brokeCode.contextSizes` parsing,
  the token estimate, the context-full threshold, the typed size check), and the read tools (`tools.ts`: `read_file` and `list_files` over the mention reader, `search`
  over ripgrep with its candidate paths, bounded `ok` or `error` results), the write tools (`writeTools.ts`:
  `write_file` and `edit_file` plan a change `{ path, target, before, after }` and never write; an applier port writes
  it, `fileApplier` straight to disk for the tests and the eval), the instruction files
  (`instructions.ts`: `~/.agents/AGENTS.md`, then each workspace folder's `AGENTS.md`, under the mention caps), and the
  skills (`skills.ts`: discovery in `~/.agents/skills/` and each workspace folder's `.agents/skills/`, the frontmatter
  subset, validation, precedence, warnings, the line the extension logs at each send). `markdownCode.ts`, `suggestions.ts`, and `conversation.ts` import nothing from
  `node:`, since the webview loads them. Unit tests sit next to them as `*.test.ts`, because `bun test` cannot load `vscode`. `tlsFixture.ts`
  generates test certificates with `/usr/bin/openssl` at test time; no private key is committed.
  `conversationFixture.ts` is the in-memory conversation file port for tests.
- `src/extension/`: the extension host glue (activation, webview view, API keys in `SecretStorage`, the
  file index's `findFiles` scan and watcher in `fileIndex.ts`, the turn limits from the user settings and the "Set
  context size" input box in `contextSizes.ts`, the read tool runner with the ripgrep candidates from
  `vscode.env.appRoot` and `PATH`, the instruction reader and the skill reader from the home folder and the workspace folders, the latter logging the
  skills of each send).
- `src/webview/`: the React chat panel and its CSS, tool step rows included. `SuggestionMenu.tsx` is the autocomplete list the `@` menu
  uses and the `/` menu (#11) is meant to reuse.
- `src/l10n.test.ts`: checks that every `l10n.t` message has a French translation and that the
  `package.nls*.json` files match.
- `l10n/bundle.l10n.fr.json`, `package.nls.json`, `package.nls.fr.json`: French strings for the host and
  webview, and the English and French manifest strings. English messages are the keys of `l10n.t`.
- `scripts/build.ts`: `bun run build` writes the host bundle (`dist/extension.js`, CommonJS) and the webview
  bundle (`dist/webview/`).
- `scripts/next-version.ts`: computes the next release version from the commits since the last `v*` tag. The
  release workflow runs it as a CLI. Its tests sit next to it.
- `eval/`: the Ollama eval bench (`bun run eval`). `scenarios.ts` holds each scenario (fixture files, message, the
  files it must write with their exact text, an optional check of a turn that ended `done`) and `judge`, the verdict
  and failure category of a run, which compares the workspace after the run with the fixture plus those writes; `run.ts` plays one run through
  the `ChatController` ports, with the read and write tools over a copy of the fixture under the system temporary
  directory, each write applied at once by `fileApplier`;
  `report.ts` formats the scores; `bench.ts` is the CLI, guarded by `import.meta.main` so `bun test` never starts it.
  Its unit tests sit next to them and need no Ollama.
- `biome.jsonc`: the Biome linter and formatter settings. Markdown is excluded, because Biome's Markdown formatter
  breaks the YAML frontmatter of the ADRs.
- `.vscode/`: the launch configuration, Biome as the workspace formatter for TS, TSX, JSON, and CSS, and the Biome
  extension as a recommendation.
- `.github/workflows/ci.yml`: lint and format check, type check, unit tests, build, and a packaging dry run on macOS.
- `.github/workflows/release.yml`: the release on each push to `main`. The Marketplace Trusted Publishing
  policy fixes its file name.
- `README.md`: the user documentation, also shown on Open VSX and the Visual Studio Marketplace.
- `LICENSE`: MIT.

## Stack

- TypeScript for both the extension host and the chat webview.
- Use `bun` for everything, including packaging and publishing. The project needs no Node and no npm.
  `@vscode/vsce` and `ovsx` are exact-pinned dev dependencies, so `bun.lock` also pins their dependencies. Run
  them under the Bun runtime with `bunx --bun vsce` and `bunx --bun ovsx`, and always pass
  `--no-dependencies` to `vsce`, because it otherwise calls npm to list dependencies. The bun bundle
  already contains them.
- If a registry upload fails under Bun, switch that release step alone to the current Node LTS, and say so
  here. Packaging and the other upload stay under Bun.
- The webview uses React and `react-markdown`, with hand-written CSS built on VS Code theme variables. Do not
  add Tailwind or a component kit, and do not use `@vscode/webview-ui-toolkit`, which Microsoft deprecated.
- The UI ships in English and French and follows the VS Code display language, with English as the fallback.

## Architecture

### Provider contract

- broke-code speaks one contract: streaming `POST /v1/chat/completions` and `GET /v1/models`. It covers the
  internal service and Ollama.
- Never send `tools` or read `tool_calls`, even to a provider that supports them. See ADR 0001.
- Providers (name and base URL) live in the VS Code user settings only (`application` scope). A workspace
  `settings.json` must not override them, because keys are stored by provider name and a repository could
  otherwise point that name at its own URL. Each API key lives in `SecretStorage`, never in `settings.json`.
- Requests never follow HTTP redirects; a redirect is reported as an error. Provider response bodies are read
  under size caps that cancel the download when exceeded. Responses may be compressed with gzip, deflate, or br;
  the caps count decoded bytes, and any other `Content-Encoding` is reported as an error.
- The API does not report a model's context size. The `brokeCode.contextSizes` user setting (`application` scope,
  read from `globalValue` like the providers) maps model names to sizes in tokens; a model absent from it, or with an
  entry that is not a positive integer, uses 32,768. While such a model is selected, the chat shows "Unknown context
  size, using 32k" with a link: the host asks for the size in an input box and merges it into the user value of the
  setting. The header shows the next request's estimated size against the model's size.
- Every provider request goes through Node's `http`/`https` modules. VS Code patches them in place in the
  extension host, adding its proxy support and, to requests without a `ca` option, the OS certificate store. A
  provider without a CA file sends no `ca`, so it trusts exactly what VS Code trusts.
- Each provider has an optional `caFile`: an absolute or `~/` path to a PEM file. It applies to that provider's
  requests only. Node's `ca` option replaces the default store, so the client passes
  `tls.getCACertificates("default")` (bundled roots and `NODE_EXTRA_CA_CERTS`), `tls.getCACertificates("system")`
  (the OS store, expired certificates dropped), and every certificate of the file together. A provider with a CA
  file always trusts the OS store, whatever VS Code's `http.systemCertificates` setting says. The file is read and
  checked with `X509Certificate` on every request, because Node ignores an invalid `ca` silently. A relative
  path, an unreadable file, or a file without a valid PEM certificate is reported naming the path, and no
  request is sent.
- Never disable certificate verification. Report a certificate failure (unknown issuer, self-signed, expired,
  hostname mismatch) as a certificate error with its code, never as a generic network error. Connection refused,
  DNS failures, and timeouts stay `unreachable`.
- A request gets 300 seconds from its start to the response headers, DNS, connect, and TLS included; past that it
  is `unreachable` and says it timed out. After the headers, 300 seconds without a byte cut the reply off, with a
  cause saying how long nothing came. Node `fetch` used the same 300-second limits.

### Harness

- Tool calls are XML tags in the reply text, with argument values written raw. Starting parsing rules: one
  call per reply, calls inside code fences are ignored, a malformed call goes back to the model as a precise
  error, three malformed calls in a row stop the agent turn, and a reply without a call is the final answer.
  Change these rules only on evidence from the Ollama eval.
- A known tool's call ends at the `</tool_name>` after its last argument value, not at the first one. A value ends at
  the first `</argument>` that closes no `<argument>` opened inside the value and is followed by nothing but
  whitespace and then another argument tag of the tool or the call's closing tag: an inner `<argument>` …
  `</argument>` pair is kept, so a value can hold a whole example call. When the tags never balance, the value ends
  at the first `</argument>` so followed, pairs ignored; failing that, at the last `</argument>` before the next
  `</tool_name>`. A value may therefore hold `</write_file>`, `</content>`, other tools' tags, and code fences. Known
  cost, kept by maintainer decision: a value holding an unpaired `<argument>` pairs it with the real closing tag, so
  it runs on into the text after the call when that text holds `</argument>` then `</tool_name>`. The parser drops
  one leading and one trailing line break of a value that sits on its own lines (both or neither). `write_file` then
  drops every trailing line break of its content (`\n` or `\r\n`) and ends the file with exactly one, of the kind its
  last line break is; content left empty writes an empty file. Accepted cost, by maintainer decision (ADR 0001):
  `write_file` cannot create a file ending with an empty line; `edit_file` can.
- The v1 tools are `read_file`, `list_files`, `search` (ripgrep), `write_file`, `edit_file`, `run_command`,
  and `load_skill`.
- `edit_file` replaces exact text only, compared byte for byte, line endings included. If the text matches zero
  times or more than once (overlapping matches count), return an error to the model. Never guess the location.
- The write tools plan a change and never write; the host's applier writes it. The path resolves like a mention, a
  path that exists nowhere going to the first workspace folder that may hold it. The deepest existing folder above
  the file must resolve inside a workspace folder; missing folders are created at apply. The file itself must not
  be a symlink, and an existing one must be a UTF-8 text file within the read caps (binary or over 1 MiB refused, as
  for reads); content over 1 MiB is refused. The applier checks the path again and writes only when the file still
  holds the planned text (already holding the new text is a success, so applying twice is harmless).
- A write is atomic: the file holds its old text or the new one, never a mix or nothing, even after a crash. The new
  text goes to a temporary file `.<name>.broke-code-<random>.tmp` in the target's own folder (at most 226 bytes of
  the file name, cut between characters, so the name fits in 255 bytes), flushed to disk. For an existing file it is
  created readable by its owner only (`0600`); for a new file, with the default bits. A last check then reads the
  target again: its folder must still resolve to the same place inside the workspace, the target must not be a
  symlink, and it must still hold the planned text (or already the new text: a success). Only then does the
  temporary file get the old file's permission bits (`rwx` for owner, group, and others) and take its place:
  `rename(2)` over an existing file, `link(2)` for a new one, which fails rather than replace a file created meanwhile
  (refused as changed since planned). On any failure the file stays byte-identical and the temporary file is
  removed; when that removal fails, the result names the temporary file and its cause. The error result keeps the
  cause ("the file was not written (ENOSPC)"), and folders created for the write stay. Accepted costs: a hard link to the file keeps the old text; its owner, extended attributes, and ACLs
  are not kept; the folder must be writable; a crash before the swap, or a folder renamed during the write, leaves
  the temporary file behind. Residual races, accepted as for reads, since such a writer already runs with the user's
  rights: a write landing between the last read and the rename is overwritten (Node has no compare-and-swap on a
  path), and a missing parent folder swapped for a symlink out after the check makes `mkdir` create an empty folder
  outside before the write is refused.
- Tools act inside the open workspace only. The one exception is read-only access to the directories of skills
  loaded in the current conversation.
- Approvals:
  - Reads run without asking.
  - A write opens the native VS Code diff editor, and the user clicks Accept or Reject in the chat. A
    rejection goes back to the model as a tool result.
  - `run_command` always waits for a click.
  - One setting auto-approves writes. Nothing auto-approves commands.
- `run_command` runs in a hidden child process in the workspace folder with the user's shell, captures the
  output, and stops after 120 seconds by default.
- Reasoning output (`<think>` tags, `reasoning`, or `reasoning_content`) shows collapsed in the chat. The parser
  never looks for tool calls in it, and the conversation history sent back to the model drops it.
- Each request of an agent turn sends a `system` message first, then the history: each user entry's composed text,
  each assistant answer verbatim with its call block (reasoning never), and each tool step as a `user` message
  `<tool_result tool="<name>" status="ok|error">`, the text, then `</tool_result>`, never the OpenAI `tool` role
  (ADR 0001). A malformed call's message goes back the same way with `status="error"`, with `tool` the tag name the block
  opens with, a known tool or not, and `tool="unknown"` only when no tool name can be read.
- When a reply ends, its answer goes through the parser. No call: the turn ends. A call: the tool runs with the
  turn's context (`ToolRunner.run(call, { signal })`, the abort signal), a tool step entry records its name, arguments, status, and text, and the loop requests again.
  A malformed call: a step entry with the message, and the loop requests again. The reply stays `streaming` while its
  call runs, and the step and the next reply are appended together, so `isReplying` holds across the whole turn.
- An agent turn has a Stop button and stops after `brokeCode.maxToolSteps` tool steps (a user setting, `application`
  scope, default 50, at least 1; calls and malformed calls alike) as `halted` with reason `stepLimit`; three malformed calls in a row (`MAX_MALFORMED_IN_A_ROW`) halt it with reason
  `malformedCalls`, and a call that parses resets that count. Stop ends the turn at once, during a reply or a tool
  run: the step in flight is dropped, nothing later runs, and the record is saved as it stands. A failed reply ends
  the turn `failed`; so does an unexpected exception inside the turn (a bug), with an `internal` error giving its
  message, logged with its stack, so the composer never stays locked. Truncate tool results longer than about 2,000 lines and say so in the result.
- Before each request of an agent turn, the first included, the controller estimates its size as the characters of the
  system prompt and of each history message's content (as `toHistory` builds it, reasoning excluded) divided by 4,
  rounded up. Above `floor(size * 7 / 8)` of the model's context size, no request is sent and the reply that would
  have carried it ends `halted` with reason `contextFull`, saved like the other halts; it is never a `ProviderError`,
  which means a request was sent. A turn reads the step limit and context sizes once, when it starts; a settings
  change reaches the usage display at once (`limitsChanged`) and the turns from the next send. The display counts the
  system prompt the last send composed, in any conversation shown, since instruction files and skills are the
  workspace's; before the first send of the session, the one without instruction files or skills. It updates once a send has composed it, before the
  request goes.
  v1 has no automatic summarization.
- After the tools, the system prompt has a "Skills" section, one `- <name>: <description>` line per skill listed to
  the model, telling it to call `load_skill` first; without such a skill the section is absent.
- The system prompt includes `~/.agents/AGENTS.md`, then each workspace folder's `AGENTS.md` (labelled with its
  folder name in a multi-root workspace), read at each send under the mention caps (1 MiB, 2,000 lines). A missing
  file is left out; an unreadable one is logged and left out. The home file follows symlinks; a workspace file is
  held to the workspace boundary. `CLAUDE.md` is not read.
- A mention `@file` attaches the file content. A mention `@folder` attaches its direct children, folders suffixed
  with `/`, sorted by name; never a recursive listing.
- A mention is `@` at the start of the message or after whitespace, up to the next whitespace, less trailing
  `.,;:!?)`. Fenced code blocks and inline code spans hold no mentions. A path mentioned twice is attached once.
- Mentions are read when the message is sent, never again: later turns resend the message as composed then. The
  composed text lives in the chat controller, outside the state posted to the webview. The message and its waiting
  reply show, with Stop, while the mentions are read.
- A mention path resolves against the workspace folders; in a multi-root workspace, a leading folder name and `/`
  select that folder, the longest name winning, since a custom name may hold `/`. After resolving symlinks the
  path must be inside a workspace folder, or its status is `outsideWorkspace`. The file is opened, then its path
  resolved again, and the open handle must be the same file (device and inode) as that inside path: this refuses a
  committed symlink out and a component swapped for one between the first check and the open. A writer swapping
  again between the later checks is out of scope: it already runs with the user's rights and can read the outside
  file itself. `search` checks its `path` the same way, then ripgrep opens it by name: a folder swapped for a
  symlink out after the check, or a subfolder swapped during the walk, is out of scope for the same reason. Other
  statuses: `missing`, `binary` (NUL byte in the first 8 KiB), `tooLarge` (over 1 MiB),
  `unreadable` (any other failure, such as a permission error or a FIFO), `attached`, and `truncated` (cut to its
  first 2,000 lines, then `[truncated: N more lines not shown]`).
- The model receives the user text, then one block per mention: a header `@<path> (<kind>, <count or status>)`,
  then the content in a backtick fence longer than any backtick run inside it, or a one-line notice when nothing
  is attached. The message is sent whatever the statuses. The chat shows each mention as a chip under the
  message, with its kind and status.
- An `@` at the start or after whitespace, outside code, opens the mention menu while the caret ends its token; the
  query is the non-space text after `@`, possibly empty. The menu lists up to 20 index entries whose path contains the query,
  ignoring case, shorter paths first, then in code order. Arrow keys move and wrap, Enter or Tab picks, a click
  picks, Escape closes; while the menu shows rows, Enter never sends. A pick replaces the token with `@<path> ` and
  records the path. At send, a picked path counts while its `@<path>` still stands as a whole token in the text, and
  its text is not parsed again, so a path with spaces or backticks is one mention. A backtick in a picked path can
  make the text read two ways; a picked path follows the reading with picked paths set aside, and a typed token
  counts, and opens the menu, only when it is outside code in both. Answers carry the query id; the
  webview drops stale ones. While the answer to a new query is pending, the menu shows only the earlier rows that
  match it, never a row for an older query. When the files cannot be listed, the menu says so instead of "No match".
- The file index is built on the first menu query with `findFiles("**/*", "**/{node_modules,.git,dist,out,build}/**",
  5000)`: an explicit exclude adds to `files.exclude` (only `null` drops it). `.gitignore` is not read. Folders are
  derived from file paths, none inside a multi-root folder name that holds `/`. Paths are `asRelativePath` with its default prefix, the folder name in a multi-root
  workspace only, which the mention resolver accepts. A file watcher marks the index stale on create and delete
  outside the excluded folders, and so does a workspace folder or `files.exclude` change; the next query rebuilds it, and queries
  during a build share it. At 5,000 files the menu's last line says the index is limited.
- Conversations are saved per workspace, as two JSON files per conversation in the extension's per-workspace storage
  directory (`ExtensionContext.storageUri`), never in the memento: the memento serializes every key on each update
  and VS Code warns from about 500 KB. The record `<id>.json` holds the conversation; the summary
  `<id>.summary.json` holds `{ version, id, title, updatedAt }` only, `version` being the record's, so a valid summary
  spares the list parsing a record that may reach megabytes. A write goes to a uniquely named temporary file, flushed
  to disk, then a `rename(2)` over the final one with `node:fs`, never `workspace.fs`: its rename with overwrite
  deletes the destination first, so a crash between the two steps would lose the conversation. The first listing
  deletes temporary files of either file left by a crash. Reads, writes, and deletes run one at a time in call order,
  so a read sees every write and delete asked before it. A save deletes the summary, writes the record, then writes
  the new summary, in one queued operation, so a summary never describes an older record: the prune deletes by the
  listed update time, and a stale one would delete a recently updated conversation as the oldest. A failed summary
  delete fails the save before the record is written, as a failed record write does, and both files stay as the last
  save left them; a failed summary write is logged only, and that failure or a crash after the delete leaves no
  summary, so the list parses the record until the next save. A delete removes the record, then the summary: a failed record delete keeps both
  and fails; a failed summary delete is logged and the conversation is gone. The workspace memento holds only the last
  provider and model choice and the id of the conversation shown. The list is derived from the directory, newest
  first, conversations without entries left out. It reads a conversation's summary, or its record when the summary is
  missing, unreadable, invalid, of another id, or of another version than 2, and parses the record only then; only a
  record that cannot be read is a listing failure. Accepted gap: a valid version-2 summary beside a corrupt or newer
  record (a crash right after a downgrade, or disk corruption) is listed, and opening it shows the usual not-found or
  invalid error. A summary without its record is not listed and is deleted at that listing. 50 conversations are
  kept: a save past the limit, and the window load, queue a prune with the navigation (below), which deletes the
  oldest by update time, oldest first, never the one shown when it runs. Before each delete the prune reads the
  record: a newer update time than its row (a summary left by a build without summaries) corrects the row and the
  oldest is picked again; a record that cannot be read is kept and the failure shown. The prune deletes only a record
  it has validated: a missing, invalid, or newer-version record is kept on disk and in the list and is logged, never
  shown as a failure, and the prune deletes the next oldest valid conversation instead, so 50 rows remain; the user can
  still delete its row.
- The record is versioned (`version: 2`) and holds the displayed entries: user entries, each with the text the model
  received (`modelText`), assistant entries, with an optional `call` locating the call block in the answer and, when
  `halted`, its `haltReason`, and tool steps. A reopened conversation therefore resends exactly what was sent and
  never reads its mentions again. Version 1 files are skipped like any unknown version: no release wrote them, so
  none is migrated. It holds no API key and nothing else of `ProviderAccess`; a failed reply's error keeps the provider's base
  URL for display, since it is user settings, not a secret. Times are whole milliseconds within the `Date` range. A
  file that fails validation or has an unknown version is logged and skipped; a file that cannot be read is shown as
  a listing failure. On load, a reply still `waiting` or `streaming` becomes `stopped`.
- A conversation is saved when a message is sent, and the request waits for that save (a failed save is shown and the
  request still goes), then at most every 500 ms while a reply streams, when a call starts, after each tool step, and
  when the turn ends (done, stopped, failed, halted, or cut off). A reply's saves go to the record it was sent
  in, also after New chat or opening another one, and a deleted conversation is never written again. A conversation
  without entries is never written.
- Navigation runs one operation at a time, in request order: restore, New chat (and `/new`, #11, through the same
  `newChat` method), open, delete, and prune. The operations that change the conversation shown (New chat, open,
  deleting the one shown) stop the reply in flight at request time and wait until it settles, its last save handed to
  the store, so a later read sees that save. Restore stops nothing: no reply exists at activation. Deleting another row
  and pruning leave the reply running; a reply's own save triggers the prune. The conversation shown is therefore the
  result of the last request, never one deleted or pruned before it: an open queued after a delete or prune of its id
  reads it as missing and says so. Each user request clears the open or not-found error it supersedes; its own failure
  is shown. A listing error has its own field in the panel state (`listFailed`), apart from the error of the
  conversation shown and the user's actions (`storageProblem`: save, delete, open, not found), so the panel can show
  both and neither hides or clears the other; it is cleared only by the next listing that succeeds. Stop ends a reply at
  once even when a step it waits on cannot be aborted (such as a CA file read on a FIFO): the reply is stopped and
  saved, and late reply text or outcome is dropped. A row is dropped only once its delete has succeeded. Deleting the
  conversation shown shows a new one first. `send` is not navigation: its saves go straight to the store. Accepted cost:
  a request waits behind a slow disk operation already queued. Reopening restores the entries only; it does not switch
  the provider or model. History works without a provider: past conversations can be read, reopened, and deleted; only
  the composer needs one. Without a folder or workspace open, there is no storage directory: the conversation stays in
  memory and the list is empty. A failed save, delete, listing, or open is logged and shown in the panel.

### Skills and slash commands

- Skills follow the Agent Skills format (`<name>/SKILL.md` with `name` and `description` frontmatter). The
  extension reads them from two places only: `.agents/skills/` in each workspace folder and `~/.agents/skills/`. A
  workspace skill wins over a personal skill with the same name, and an earlier workspace folder over a later one; a
  hidden skill gives no warning, valid or not. A skipped skill hides nothing: a valid one of its name further down
  the order wins, and the skipped one warns.
- Discovery runs at each send, like the instruction files, over the direct children of `~/.agents/skills/`, then of
  each workspace folder's `.agents/skills/`. A child is a skill when it is a folder holding `SKILL.md` (1 MiB cap); a
  folder without one, a stray file, and a missing skills folder pass silently. A personal skill folder follows
  symlinks; a workspace one, the folder and its `SKILL.md` alike, is held to its own workspace folder, and one linked
  out of it, into another workspace folder included, is skipped with a warning.
- A repository controls its skills folder, and each `SKILL.md` read holds a 1 MiB buffer and a file descriptor, so
  discovery reads one `SKILL.md` at a time, folder after folder, and only the first `MAX_SKILL_ENTRIES` (200) entries of
  each skills folder by name. A folder holding more gives one `tooManyEntries` warning naming it; an entry past the cap
  is never read, so it hides nothing. 5,000 entries linked to one 1 MiB file take about 90 ms per send on the
  maintainer's Mac.
- The frontmatter is the lines between a first line `---` and the next `---`, read by a hand-written subset of YAML
  (`skills.ts`), no YAML dependency: top-level `key: value` with plain, single- or double-quoted, or `>` and `|` block
  values; nested maps and unknown keys are ignored. `name` follows the spec (1 to 64 of `a-z`, `0-9`, `-`, no hyphen
  first, last, or twice in a row); `description` is 1 to 1,024 characters.
- `disable-model-invocation: true` (outside the spec) keeps a valid skill out of the model's list and of
  `load_skill`; it stays discovered for `/<name>`.
- Do not read `.claude/`, `.codex/`, or any other tool's directory. The `.agents` convention is the only one.
- The system prompt lists each skill's name and description only. `load_skill` or `/<name>` loads the body.
- In `/<name> args`, the text after the name replaces `$ARGUMENTS` in the skill body. If the body has no
  `$ARGUMENTS`, the text follows the skill as a user message.
- Skip a skill whose frontmatter lacks `name` or `description`, whose `name` breaks the spec or differs from its
  directory name, or whose `SKILL.md` cannot be read, and show a warning naming the file and the problem; a skills
  folder that exists but cannot be listed is one warning too. The warnings sit in `ChatState.skillWarnings`, are
  replaced at each send, and show in the panel list of skipped providers. The extension logs each send's skills
  (`broke-code: skills listed to the model: ...`) to the extension host console.
- The built-in slash commands are `/new` and `/model`. Typing `/` lists them with every skill.

## Verification

- `bun run lint`, `bun run typecheck`, `bun test`, and `bun run build` run in CI on every pull request and on
  `develop` and `main`. `bun test` needs `rg` (ripgrep) on `PATH`, because the `search` tests run the real binary;
  the workflows install it.
- `bun run lint` runs Biome over code, CSS, and JSON without writing. `bun run format` applies its formatting,
  import sorting, and safe lint fixes. Run it before committing.
- `bun run package` builds and writes `broke-code-<version>.vsix` with the version from `VERSION` (default
  `0.0.0`). It writes the version into the VSIX only, never into `package.json`. CI runs it on every pull
  request as a dry run of the release and checks the version inside the VSIX.
- Run `actionlint` on the workflow files after editing them.
- To try the extension, run `bun run build`, then `codium --extensionDevelopmentPath=<repository path>`
  (VSCodium is the maintainer's editor). Rebuild and reload the window after each change.
- `bun run eval` plays each scenario 10 times per model against the local Ollama at `http://localhost:11434/v1`,
  on `qwen3.8:27b` then `gemma4:26b-a4b-it-qat`, all runs of one model before the next. Each run drives the
  chat controller with the read and write tools over a throwaway copy of the scenario's fixture, each write applied
  at once, no instruction file, no skill, and a
  step limit of 6. Three scenarios, each judged on the turn ending `done` and on the workspace after it: every file
  the scenario writes holds its exact expected text, byte for byte, and every other file is unchanged.
  - `read`: the model must read a setting it cannot guess and answer with its value. Passes when a tool step got the
    value, the answer holds it, and no file changed.
  - `edit`: rename a function named once in `src/pricing.py`. Passes when exactly that line changed.
  - `create`: create `docs/call-format.md` with a text stated in the message that holds double quotes, backslashes,
    `<content>...</content>`, `</write_file>`, and a fenced code block. Passes when the file is exactly that text
    plus one line break.

  A failed run shows one category and a one-line detail: `malformed`, `wrongTool`, `wrongAnswer`, `stepLimit`,
  `contextFull`, `providerError`, `wrongEdit` (a file the scenario writes is missing or holds other text, with the
  first differing line), or `workspaceChanged` (the written files are right, or none was asked for, but another file
  changed). The bar is 9 runs of 10 per model and scenario; the bench exits 1 when a model is under it, and before
  any run when Ollama is unreachable or does not list a model. `--model <name>` (repeatable) and `--runs <n>` shorten
  a local iteration; `--dump <file>` appends each run's entries (tool steps with their call's arguments), verdict, and
  `changes` (each file that differs from the fixture, with its text, `null` when removed) as JSON Lines, to read the
  failing replies; an incomplete last line left by an interrupted run is removed, with a notice, before the first
  append. A full run took 11 min 43 s on the maintainer's Mac, the first run of each model including its load. It
  runs locally on demand and never in CI. On 6224b01, `gemma4:26b-a4b-it-qat` is under the bar on `edit` (6/10):
  every miss is a reply with reasoning and no text, which ends the turn `done` before any call (ADR 0001, amendment
  of 2026-11-09). Scenarios for commands and skills come with
  `run_command` (#9) and skills (#10).
- v1 supports macOS only. Windows and Linux are planned for v2.

## Git and release workflow

- Work on `feature/*` branches and open pull requests to `develop`. Release by opening a pull request from
  `develop` to `main`.
- Merge `develop` into `main` with a merge commit, never a squash. A squash rewrites the commits on `main`, so
  `develop` would always look ahead of `main`.
- Commit messages follow Conventional Commits in English. On each merge to `main`, `release.yml` computes the
  version from the non-merge commits since the last `v*` tag: `feat` or a breaking change (`!` or a
  `BREAKING CHANGE:` footer) bumps the minor, `fix` bumps the patch, and the major stays at 0. The first
  release is `0.1.0`. A range with no `feat`, `fix`, or breaking change publishes nothing, and the run
  succeeds with a log line saying so.
- The release builds, tests, and packages, then creates tag `v<version>` on the merged commit before any
  upload. The tag reserves that version for that commit. Then it publishes to Open VSX, to the Visual Studio
  Marketplace, and last creates a GitHub Release that carries the `.vsix`. A failed run keeps its tag; finish
  it by re-running that run, which reuses the tag's version, skips a registry that already has it, and
  completes the Release. The next merge moves to the next version. The run fails before any upload if the
  computed tag already exists on another commit.
- The git tag is the only source of the version. CI writes the version into the package at build time and
  never commits to `main`, so `package.json` keeps `0.0.0`.
- Only `main` publishes, through the GitHub environment `release`, whose branch policy allows `main` only.
  Open VSX uses the environment secret `OVSX_PAT`, passed to the publish step as an environment variable and
  never on a command line. The Visual Studio Marketplace uses Trusted Publishing (`vsce publish --oidc`), with
  no stored token.

## Boundaries

- broke-code collects no telemetry. It contacts only the configured providers.
- Out of scope for v1, by maintainer decision: Windows and Linux, inline completion, multi-agent modes, MCP,
  code indexing and embeddings, a browser tool, git checkpoints, native or hybrid tool calling, skill
  directories other than `.agents`, `CLAUDE.md`, mentions of the editor selection or diagnostics, automatic
  context summarization, `/clear`, `/help`, and publishing from `develop`.
- Do not copy code from swarm-lab (`joe-el-khoury/swarm-lab`). Its license forbids copying and forks. twinny
  is MIT, so credit it in the README when reusing its code or styles.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `schalappe/broke-code`, managed with `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The default labels `needs-triage`, `needs-info`, `ready-for-agent`, and `wontfix`. See
`docs/agents/triage-labels.md`.

### Domain docs

Single context: `GLOSSARY.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.
