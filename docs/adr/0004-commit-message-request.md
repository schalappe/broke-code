---
status: accepted
---

# The commit message is one provider request outside any agent turn, over the built-in Git extension looked up at run time

Until now every provider request belonged to an agent turn of the chat: the controller composed it, saved the
conversation, and ran the harness on the reply. The command "broke-code: Generate commit message" (#71) needs a
request of another kind: the staged diff of a git repository in, a commit message out, written to the Source
Control view's input box. It needs git access too, which broke-code did not have.

## One request, no harness, no conversation

The command sends one streaming request through the same client as the chat (`streamChat`), so the 300-second
limits, the redirect refusal, the size caps, the CA file, and the typed provider errors come with it, to the provider
and model selected in the chat, with that provider's key. The request is a system prompt asking for a Conventional
Commits message in English (a subject of at most 72 characters, asked of the model and not enforced, and an optional
body saying why), then the diff as the user message. It offers no tool and the reply is never parsed for a call: a
commit message has nothing to call. Reasoning is dropped, as the chat drops it from the history. The request goes
through the chat's context budget (`estimateTokens`, the 7/8 rule of `fillsContext`, the context sizes of
`brokeCode.contextSizes`): a diff over it is cut between files, whole files in order while they fit, and a first file
that alone exceeds the room is cut to it. A cut request says so to the model and to the user.

The reply is written once, when it has ended, cleaned of `<think>` text and of a code fence or quotes wrapping the
whole of it. Nothing streams into the input box (maintainer decision, 2026-11-11): text already shown there could not
be cleaned, and a cancel would have to restore the box. A box that already holds text is replaced only after the user
confirms, asked before the request so no request is wasted. A box the user changed during the run is asked about
again right before the write (maintainer decision, 2026-11-11), so the message never replaces text nobody agreed to
lose.

The command runs beside the chat, also while a chat reply is in flight, and touches no conversation: nothing is
saved and no entry is added. It shares nothing with the controller but the selection it reads (`snapshot.provider`,
`snapshot.model`). The core holds the request composition, the cleaning, and the flow over ports
(`CommitMessageGenerator`: git, provider request, user interface), so all of it is tested without `vscode`. The
provider error wording moved to the core (`describeProviderError` with a translator), so the command's notification
says what the chat says.

## The built-in Git extension, an optional lookup

Git access goes through the API of VS Code's built-in Git extension (`vscode.git`, API version 1). It is looked up
when the command runs (`extensions.getExtension("vscode.git")`, its exports, `getAPI(1)`), never declared in
`extensionDependencies`: the chat must keep working where git is disabled or missing, and a dependency would block
broke-code's activation there. A missing extension, `git.enabled` turned off, or git not found becomes a notification
of that command, nothing more. The API's declaration file is not copied: the few members used (`enabled`, `getAPI`,
`state`, `onDidChangeState`, `repositories`, `Repository.rootUri`, `inputBox.value`, `diff(cached)`) are typed
structurally and the exports are checked at run time. The Git extension ships in VSCodium (1.143 bundles
`vscode.git` 10.0.0).

## Considered options

- **An agent turn with a "commit" prompt.** Rejected: the harness, the tool list, and the conversation add nothing to
  a single answer and would save a conversation the user never started.
- **Running `git diff --cached` with `child_process`.** Rejected: it needs the repository list and the input box from
  the Git extension anyway, and a second way to reach git.
- **`extensionDependencies: ["vscode.git"]`.** Rejected: a user with git turned off would lose the chat.
- **Streaming the message into the input box.** Rejected, see above.

## Consequences

- broke-code now sends the staged diff of a repository to the selected provider, at the user's click only. The README
  "Privacy" section says so.
- The v1 goal names the chat panel only; this command is in scope by maintainer decision (#71). AGENTS.md "Boundaries"
  excludes git checkpoints, not this.
- The `@diff` mention (#66) can reuse the same git access.
- `diff(true)` holds the whole staged diff in memory, uncapped, before the cut: a huge staged change costs memory in
  the extension host for the length of the run.
