# Module map

This file says which file holds which responsibility. Update it when a module gains or loses one.

- `GLOSSARY.md`: the domain terms (body tool call, harness, agent turn, tool step, provider, skill, slash command,
  mention). Code and docs use these names.
- `docs/adr/`: architecture decision records.
- `PRODUCT.md`: the product record: who the extension is for, what it is for, its constraints, and the principles
  that settle a conflict between two qualities. Read it before a product or interface decision.
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
  skill reader ports, its limits source and step limits, the context budget check, streaming, Stop, saving, reopen, delete,
  the queue of messages sent while a reply is in flight, with `mayStartTurn`, the one check a send, `/compact`, the
  queue, Retry, and Continue share, Retry and Continue (`retry`, `continueTurn`, over `startTurn` and `removeFrom`), a
  send replacing the last turn (`send`'s `replaces`, Edit, over the same checks and `removeFrom`), and "Undo changes": each turn's `RecordedChanges` on `ToolContext.changes`, the held turn with its
  write steps by file, and `undoChanges` over the `UndoHost` port, which marks the steps of the files put back), the conversation record
  (`conversation.ts`: version 2, its validation on load, title, id, the summary file's shape, `filterConversations`, the
  History filter), its store
  (`conversationStore.ts`: a record and a summary file per conversation, the list from the summaries, reads, writes,
  and deletes in call order), and the store's file access (`conversationFiles.ts`:
  the file port, and its implementation over a local directory with `node:fs`: missing versus failed, regular files
  only, atomic writes, leftover temporary files), the dialog queue, the host-webview message
  protocol and its validation (and `sendWouldAct`, the panel's one "Send would act" check; `send`'s optional
  `replaces`, and `retry` and `continueTurn`, each carrying `ShownEntries`, the conversation and entries count the
  panel showed), the model list (`modelList.ts`: `emptyModelsLabel`, why the list is empty, for the
  header's select and the Quick Pick; `modelChoices`, the rows `/model` opens; `chooseModel`, the `/model` pick over a
  pick port the host fills with `showQuickPick`), workspace file access (`workspaceFiles.ts`: the inside-workspace check and its read-only
  roots (the loaded skills' folders outside the workspace, for reads only), capped reads, one-level listings, line truncation and `cutLineRange`, the line range `read_file` shows, the write boundary and atomic writes, `removeWorkspaceFile`, the remove with the write's checks, with `node:fs`), mentions (`mentions.ts`: token detection, picked and typed
  mentions merged, reading, the text the model receives, and `cutToMentionCaps`, the cut of a reserved mention's text),
  the reserved mentions (`reservedMentions.ts`: `RESERVED_MENTIONS`, the table a new name is added to, `MentionKind`,
  `NOTHING_TO_ATTACH`, the statuses of a neutral chip, and
  `pickedPath`, the `@./<name>` a menu pick inserts), the
  mention reader the host builds (`mentionReader.ts`: a reserved name to its reader over its host source, any other
  path to `readMention`), `@problems` (`problems.ts`: the raw `Diagnostic` the host's `DiagnosticsReader` returns, and
  `readProblems`, the filter, order, line format, and caps; also `workspacePath`, an absolute path as the file index
  writes it), `@diff` (`diff.ts`: the raw `FolderDiff` per workspace folder the host's `DiffReader` returns, and
  `readDiff`, the status, the multi-root layout, the failed folders of a partial diff, and caps), the Git API lookup
  (`git.ts`: `lookUpGit` over the extension handle the host passes, its availability checks and its wait for
  `initialized` with an injectable timeout, the structural typing of the members used, and `gitDiffReader`, the
  `@diff` port, with the repository-relative literal pathspec and git's `stderr` as the cause), `@selection` (`selection.ts`: the raw `EditorSelection` the
  host's `SelectionReader` returns, `editorSelection`, that record from a structural text editor, and `readSelection`, the workspace check, the line range, and the caps), the quick fix "Fix with broke-code" (`quickFix.ts`: `fixDraft`, the
  diagnostics it is offered on and the draft it fills, and `parseDiagnostic`, the check of its command's argument), the editor drafts on their way to the webview
  (`draftQueue.ts`: `DraftQueue`, an editor draft queued once the chat shows, a returned queued text at once (`queue`),
  delivered in order and once, kept when a post fails), where a
  message holds Markdown code
  (`markdownCode.ts`; also `remarkFenceClosed`, the remark plugin marking a fenced block whose closing fence the parser read,
  `hasTextAfter`, whether rendered text follows a block, and `codeBlockText`,
  the text Copy and Insert at cursor take), Insert at cursor (`insertCode.ts`: `insertCode` over an editor port the
  host fills with `window.activeTextEditor`: no editor, edit refused, failed, or done), the menu logic (`suggestions.ts`: the `@` token at the caret, index entries,
  filtering, the index exclusions; the `/` token at the start of the message, `BUILT_IN_COMMANDS`, `builtInCommand`, the built-in
  command a message runs, which the composer runs and the controller never queues, the slash command filter), the menu's file index (`fileIndex.ts`: one scan shared until a file
  changes, behind a scan port), the request history (`history.ts`: `toHistory`, the history a request sends, the
  oldest tool results left out when it would fill the context; `historyStart`, the last `done` summary it starts at,
  which the webview reads for the "no longer sent" mark; `isAutomaticSummary`, a summary the turn ran itself, told by
  the reply after it, and `sentEntries`, the entries the history sends, the message an automatic summary quotes
  included; `summaryHistory` and `SUMMARY_REQUEST`, the summary request's
  history; and `resultLineCount`, the step row's line count), the body tool call parser (`toolCalls.ts`: `ToolSpec`, the first call-shaped block, `CALL_WRAPPERS`, a forged
  result before the call, `replyCut`, the stream's cut, malformed-call messages), the system prompt composer (`systemPrompt.ts`: role, the Plan paragraph, call format, rules, tools,
  skills, instruction files; `composeSummaryPrompt`, the summary request's own prompt; `offeredTools`, the tools a send
  offers, and `PLAN_BLOCKED_TOOLS`), the turn limits (`limits.ts`: `brokeCode.maxToolSteps`, `brokeCode.contextSizes`, and `brokeCode.autoCompact` parsing,
  `userLimits`, their user values only,
  the token estimate, the context-full threshold, the typed size check, and `brokeCode.commandTimeoutSeconds` parsing),
  the command tool (`commands.ts`: `RUN_COMMAND_TOOL`, `runCommandTool` checks the call and the folder and asks the
  approval, `runCommand` runs an approved command in its own process group with an injected shell and timeout, and,
  when given (the eval bench only), `environment`, the child's whole environment in place of the host's, and
  `launcher`, a program and its arguments placed before `<shell> -c <command>`, and
  `commandShell` picks the shell), and the read tools (`tools.ts`: `list_files` over the mention reader, `read_file` over the same read and its own line range, header, and notice, `search`
  over ripgrep with its candidate paths, bounded `ok` or `error` results, each also reaching the loaded skills' folders
  by absolute path), the write tools (`writeTools.ts`:
  `write_file` and `edit_file` plan a change `{ path, target, before, after }` and never write; an applier port writes
  it, `fileApplier` straight to disk for the tests and the eval, `approvalApplier` around it in the extension: the
  unsaved-editor check, the approval request, then the write; an applier's result carries `written`, the file's real
  path, only when that change was written), the recorded changes (`recordedChanges.ts`: `recordingApplier`, opt-in,
  records into `RecordedChanges` each change its applier reports `written`, one `RecordedFile` per file, calling its
  `onRecord` with that file after each; `has`, whether a file is still in the set;
  `RecordedChanges.restore`, the per-file restore over the workspace roots and an unsaved-changes port, each file
  `restored`, `removed`, or `skipped` with its `RestoreRefusal`, as `UndoneFile` in `protocol.ts` plus the file's real
  path), the approval seam (`approval.ts`: the request a tool
  makes, the decision it gets, the rejection text, and the decisions of the editor side: which change diffs to close,
  the unsaved-editor check over the open documents, the auto-approve setting from its user value), the tool runner (`toolRunner.ts`: the read and write tools over the
  workspace folders, the read tools also over the run's `skillRoots`, each write handed to the applier the host builds
  for the run, `run_command` with the command environment the host passes, read at each call, and `load_skill` over
  the run's `skills`), the instruction files
  (`instructions.ts`: `~/.agents/AGENTS.md`, then each workspace folder's `AGENTS.md`, under the mention caps), and the
  skills (`skills.ts`: discovery in `~/.agents/skills/` and each workspace folder's `.agents/skills/`, the frontmatter
  subset, validation, precedence, warnings, the line the extension logs at each send; `LOAD_SKILL_TOOL`, `loadSkill`
  for the model's call, `findSlashSkill`, the skill a `/<name> args` message loads, `loadSkillText`, the load result
  whoever loads, the user's arguments substituted or appended, and `answerSkillQuery`, the `/` menu's answer). the last turn's actions (`lastTurn.ts`: `lastTurnActions`, whether the last turn offers Retry and Continue and
  under which reply; `unrevertedEffects`, the applied writes and run commands a removal from an index leaves on disk;
  `CONTINUE_TEXT`). `markdownCode.ts`, `suggestions.ts`, `reservedMentions.ts`, `modelList.ts`, `conversation.ts`,
  `history.ts`, and `lastTurn.ts` import nothing from
  `node:`, since the webview loads them. Unit tests sit next to them as `*.test.ts`, because `bun test` cannot load `vscode`. `tlsFixture.ts`
  generates test certificates with `/usr/bin/openssl` at test time; no private key is committed.
  `conversationFixture.ts` is the in-memory conversation file port for tests.
- `src/extension/`: the extension host glue (activation, the mention reader with the diagnostics `@problems` reads,
  `vscode.languages.getDiagnostics()` as raw records, the git diffs `@diff` reads, through the Git API lookup the
  commit message command shares, `git.ts` passing the core's `lookUpGit` the `vscode.git` extension and building
  `gitDiffs` with `Uri.file`),
  and the selection `@selection` reads, the primary selection of `window.activeTextEditor` as a raw record through the core's `editorSelection`, webview
  view, API keys in `SecretStorage` and their dialog
  queue, the "Add provider" flow's Quick Pick, input boxes, and settings write in `addProvider.ts`, the
  file index's `findFiles` scan and watcher in `fileIndex.ts`, the turn limits and the command timeout from the user
  settings and the "Set context size" input box in `contextSizes.ts`, the tool runner's wiring (the ripgrep candidates
  from `vscode.env.appRoot` and `PATH`, the write tools behind `approvalApplier` around `recordingApplier`, the `undo` port over the workspace folders
  and `hasUnsavedChanges`, the command shell from
  `vscode.env.shell`, `$SHELL`, or `/bin/sh`), the write approval's editor side in
  `approval.ts` (the diff preview over `vscode.diff` and a content provider, the tabs, documents, and
  `brokeCode.autoApproveWrites` values it feeds the core decisions, and `writeAutoApproveWrites`, the user value the
  mode selector writes), the instruction reader and the skill reader from the home folder and the workspace folders, the latter logging the
  skills of each send, and the same discovery, unlogged, for the `/` menu's `querySkills`; `chatView.ts` opens the
  Quick Pick of `chooseModel`, runs `insertCode` over the active text editor, shows a failed mode write, and wires the
  `DraftQueue` to the view's focus command and `postMessage` (`insertDraft`); `extension.ts` registers `broke-code.addSelectionToChat`,
  `broke-code.fixDiagnostic`, and the code action provider of the quick fix; `commitMessage.ts` registers `broke-code.generateCommitMessage`, its git port over the
  built-in Git extension's API, the repository Quick Pick, the replace question, the progress notification, and the
  notifications).
- `src/webview/`: the React chat panel and its CSS (`styles.css`: a token layer, then rules that consume it, every color
  from a `--vscode-*` variable; see `DESIGN.md`), the thread that carries a turn's tool steps as nodes, the latest
  user message in the theme's button colors and the earlier ones outlined (`Entry`'s `earlier`), tool step rows, the approval controls, the mode selector after the message box (`ModeSelect`), the turn's actions row (`TurnActions`: Retry, its
  confirmation and Cancel, and Continue under the last turn's reply, then "Undo changes" under the reply
  `ChatState.undo` names), Edit under the last turn's user message and the replacing state's mark with Cancel (held by
  `App`, the composer's Send carrying it) and the last undo's outcome (`UndoOutcome`), and the answer's code blocks with Copy and Insert at cursor (`CodeBlock`,
  the `pre` override of the answer's renderer) included. `SuggestionMenu.tsx` is the autocomplete list the `@` and
  `/` menus share, a row with an optional description; `composer.ts` holds the message box's decisions without React
  (the token at the caret, each menu's rows, what a key does, what picking a `/` row does (`slashPick`), `applyDraft`,
  how a host draft (an editor entry point's, or queued texts returned as a `paragraph`) edits the message box's text,
  caret, and picked paths; `editDraft`, the draft Edit puts there; `Replacing` and `stillReplacing`, the replacing
  state and when it ends). The queued messages render under the message box (`QueuedMessages`).
  `Root.tsx` is the panel's root: it posts `ready`, renders each state, and queues the `insertDraft` drafts for the
  message box; `main.tsx` mounts it. `turns.ts` groups the entries for rendering without React (`foldTurns`: each entry once,
  an ended turn's fold and its step counts, a summary a boundary of its own), and `text.ts` words the fold's row (`describeFold`), the step row
  (`mainArgument`, a `read_file` range after its path; `describeToolStep`, "undone" included), and the undo's outcome (`describeUndoOutcome`, `describeUndoneFile`, each path a part of its own for the editor font,
  `describeUndoFailure`).
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
  once by `fileApplier` and recorded for the dump, each command approved at once and run with `benchCommandEnv` (the
  allow-listed environment and `sandbox-exec` with `BENCH_SANDBOX_PROFILE` as the launcher, the run's real paths as
  its parameters), and the skills discovered in a copy of the fixture home, never the real one;
  `report.ts` formats the scores; `bench.ts` is the CLI (`sandboxProblem`, its check before any run), guarded by `import.meta.main` so `bun test` never starts it.
  Its unit tests sit next to them and need no Ollama.
- `media/`: `logo.png` (256 px), the extension icon on Open VSX and the Visual Studio Marketplace (`icon` in
  `package.json`; the registries refuse SVG), rendered from its source `logo.svg` with
  `rsvg-convert -w 256 media/logo.svg -o media/logo.png`; `icon.svg`, the same mark in one color (`currentColor`), the chat
  view's icon in the activity bar. The README shows `logo.png` at its top.
- `biome.jsonc`: the Biome linter and formatter settings. Markdown is excluded, because Biome's Markdown formatter
  breaks the YAML frontmatter of the ADRs.
- `.vscode/`: the launch configuration, Biome as the workspace formatter for TS, TSX, JSON, and CSS, and the Biome
  extension as a recommendation.
- `.github/workflows/ci.yml`: lint and format check, type check, unit tests, build, and a packaging dry run on macOS.
- `.github/workflows/release.yml`: the release on each push to `main`. The Marketplace Trusted Publishing
  policy fixes its file name.
- `README.md`: the user documentation, also shown on Open VSX and the Visual Studio Marketplace.
- `LICENSE`: MIT.
