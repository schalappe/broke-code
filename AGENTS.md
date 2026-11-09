# AGENTS.md

## Project overview

broke-code is a VS Code extension that runs a coding agent against LLM services without native tool calling.
It ships on Open VSX and the Visual Studio Marketplace. The author's employer runs an internal LLM service with
an OpenAI-compatible API. It serves Gemma, GLM, Qwen, and newer models, but it rejects the `tools` request
field. Kilo Code and similar agent extensions therefore fail against it. In broke-code, the model writes each
tool call in the text of its reply, and the extension parses and runs the call. The v1 goal is narrow. It
covers the agent loop over the reply text, skills, and slash commands, in a minimal chat panel styled after
twinny.

The code so far covers the extension skeleton and a streaming chat with a provider, with no tools yet. Read
`GLOSSARY.md` for the domain vocabulary and `docs/adr/` for the decisions behind the design, starting with
`docs/adr/0001-body-tool-calls.md`.

## Structure

- `GLOSSARY.md`: the domain terms (body tool call, harness, agent turn, provider, skill, slash command,
  mention). Code and docs use these names.
- `docs/adr/`: architecture decision records.
- `src/core/`: modules that import nothing from `vscode`: settings parsing, the API key shape check, the provider
  HTTP client, the CA trust and certificate error classification (`tls.ts`), the SSE reader, the typed provider
  errors, the chat controller (conversation state, streaming, Stop, saving, reopen, delete), the conversation record
  (`conversation.ts`: version 1, its validation on load, title, id, the summary file's shape), its store
  (`conversationStore.ts`: a record and a summary file per conversation, the list from the summaries, reads, writes,
  and deletes in call order), and the store's file access (`conversationFiles.ts`:
  the file port, and its implementation over a local directory with `node:fs`: missing versus failed, regular files
  only, atomic writes, leftover temporary files), the dialog queue, the host-webview message
  protocol and its validation, workspace file access (`workspaceFiles.ts`: the inside-workspace check, capped reads,
  one-level listings, line truncation, with `node:fs`), mentions (`mentions.ts`: token detection, picked and typed
  mentions merged, reading, and the text the model receives), where a message holds Markdown code
  (`markdownCode.ts`), the mention menu logic (`suggestions.ts`: the `@` token at the caret, index entries,
  filtering, the index exclusions), and the menu's file index (`fileIndex.ts`: one scan shared until a file
  changes, behind a scan port). `markdownCode.ts`, `suggestions.ts`, and `conversation.ts` import nothing from
  `node:`, since the webview loads them. Unit tests sit next to them as `*.test.ts`, because `bun test` cannot load `vscode`. `tlsFixture.ts`
  generates test certificates with `/usr/bin/openssl` at test time; no private key is committed.
  `conversationFixture.ts` is the in-memory conversation file port for tests.
- `src/extension/`: the extension host glue (activation, webview view, API keys in `SecretStorage`, the
  file index's `findFiles` scan and watcher in `fileIndex.ts`).
- `src/webview/`: the React chat panel and its CSS. `SuggestionMenu.tsx` is the autocomplete list the `@` menu
  uses and the `/` menu (#11) is meant to reuse.
- `src/l10n.test.ts`: checks that every `l10n.t` message has a French translation and that the
  `package.nls*.json` files match.
- `l10n/bundle.l10n.fr.json`, `package.nls.json`, `package.nls.fr.json`: French strings for the host and
  webview, and the English and French manifest strings. English messages are the keys of `l10n.t`.
- `scripts/build.ts`: `bun run build` writes the host bundle (`dist/extension.js`, CommonJS) and the webview
  bundle (`dist/webview/`).
- `scripts/next-version.ts`: computes the next release version from the commits since the last `v*` tag. The
  release workflow runs it as a CLI. Its tests sit next to it.
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
- The API does not report a model's context size. A settings table maps model names to sizes, and unknown
  models default to 32k. When the user picks an unknown model, the chat shows a link to set its size.
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
- The v1 tools are `read_file`, `list_files`, `search` (ripgrep), `write_file`, `edit_file`, `run_command`,
  and `load_skill`.
- `edit_file` replaces exact text only. If the text matches zero times or more than once, return an error to
  the model. Never guess the location.
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
- An agent turn has a Stop button and stops after 50 tool steps by default. Truncate tool results longer than
  about 2,000 lines and say so in the result. When the context is full, stop the turn with a clear message.
  v1 has no automatic summarization.
- The system prompt includes `~/.agents/AGENTS.md`, then the workspace `AGENTS.md`, when they exist.
  `CLAUDE.md` is not read.
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
  file itself. Other statuses: `missing`, `binary` (NUL byte in the first 8 KiB), `tooLarge` (over 1 MiB),
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
  missing, unreadable, invalid, of another id, or of another version than 1, and parses the record only then; only a
  record that cannot be read is a listing failure. Accepted gap: a valid version-1 summary beside a corrupt or newer
  record (a crash right after a downgrade, or disk corruption) is listed, and opening it shows the usual not-found or
  invalid error. A summary without its record is not listed and is deleted at that listing. 50 conversations are
  kept: a save past the limit, and the window load, queue a prune with the navigation (below), which deletes the
  oldest by update time, oldest first, never the one shown when it runs. Before each delete the prune reads the
  record: a newer update time than its row (a summary left by a build without summaries) corrects the row and the
  oldest is picked again; a record that cannot be read is kept and the failure shown. The prune deletes only a record
  it has validated: a missing, invalid, or newer-version record is kept on disk and in the list, counts toward the 50,
  and is logged, never shown as a failure; the user can still delete its row.
- The record is versioned (`version: 1`) and holds the displayed entries, each user entry with the text the model
  received (`modelText`), so a reopened conversation resends exactly what was sent and never reads its mentions
  again. It holds no API key and nothing else of `ProviderAccess`; a failed reply's error keeps the provider's base
  URL for display, since it is user settings, not a secret. Times are whole milliseconds within the `Date` range. A
  file that fails validation or has an unknown version is logged and skipped; a file that cannot be read is shown as
  a listing failure. On load, a reply still `waiting` or `streaming` becomes `stopped`.
- A conversation is saved when a message is sent, and the request waits for that save (a failed save is shown and the
  request still goes), then at most every 500 ms while the reply streams, and when the reply ends (done, stopped,
  failed, or cut off). A reply's saves go to the record it was sent
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
  extension reads them from two places only: `.agents/skills/` in the workspace and `~/.agents/skills/`. A
  workspace skill wins over a personal skill with the same name.
- Do not read `.claude/`, `.codex/`, or any other tool's directory. The `.agents` convention is the only one.
- The system prompt lists each skill's name and description only. `load_skill` or `/<name>` loads the body.
- In `/<name> args`, the text after the name replaces `$ARGUMENTS` in the skill body. If the body has no
  `$ARGUMENTS`, the text follows the skill as a user message.
- Skip a skill whose frontmatter lacks `name` or `description`, or whose `name` differs from its directory
  name, and show a warning.
- The built-in slash commands are `/new` and `/model`. Typing `/` lists them with every skill.

## Verification

- `bun run lint`, `bun run typecheck`, `bun test`, and `bun run build` run in CI on every pull request and on
  `develop` and `main`.
- `bun run lint` runs Biome over code, CSS, and JSON without writing. `bun run format` applies its formatting,
  import sorting, and safe lint fixes. Run it before committing.
- `bun run package` builds and writes `broke-code-<version>.vsix` with the version from `VERSION` (default
  `0.0.0`). It writes the version into the VSIX only, never into `package.json`. CI runs it on every pull
  request as a dry run of the release and checks the version inside the VSIX.
- Run `actionlint` on the workflow files after editing them.
- To try the extension, run `bun run build`, then `codium --extensionDevelopmentPath=<repository path>`
  (VSCodium is the maintainer's editor). Rebuild and reload the window after each change.
- `bun run eval` (to be created) plays fixed scenarios against a local Ollama with `qwen3.8:27b` and
  `gemma4:26b-a4b-it-qat`: read then answer, edit a line, create a file containing quotes and tags, run a
  command, load a skill. A scenario passes when it succeeds at least 9 times out of 10 on each model. The eval
  runs locally on demand and never in CI, because it takes several minutes.
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
