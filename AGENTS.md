# AGENTS.md

## Project overview

broke-code is a VS Code extension that runs a coding agent against LLM services without native tool calling.
It ships on Open VSX and the Visual Studio Marketplace. The author's employer runs an internal LLM service with
an OpenAI-compatible API. It serves Gemma, GLM, Qwen, and newer models, but it rejects the `tools` request
field. Kilo Code and similar agent extensions therefore fail against it. In broke-code, the model writes each
tool call in the text of its reply, and the extension parses and runs the call. The v1 goal is narrow. It
covers the agent loop over the reply text, skills, and slash commands, in a minimal chat panel styled after
twinny.

The repository holds no code yet. Read `GLOSSARY.md` for the domain vocabulary and `docs/adr/` for the
decisions behind the design, starting with `docs/adr/0001-body-tool-calls.md`.

## Structure

- `GLOSSARY.md`: the domain terms (body tool call, harness, agent turn, provider, skill, slash command,
  mention). Code and docs use these names.
- `docs/adr/`: architecture decision records.
- `LICENSE`: MIT.

## Stack

- TypeScript for both the extension host and the chat webview.
- Use `bun` to install, test, and build. Use Node 22 or newer only to package and publish, because `@vscode/vsce`
  and `ovsx` run under Node and hardcode npm.
- The webview uses React and `react-markdown`, with hand-written CSS built on VS Code theme variables. Do not
  add Tailwind or a component kit, and do not use `@vscode/webview-ui-toolkit`, which Microsoft deprecated.
- The UI ships in English and French and follows the VS Code display language, with English as the fallback.

## Architecture

### Provider contract

- broke-code speaks one contract: streaming `POST /v1/chat/completions` and `GET /v1/models`. It covers the
  internal service and Ollama.
- Never send `tools` or read `tool_calls`, even to a provider that supports them. See ADR 0001.
- Providers (name and base URL) live in the VS Code settings. Each API key lives in `SecretStorage`, never in
  `settings.json`.
- The API does not report a model's context size. A settings table maps model names to sizes, and unknown
  models default to 32k. When the user picks an unknown model, the chat shows a link to set its size.
- TLS goes through the OS certificate store, which the VS Code extension host already applies to `fetch`.
  Each provider has an optional CA file (`.pem`) setting as a fallback. Never disable certificate
  verification. Report a certificate failure as a certificate failure, not as a generic network error.

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
- Reasoning output (`<think>` tags or `reasoning_content`) shows collapsed in the chat. The parser never looks
  for tool calls in it, and the conversation history sent back to the model drops it.
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

- Unit tests and the type check run in CI on every pull request and on `develop` and `main`.
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
