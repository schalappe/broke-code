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
- `src/core/`: modules that import nothing from `vscode`: settings parsing, the provider HTTP client, the CA
  trust and certificate error classification (`tls.ts`), the SSE reader, the typed provider errors, the chat
  controller (conversation state, streaming, Stop), the dialog queue, and the host-webview message protocol. Unit
  tests sit next to them as `*.test.ts`, because `bun test` cannot load `vscode`. `tlsFixture.ts` generates test
  certificates with `/usr/bin/openssl` at test time; no private key is committed.
- `src/extension/`: the extension host glue (activation, webview view, API keys in `SecretStorage`).
- `src/webview/`: the React chat panel and its CSS.
- `src/l10n.test.ts`: checks that every `l10n.t` message has a French translation and that the
  `package.nls*.json` files match.
- `l10n/bundle.l10n.fr.json`, `package.nls.json`, `package.nls.fr.json`: French strings for the host and
  webview, and the English and French manifest strings. English messages are the keys of `l10n.t`.
- `scripts/build.ts`: `bun run build` writes the host bundle (`dist/extension.js`, CommonJS) and the webview
  bundle (`dist/webview/`).
- `.github/workflows/ci.yml`: type check, unit tests, and build on macOS.
- `LICENSE`: MIT.

## Stack

- TypeScript for both the extension host and the chat webview.
- Use `bun` for everything, including packaging and publishing. The project needs no Node and no npm. Run the
  publishing tools under the Bun runtime with `bunx --bun @vscode/vsce` and `bunx --bun ovsx`, and always pass
  `--no-dependencies` to `vsce`, because it otherwise calls npm to list dependencies. The bun bundle
  already contains them.
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
  under size caps that cancel the download when exceeded.
- The API does not report a model's context size. A settings table maps model names to sizes, and unknown
  models default to 32k. When the user picks an unknown model, the chat shows a link to set its size.
- Every provider request goes through `http`/`https` imported without the `node:` prefix, because VS Code adds
  its proxy support and the OS certificate store only to `require("http")` and `require("https")`. `bun run build`
  fails if the bundle loads `node:http` or `node:https`.
- A provider without a CA file sends no `ca` option, so it trusts exactly what VS Code trusts (bundled roots plus
  the OS store, through any configured proxy).
- Each provider has an optional `caFile`: an absolute or `~/` path to a PEM file. It applies to that provider's
  requests only. Node's `ca` option replaces the default store, so the client passes the runtime's default
  certificates, the OS store, and every certificate of the file together. The OS store is read as VS Code reads it
  on the same runtime: `tls.getCACertificates("system")` where it exists (Node 22.15 and later), else the macOS
  keychains through `security find-certificate`. The file is read and checked with `X509Certificate` on every
  request, because Node ignores an invalid `ca` silently. A relative path, an unreadable file, or a file without a
  valid PEM certificate is reported naming the path, and no request is sent.
- Never disable certificate verification. Report a certificate failure (unknown issuer, self-signed, expired,
  hostname mismatch) as a certificate error with its code, never as a generic network error. Connection refused,
  DNS failures, and timeouts stay `unreachable`.

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
- A mention `@file` attaches the file content. A mention `@folder` attaches its file listing.
- Conversations are saved per workspace.

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

- `bun run typecheck`, `bun test`, and `bun run build` run in CI on every pull request and on `develop` and
  `main`.
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
- Commit messages follow Conventional Commits in English. On each merge to `main`, CI computes the version
  from those messages (`fix` bumps the patch, `feat` bumps the minor, the major stays at 0), tags it, builds,
  tests, and publishes to Open VSX and the Visual Studio Marketplace. The first release is `0.1.0`.
- The git tag is the only source of the version. CI writes the version into the package at build time and
  never commits to `main`, so `package.json` keeps `0.0.0`.
- Only `main` publishes. Open VSX uses a token stored as a GitHub secret. The Visual Studio Marketplace uses
  Trusted Publishing, with no stored token.

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
