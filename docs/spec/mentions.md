# Mentions, menus, and editor entry points

This file specifies mentions (`@file`, `@folder`, and the reserved `@problems`, `@diff`, `@selection`), the `@` and `/` menus, the built-in slash commands, the editor entry points, and the file index.

- A mention `@file` attaches the file content. A mention `@folder` attaches its direct children, folders suffixed
  with `/`, sorted by name; never a recursive listing.
- A mention is `@` at the start of the message or after whitespace, up to the next whitespace, less trailing
  `.,;:!?)`. Fenced code blocks and inline code spans hold no mentions. A code span opens and closes in one paragraph: a
  blank line or a fenced block between two backticks leaves both literal. A path mentioned twice is attached once.
- A mention whose path is exactly a reserved name (`RESERVED_MENTIONS`: `problems`, `diff`, `selection`), lowercase, once its trailing
  punctuation is dropped, is a reserved mention: it is read from its host source and never resolves to a workspace
  path. `@problems` and `@problems.` are reserved; `@Problems`, `@problems/`, and `@./problems` are paths. The text
  alone decides: a workspace file or folder of that name is mentioned as `@./<name>`, and in a multi-root workspace a
  folder named like a reserved name is no longer reached by `@<name>`, while `@<name>/` and `@<name>/<path>` still
  are. A reserved mention follows the rules of the others: read at send, once per message however often written, in
  the arguments of a `/<name>` skill message too, and never inside code. Its kind is its name (`MentionKind`, apart
  from the workspace `EntryKind`). A status of `NOTHING_TO_ATTACH` (`noProblems`, `noChanges`) says it found nothing
  to attach without failing: the chip is then neutral and dim, in words; a status of `RESERVED_FAILURES`
  (`noRepository`, `gitUnavailable`, `noEditor`, `emptySelection`) says its source lacks what the user asked for, or is
  absent or off, a failure; every status that attaches nothing, other than `NOTHING_TO_ATTACH`, keeps the error color.
  A source that fails is `unreadable` with its cause, the notice `the <name> could not be read
  (<cause>)`. Its text is cut, never refused: over 2,000 lines with the truncation notice, over 1 MiB between
  characters (`cutToMentionCaps`), the cut line counted as not shown. Adding a name: append it to
  `RESERVED_MENTIONS` and follow the type errors (its reader in `mentionReader.ts`, its count unit in `mentions.ts`,
  its chip wording and menu description in the webview), then add its statuses to `NOTHING_TO_ATTACH` or
  `RESERVED_FAILURES`, which the record's validation includes.
- `@problems` attaches the errors and warnings VS Code holds now (what the Problems panel shows; a language service
  may report only open files) for `file` documents inside the workspace folders; information and hints are left out.
  The host's `DiagnosticsReader` returns `vscode.languages.getDiagnostics()` as raw records (scheme, file system
  path, 0-based start, severity, message, source); `readProblems` filters, sorts, formats, and cuts them. One line
  each, `<path>:<line>:<column> <severity> <message>`, then ` (<source>)` when it has one: the path as the file index
  writes it (relative to the deepest workspace folder holding it, as written, led by that folder's name in a
  multi-root workspace), line and column 1-based, the severity `error` or `warning`, each line break of the message a
  space; sorted by path (code order), line, then column. The header counts problems (`@problems (problems, 2
  problems)`, `1 problem`). None: `noProblems`, "Not attached: VS Code holds no error or warning for the workspace
  files.", and the message is still sent. The diagnostic's code is not written.
- `@diff` attaches the changes of tracked files against `HEAD`, staged and unstaged together in one diff, of each
  workspace folder inside a git repository. The host's `DiffReader` (`gitDiffs`) runs the shared Git API lookup
  (`lookUpGit`, the commit message's: the same missing and disabled checks and the same wait, at most 10 seconds, for
  `initialized`; Stop during it ends the turn as during any mention read), then, per folder in workspace order,
  `getRepository(<folder URI>)`, the deepest open repository holding the folder, and `diffWith("HEAD", <path>)`, which
  runs `git diff HEAD -- <path>` in the repository root; `<path>` is `:(literal)` then the folder relative to the
  repository's real root, `.` for the root itself (an absolute path equal to the root becomes an empty pathspec, which
  git refuses). The literal pathspec keeps a folder a repository names `app*`, `[x]`, `?`, or `:e` from matching paths
  outside it, such as `app-private`; `diffWith` turns each `\` of the path into `/`, so a folder whose path holds one
  fails, "its path holds a backslash, which the Git extension reads as a folder separator", and git is not run. Never
  `diffWithHEAD(path)`: it runs `git diff -- <path>`, unstaged only. Untracked files are left out, and a repository
  nested in a folder that is not itself in one is not looked for; nor is a repository the Git extension has not
  opened, such as one above the folder that `git.openRepositoryInParentFolders` keeps closed. `readDiff` builds the
  block: the header counts lines (`@diff (diff, 9 lines)`, `1 line`), and in a multi-root workspace each folder's diff
  follows a line `# <folder name>`; folders without a repository or without changes are left out, and the mention is
  attached as soon as one folder has a diff. Nothing to attach: no tracked file differs from `HEAD` in any repository,
  `noChanges` (neutral), "Not attached: no tracked file differs from HEAD."; no folder in a repository (or no folder),
  `noRepository`, "Not attached: no workspace folder is a git repository."; the Git extension missing or disabled,
  `gitUnavailable`, "Not attached: git is not available in VS Code."; a reader that rejects, or, with no folder
  holding a diff, a folder's diff that fails (a repository without a commit included), `unreadable` with the cause
  (git's own `stderr` when it has one, led by the folder's name in a multi-root workspace). A folder whose diff fails
  beside a folder with a diff is a partial success (maintainer decision, 2026-11-11): the diffs read are attached as
  above, and below the block (after its truncation notice, if any) one line per failed folder, in workspace order,
  "Not attached for <folder>: the diff could not be read (<cause>)."; the mention result's optional `failedFolders`
  counts them, and the chip shows the line count then ", N folders failed" (`1 folder failed`) in the error color.
  Never silent, and never confused with the full failure. The message is still sent.
- `@selection` attaches the text of `window.activeTextEditor`'s primary selection as it stands when the message is
  sent; the other selections of a multi-cursor are left out. `activeTextEditor` is the editor with the focus, else the one
  whose input changed last, so it stays defined while the chat has the focus. The host's `SelectionReader` returns the raw record (the document's URI scheme and file
  system path, the 0-based start and end, the text) or that no text editor is active; `readSelection` checks it and
  cuts it. The header gives the path as the file index writes it and the 1-based lines:
  `@selection (selection, src/app.ts lines 10-12, 3 lines)`, `line 10` and `1 line` for one line, then the text in a
  fence longer than any backtick run inside it. A selection ending at column 0 of a line does not count that line in
  its range. The range is the whole selection's, also when the text is cut (`lines 1-2003, 2000 lines, truncated`).
  Nothing attached, the message still sent and the chip in the error color: no active text editor, `noEditor`, "Not
  attached: no text editor is active."; a document that is not a `file` inside the workspace folders (an untitled
  document, the diff preview of an approval, any other scheme), `outsideWorkspace`, "Not attached: the selected file
  is outside the workspace folders.", checked before the selection's emptiness; an empty selection,
  `emptySelection`, "Not attached: the selection is empty.". The mention result carries the path and range in its
  optional `range` (`{ path, start, end }`, 1-based lines, `start` not after `end`), which the chip shows with the
  count: "src/app.ts 10-12, 3 lines", "src/app.ts 10, 1 line".
- Two editor entry points fill the message box and never send (Send's rules stay in one place): the command
  `broke-code.addSelectionToChat` ("broke-code: Add selection to chat", Command Palette, and the first entry of the
  editor's `broke-code` submenu, `editor/context` when `editorHasSelection`, `docs/spec/edit-selection.md`) and the quick fix "Fix with broke-code". Both go through `ChatView.insertDraft`, which runs the
  view's `brokeCode.chat.focus` command (resolving the view on a first show), then posts `insertDraft { text, mode,
  picked }` (`DraftInsert`) through the `DraftQueue` (`draftQueue.ts`). A draft is queued only once the show succeeded:
  a show that fails queues nothing and is shown as an error, so a retry delivers it once. Queued drafts are posted in
  order while the webview is ready and visible: a draft sent before the first open, or while the view is hidden, waits
  for the webview's next `ready` and follows its `init`; hiding the view resets `ready`, since a hidden webview drops
  what it is posted. A post that resolves `false` or rejects is logged and keeps that draft first in the queue, those
  behind it after it, for the next `ready`; one delivery runs at a time, so no draft is posted twice. Without a valid
  provider there is no message box: the panel shows, a warning notification says to add a provider first, and the
  draft is dropped, never held. `chatStateOf` leaves
  `insertDraft` out. The webview receives it in `Root`, not the composer, since it can arrive right behind `init`, before
  the composer exists; the composer applies each queued draft in order with `applyDraft` (also while a reply is in
  flight), History closes, and the message box takes the focus (the second focus move DESIGN.md allows), and takes it back when the panel's
  window regains the focus with nothing focused, until the user clicks or presses a key in the panel (the view's focus
  command settles before the workbench has focused the webview, which can blur the box right after the draft); an editor
  draft that arrives while the panel has no message box is dropped (Root's `takeDrafts` takes it unapplied), while a
  returned queued text (`paragraph`) stays in Root's list and is applied, in order, once the message box mounts. `mode: caret` inserts at the box's caret, with a space before
  it unless the text before is empty or ends with whitespace, and one after it unless whitespace follows, which the caret
  then passes, so it follows whitespace and no menu opens; `fillOrAppend` fills a box empty or holding only whitespace,
  else appends after one line break, the caret at the end. `picked` joins the box's picked paths. The selection command
  inserts `@selection`, read at send like any mention, and leaves the editor's selection as it is.
  - The quick fix: a `CodeActionProvider` of kind `QuickFix` for `{ scheme: "file" }`, registered at activation
    (`activationEvents: ["onStartupFinished"]`, so it exists before the panel is opened; cost: the extension loads in
    every window, after startup), one action per diagnostic of the request for which `fixDraft` gives a draft: errors
    and warnings of a `file` document inside the workspace folders. Its text is `Fix this problem in @<path> at line
    <n>: <message>`, `<path>` as the file index writes it (`workspacePath`), `./<name>` for a reserved name
    (`pickedPath`), and picked; `<n>` 1-based; each line break of the message a space, as `@problems` writes it;
    `fillOrAppend`. Known cost, accepted: a backtick in the message can pair with a stray backtick of the draft's last
    paragraph and hide the mention. Its command `broke-code.fixDiagnostic` is hidden from the Command Palette (`when:
    false`) and takes the raw `Diagnostic` record; since any extension can run it, it checks the record
    (`parseDiagnostic`) and filters it through `fixDraft` again, and does nothing for anything else.
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
  first 2,000 lines, then `[truncated: N more lines not shown]`). A reserved mention adds its own statuses
  (`noProblems`, `noEditor`, `emptySelection`).
- The model receives the user text, then one block per mention: a header `@<path> (<kind>, <count or status>)`,
  then the content in a backtick fence longer than any backtick run inside it, or a one-line notice when nothing
  is attached. The message is sent whatever the statuses. The chat shows each mention as a chip under the
  message, with its kind and status: a count or `truncated` in the default look, a `NOTHING_TO_ATTACH` status
  neutral, any other status in the error color.
- An `@` at the start or after whitespace, outside code, opens the mention menu while the caret ends its token; the
  query is the non-space text after `@`, possibly empty. The menu lists the reserved names whose name starts with the
  query, ignoring case (a prefix, as the `/` menu filters), each with its kind marker and a one-line description
  ("Errors and warnings of the workspace files", "Selected text of the active editor"), then the index entries whose path contains the query, ignoring
  case, shorter paths first, then in code order: 20 rows in all (`menuView`). The webview adds the reserved rows
  itself, so they show before the files answer and when the files cannot be listed. Arrow keys move and wrap, before the recall of earlier
  messages (`docs/spec/chat-panel.md`), Enter or Tab picks, a click picks, Escape closes; while the menu shows rows, Enter
  sends only when the `@` token already is what the highlighted row would insert, its trailing space aside
  (`pickKeepsToken`): the user typed the whole path, so the message goes with that path as picked; otherwise Enter never
  sends. Picking a reserved row
  replaces the token with `@<name> ` and records nothing; picking an index entry replaces it with `@<path> ` and
  records the path, `@./<name> ` and `./<name>` for an entry named like a reserved name (`mentionPick`). At send, a picked path counts while its `@<path>` still stands as a whole token in the text, and
  its text is not parsed again, so a path with spaces or backticks is one mention. A backtick in a picked path can
  make the text read two ways; a picked path follows the reading with picked paths set aside, and a typed token
  counts, and opens the menu, only when it is outside code in both. Answers carry the query id; the
  webview drops stale ones. While the answer to a new query is pending, the menu shows the matching reserved rows
  and only the earlier rows that match it, never a row for an older query. When the files cannot be listed, the menu says so instead of "No match".
- A `/` at the very start of the message opens the `/` menu while the caret ends its first word; the query is the text
  after `/`, possibly empty. A `/` anywhere else opens nothing, since paths hold them. The menu lists `/new` ("Start a
  new conversation"), `/model` ("Choose the model"), `/compact` ("Summarize the conversation to free context"), then
  each skill the send's discovery finds, by name, with its
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
  Exactly `/compact` posts `compact`, validated like `newChat`, and the host runs `ChatController.compact` (`docs/spec/harness.md`,
  `/compact`). All three clear the box and act only when Send would (a model chosen, no reply in flight, no mode write
  pending); `/new` and `/model` send nothing to the model. `/new` returns the queued messages to the box, as the New
  chat button does. `/new words`, `/model words`, and `/compact words` are ordinary messages.
- The file index is built on the first menu query with `findFiles("**/*", "**/{node_modules,.git,dist,out,build}/**",
  5000)`: an explicit exclude adds to `files.exclude` (only `null` drops it). `.gitignore` is not read. Folders are
  derived from file paths, none inside a multi-root folder name that holds `/`. Paths are `asRelativePath` with its default prefix, the folder name in a multi-root
  workspace only, which the mention resolver accepts. A file watcher marks the index stale on create and delete
  outside the excluded folders, and so does a workspace folder or `files.exclude` change; the next query rebuilds it, and queries
  during a build share it. At 5,000 files the menu's last line says the index is limited.
