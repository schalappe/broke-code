# Conversations, navigation, and History

This file specifies how conversations are saved, listed, pruned, and reopened, and how History searches them.

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
  provider and model choice, the id of the conversation shown, and whether Plan is on. The list is derived from the directory, newest
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
  `halted`, its `haltReason`, and tool steps, with an optional `approval` and an optional `undone` (`true` only). A reopened conversation therefore resends exactly what was sent and
  never reads its mentions again. Version 1 files are skipped like any unknown version: no release wrote them, so
  none is migrated. An optional field added to an entry keeps the version: an older build drops the unknown key and
  reads the rest (ADR 0003), such as a mention's `range` (`@selection`), `failedFolders` (a partial `@diff`, a
  positive whole number), an assistant entry's `summary` (`true` only), and a tool step's `undone` (`true` only), validated when present: any other shape makes the record invalid. A new value of an existing field keeps it too, such as the mention kinds `problems`,
  `diff`, and `selection` and the statuses `noProblems`, `noChanges`, `noRepository`, `gitUnavailable`, `noEditor`,
  and `emptySelection`, each validated: an older build skips such a record as invalid and keeps it on disk (accepted,
  ADR 0003, 2026-11-11). An unknown kind or status makes the record invalid. It holds no API key and nothing else of `ProviderAccess`; a failed reply's error keeps the provider's base
  URL for display, since it is user settings, not a secret. Times are whole milliseconds within the `Date` range. A
  file that fails validation or has an unknown version is logged and skipped; a file that cannot be read is shown as
  a listing failure. On load, a reply still `waiting` or `streaming` becomes `stopped`.
- A conversation is saved when a message is sent, and the request waits for that save (a failed save is shown and the
  request still goes), then at most every 500 ms while a reply streams, when a call starts, after each tool step, and
  when the turn ends (done, stopped, failed, halted, or cut off). A reply's saves go to the record it was sent
  in, also after New chat or opening another one, and a deleted conversation is never written again. A conversation
  without entries is never written.
- Navigation runs one operation at a time, in request order: restore, New chat (and `/new`, through the same
  `newChat` request), open, delete, prune, and "Undo changes", which changes no conversation and stops no reply. The operations that change the conversation shown (New chat, open,
  deleting the one shown) stop the reply in flight at request time and wait until it settles, its last save handed to
  the store, so a later read sees that save. Restore stops nothing: no reply exists at activation. Deleting another row
  and pruning leave the reply running; a reply's own save triggers the prune. The conversation shown is therefore the
  result of the last request, never one deleted or pruned before it: an open queued after a delete or prune of its id
  reads it as missing and says so. Each user request clears the open or not-found error it supersedes; its own failure
  is shown. A listing error has its own field in the panel state (`listFailed`), apart from the error of the
  conversation shown and the user's actions (`storageProblem`: save, delete, open, not found), so the panel can show
  both and neither hides or clears the other; it is cleared only by the next listing that succeeds. Stop ends a reply at
  once even when a step it waits on cannot be aborted (such as a CA file read on a FIFO): the reply is stopped and
  saved, and late reply text or outcome is dropped. A row's Delete asks first: its first click turns it into "Confirm delete", with Cancel after it, and only
  the second click posts `deleteConversation`; Cancel posts nothing. A row is dropped only once its delete has succeeded. Deleting the
  conversation shown shows a new one first. New chat, opening another conversation, and deleting the one shown also
  empty the queue at request time, not when they run, so a turn ending `done` meanwhile sends nothing; opening the
  conversation shown, deleting another row, and pruning leave it. The controller returns the queued texts to the
  message box as it empties the queue (one `paragraph` draft, one per paragraph, after the draft when the box holds
  one), so a message queued just before the request is returned too, and a second request returns nothing again.
  `send` is not navigation: its saves go straight to the store. Accepted cost:
  a request waits behind a slow disk operation already queued. Reopening restores the entries only; it does not switch
  the provider or model. History works without a provider: past conversations can be read, reopened, and deleted; only
  the composer needs one. Without a folder or workspace open, there is no storage directory: the conversation stays in
  memory and the list is empty. A failed save, delete, listing, or open is logged and shown in the panel.
- History has a text field "Search conversations" above its rows, shown when at least one conversation is listed; it
  stays in place while the rows scroll. It searches the titles and the messages of the listed conversations.
  - By title, at once, in the webview: the rows whose title contains the text (`filterConversations`: the text
    trimmed, lowercase on both sides, a substring, no accent folding, order kept; a blank text keeps all), over the
    listed titles (cut to 60 characters).
  - By content, through the host. The needle (`searchNeedle`) is the text trimmed, in lower case, its whitespace runs
    collapsed to one space; it is searchable at 3 characters (code points) or more and at most `MAX_QUERY_LENGTH`
    (1,024 UTF-16 units). Once a searchable needle has stayed the same for 300 ms, the webview posts
    `searchConversations { id, query }`, `query` being the needle. The request id advances at each change of the
    needle, searchable or not; a change that leaves it the same (a trailing space, a letter case) neither restarts the
    wait nor sends anything. Each change of the needle drops the earlier answer's rows and count at once, and the
    webview drops an answer whose id is not its latest. Closing History cancels the wait. There is no cancel message.
  - The host (`ConversationStore.search`) searches its own listed conversations, newest first, the 50 first only,
    never ids from the webview, and ignores a query that is not searchable. Per record, entry by entry, it searches
    each user message as typed and each assistant entry's answer as the chat shows it (`shownAnswer`: the text
    around the call block, joined and trimmed; a malformed block the chat shows, a summary, and the partial text of
    a failed or stopped reply count). Tool steps (arguments and results), reasoning, the text the model received for
    mentions and skills, and error texts are never searched. Each entry's whitespace runs collapse to one space and it
    is compared in lower case, as a substring, with no accent folding, so a match never spans two entries; the
    Markdown source is searched (`bold text` does not find `**bold** text`). A matching record gives one excerpt, from
    its first matching entry (`conversationExcerpt`): the collapsed text from 30 characters (code points) before the
    match, 120 characters at most, with "…" at each cut end; where lower-casing changes a text's length, it may start
    a few characters off. Records are read one at a time through the store's queue, each read queued when the one
    before has ended, so a save waits behind one read of a search at most. A newer search stops an older one's
    remaining reads, and the older one gets no answer. The answer `conversationMatches { id, items, unreadableCount }`
    holds every matching conversation in the list's order, whatever its title, each with its excerpt. A record whose
    read fails, or that is invalid or of an unknown version, is left out and counted in `unreadableCount`; one gone
    meanwhile (deleted or pruned) is left out and not counted. Neither is a listing failure, and a search writes
    nothing. An unexpected failure of the search itself (`answerConversationSearch`) is logged and answered with no
    row and every conversation it would have searched counted, so the panel never waits forever or claims no match. The conversation shown is searched as saved, so during a reply the disk can be one save interval behind.
  - The rows: those matching by title first, without an excerpt, even when their messages match too; then those
    matching by content only, in the list's order, each with its excerpt as plain text on one line, never rendered as
    Markdown, without a highlight. The answer is crossed with the list as it is now, so a conversation deleted since
    shows no row, and a list change (a save, a delete) sends no new search. While a search is awaited (from the change
    to a searchable needle until its answer) and no row matches by title, "Searching…" stands where "No match" would;
    "No match" shows when no row is listed and no search is awaited. When the answer counts unreadable records, a
    warning between the field and the rows says "1 conversation could not be searched" or "N conversations could not
    be searched", with the rows or with "No match".

  Opening History focuses the field (the first focus move DESIGN.md allows). Enter opens the first row shown, as a
  click on it does, and does nothing with no row or while an input method composes. Escape clears a non-empty field;
  in an empty one it closes History and focuses the History button. A reply that ends while History is open leaves
  the focus where it is, instead of moving it to the message box. Its text lives in the list mounted while History is
  open, so every close clears it; a list change (a delete, a save) is filtered by title with the same text. The
  listing-failure notice shows whatever the field holds.
