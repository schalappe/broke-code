# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The only surface is a VS Code webview (the chat panel in the side bar), plus native VS Code UI the extension drives:
Quick Picks, input boxes, notifications, the diff editor, the Source Control title button, and a quick fix.

## Users

The primary user is a developer whose employer provides an internal LLM service with an OpenAI-compatible API that
rejects the `tools` request field. They work in VS Code all day, beside their code, and agent extensions that rely
on native tool calling fail against that service. Their job: hand a coding task to an agent that works with the
models they are allowed to use, and keep working.

A developer running open models on their own machine with Ollama is also served, by the same contract, but product
decisions are made for the primary user first (maintainer decision, 2026-11-12).

## Product Purpose

broke-code is a VS Code extension that runs a coding agent against LLM services without native tool calling. The
model writes each tool call in the text of its reply; the extension parses and runs it. Success is an agent turn
that reads, edits, and runs commands in the workspace on such a service, with small open models (Qwen, Gemma, GLM).

The v1 goal is narrow: the agent loop over the reply text, skills, and slash commands, in a minimal chat panel.

## Positioning

It works where the `tools` field is refused. It never sends `tools` or reads `tool_calls`, even to a provider that
supports them (ADR 0001), so one contract covers the internal service and Ollama: streaming
`POST /v1/chat/completions` and `GET /v1/models`.

## Operating Context

- The side bar of VS Code (the maintainer uses VSCodium), at side-bar width, open for hours beside the editor.
- Corporate networks: proxies, private certificate authorities (a per-provider CA file), API keys in
  `SecretStorage`.
- Small models with small contexts (32,768 tokens assumed when unknown): context usage, left-out tool results,
  `/compact`, and automatic compaction are everyday parts of use, not edge cases.
- The workspace's own conventions: `AGENTS.md` instruction files and Agent Skills under `.agents/skills/`.
- Entry points outside the chat: "Add selection to chat", the quick fix "Fix with broke-code", and "Generate commit
  message" in Source Control.

## Capabilities and Constraints

- Tools: `read_file`, `list_files`, `search`, `write_file`, `edit_file`, `run_command`, `load_skill`.
- Three modes of one agent: Ask (each write waits for Accept or Reject), Auto-edit (writes are accepted at once),
  Plan (read tools only). A command always waits for Run (ADR 0002, ADR 0005).
- The way back: "Undo changes" for a turn's writes, Retry, Continue, and Edit on the last turn.
- Mentions (`@file`, `@folder`, `@problems`, `@diff`, `@selection`), slash commands (`/new`, `/model`, `/compact`,
  skills), queued messages, saved conversations per workspace with History.
- English and French, following the VS Code display language.
- macOS only in v1; Windows and Linux are planned for v2.
- No telemetry; the extension contacts only the configured providers.
- The webview's Content Security Policy allows the bundled stylesheet only: no inline style, no icon font, no
  component kit, no Tailwind. Every color comes from the active VS Code theme (see `DESIGN.md`).
- Out of scope for v1, by maintainer decision: inline completion, multi-agent modes, MCP, code indexing and
  embeddings, a browser tool, git checkpoints, native or hybrid tool calling, skill directories other than
  `.agents`, `CLAUDE.md`, `/clear`, `/help`.
- The domain vocabulary is in `GLOSSARY.md`; the decisions are in `docs/adr/`.

## Brand Commitments

- The name is broke-code, lowercase.
- The chat panel follows twinny's minimal manner, credited in the README (twinny is MIT).
- No code from swarm-lab, whose license forbids copying.

## Evidence on Hand

- The Ollama eval bench (`bun run eval`): seven scenarios, 10 runs each, on `qwen3.8:27b` and
  `gemma4:26b-a4b-it-qat`; 140 of 140 runs passed on edc18b5. Results per commit are in `docs/eval.md`.
- The extension is published on Open VSX and the Visual Studio Marketplace.
- Nothing else exists: no testimonial, user count, benchmark against other extensions, or customer name. Future
  work must not invent one.

## Product Principles

1. **It works where the others fail.** The body tool call contract comes first; nothing may depend on native tool
   calling.
2. **Speed and flow win a conflict.** When two qualities pull apart, prefer the fewest steps between the request and
   the result (maintainer decision, 2026-11-12). The guards on record (a command always waits for Run, a write waits
   in Ask) are decisions of their own and change only by a new decision, not by this principle.
3. **Never silent.** A failure, a refusal, and a partial success each say what happened, in words.
4. **Native to the editor.** The panel takes the theme's colors and the user's fonts, and uses VS Code's own UI
   where it has one.
5. **Narrow on purpose.** A feature outside the v1 scope is refused, not half-built.

## Accessibility & Inclusion

What `DESIGN.md` already requires, with no named standard (maintainer decision, 2026-11-12): every control reachable
by keyboard in visual order, focus that never moves on its own, high-contrast themes supported, text at 4.5:1 on
the default themes, no state carried by color alone, and reduced motion honored.
