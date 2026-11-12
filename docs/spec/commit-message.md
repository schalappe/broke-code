# Commit message

This file specifies the command "broke-code: Generate commit message". ADR 0004 records the decision behind it.

- The command `broke-code.generateCommitMessage` ("broke-code: Generate commit message", `$(sparkle)` icon) is in the
  Command Palette and in the `scm/title` menu, group `navigation`, `when` `scmProvider == git` (ADR 0004). It never
  stages, commits, or pushes; it runs while a chat reply is in flight and touches no conversation: nothing is saved.
- Git access goes through the built-in Git extension's API (`vscode.git`, version 1), looked up at each run by
  `lookUpGit`, which the `@diff` mention shares, never an `extensionDependencies` entry. The members used are typed
  structurally in `src/core/git.ts` (`enabled`, `getAPI(1)`, `state`, `onDidChangeState`, `repositories`,
  `Repository.rootUri`, `inputBox.value`, `diff(true)`, and, for `@diff`, `getRepository` and `diffWith`), and the
  exports and the API `getAPI(1)` returns are checked at run time. No extension, or exports or an API of another
  shape: "not available"; `enabled` false or `getAPI` throwing (`git.enabled` off, git not found): "disabled". While
  the API's `state` is `uninitialized` its repository list is empty, so a run waits for `initialized`, at most 10
  seconds, then goes on with the repositories opened so far.
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
