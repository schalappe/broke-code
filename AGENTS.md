# AGENTS.md

## Project overview

broke-code is a VS Code extension that runs a coding agent against LLM services without native tool calling.
It ships on Open VSX and the Visual Studio Marketplace. The author's employer runs an internal LLM service with
an OpenAI-compatible API. It serves Gemma, GLM, Qwen, and newer models, but it rejects the `tools` request
field. Kilo Code and similar agent extensions therefore fail against it. In broke-code, the model writes each
tool call in the text of its reply, and the extension parses and runs the call. The v1 goal is narrow. It
covers the agent loop over the reply text, skills, and slash commands, in a minimal chat panel styled after
twinny.

The code so far covers the extension skeleton, a streaming chat with a provider, and the harness with the read and
write tools and commands: a message starts an agent turn that runs `read_file`, `list_files`, `search`, `write_file`,
`edit_file`, and `run_command` until the model answers without a call. Each write waits behind the approval (a diff and
Accept or Reject in the chat, ADR 0002) unless the user setting auto-approves it; each command waits for Run or Reject,
always. Each send discovers the skills and lists them to the model, which loads one with `load_skill` and may then read
its folder (ADR 0003). `bun run eval` measures that loop on local Ollama models, applying each change and running each
command at once. Typing `/` at the start of a message lists `/new`, `/model`, and the skills; the panel runs `/new` and
`/model` itself, and a message `/<name> args` loads that skill in the controller, with its arguments; any other `/word`
goes to the model as typed. Outside the chat, the command "broke-code: Generate commit message", a button in the
Source Control title of a git repository, sends that repository's staged diff to the provider and model selected in the
chat and writes the reply to the commit input box (ADR 0004). Each final code block of an answer has Copy and Insert at
cursor. The command "broke-code: Add provider", also a button of the panel, adds a provider to the user settings and
stores its key, with a preset for Ollama on this machine. Read `GLOSSARY.md` for the domain vocabulary and `docs/adr/` for the decisions behind the design, starting with
`docs/adr/0001-body-tool-calls.md`.

## Structure

- `GLOSSARY.md`: the domain terms (body tool call, harness, agent turn, tool step, provider, skill, slash command,
  mention). Code and docs use these names.
- `docs/adr/`: architecture decision records.
- `DESIGN.md`: the design rules of the chat panel, written from `src/webview/styles.css`: the token layer, the two
  fonts, spacing and radii, the high-contrast rule, the look of each state, motion, and the keyboard and focus rules.
  Read it before changing the panel's markup or styles.
- `src/core/`: modules that import nothing from `vscode`: settings parsing (`providers.ts`; `readCandidate`, how the
  parser reads a new entry appended to the setting, the one rule of what may be added), the "Add provider" flow
  (`addProvider.ts`: the Ollama preset, the input boxes' validation, the key then the setting, over ports the host
  fills), the API key shape check, the provider
  HTTP client, the CA trust and certificate error classification (`tls.ts`), the SSE reader, the typed provider
  errors and their wording (`providerError.ts`: `describeProviderError` with a translator, for the panel and the
  host's notifications), the generated commit message (`commitMessage.ts`: the request's system prompt, the diff cut to
  the context threshold, the reply's cleaning, and `CommitMessageGenerator`, the command over its git, provider
  request, and user interface ports), the chat controller (conversation state, the agent turn loop with its tool runner, instruction reader, and
  skill reader ports, its limits source and step limits, the context budget check, streaming, Stop, saving, reopen, delete), the conversation record
  (`conversation.ts`: version 2, its validation on load, title, id, the summary file's shape, `filterConversations`, the
  History filter), its store
  (`conversationStore.ts`: a record and a summary file per conversation, the list from the summaries, reads, writes,
  and deletes in call order), and the store's file access (`conversationFiles.ts`:
  the file port, and its implementation over a local directory with `node:fs`: missing versus failed, regular files
  only, atomic writes, leftover temporary files), the dialog queue, the host-webview message
  protocol and its validation, the model list (`modelList.ts`: `emptyModelsLabel`, why the list is empty, for the
  header's select and the Quick Pick; `modelChoices`, the rows `/model` opens; `chooseModel`, the `/model` pick over a
  pick port the host fills with `showQuickPick`), workspace file access (`workspaceFiles.ts`: the inside-workspace check and its read-only
  roots (the loaded skills' folders outside the workspace, for reads only), capped reads, one-level listings, line truncation, the write boundary and atomic writes, with `node:fs`), mentions (`mentions.ts`: token detection, picked and typed
  mentions merged, reading, and the text the model receives), where a message holds Markdown code
  (`markdownCode.ts`; also `remarkFenceClosed`, the remark plugin marking a fenced block whose closing fence the parser read,
  `hasTextAfter`, whether rendered text follows a block, and `codeBlockText`,
  the text Copy and Insert at cursor take), Insert at cursor (`insertCode.ts`: `insertCode` over an editor port the
  host fills with `window.activeTextEditor`: no editor, edit refused, failed, or done), the menu logic (`suggestions.ts`: the `@` token at the caret, index entries,
  filtering, the index exclusions; the `/` token at the start of the message, `BUILT_IN_COMMANDS`, the slash command
  filter), the menu's file index (`fileIndex.ts`: one scan shared until a file
  changes, behind a scan port), the request history (`history.ts`: `toHistory`, the history a request sends, the
  oldest tool results left out when it would fill the context, and `resultLineCount`, the step row's line count), the body tool call parser (`toolCalls.ts`: `ToolSpec`, the first call-shaped block,
  malformed-call messages), the system prompt composer (`systemPrompt.ts`: role, call format, rules, tools,
  skills, instruction files), the turn limits (`limits.ts`: `brokeCode.maxToolSteps` and `brokeCode.contextSizes` parsing,
  the token estimate, the context-full threshold, the typed size check, and `brokeCode.commandTimeoutSeconds` parsing),
  the command tool (`commands.ts`: `RUN_COMMAND_TOOL`, `runCommandTool` checks the call and the folder and asks the
  approval, `runCommand` runs an approved command in its own process group with an injected shell and timeout, and
  `commandShell` picks the shell), and the read tools (`tools.ts`: `read_file` and `list_files` over the mention reader, `search`
  over ripgrep with its candidate paths, bounded `ok` or `error` results, each also reaching the loaded skills' folders
  by absolute path), the write tools (`writeTools.ts`:
  `write_file` and `edit_file` plan a change `{ path, target, before, after }` and never write; an applier port writes
  it, `fileApplier` straight to disk for the tests and the eval, `approvalApplier` around it in the extension: the
  unsaved-editor check, the approval request, then the write), the approval seam (`approval.ts`: the request a tool
  makes, the decision it gets, the rejection text, and the decisions of the editor side: which change diffs to close,
  the unsaved-editor check over the open documents, the auto-approve setting from its user value), the tool runner (`toolRunner.ts`: the read and write tools over the
  workspace folders, the read tools also over the run's `skillRoots`, each write handed to the applier the host builds
  for the run, `run_command` with the command environment the host passes, read at each call, and `load_skill` over
  the run's `skills`), the instruction files
  (`instructions.ts`: `~/.agents/AGENTS.md`, then each workspace folder's `AGENTS.md`, under the mention caps), and the
  skills (`skills.ts`: discovery in `~/.agents/skills/` and each workspace folder's `.agents/skills/`, the frontmatter
  subset, validation, precedence, warnings, the line the extension logs at each send; `LOAD_SKILL_TOOL`, `loadSkill`
  for the model's call, `findSlashSkill`, the skill a `/<name> args` message loads, `loadSkillText`, the load result
  whoever loads, the user's arguments substituted or appended, and `answerSkillQuery`, the `/` menu's answer). `markdownCode.ts`, `suggestions.ts`, `modelList.ts`, `conversation.ts`, and `history.ts` import nothing from
  `node:`, since the webview loads them. Unit tests sit next to them as `*.test.ts`, because `bun test` cannot load `vscode`. `tlsFixture.ts`
  generates test certificates with `/usr/bin/openssl` at test time; no private key is committed.
  `conversationFixture.ts` is the in-memory conversation file port for tests.
- `src/extension/`: the extension host glue (activation, webview view, API keys in `SecretStorage` and their dialog
  queue, the "Add provider" flow's Quick Pick, input boxes, and settings write in `addProvider.ts`, the
  file index's `findFiles` scan and watcher in `fileIndex.ts`, the turn limits and the command timeout from the user
  settings and the "Set context size" input box in `contextSizes.ts`, the tool runner's wiring (the ripgrep candidates
  from `vscode.env.appRoot` and `PATH`, the write tools behind `approvalApplier`, the command shell from
  `vscode.env.shell`, `$SHELL`, or `/bin/sh`), the write approval's editor side in
  `approval.ts` (the diff preview over `vscode.diff` and a content provider, the tabs, documents, and
  `brokeCode.autoApproveWrites` values it feeds the core decisions), the instruction reader and the skill reader from the home folder and the workspace folders, the latter logging the
  skills of each send, and the same discovery, unlogged, for the `/` menu's `querySkills`; `chatView.ts` opens the
  Quick Pick of `chooseModel` and runs `insertCode` over the active text editor; `commitMessage.ts` registers `broke-code.generateCommitMessage`, its git port over the
  built-in Git extension's API, the repository Quick Pick, the replace question, the progress notification, and the
  notifications).
- `src/webview/`: the React chat panel and its CSS (`styles.css`: a token layer, then rules that consume it, every color
  from a `--vscode-*` variable; see `DESIGN.md`), tool step rows, the approval controls, and the answer's code blocks with Copy and Insert at cursor (`CodeBlock`,
  the `pre` override of the answer's renderer) included. `SuggestionMenu.tsx` is the autocomplete list the `@` and
  `/` menus share, a row with an optional description; `composer.ts` holds the message box's decisions without React
  (the token at the caret, each menu's rows, what a key does, what picking a `/` row does (`slashPick`), the built-in
  command a message runs). `turns.ts` groups the entries for rendering without React (`foldTurns`: each entry once,
  an ended turn's fold and its step counts), and `text.ts` words the fold's row (`describeFold`).
- `src/l10n.test.ts`: checks that every `l10n.t` message has a French translation and that the
  `package.nls*.json` files match.
- `l10n/bundle.l10n.fr.json`, `package.nls.json`, `package.nls.fr.json`: French strings for the host and
  webview, and the English and French manifest strings. English messages are the keys of `l10n.t`.
- `scripts/build.ts`: `bun run build` writes the host bundle (`dist/extension.js`, CommonJS) and the webview
  bundle (`dist/webview/`).
- `scripts/next-version.ts`: computes the next release version from the commits since the last `v*` tag. The
  release workflow runs it as a CLI. Its tests sit next to it.
- `eval/`: the Ollama eval bench (`bun run eval`). `scenarios.ts` holds each scenario (fixture files, an optional
  fixture home folder, message, the files it must write with their exact text, an optional check of a turn that ended
  `done`) and `judge`, the verdict and failure category of a run, which compares the workspace after the run with the
  fixture plus those writes; `run.ts` plays one run through the `ChatController` ports, with the read and write tools,
  `run_command`, and `load_skill` over a copy of the fixture under the system temporary directory, each write applied at
  once by `fileApplier` and recorded for the dump, each command approved at once and run with `BENCH_COMMAND_ENV`, and
  the skills discovered in a copy of the fixture home, never the real one;
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
- Webview tests render static HTML with `renderToStaticMarkup`. A test that clicks or types registers a DOM with
  `@happy-dom/global-registrator` (exact-pinned dev dependency) for its own duration and unregisters it after.
- The UI ships in English and French and follows the VS Code display language, with English as the fallback.

## Architecture

### Provider contract

- broke-code speaks one contract: streaming `POST /v1/chat/completions` and `GET /v1/models`. It covers the
  internal service and Ollama.
- Never send `tools` or read `tool_calls`, even to a provider that supports them. See ADR 0001.
- Providers (name and base URL) live in the VS Code user settings only (`application` scope). A workspace
  `settings.json` must not override them, because keys are stored by provider name and a repository could
  otherwise point that name at its own URL. Each API key lives in `SecretStorage`, never in `settings.json`.
- One writer of `brokeCode.providers`: "broke-code: Add provider" (`broke-code.addProvider`, in the Command Palette,
  beside "Open provider settings" in the no-provider state, and under the skipped providers while a valid provider
  exists; without one, the empty state's button is the only one, maintainer decision). A Quick Pick offers
  "Ollama on this machine" (`ollama`, `http://localhost:11434/v1`, the empty key; never probed) and "Other
  OpenAI-compatible service", which asks the name, the base URL, then the key in a password box, no Back. A box
  accepts a value when `parseProviders`, given the user value plus the candidate entry, keeps it (`readCandidate`),
  each reason with a short message of its own; the key passes the shape check and may be empty. When a valid
  `ollama` exists, the preset writes nothing and selects it. On completion, in order: the key is stored under the
  name (`""` for no key, so no key prompt follows), then the entry `{ name, baseUrl }`, base URL as the parser
  normalizes it, is appended to the user value (`ConfigurationTarget.Global`); other entries, skipped ones and
  `caFile` included, keep their order and fields, and a value that is not an array becomes the one-entry array. Key
  first because keys are never deleted with their provider: a setting written first would send a removed provider's
  leftover key to a new URL of the same name. A failed key write is shown and writes no setting; a failed settings
  write is shown and deletes the key just stored. The entry is checked against the setting before the key is stored
  and again after, and the write appends to that second read, so a providers change made meanwhile (another window,
  a `settings.json` edit) is kept; an entry refused by then (its name taken) is shown and deletes the key, writing
  nothing. Accepted race: a change landing between that read and the write is overwritten, since settings have no
  compare-and-swap. Then the host applies the settings and selects the new provider,
  except while a reply is in flight. The flow runs in the API key dialog queue, so the missing-key prompt the settings
  write triggers runs after it and finds the key. Escape at any step writes nothing. Editing or removing a provider
  stays in `settings.json`.
- Requests never follow HTTP redirects; a redirect is reported as an error. Provider response bodies are read
  under size caps that cancel the download when exceeded. Responses may be compressed with gzip, deflate, or br;
  the caps count decoded bytes, and any other `Content-Encoding` is reported as an error.
- The API does not report a model's context size. The `brokeCode.contextSizes` user setting (`application` scope,
  read from `globalValue` like the providers) maps model names to sizes in tokens; a model absent from it, or with an
  entry that is not a positive integer, uses 32,768. While such a model is selected, the chat shows "Unknown context
  size, using 32k" with a link: the host asks for the size in an input box and merges it into the user value of the
  setting. The header shows the next request's estimated size, as it would be sent (older tool results left out
  included, see "Harness"), against the model's size.
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
  error, three malformed calls in a row stop the agent turn, and a reply with text but no call is the final answer. An
  empty reply (no text once trimmed, reasoning excluded) is no final answer: it is handled as a malformed call
  (maintainer decision, ADR 0001). Change these rules only on evidence from the Ollama eval.
- A known tool's call ends at the `</tool_name>` after its last argument value, not at the first one. A value ends at
  the first `</argument>` that closes no `<argument>` opened inside the value and is followed by nothing but
  whitespace and then another argument tag of the tool or the call's closing tag: an inner `<argument>` …
  `</argument>` pair is kept, so a value can hold a whole example call. When the tags never balance, the value ends
  at the first `</argument>` so followed, pairs ignored; failing that, at the last `</argument>` before the next
  `</tool_name>`. A value may therefore hold `</write_file>`, `</content>`, other tools' tags, and code fences. Known
  cost, kept by maintainer decision: a value holding an unpaired `<argument>` pairs it with the real closing tag, so
  it runs on into the text after the call when that text holds `</argument>` then `</tool_name>`. The parser drops
  one leading and one trailing line break of a value that sits on its own lines (both or neither); an argument marked
  `oneLine` in its `ToolSpec` (each `path`, `cwd`, the `search` pattern, the `load_skill` name) loses every leading
  and trailing line break instead (ADR 0001, 2026-11-10). `write_file` then
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
- The file tools (`read_file`, `list_files`, `search`, `write_file`, `edit_file`, and `load_skill`) act inside the open
  workspace only. `run_command` is not confined: its `cwd` must be a workspace folder, but an approved command runs
  with the user's rights and can read, change, or delete anything the user can, outside the workspace too; the
  approval is the only guard. The one exception to the file tools' boundary is read-only access to the directories of
  skills loaded in the current conversation that lie outside the workspace (ADR 0003):
  - A skill is loaded when the conversation holds an `ok` `load_skill` step for its name, or a user entry whose
    `skill` is `loaded` (a `/<name>` message); an `error` step, a step dropped by Stop, a malformed call, and a
    `failed` user skill load nothing. Before each call the controller maps those names to folders through the current
    send's discovery (`ToolContext.skillRoots`, beside `ToolContext.skills`, the send's skills), so a load earlier in
    the turn counts at the next call, a reopened conversation keeps its loaded skills, and a skill gone since is no
    longer readable.
  - `read_file`, `list_files`, and `search` also accept an absolute path inside a loaded skill's real folder, the path
    its load result gives. The shared read boundary (`readWorkspaceEntry`, `locateWorkspacePath`) takes the folders
    as read-only roots. An absolute path written inside one is read as written, never rerouted through a multi-root
    folder name (a folder named `/private` included). For a folder outside the workspace, the path must resolve inside
    the deepest loaded folder that holds it, symlinks resolved, and the open handle must match it by device and
    inode, as for workspace reads. A symlink out of it, into another loaded folder (its outer one included) or the
    workspace, is `outsideWorkspace`. The folder is matched by the real path discovery gave, never resolved again.
    `search` with a `path` in such a folder prints absolute paths.
  - Mentions never get the exception, and the write boundary never takes the read-only roots: a planned write into a
    skill folder outside the workspace is refused `outsideWorkspace`. A workspace skill's folder is ordinary
    workspace (maintainer decision): writable with approval, its symlinks may resolve anywhere in the workspace, and
    `search` prints its paths relative to the workspace.
- Approvals (ADR 0002):
  - Reads run without asking.
  - A tool asks through its run context: `ToolContext.requestApproval(request)` settles with Accept, Reject (with the
    reason typed, trimmed, left out when blank), or Cancel. While the request is open, the reply stays `streaming` and
    `ChatState.approval` holds `{ id, kind, tool, summary }`; the chat renders the step row "waiting for your decision",
    Accept (Run for a command), Reject, and a reason field from that state alone, in one block, and never moves the
    focus when the request opens: from the message box, Shift+Tab reaches Reject, then Accept or Run, then the reason
    field. The webview's `approve { id }` and
    `reject { id, reason? }` are validated like the other messages, and a decision for a request no longer open is
    ignored. One request at a time, since one call runs per reply.
  - A write opens the native VS Code diff editor beside the chat, titled with the path: the planned `before` text on
    the left (empty for a new file), the proposed text on the right, both from a content provider. Accept writes with
    the atomic applier below, never through `WorkspaceEdit`; the diff tab closes on Accept, Reject, and Cancel. Closing
    the tab by hand changes nothing: the request stays open, Accept and Reject still work, and the diff cannot be
    reopened. A file
    open in an editor with unsaved changes is refused before the request and again right before the write, with
    auto-approve too, as an `error` result saying so; a file changed on disk since the plan is refused by the
    applier's planned-text check.
  - A rejection goes back to the model as an `error` tool result: "The user rejected this change." ("The user rejected
    this command." for a command), then the reason on its own line when given. It is a tool step like any other and counts toward the step limit. The step records how it
    was approved (`approval`: `accepted`, `rejected`, or `auto`), and the row says rejected or auto-approved.
  - Stop, New chat, opening another conversation, deleting the one shown, and deactivation cancel the open request:
    the diff tab closes, nothing is written, the reply ends `stopped`. An open request is never saved; a record saved
    while one waits reloads `stopped` by the in-flight rule below.
  - `run_command` always waits for a click: it asks with a request of kind `command`, its summary the whole command,
    which the step row shows whole, line breaks kept, with the `cwd` when given ("in <cwd>"), Run, and Reject. Nothing runs before Run, and one Run runs
    the command once.
  - `brokeCode.autoApproveWrites` (boolean, default false, `application` scope, read from `globalValue` like the
    providers) accepts writes at once, without a diff, and is read at each write's request. The controller applies it
    to requests of kind `write` only: nothing auto-approves commands.
- `run_command(command, cwd?)` runs `<shell> -c <command>` in a hidden child process, no login shell, the shell being
  `vscode.env.shell`, else `$SHELL`, else `/bin/sh`. `cwd` resolves like a read tool's path and must be an existing
  folder inside the workspace; left out, the command runs in the first workspace folder. Without a workspace folder,
  an empty command, or a refused `cwd`, the call is an `error` before any approval. The child is spawned `detached`, so
  it leads a process group of its own, with stdin closed (`ignore`, so a read gets end of file at once) and the host's
  environment.
  - The result's first line is `exit code N`, `killed by <signal>`, or `stopped after N seconds`, then a `stdout:` and
    a `stderr:` section (`stdout: (empty)` when nothing came), each cut to its first 2,000 lines and 1 MiB (cut
    between UTF-8 characters) with the mention truncation notice. It is `ok` only on exit code 0; a non-zero code, a
    signal, a timeout, a spawn failure, and a rejection are `error`. The step row shows the command, then the exit code
    (or signal, or timeout) and the result's line count.
  - `brokeCode.commandTimeoutSeconds` (integer, default 120, at least 1, `application` scope, read from `globalValue`
    at each command; capped at the longest timer delay, about 24 days). At the timeout, or on Stop, New chat, the other
    navigation, and deactivation during the run, the group gets SIGTERM (`process.kill(-pid)`), then SIGKILL two
    seconds later unless the group is gone by then (checked every 20 ms). The result waits until the group is gone or
    SIGKILL was sent, so it never claims a stop that has not happened, and then for the output pipes, at most half a
    second more, since a process that left the group may hold them. A stop during the run ends the reply `stopped`.
  - Once the shell exits, the output gets 200 ms to drain. A process still in the group then (a background job, its
    output redirected or not) is stopped the same way, and the result ends with a line saying what is true when it
    settles: "were stopped" (the group is gone), "did not stop on SIGTERM; they were sent SIGKILL after 2 seconds",
    "were sent SIGKILL as the extension shut down" (deactivation, below), or "could not be stopped; they may still be
    running" (the signals failed). A process that left the group (`setsid`, a
    daemon) is not stopped, and the result stops waiting for the pipes it holds. A Stop after the shell exited keeps
    its exit code. macOS answers EPERM for a group of zombies, so only a group a signal 0 reaches counts as alive.
  - A signal that fails with ESRCH (the group is gone) or EPERM (zombies, or processes that changed user and could not
    be stopped anyway) is ignored. Any other failure adds a line `Sending <signal> to the command's processes failed
    (<code>).` to the result, whose status still follows the exit code. When SIGKILL itself fails, the result never
    says the command stopped: a timeout's first line is `timed out after N seconds; its processes could not be stopped
    and may still be running` (the step row then shows the generic error status), a Stop's is `run_command: Stop could
    not end the command; its processes may still be running.`.
  - Deactivation also calls `killRunningCommands` synchronously from `deactivate`: SIGKILL at once to every group still
    running or in its grace, since the host may exit before a scheduled SIGKILL fires. Ownership is per run, not per
    group id (`ownCommandGroup`): a run claims its group at spawn and releases its own claim, by identity, once the
    group is gone, got SIGKILL, or the run settled, so a later run that gets the same id keeps its claim. Deactivation
    releases every claim and tells each run, which cancels its pending SIGKILL and probes: once released, a run never
    signals that id again, since the system may reuse it. A SIGKILL that fails there for another reason than ESRCH or
    EPERM is logged and reaches that run's result as a failed-signal line, so the run never says it stopped; a run not
    yet stopping ends as stopped, a timeout or a leftover cleanup keeps its reason. Accepted limit: a host that crashes never calls it, so a process that ignores SIGTERM can then
    outlive it.
- A turn runs from a user message to the entry before the next one; it has ended unless it is the last turn and a
  reply is in flight. An ended turn keeps its last reply, and any tool step after it (a `stepLimit` or `malformedCalls`
  halt), in view, and folds every entry between its user message and that reply under one row when the fold holds at
  least 2 tool steps (`foldTurns`); any other turn renders as before, with no wrapper. The row is an uncontrolled
  `<details>`, closed when the turn ends, like the reasoning block: "N steps", N the tool steps inside the fold
  (malformed calls and empty replies included), then ", M failed" (status `error` or `malformed`, not rejected) and
  ", K rejected" (`approval` `rejected`) when not zero, in words. The turn in flight never folds, so a running step and
  an open approval always show; a row opened inside comes back closed once its turn folds, since its entries remount.
  Entries before the first user message, and a turn with no reply, never fold. Rendering only: the state, the record,
  and the history sent to the model are unchanged.
- Reasoning output (`<think>` tags, `reasoning`, or `reasoning_content`) shows collapsed in the chat. The parser
  never looks for tool calls in it, and the conversation history sent back to the model drops it.
- A code block of an assistant answer (fenced or indented, rendered by the answer's Markdown) has Copy and Insert at
  cursor in a header above its code once its text is final: its closing fence was written, rendered text follows it
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
  place for 2 seconds. Insert at cursor posts `insertCode { text }` (dropped unless `text` is a string of at most
  `REPLY_MAX_LENGTH` characters, since a block cannot be longer than its reply); the host replaces every selection of
  `window.activeTextEditor` with it, inserting at each caret, in one `editor.edit`, so one Undo restores it. No active
  text editor, an edit the editor refuses (a read-only document, such as the write approval's diff), and an edit that
  throws each show a native error notification and change nothing. VS Code's `edit` settles `true` on a read-only
  document although nothing applied, so an edit counts as refused when it settles `false`, or when the document's
  version did not change and some selection does not already hold the text (then nothing needed changing: `done`). A
  success shows nothing, and neither button moves the focus.
- Each request of an agent turn sends a `system` message first, then the history: each user entry's composed text,
  each assistant answer verbatim with its call block (reasoning never), and each tool step as a `user` message
  `<tool_result tool="<name>" status="ok|error">`, the text, then `</tool_result>`, never the OpenAI `tool` role
  (ADR 0001). A malformed call's message goes back the same way with `status="error"`, with `tool` the tag name the block
  opens with, a known tool or not, and `tool="unknown"` only when no tool name can be read, as for an empty reply. A
  reply without text is left out of the history, unless a tool step follows it: an empty reply goes back as an
  assistant message with `content: ""` before its step, so the roles keep alternating (Gemma's chat template requires
  it). `toHistory` (`history.ts`) builds it, and leaves the oldest tool results out of a request that would fill the
  context (below).
- While a reply streams, a `<tool_result` the model writes after a complete call (`forgedResultCut`) cancels the request,
  and the reply ends `done` at the end of that call (ADR 0001, 2026-11-10): models forge results of calls that never
  ran. An opening with no complete call before it stops nothing.
- When a reply ends, its answer goes through the parser. Text and no call: the turn ends. A call: the answer is cut
  at the end of the call block, so the chat and the history never hold the text after it, then the tool runs with the
  turn's context (`ToolRunner.run(call, { signal, requestApproval })`, the abort signal and the approval request), a tool step entry records its name, arguments, status, text, and approval, and the loop requests again.
  A malformed call or an empty reply: a step entry with the message (for an empty reply, "Your reply was empty. Call a
  tool, or write your answer to the user."), and the loop requests again. The reply stays `streaming` while its
  call runs, and the step and the next reply are appended together, so `isReplying` holds across the whole turn.
- An agent turn has a Stop button and stops after `brokeCode.maxToolSteps` tool steps (a user setting, `application`
  scope, default 50, at least 1; calls and malformed calls alike) as `halted` with reason `stepLimit`; three malformed calls in a row (`MAX_MALFORMED_IN_A_ROW`) halt it with reason
  `malformedCalls`, and a call that parses resets that count. Stop ends the turn at once, during a reply or a tool
  run: the step in flight is dropped, nothing later runs, and the record is saved as it stands. A failed reply ends
  the turn `failed`; so does an unexpected exception inside the turn (a bug), with an `internal` error giving its
  message, logged with its stack, so the composer never stays locked. Truncate tool results longer than about 2,000 lines and say so in the result.
- Before each request of an agent turn, the first included, the controller estimates its size as the characters of the
  system prompt and of each history message's content (as `toHistory` builds it, reasoning excluded) divided by 4,
  rounded up. Above `floor(size * 7 / 8)` of the model's context size (`fillsContext`, never a copy of its arithmetic),
  the history sent replaces the text of tool steps, oldest first over the whole conversation as sent (earlier turns
  included), with one line inside the same `<tool_result>` wrapper, same `tool` and `status`:
  `[result left out to save context: N lines]` (`1 line` for one), N being the step row's line count
  (`resultLineCount`: a trailing line break dropped, then split; 0 for an empty text). It replaces the fewest steps
  that make the estimate fit. Never replaced: the system prompt, user messages (a `/<name>` skill message included),
  assistant answers, the last 3 tool steps of the conversation (`KEPT_RECENT_STEPS`), whatever turn they belong to,
  every `load_skill` step, whatever its status (a second load answers "already loaded" without the body), and a step
  whose replacement line is not shorter than its text; a malformed-call step follows the same rule as the others. The
  choice is a pure function of the entries, the system prompt, and the context size, linear in the entries, since the
  usage display runs it at each streamed delta. Only what is sent changes: the record and the chat keep every result
  whole, and the loaded skills are still derived from the entries. When the estimate is still over with every eligible
  result replaced, the history goes whole, no request is sent, and the reply that would have carried it ends `halted`
  with reason `contextFull`, saved like the other halts; it is never a `ProviderError`, which means a request was sent.
  The usage display (`ChatState.context`) counts the request as it would be sent, and its optional `leftOut` counts the
  results left out; while it is set, the panel shows "N older tool results are left out of the request to save
  context." in the place and look of the unknown-size notice, derived from the state, never saved or sent. Known cost,
  accepted: once at the threshold, most requests replace one more old step, which changes the prompt's prefix and
  defeats a provider's prompt cache. A turn reads the step limit and context sizes once, when it starts; a settings
  change reaches the usage display at once (`limitsChanged`) and the turns from the next send. The display counts the
  system prompt the last send composed, in any conversation shown, since instruction files and skills are the
  workspace's; before the first send of the session, the one without instruction files or skills. It updates once a send has composed it, before the
  request goes.
  v1 has no automatic summarization: leaving results out is a deterministic cut, with no model call.
- After the tools, the system prompt has a "Skills" section, one `- <name>: <description>` line per skill listed to
  the model, telling it to call `load_skill` first; without such a skill the section is absent, and so are the
  `load_skill` tool and its rule (reading a loaded skill's files by the absolute path the result gives, read-only
  outside the workspace): the
  controller offers the runner's tools less `load_skill` (`offeredTools`), so its call is then malformed.
- The system prompt includes `~/.agents/AGENTS.md`, then each workspace folder's `AGENTS.md` (labelled with its
  folder name in a multi-root workspace), read at each send under the mention caps (1 MiB, 2,000 lines). A missing
  file is left out; an unreadable one is logged and left out. The home file follows symlinks; a workspace file is
  held to the workspace boundary. `CLAUDE.md` is not read.
- A mention `@file` attaches the file content. A mention `@folder` attaches its direct children, folders suffixed
  with `/`, sorted by name; never a recursive listing.
- A mention is `@` at the start of the message or after whitespace, up to the next whitespace, less trailing
  `.,;:!?)`. Fenced code blocks and inline code spans hold no mentions. A code span opens and closes in one paragraph: a
  blank line or a fenced block between two backticks leaves both literal. A path mentioned twice is attached once.
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
- A `/` at the very start of the message opens the `/` menu while the caret ends its first word; the query is the text
  after `/`, possibly empty. A `/` anywhere else opens nothing, since paths hold them. The menu lists `/new` ("Start a
  new conversation"), `/model` ("Choose the model"), then each skill the send's discovery finds, by name, with its
  description (`disable-model-invocation: true` included, skipped ones left out), keeping those whose name starts with
  the query, ignoring case, up to 20; "No match" when none. When the menu opens, the webview posts `querySkills { id }`
  once, since a discovery reads every `SKILL.md`; the host runs the send's discovery without its log line (its warnings
  wait for the next send) and answers `skillSuggestions { id, items, failed }`, which `chatStateOf` leaves out; the
  webview filters as the user types and drops an answer to an earlier opening. Until the answer comes, only the
  matching built-ins show, and no menu when none matches. When a skills folder cannot be listed (its
  `folderUnreadable` warning) or the discovery fails, the answer is `failed` and the menu says so, keeping the
  built-ins and the skills found elsewhere; a skipped skill is no listing failure. Keys and clicks work as in the `@`
  menu. Picking a skill row replaces the token with `/<name> `, for its arguments. Picking a built-in row (Enter, Tab,
  or a click) runs that command at once, as sending it would, when Send would act and nothing but whitespace follows
  the token; otherwise it inserts `/<name> ` and nothing runs, so a draft after the token is never cleared.
- A message whose trimmed text is exactly `/new` posts the New chat button's `newChat` request and closes History;
  exactly `/model` posts `chooseModel`, and the host opens VS Code's Quick Pick over `controller.snapshot`: the
  selected provider's listed models in listing order (`modelChoices`, the header select's list, never fetched again),
  the selected one described "current", placeholder "Choose the model". Before the models are listed, it opens empty,
  its placeholder saying why as the header's select does ("Loading models…", "Models unavailable", "No models"). A
  pick goes through `controller.selectModel`, as the header select's change, so the header follows; Escape changes
  nothing; a Quick Pick that fails is logged and shown as an error (`chooseModel`). (A webview cannot open the
  select's own list: Chromium refuses `showPicker()` in a cross-origin iframe.)
  Both clear the box and act only when Send would (a model chosen, no reply in flight); nothing reaches the model.
  `/new words` and `/model words` are ordinary messages.
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
  received (`modelText`) and an optional `skill` (`{ name, status }`, any other shape making the record invalid),
  assistant entries, with an optional `call` locating the call block in the answer and, when
  `halted`, its `haltReason`, and tool steps, with an optional `approval`. A reopened conversation therefore resends exactly what was sent and
  never reads its mentions again. Version 1 files are skipped like any unknown version: no release wrote them, so
  none is migrated. An optional field added to an entry keeps the version: an older build drops the unknown key and
  reads the rest (ADR 0003). It holds no API key and nothing else of `ProviderAccess`; a failed reply's error keeps the provider's base
  URL for display, since it is user settings, not a secret. Times are whole milliseconds within the `Date` range. A
  file that fails validation or has an unknown version is logged and skipped; a file that cannot be read is shown as
  a listing failure. On load, a reply still `waiting` or `streaming` becomes `stopped`.
- A conversation is saved when a message is sent, and the request waits for that save (a failed save is shown and the
  request still goes), then at most every 500 ms while a reply streams, when a call starts, after each tool step, and
  when the turn ends (done, stopped, failed, halted, or cut off). A reply's saves go to the record it was sent
  in, also after New chat or opening another one, and a deleted conversation is never written again. A conversation
  without entries is never written.
- Navigation runs one operation at a time, in request order: restore, New chat (and `/new`, through the same
  `newChat` request), open, delete, and prune. The operations that change the conversation shown (New chat, open,
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
- History has a text field "Filter by title" above its rows, shown when at least one conversation is listed; it stays
  in place while the rows scroll. It keeps the rows whose title contains its text (`filterConversations`: the query
  trimmed, lowercase on both sides, a substring, no accent folding, order kept; a blank query keeps all), and says "No
  match" when none is left. It filters in the webview over the listed titles (cut to 60 characters): no host message,
  no record read. Opening History focuses it (the one focus move DESIGN.md allows). Enter opens the first row listed,
  as a click on it does, and does nothing with no row or while an input method composes. Escape clears a non-empty
  field; in an empty one it closes History and focuses the History button. A reply that ends while History is open
  leaves the focus where it is, instead of moving it to the message box. Its text lives in the list mounted while
  History is open, so every close clears it; a list change (a delete, a save) is filtered with the same text. The
  listing-failure notice shows whatever the filter.

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
  out of it, into another workspace folder included, is skipped with a warning (`outsideWorkspace`). Every file of a
  skill lies in its own folder: for a personal or a workspace skill, a `SKILL.md` that resolves outside the skill
  folder's real path (the folder's own link resolved) is skipped with an `outsideSkillFolder` warning, so the folder a
  loaded skill's files are read from holds all of it.
- A repository controls its skills folder, and each `SKILL.md` read holds a 1 MiB buffer and a file descriptor, so
  discovery reads one `SKILL.md` at a time, folder after folder, and only the first `MAX_SKILL_ENTRIES` (200) entries of
  each skills folder by name. A folder holding more gives one `tooManyEntries` warning naming it; an entry past the cap
  is never read, so it hides nothing. 5,000 entries linked to one 1 MiB file take about 90 ms per send on the
  maintainer's Mac.
- The frontmatter is the lines between a first line `---` and the next `---`, read by a hand-written subset of YAML
  (`skills.ts`), no YAML dependency: top-level `key: value` with plain, single- or double-quoted, or `>` and `|` block
  values; nested maps and unknown keys are ignored. `name` follows the spec (1 to 64 of `a-z`, `0-9`, `-`, no hyphen
  first, last, or twice in a row); `description` is 1 to 1,024 characters.
- `disable-model-invocation: true` (outside the spec) keeps a valid skill out of the model's list, and the model cannot
  load it with `load_skill`; it stays discovered for `/<name>`, and once the user loaded it that way the model's
  `load_skill` of it answers "already loaded".
- Do not read `.claude/`, `.codex/`, or any other tool's directory. The `.agents` convention is the only one.
- The system prompt lists each skill's name and description only. `load_skill` or `/<name>` loads the body.
- `load_skill(name)` loads a skill of the send's discovery that is listed to the model; a skill already loaded in the
  conversation answers "already loaded" (below), listed to the model or not. Its `ok` result is
  `Skill <name> loaded; its files live in <real folder path>; read them by that absolute path.`, a blank line, then the
  `SKILL.md` body without its frontmatter and the blank lines after it, cut to 2,000 lines with the mention notice
  (`SKILL.md` is read under the 1 MiB cap, inside the skill's real folder like its other files: discovery already
  skipped one linked out, so this check only catches a swap since, as `its SKILL.md could not be read (it links outside
  the skill's folder)`). A skill already loaded gives `ok`, `Skill <name> is already loaded; its files live in ...`,
  without the body, also one kept from the model that the user loaded with `/<name>`: an error there made models read
  the loaded text as injected and refuse it (#50, live). An unknown name, a skipped skill, and one kept from the model
  and not loaded give an `error` naming the skills the model may load.
- A sent message is a skill command when its trimmed text is `/`, a name of the send's discovery (listed to the model
  or not; a skipped skill is not discovered), then whitespace or the end (`findSlashSkill`, in the controller's send,
  after discovery). Any other `/word` is sent as typed, `/new` and `/model` included (#51 handles them in the webview
  before any send). `args` is the text after the name, trimmed.
- The model receives one user message (role alternation): `loadSkillText(skill, args)`, the `load_skill` text with
  every `$ARGUMENTS` of the body replaced by `args`, the empty string included, before the cut to 2,000 lines and
  1 MiB (between characters, a line the byte cap cuts counted as not shown; a longer text is never built whole, since a
  repository's `SKILL.md` can hold 100,000 `$ARGUMENTS`); a body without `$ARGUMENTS` is followed, when `args` is not
  empty, by a blank line and `args`, its trailing line breaks dropped first. Mentions in `args` are read as for any
  message and their blocks follow; the `/<name>` token is never a mention. A `SKILL.md` that cannot be read at send
  (swapped since discovery) still sends the message, as an unreadable mention does: `Skill <name> could not be loaded: its SKILL.md could not be read (<reason>).`, then `args`
  after a blank line. The user entry keeps the text as typed and gets `skill: { name, status: "loaded" | "failed" }`,
  which the chat shows as a chip `Skill <name>` before the mention chips. A loaded one counts as loaded in the
  conversation from that message on (see "Harness"); a second `/<name>` sends the whole text again, and the model's
  `load_skill` of it answers "already loaded".
- Skip a skill whose frontmatter lacks `name` or `description`, whose `name` breaks the spec or differs from its
  directory name, or whose `SKILL.md` cannot be read, and show a warning naming the file and the problem; a skills
  folder that exists but cannot be listed is one warning too. The warnings sit in `ChatState.skillWarnings`, are
  replaced at each send, and show in the panel list of skipped providers. The extension logs each send's skills
  (`broke-code: skills listed to the model: ...`) to the extension host console.
- The built-in slash commands are `/new` and `/model`, run by the webview and never sent (Harness, the `/` menu).
  Typing `/` lists them with every skill. A skill named `new` or `model` is listed too, after the built-ins, but a
  message of exactly its `/<name>` runs the built-in; picking the skill's row inserts `/<name> ` like any skill.

### Commit message

- The command `broke-code.generateCommitMessage` ("broke-code: Generate commit message", `$(sparkle)` icon) is in the
  Command Palette and in the `scm/title` menu, group `navigation`, `when` `scmProvider == git` (ADR 0004). It never
  stages, commits, or pushes; it runs while a chat reply is in flight and touches no conversation: nothing is saved.
- Git access goes through the built-in Git extension's API (`vscode.git`, version 1), looked up at each run, never an
  `extensionDependencies` entry. The members used are typed structurally in `src/extension/commitMessage.ts`
  (`enabled`, `getAPI(1)`, `state`, `onDidChangeState`, `repositories`, `Repository.rootUri`, `inputBox.value`,
  `diff(true)`), and the exports are checked at run time. No extension or exports of another shape: "not available";
  `enabled` false or `getAPI` throwing (`git.enabled` off, git not found): "disabled". While the API's `state` is
  `uninitialized` its repository list is empty, so a run waits for `initialized`, at most 10 seconds, then goes on with
  the repositories opened so far.
- From the Source Control title, the command gets the `SourceControl` the button belongs to and works on the repository
  whose `rootUri` equals its `rootUri`; none: "No git repository is open". From the Command Palette: the only
  repository, or the one picked in a Quick Pick ("Choose a repository") when there are several; dismissing it ends
  the run silently; none: the same message.
- One run per repository, by root path: a second run while one is in flight there is refused with a notification.
- A run (`CommitMessageGenerator.run`), in order: when the input box holds text other than whitespace, a modal asks
  whether to replace it, and anything but "Replace" ends the run with nothing sent; then the chat's selection
  (`controller.snapshot` provider and model, the provider from the user settings, its key from `SecretStorage`, the
  model's size from `brokeCode.contextSizes`); no provider or model: a notification. Then, under a cancellable
  progress notification, the staged diff (`diff(true)`): empty or only whitespace, "Nothing is staged"; a failed read,
  its own notification.
- The request (`composeCommitRequest`) is a `system` message asking for an English Conventional Commits message (a
  subject of at most 72 characters, asked and never enforced, an optional body saying why, no fence or quotes), then
  the diff as one `user` message; no tool section. Its estimate (`estimateTokens`) stays within `fillsContext`'s
  threshold: `floor(size * 7 / 8) * 4` characters for both messages, 114,688 for 32,768 tokens. A diff over it is
  split before each line starting with `diff --git ` and kept whole file by whole file in order while the files fit;
  when the first file alone exceeds the room it is cut to it between characters (never inside a surrogate pair). A
  cut diff ends with a blank line and `CUT_NOTICE`, telling the model, and the run then shows a warning that the
  message covers only part of the staged changes. A context too small to hold the prompt and any diff is a
  notification, with no request.
- One streaming request through `streamChat`, never `tools`; reasoning (`reasoning`, `reasoning_content`, a leading
  `<think>`) is dropped. When the reply has ended, `cleanCommitMessage` drops any `<think>` … `</think>` text (one never
  closed, to the end), then unwraps, again and again until nothing changes, a code fence (` ``` ` or `~~~`, any
  info string) wrapping the whole reply, or a quote pair (`"`, `'`, `“”`, `‘’`, a backtick) whenever the trimmed text
  starts with the opening quote and ends with the closing one, whatever the interior holds (a Conventional Commits
  message starts with its type, never a quote), trimming each time. A fence wraps the whole reply also when it holds fences of the same kind, if its text starts with one (nested wrappers); a fence around only part of the reply stays. The input box gets that text once; nothing is written before
  the reply ends. The run remembers the box's text once it decided to go on (the text the user agreed to replace, or
  the empty box); right before the write it reads the box again, and when the text differs (the user typed
  meanwhile) it asks the replace question again: a refusal writes nothing and ends quietly, keeping the user's text;
  "Replace" writes once (maintainer decision, 2026-11-11). Cancel or deactivation while that question is open writes
  nothing. Empty after cleaning: "The model's reply held no commit message.", nothing written.
- A provider error shows the chat's wording (`describeProviderError` with `vscode.l10n`), its detail after the message.
  Cancel aborts the request and writes nothing, with no notification. Deactivation disposes the generator, which aborts
  every run; an aborted run writes nothing, also when its replace question is answered after the abort. An unexpected
  exception is logged and shown ("Could not generate the commit message."), and frees the repository.

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
  chat controller with the read and write tools, `run_command`, and `load_skill` over a throwaway copy of the scenario's
  fixture, each write applied at once, each command approved at once through the run context (the bench plays the
  model, not the user; nothing in the product auto-approves a command) and run with `/bin/sh` in the copy with a
  10-second timeout, no instruction file, and a step limit of 10. A command inherits the bench's environment, `HOME`
  included, so the bench confines what the tools reach, not what a command itself does. Skills are discovered as the extension
  does, but with a throwaway copy of the scenario's home fixture as the home folder, so the bench never reads the real
  `~/.agents`; a scenario without one gets no skill, and its prompt has neither the Skills section nor `load_skill`.
  Seven scenarios, each judged on the turn ending `done` and on the workspace after it: every file the scenario writes
  holds its exact expected text, byte for byte, and every other entry is unchanged. The workspace is read back without
  following symlinks: every entry but a folder counts, a file by its text, a symlink by its target (`{ symlink }`), any
  other kind, such as a FIFO, by its kind (`{ special }`), so a command that adds a symlink fails `workspaceChanged`.
  - `read`: the model must read a setting it cannot guess and answer with its value. Passes when a tool step got the
    value, the answer holds it, and no file changed.
  - `edit`: rename a function named once in `src/pricing.py`. Passes when exactly that line changed.
  - `create`: create `docs/call-format.md` with a text stated in the message that holds double quotes, backslashes,
    `<content>...</content>`, `</write_file>`, and a fenced code block. Passes when the file is exactly that text
    plus one line break.
  - `skill`: the home fixture holds one personal skill, `depot-codes`, whose description matches the message (the
    dispatch code of a depot) and whose body sends the model to `reference/depots.md` in its folder, the only file
    holding the code. The message names neither the skill nor the tool. Passes when an `ok` `load_skill` step ran, a
    read step got the code, the answer holds it, and no file changed; without an `ok` `load_skill` step it is
    `wrongTool`.
  - `command`: count the files under `logs/`, subfolders included: 61 files in 18 month folders under two year folders,
    more folders than the step limit lets the model list, and none hidden. The message does not name the tool. Passes
    when an `ok` `run_command` step ran, the answer holds 61 as a number token of its own (the answer is split into runs of digits, letters, `.`, `,`, `_`, `+`, `-`, and U+2212 holding a digit, trailing `.` and `,` dropped, so `161`, `61,000`, `61.5`, `0,61`, `-61`, `61e3`, and `61k` fail and `61.` passes), and no file changed. Without an `ok`
    `run_command` step it is `wrongTool`, its detail led by the first line of the last command step when one ran (a
    rejection, `stopped after 10 seconds`, an exit code).
  - `slash`: the `skill` fixture and home, the message `/depot-codes` then the `skill` question, so the user loads the
    skill. Passes when a read step got the code, the answer holds it, and no file changed; no `load_skill` step is
    required, and an `ok` one is allowed. A first user entry without a `loaded` skill is `wrongTool`, its detail
    saying so, since the run then measures nothing of the slash path.
  - `hidden`: `slash` with `disable-model-invocation: true` in the skill's frontmatter, beside a second personal skill,
    `release-notes`, unrelated to depots and listed, so the prompt has the Skills section and offers `load_skill` while
    `depot-codes` stays off its list; judged the same way. It measures that the model follows a skill the user loaded
    although it was never listed to it, instead of refusing the loaded text as injected: live, a `load_skill` of it
    answered an error and the model refused (#50); it now answers "already loaded".

  A failed run shows one category and a one-line detail: `malformed`, `wrongTool`, `wrongAnswer`, `stepLimit`,
  `contextFull`, `providerError`, `wrongEdit` (a file the scenario writes is missing or holds other text, with the
  first differing line), or `workspaceChanged` (the written files are right, or none was asked for, but another file
  changed). The bar is 9 runs of 10 per model and scenario; the bench exits 1 when a model is under it, and before
  any run when Ollama is unreachable or does not list a model. `--model <name>`, `--scenario <name>` (both
  repeatable; an unknown scenario exits 1 naming the others), and `--runs <n>` shorten a local iteration; `--dump <file>` appends each run's entries (tool steps with their call's arguments), verdict,
  `planned` (each change handed to the applier, in call order: tool, path, `before` (`null` for a new file), `after`,
  and the applier's status), and `changes` (each entry that differs from the fixture after the run, with its text,
  `{ symlink }`, or `{ special }`, `null` when removed) as JSON Lines, to read the
  failing replies; an incomplete last line left by an interrupted run is removed, with a notice, before the first
  append. A full run of the five scenarios took 22 min 48 s on the maintainer's Mac on 394042c, the first run of each
  model including its load; the bench has no time limit per run, and one `gemma4` run whose reasoning ran on for about
  98,000 characters once took 18 min on its own (b1049a2). It runs locally on demand and never in CI. On 394042c every
  model met the bar on every scenario, 10/10 everywhere; every `command` run counted with `find logs -type f | wc -l`,
  most after listing a level or two. On 9a67dd7, `gemma4` once failed `skill` (`wrongTool`: it listed the skill folder
  and answered without reading the reference file). Live, `qwen3.8:27b` proposes a command for that count, but on a
  small tree (7 files in 4 folders) it walks the folders with `list_files` instead, even when asked to count the
  subfolders (#9 verification). On 9db1a52 the six scenarios took 55 min 45 s, one `gemma4` `edit` run alone 22 min 56 s
  before it failed `malformed` (a `<read_file>` call never closed); every model met the bar: `slash` 10/10 on both
  models, `command` 9/10 on `qwen3.8:27b` (`wrongTool`: it listed the folders, then searched, and ran no command),
  `edit` 9/10 on `gemma4`, every other scenario 10/10. On 9f6ae23 plus the `release-notes` skill, `hidden` alone
  took 5 min 38 s, 10/10 on both models: `qwen3.8:27b` read the reference file at once in every run; `gemma4` called
  `load_skill(depot-codes)` in 2 runs, got "already loaded", then read the file, and listed the skill folder first in 4.
  On edc18b5 the seven scenarios took 56 min 39 s, 10/10 for every scenario on both models (140 of 140 runs); one
  `gemma4` `edit` run alone took 19 min 19 s and passed.
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
