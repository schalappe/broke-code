# AGENTS.md

## Project overview

broke-code is a VS Code extension that runs a coding agent against LLM services without native tool calling. The
author's employer runs an internal OpenAI-compatible service that rejects the `tools` request field. The model
therefore writes each tool call in the text of its reply, and the extension parses and runs the call (ADR 0001). The
extension ships on Open VSX and the Visual Studio Marketplace. v1 supports macOS only.

Most changes touch `src/core/chatController.ts`, `src/core/protocol.ts`, `src/webview/App.tsx`, and
`l10n/bundle.l10n.fr.json`. Read `GLOSSARY.md` for the domain terms and use them in code and docs. Read the ADRs in
`docs/adr/` before you change a decision, starting with `docs/adr/0001-body-tool-calls.md`.

## Structure

- `src/core/`: all the logic. It imports nothing from `vscode`, and its tests sit beside each module as `*.test.ts`.
- `src/extension/`: the extension host code that connects `vscode` to the ports of `src/core/`.
- `src/webview/`: the React chat panel, with its styles in `src/webview/styles.css`.
- `eval/`: the eval bench that `bun run eval` runs against local Ollama models.
- `scripts/`: `scripts/build.ts` and `scripts/next-version.ts`, the release version calculator.
- `l10n/bundle.l10n.fr.json`, `package.nls.json`, `package.nls.fr.json`: the French strings and the manifest strings.
- `media/`: the icons. Render `media/logo.png` from `media/logo.svg` with the command in `docs/modules.md`.
- `PRODUCT.md`: read it before a product or interface decision.
- `DESIGN.md`: read it before you change the panel's markup or styles.

`docs/modules.md` says which file holds which responsibility. The behavior is specified by topic:

| Topic | Specification |
|---|---|
| Provider HTTP contract, settings, API keys, TLS | `docs/spec/provider.md` |
| Tool calls, tools, writes, approvals, modes, commands, history, context budget, system prompt | `docs/spec/harness.md` |
| Turn folding, code block actions, Quote, queued messages, Retry, Continue, Edit, message recall | `docs/spec/chat-panel.md` |
| Mentions, the `@` and `/` menus, editor entry points, file index | `docs/spec/mentions.md` |
| Saved conversations, navigation, History | `docs/spec/conversations.md` |
| Skill discovery, `load_skill`, `/<name>` | `docs/spec/skills.md` |
| "Generate commit message" | `docs/spec/commit-message.md` |

## Commands

Run every command from the repository root. The project uses `bun` only and needs no Node and no npm.

```bash
bun install --frozen-lockfile                 # install the pinned dependencies
bun run lint                                  # Biome check over code, CSS, and JSON, without writing
bun run format                                # apply Biome formatting, import sorting, and safe fixes
bun run typecheck                             # tsc --noEmit
bun test                                      # the full suite, about 45 seconds
bun test src/core/toolCalls.test.ts           # one test file
bun test src/core/toolCalls.test.ts -t "wrapper"   # the tests of one file whose name matches
bun run build                                 # write dist/extension.js and dist/webview/
bun run package                               # build, then write broke-code-0.0.0.vsix (gitignored)
actionlint                                    # run after editing a file in .github/workflows/
```

- A task is done when `bun run lint`, `bun run typecheck`, `bun test`, and `bun run build` pass. CI runs these four
  and `bun run package` on every pull request (`.github/workflows/ci.yml`).
- Run `bun run format` before you commit.
- `bun run eval` needs a local Ollama with both models and takes about an hour. Never use it as a routine check. It
  never runs in CI. Read `docs/eval.md` for its flags, scenarios, and measured results.
- To try the extension, run `bun run build`, then `codium --extensionDevelopmentPath="$PWD"`. Rebuild and reload the
  window after each change.

## Architecture

- The dependency direction is `src/extension/` and `src/webview/` into `src/core/`, never the reverse. `bun test`
  cannot load `vscode`, so put logic in `src/core/` behind a port and keep `src/extension/` to wiring.
- The webview bundles `markdownCode.ts`, `suggestions.ts`, `reservedMentions.ts`, `modelList.ts`, `conversation.ts`,
  `history.ts`, `lastTurn.ts`, `providerError.ts`, and `turnEndText.ts` from `src/core/`. Keep `node:` imports out of
  these files.
- `src/core/protocol.ts` defines and validates every message between the host and the webview. To add a message,
  change `protocol.ts` first, then the host handler in `src/extension/chatView.ts`, then the webview.
- English messages are the keys of `l10n.t`. When you add or change a UI string, add its French translation to
  `l10n/bundle.l10n.fr.json`, or `src/l10n.test.ts` fails. Keep `package.nls.json` and `package.nls.fr.json` in step.
- Never send `tools` or read `tool_calls`, even to a provider that supports them (ADR 0001).
- Change a tool call parsing rule only with evidence from the eval. Record the measurement in `docs/eval.md` and the
  decision in ADR 0001.
- Providers and the other `brokeCode.*` settings are read from the user value only. A workspace `settings.json` must
  never override them, because API keys are stored by provider name (`docs/spec/provider.md`).
- An optional field added to a conversation entry keeps the record at version 2. Validate it on load in
  `src/core/conversation.ts` (ADR 0003).
- Never disable certificate verification.

## Conventions

- The specifications in `docs/spec/` are the source of truth for behavior. When behavior changes, update the
  matching specification, `docs/modules.md`, `GLOSSARY.md`, and `README.md` in the same change. Keep behavior detail
  out of this file.
- Biome formats and lints with a line width of 120. Markdown is excluded.
- The webview uses React, `react-markdown`, and hand-written CSS. Every color comes from a `--vscode-*` variable.
- Webview tests render static HTML with `renderToStaticMarkup`. A test that clicks or types registers a DOM with
  `@happy-dom/global-registrator` for its own duration and unregisters it after.
- The UI ships in English and French and follows the VS Code display language.

## Git and PR workflow

- Branch `feature/*` from `origin/develop` and open the pull request to `develop`. Pull requests are squash-merged,
  so the PR title becomes the commit subject.
- Write commit subjects and PR titles as English Conventional Commits, for example `fix(eval): trim the dump line`.
  The types in history are `feat`, `fix`, `docs`, `test`, and `chore`. Add no trailers. History has none.
- The type decides the release. On `main`, `feat` bumps the minor version and `fix` bumps the patch, so do not
  label a behavior change `chore` or `docs`.
- Release by opening a pull request from `develop` to `main`, and merge it with a merge commit, never a squash. A
  squash makes `develop` look ahead of `main` forever. Read `docs/release.md` before you touch
  `.github/workflows/release.yml`. The Marketplace Trusted Publishing policy fixes that file's name.
- `package.json` keeps version `0.0.0`. The git tag is the only source of the version.

## Boundaries

- broke-code collects no telemetry and contacts only the configured providers.
- Do not add Tailwind, a component kit, or `@vscode/webview-ui-toolkit`, which Microsoft deprecated. Write CSS in
  `src/webview/styles.css`.
- Do not add a YAML dependency. `src/core/skills.ts` reads the frontmatter subset by hand.
- Do not read `.claude/`, `.codex/`, `CLAUDE.md`, or another tool's directory from the extension. The `.agents`
  convention is the only one.
- Do not copy code from swarm-lab (`joe-el-khoury/swarm-lab`). Its license forbids copying and forks. twinny is MIT,
  so credit it in `README.md` when you reuse its code or styles.
- Never commit an API key or a private key. `src/core/tlsFixture.ts` generates the test certificates at test time.
- Out of scope for v1, by maintainer decision: Windows and Linux, inline completion, multi-agent modes, MCP, code
  indexing and embeddings, a browser tool, git checkpoints, native or hybrid tool calling, skill directories other
  than `.agents`, `/clear`, `/help`, and publishing from `develop`. Ask, Auto-edit, and Plan are settings of one
  agent, not multi-agent modes.

## Failure log

- Install ripgrep before `bun test`. The `search` tests run the real `rg` binary and fail without it
  (`.github/workflows/ci.yml`).
- Run `vsce` as `bunx --bun vsce` with `--no-dependencies`. Without the flag it calls npm to list dependencies, and
  the project has no npm (7329db7).
- Do not include Markdown in `biome.jsonc`. Biome's Markdown formatter turns the YAML frontmatter of the ADRs into a
  heading (`biome.jsonc`).
- Write conversation files with `node:fs` and `rename(2)`, never `workspace.fs`. Its rename with overwrite deletes
  the destination first, so a crash between the two steps loses the conversation (`src/core/conversationFiles.ts`).
- Run the `eval/` tests outside a sandboxed shell. They need `/usr/bin/sandbox-exec` to apply a profile, which fails
  with exit code 71 inside another sandbox (a3cb2c3).

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `schalappe/broke-code`, managed with `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The default labels are `needs-triage`, `needs-info`, `ready-for-agent`, and `wontfix`. See
`docs/agents/triage-labels.md`.

### Domain docs

The repository has a single context: `GLOSSARY.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.
