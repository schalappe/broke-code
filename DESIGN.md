---
name: broke-code chat panel
description: >-
  The design rules of the broke-code chat panel, a VS Code webview in twinny's minimal manner. Written from the
  shipped stylesheet, src/webview/styles.css, which is the source of truth for every value.
typography:
  body:
    fontFamily: var(--vscode-font-family)
    fontSize: var(--vscode-font-size)
    lineHeight: 1.5
  small:
    fontFamily: var(--vscode-font-family)
    fontSize: calc(var(--vscode-font-size) - 1px)
  smallest:
    fontFamily: var(--vscode-font-family)
    fontSize: calc(var(--vscode-font-size) - 2px)
  code:
    fontFamily: var(--vscode-editor-font-family)
    fontSize: calc(var(--vscode-font-size) - 1px)
rounded:
  sm: 4px
  md: 6px
  lg: 10px
spacing:
  "1": 2px
  "2": 4px
  "3": 8px
  "4": 12px
  "5": 24px
---

# Design System: broke-code chat panel

## Overview

The chat panel is a tool people work in all day, in the VS Code side bar, beside their code. It follows
[twinny](https://github.com/twinnydotdev/twinny)'s minimal look: the user's message is a block, the reply runs flush
on the panel, whitespace separates the turns, and greys do most of the work. Three things stand out of the greys
(maintainer decision, 2026-11-12): the latest user message, in the theme's button colors; the thread, a drawn line
that carries the agent's tool steps as nodes; and the decision block, drawn in negative. It must look native in any
VS Code theme, so it owns no color: every color comes from the active theme.

The stylesheet has two layers. The token layer (`--bc-*` custom properties on `:root`) comes first and is the only
place that reads a `--vscode-*` variable; every rule after it reads tokens only. A new screen follows the same
order: pick tokens first, and add a token, under a name that says its role, only when no existing one says what you
mean. To check that no rule reaches past the token layer:

```sh
awk 'f; /^}/{f=1}' src/webview/styles.css | rg 'var\(--vscode'
```

It must print nothing (the first `}` of the file closes the token layer).

Constraints that shape everything here:

- The webview's Content Security Policy allows the bundled stylesheet only. An inline `style` attribute does nothing;
  all styling goes through classes.
- No icon font, no component kit, no Tailwind. Marks (chevron, dot, file, folder, problems, diff, and selection
  markers, the rule before a turn ending) are drawn in CSS from borders and backgrounds.
- The frontmatter above lists the type, radius, and spacing tokens. It lists no color, because no color has a fixed
  value: see "Colors".

## Colors

Every color is a `--vscode-*` theme variable, used directly or through `color-mix()` of such variables. The only
literal color is `transparent`. No hex value, no `rgb()`, no named color. To check:

```sh
rg -n '#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(' src/webview/styles.css
```

It must print nothing.

### Neutral

| Token | Value | Use |
| --- | --- | --- |
| `--bc-bg` | `--vscode-sideBar-background` | The panel. |
| `--bc-fg` | `--vscode-foreground` | Text people read. |
| `--bc-fg-dim` | 72% of the foreground (88% in high contrast) | Secondary text and the drawn marks. 72% keeps 4.5:1 on the default light and dark themes. |
| `--bc-rule` | 16% of the foreground | Hairlines. |
| `--bc-fill` | 6% of the foreground | A surface a shade off the panel: a code block, a command, a queued message. |
| `--bc-fill-strong` | 11% of the foreground | One step stronger: inline code, chips, a hovered or pressed secondary button. |
| `--bc-unsent-opacity` | 0.6 (1 in high contrast) | The entries no longer sent to the model after a summary, and the turn Edit replaces. |

### Role tokens

Each takes the color the theme gives that exact job, so a button is the theme's button and a link the theme's link.

| Token | Theme variable (then its fallback) | Use |
| --- | --- | --- |
| `--bc-field-fg`, `--bc-field-bg` | `input.foreground`, `input.background` | Inputs and the message box. |
| `--bc-field-border` | `input.border`, then `--bc-line` | Their border. |
| `--bc-field-placeholder` | `input.placeholderForeground`, then `--bc-fg-dim` | Placeholder text. |
| `--bc-caret` | `editorCursor.foreground`, then `--bc-fg` | The text caret. |
| `--bc-select-fg`, `--bc-select-bg`, `--bc-select-border` | `dropdown.foreground`, `.background`, `.border` (then `--bc-line`) | The pickers. |
| `--bc-button-fg`, `--bc-button-bg`, `--bc-button-bg-hover` | `button.foreground`, `.background`, `.hoverBackground` | The primary button. |
| `--bc-button-border` | `button.border`, then `--bc-edge` | Its border. |
| `--bc-button-border-hover` | `contrastActiveBorder`, then `--bc-button-border` | Its border when hovered. |
| `--bc-accent-line` | `button.background`, then `--bc-edge` | The outline of an earlier user message. The latest one takes the button tokens themselves. |
| `--bc-accent-chip` | 18% of `button.foreground` | A chip on the latest user message. |
| `--bc-tool` | `textLink.foreground` | A tool's name on the thread. Not a link: its row opens, and the name is also in the editor font, weight 600. |
| `--bc-inverse-well`, `--bc-inverse-hover`, `--bc-inverse-line` | 14%, 16%, and 45% of `sideBar.background` | On the decision block, drawn in negative: the command's ground, a hovered Reject, Reject's border. |
| `--bc-inverse-button-hover` | 86% of `sideBar.background` over the foreground | The hovered Accept or Run on the decision block. |
| `--bc-link`, `--bc-link-active` | `textLink.foreground`, `textLink.activeForeground` | Links, always underlined, so color is never the only cue. |
| `--bc-code-fg` | `textPreformat.foreground`, then `--bc-fg` | Inline code. |
| `--bc-error`, `--bc-warning` | `errorForeground`, `editorWarning.foreground` | Status text and marks. |
| `--bc-error-fill`, `--bc-warning-fill` | `inputValidation.errorBackground`, `.warningBackground` | The fill of an error or a warning block. |
| `--bc-error-edge`, `--bc-warning-edge` | `contrastBorder`, then `inputValidation.errorBorder` or `.warningBorder` | Its border. |
| `--bc-error-edge-soft` | `contrastBorder`, then 55% of `errorForeground` | The border of a failed chip. |
| `--bc-error-text`, `--bc-warning-text` | `--bc-fg`; the status color in high contrast | The text of an error or a warning block. |
| `--bc-row-hover` | `list.hoverBackground`, then `--bc-fill` | A hovered row of a menu or of History. |
| `--bc-row-current` | `list.inactiveSelectionBackground`, then `--bc-fill-strong` | The current History row. |
| `--bc-row-selected`, `--bc-row-selected-fg` | `list.activeSelectionBackground` (then `--bc-fill-strong`), `list.activeSelectionForeground` (then `--bc-menu-fg`) | The highlighted menu row. |
| `--bc-menu-fg`, `--bc-menu-bg` | `quickInput.foreground` (then `--bc-fg`), `quickInput.background` (then `editorWidget.background`) | The `@` and `/` menus. |
| `--bc-menu-border` | `contrastBorder`, then `widget.border`, then `--bc-rule` | Their border. |
| `--bc-shadow` | `widget.shadow` | Their shadow. |
| `--bc-focus` | `focusBorder` | The focus ring only. |
| `--bc-line-active` | `contrastActiveBorder`, then `--bc-rule` | The border of a hovered or pressed secondary button. |

A theme variable is written `--vscode-` plus its name with `.` turned into `-` (`input.border` is
`--vscode-input-border`).

### The high-contrast rule

Surfaces are set apart by a fill, never by a line drawn around them. A high-contrast theme flattens those fills: its
button, input, selection, code block, and validation backgrounds equal the panel or have no value. Only a
high-contrast theme defines `--vscode-contrastBorder` and `--vscode-contrastActiveBorder`. So:

- `--bc-edge` is `var(--vscode-contrastBorder, transparent)`. Every filled surface carries
  `border: 1px solid var(--bc-edge)`: invisible in light and dark themes, a visible boundary in high contrast. This
  covers code blocks (the frame of a block with its header included), command blocks, chips, buttons, and the warning
  and error blocks. The user's message takes the button's border (`--bc-button-border`), which is the contrast
  border there; a high-contrast theme whose button has no fill shows the latest message and the earlier ones alike,
  as outlined blocks, which is accepted: the difference is emphasis, not a state. The pickers and the header's
  buttons, quiet text elsewhere, carry `--bc-edge` too.
- `--bc-edge-active` is `var(--vscode-contrastActiveBorder, transparent)`. The highlighted menu row and the current
  History row carry it as a solid outline; a hovered row, as a dashed one.
- `--bc-line` is `var(--vscode-contrastBorder, var(--bc-rule))`: a line that is drawn in every theme (a secondary
  button, the decision block, a rule) becomes the contrast border in high contrast.
- In high contrast an error and a warning block share the same border and no fill, so their text takes the status
  color (`--bc-error-text`, `--bc-warning-text`); elsewhere the fill says it and the text stays the foreground.
- In high contrast the entries no longer sent after a summary, and the turn Edit replaces, are not dimmed
  (`--bc-unsent-opacity` is 1): faded text would fall under the theme's contrast, and the line above them says it in
  words.

Two controls are buttons in the markup and not to the eye, so they get no box, in high contrast either (maintainer
decision): a link button (`button.link`), which is underlined at rest in every theme, and a History row's title
(`button.history-open`), which is told apart by its row: title over date, Delete at the right. A History row takes
`--bc-edge-active` when hovered (dashed) and when its title has the keyboard focus (solid), as the current row does
at rest.

The rule needs no theme class: it follows the variables, so it holds in High Contrast Light and in any theme that
defines the contrast borders. Anything new that is a block, a button, or a selected row takes one of the three
tokens.

## Typography

Two faces, both the user's own:

- The VS Code UI font (`--bc-font`) for everything people read: messages, replies, labels, buttons, statuses.
- The editor font (`--bc-mono`) for what is code: code blocks, inline code, paths, commands, tool names and
  arguments, menu rows (a path or a command name), chip paths.

Sizes derive from `--vscode-font-size`, so the panel follows the user's setting: `--bc-fs` (body), `--bc-fs-sm` (one
pixel down: tool steps, reasoning, notices, menus, header buttons), `--bc-fs-xs` (two down: usage, dates, step
statuses, chips). Code is set at `--bc-fs-mono`, one pixel down, because the editor font runs large beside the UI
font. Line height is 1.5. Markdown headings step by one pixel (`h1` +3, `h2` +2, `h3` +1), weight 600; emphasis comes
from weight, not from size or color. Numbers that change in place (usage, dates) use tabular figures.

## Layout

One column, at the side bar's width; nothing scrolls sideways. The panel has 12px of side padding and an 8px gap
between its regions: header, notices, the conversation (or History in its place), the message box.

- Spacing (padding, gap, margin) comes from the `--bc-space-*` scale: 2, 4, 8, 12, 24. Tight inside a group, wider
  between groups. Four kinds of length are not spacing and stay off the scale: a line (every border, rule, and
  outline is 1px, and the menu is pulled 1px over the message box's border); the focus ring's offset (see "Keyboard
  and focus"); the size tokens, `--bc-row` (22px, the least height of a one-line row), `--bc-mark` (6px, a chevron
  drawn in CSS), `--bc-thread-indent` (20px, the indent of what sits on the thread), `--bc-node` (7px, a node) and
  `--bc-node-solid` (9px, the decision block's node), with the file and folder markers sized in `em`; and Markdown's
  vertical rhythm, set in `em` so it follows the text size.
- Whitespace separates turns: 12px between entries, 8px more above a user's message; the replies and tool steps of
  one turn sit 4px apart, and so do a folded turn's row and its final reply. Opened, the fold lays its entries out in
  a column of its own with the same spacing, 4px under its row.
- Long content never widens the panel: a path or a title on one line is cut with an ellipsis; a message, a command,
  and a chip wrap anywhere; a folded turn's row wraps between words; a code block, a step result, and a table scroll
  inside themselves.
- The header is a running head over one rule (`--bc-line`): the two pickers share the first line; the usage and the
  buttons drop below once the pickers would fall under 16em.
- The conversation keeps 4px of side padding inside its scroll box, so a focus ring on a row at its edge is not
  clipped.
- The conversation follows its bottom while the user is there (within 24px of it) and stays where it is once they
  scroll up. When a turn ends and folds while they are scrolled up, the turn's question row (the user's message above
  the fold) stays at the same place on screen. Nothing above that row changes, so the view need not move: the
  browser's own scroll anchoring is off (`overflow-anchor: none`), since it would re-anchor on the final reply or on a
  step that vanished into the fold and move the view. Known limit: when the fold leaves too little content under the
  view, the browser lowers the scroll position to its new maximum and the row moves down; nothing can avoid it.

## Elevation & Depth

Flat. Depth comes from fills, not shadows. The one shadow belongs to the `@` and `/` menus, which overlay the
conversation: 4px down, 12px of blur, in `--bc-shadow`.

## Shapes

Three radii: 4px for controls and small tokens (buttons, fields, chips, inline code, menu rows), 6px for blocks (code
blocks, alerts, the decision block, the menu, History rows), 10px for the two large blocks (the message box, a
user's message). Borders and rules are 1px. No colored side stripe.

## Components

### Buttons

- Primary (Send, Stop, Set API key, Add provider in the empty state): the theme's button colors. At most one per region. In the
  conversation, only the decision block has one, Accept or Run, drawn in negative like its block (see "The decision
  block"). While a reply is in flight, Stop is the message box's primary button
  and Send, which then queues, is secondary.
- Header (New chat, History): secondary buttons shown as quiet text, dim and without a drawn box (`--bc-edge` only),
  until hovered, focused, or pressed, when they take the secondary look. The two pickers follow the same rule: dim
  text on the panel, one size down, their border back on hover and focus.
- Secondary (New chat, History, Delete, Reject, Retry, Add provider under the skipped providers, a queued message's
  Send now, Edit, and Remove, the turn's Retry, Retry anyway, Cancel, Continue, "Implement in ... mode", and Undo changes, the last message's Edit and the Cancel of its mark): a hairline box on the panel (`--bc-line`), the foreground as
  text; `--bc-fill-strong` when hovered or pressed (`aria-expanded="true"`).
- Link (Open provider settings, Set context size): the link color, underlined.
- Code block action (Copy, Insert at cursor): a secondary button two pixels down (`--bc-fs-xs`), at least a row high
  (`--bc-row`). Never primary, so the decision block keeps the conversation's one primary button. Copy shows its
  outcome, "Copied" or "Copy failed", in place of its label for about two seconds. Their header is not selectable.
- Quote: a secondary button in a row of its own (`.quote-row`) directly under an answer's Markdown, 4px under it (2px
  under the narration before a call), shown while text of that answer is selected. The row is not selectable. No room
  is kept for it, a written exception to the rule that a revealed control keeps its room, which covers controls
  revealed on hover: a row kept under every answer would cost more than the one-row move.
- Disabled: half opacity. Header and History buttons are one size down.

### Fields

Inputs and selects use the theme's input and dropdown colors, a 1px border, radius 4px. The message box, the mode
selector, and Send (then Stop, while a reply is in flight) share one large rounded field (radius 10px): the text area
on its own line, then the selector at the left and the buttons at the right. The field's border takes the focus color while the text area has
focus.

The mode selector is a native select one size down (`--bc-fs-sm`), "Ask", "Auto-edit", or "Plan", its tooltip saying
what the mode does. It shows the mode the host holds (Plan from the workspace, the others from the setting): a pick
shows only once the host has applied it, and a failed write leaves it as it was, with the error in a notification. Disabled (half opacity) while a reply is in flight, like the
pickers, and while a mode change is being written, when Send is disabled too (Enter sends nothing).

### Queued messages

Under the message box, outside its field: one row per queued message, in order, on `--bc-fill` with `--bc-edge`,
radius 6px, one size down. The text is cut to one line with an ellipsis (its tooltip holds it whole), then Edit and
Remove at the right; while the queue is paused, the first row leads its actions with Send now, disabled when Send
would not act. Above the rows, a notice line says "The queue is paused." when no reply is in flight, and another
"The queue is full: 10 messages at most." at the cap. Nothing went wrong in either case, so no block.

### The conversation

- User message: radius 10px, full width. The latest one of the conversation is a block in the theme's button colors
  (`--bc-button-fg` on `--bc-button-bg`); a message a later one follows (`.earlier`) keeps only their outline
  (`--bc-accent-line`) on the panel, its text in the foreground, so the question in progress is the one filled block.
  Its chips sit under the text: a path in the editor font on `--bc-fill-strong`, then its status in dim text; a
  failed chip is drawn in the error color. On the latest message a chip is a tint of the text (`--bc-accent-chip`)
  with its status and marker in that text's color, and a failed or neutral chip takes the panel's ground back, where
  its own color reads. A chip that found
  nothing to attach without failing (`@problems` with no error or warning, `@diff` with no change) is neutral: no fill
  and dim text, its edge kept for high contrast, its status in words. A `@diff` whose source is absent or off (no
  repository, git not available) is failed, not neutral, and so is a partial `@diff`, some folders read and some
  failed: its status gives the line count then the failed folders ("9 lines, 1 folder failed"). The kind marker of `@problems` is a ring; of `@diff`, a box
  with a thick left edge, a change bar. A `@selection` chip's status leads with the file and line range ("src/app.ts
  10-12, 3 lines"); its kind marker is a pair of brackets (side borders only), and with no active editor, an empty
  selection, or a file outside the workspace it is a failed chip.
- Reply: Markdown flush on the panel, inside `.answer`, the only place the Markdown rules apply.
- Code block of a reply: once its text is final, its frame (`.code-block`: `--bc-fill`, `--bc-edge`, radius 6px)
  holds a header (`.code-actions`) with Copy and Insert at cursor at the right, then the code, which scrolls inside
  itself under the header. A block still growing renders as a bare code block, without the header.
- Quote under a reply: its row sits between the answer's Markdown and the reply's tool step or decision block, so the
  tool step moves down by one row while it shows.
- The thread: a reply that holds a tool step, and a folded turn, sit 20px in, beside one drawn 1px line
  (`--bc-line`) that runs from one to the next. Each row that opens is a node on it, a 7px ring filled with the
  panel's color: plain for a tool step, dotted for reasoning, a double ring for a folded turn, in the error color for
  a failed step (its status says so in words). What the agent says before a call is narration: small and dim. A
  reply without a step, the turn's answer, leaves the thread and runs flush at full size. Opened, a fold's entries
  move back onto the line.
- A row that opens (reasoning, a tool step, a folded turn) ends with its chevron, turned down once open.
- Reasoning: a small dim row; opened, its text sits behind a 1px rule. On the thread only when its reply holds a
  step.
- Tool step: one small dim line: tool name (`--bc-tool`), main argument (a `read_file` range after its path, `big.log 2001-`), status at the right, then the chevron. It opens to its result in a
  code block. A command shows whole in a block under its line. A failed status is in the error color. A write that
  "Undo changes" put back says so first in its status, in words ("undone, ok, 1 line"), in the default look: nothing
  failed, and the line count stays the result's.
- A call without a result has no chevron: its node is filled and breathing while it runs, hollow when it ended with
  no result.
- Folded turn: an ended turn's steps and intermediate replies under one small dim row, a double-ring node on the
  thread, between the user's message and the final reply: what the steps did, "Read 3 files, edited 1 file, ran 1
  command, 1 failed", the counts in words, never in color alone, a path counted once after a lexical cleanup (`a.ts` and
  `./a.ts` are one file); it wraps, never cut. Closed when the turn ends; opened, the entries show exactly as they
  rendered before. Its rules use the child combinator (`.turn-fold > summary`), so the reasoning and step rows inside
  keep their own chevrons.
- Summary (`/compact`): its reply sits under a separator (`.summary-separator`), small dim words between two 1px
  rules in `--bc-line` that run across the conversation: "Summarizing the conversation…" while it streams, then
  "Conversation summarized" ("Conversation summarized automatically" for one an agent turn ran itself), or
  "Conversation not summarized" when it failed, stopped, halted, or came back empty. A summary is never folded, and the
  turn before it folds by the usual rule.
- The turn's actions (`.turn-actions`): one row of secondary buttons after how the turn ended, wrapping when narrow:
  under the last turn's reply, Retry, then Continue when the turn was stopped or halted on the step limit or on
  malformed calls, both disabled when Send would not act; then, while Plan is on and the conversation ends on its
  final answer, "Implement in Ask mode" or "Implement in Auto-edit mode", named after the mode the setting holds and
  disabled like Retry (secondary too: only the decision block has a primary button); then, under the last reply of
  the turn whose writes are held, "Undo changes", followed by the small dim hint "Commands this turn ran are not listed or undone." when the
  turn ran one.
  None shows while a reply is in flight, so nothing sits between an approval's controls and the message box. When
  Retry would leave written files or run commands behind, its first click asks: a line of its own above the buttons
  (`.retry-warning`, one size down, in the full foreground, since it asks before acting) says Retry does not revert
  them and that Undo changes gets the files back, the same button reads "Retry anyway", and Cancel follows it. Not a
  modal: the question sits where the user clicked.
- Edit: under the last user message, at its right and 4px below it (`.user-actions`), a secondary button, shown
  where Retry is and disabled when Send would not act. A click fills the message box and marks the last turn: that
  message and everything after it sit in one group (`.replacing`) under a line of their own (`.replacing-head`): the
  words "Sending replaces this message and its replies.", one size down in the full foreground, since they say what
  Send will do, plus Retry's warning about the files and commands not reverted when it applies, then Cancel at the
  right, wrapping when narrow. The entries are dimmed like those no longer sent (`--bc-unsent-opacity`), the line and
  Cancel are not, and Edit goes while the mark shows. Not a modal: Send is the consent.
- Undo changes' outcome: the last undo's outcome sits under the reply it undid (`.undo-outcome`), in
  words, one line per file with its path, status, and reason, each path (and a temporary file left behind) in the
  editor font (`.undo-path`) and the rest in the UI font: a notice ("Changes undone.") when every file is back, a
  warning block when some or all were skipped ("Some changes were not undone. …", "No change was undone. …"), since
  those files stay changed until the next click, and an error block (`.undo-outcome.failed`: the error fill, edge, and
  text) when the undo failed unexpectedly, its cause in the editor font, then the files put back before it. The
  outcome comes before the button, so the button stays last.
- Changed files: under the last reply of the turn whose writes are held, exactly when "Undo changes" shows, before the
  undo's outcome and the actions row, always open, no fold (`.changed-files`). A small dim head, "Changed files", then
  one row per file, in the order of its first write: each row a full-width button with no box (`button.changed-file`),
  its path in the editor font (`.changed-path`), "created" or "edited" in dim text (`.changed-kind`), and the counts
  `+2 −1` at the right in the editor font, dim, with tabular figures (`.changed-counts`), the change in signs and
  numbers, never in color. A row takes the list's hover fill (`--bc-row-hover`, `--bc-edge-active` in high contrast)
  and the focus ring inside its edge; a click opens the file's diff in the editor and moves no focus in the panel.
- No longer sent: the entries before the summary the history starts at sit in one group (`.unsent`), each at 60%
  opacity (`--bc-unsent-opacity`), under one small dim line that says so in words ("Earlier messages are no longer
  sent to the model: the summary below replaces them."), so the state never rests on the dimming alone. A
  high-contrast theme sets the token to 1: faded text would fall under the theme's contrast, and the line already says
  it. After an automatic summary, the turn's message its request quotes stays in the group at full opacity
  (`.still-sent`), followed by its own small dim line, "Still sent with the summary".

### The decision block

The call that waits for the user and its controls share one block drawn in negative (`.decision`): the foreground
as its ground, the panel's color as its text. It is the one element of the conversation that asks for attention,
and the thread ends on its solid 9px node. "Waiting for your decision" is in weight 600, and the row wraps so the
path or command is never cut. Under it: the reason field, in the theme's input colors, then Accept or Run and
Reject. On this block Accept or Run is the panel's own ground with the foreground as text, weight 600, since the
theme's button color is not chosen for this ground and a high-contrast theme gives it no fill; Reject is outlined in
the panel's color. A focus ring on its buttons is the panel's color.

### Menus and History

- The `@` and `/` menus overlay the conversation above the message box. The highlighted row takes the theme's active
  selection, or `--bc-fill-strong` where the theme has none, and `--bc-edge-active` in high contrast.
- History: the search field ("Search conversations") on top, at full width, then one row per conversation, title over
  date, Delete at the right. A row found by its messages only carries its excerpt between title and date: one line,
  dim, one size down, cut with an ellipsis, plain text without a highlight. Only the rows scroll; the field stays in
  place. The current row has a fill, a title in weight 600, and `--bc-edge-active` in high contrast. With no
  conversation saved, History shows its empty line and no field; with no row left, "No match" as one dim centered
  line under the field, or "Searching…" in its place, in the Loading look, while a content search is awaited. The
  count of conversations that could not be searched is a warning block between the field and the rows.

### States

Each kind of state has one look, distinct from the others at a glance:

| State | Look |
| --- | --- |
| Loading (waiting for the reply, thinking, tool running, models loading, History's "Searching…") | Dim text that breathes; a line of its own leads with a dot. The pickers and the mode selector are disabled. While a mode change is being written, the mode selector and Send are disabled, with no other sign: the write takes a moment. While an undo runs, its button reads "Undoing changes…" and is disabled, and so is Send. |
| Empty (no provider, new conversation, empty History, no History row left by the search) | One dim line, centered in the room it has; a link under it when there is something to do. No provider: Add provider (primary) and the Open provider settings link side by side under it. |
| Notice (unknown context size, older tool results left out of the next request, the queue paused or full, an undo that put every file back) | One small dim line, with a link when there is something to do (Set context size). Nothing went wrong, so no block. |
| Warning (skipped providers and skills, an undo that skipped files, conversations History could not search) | A block on the theme's warning fill; under skipped providers, Add provider (secondary) below the block, only while a valid provider exists: without one, the empty state's Add provider is the panel's only one. |
| Error (models unavailable, failed reply, storage and listing problems, an undo that failed unexpectedly) | A block on the theme's error fill: the message, its technical detail in the editor font, then its actions. |
| Failed step or chip | The error color on the status text; no block. |
| Waiting for a decision | The decision block, in negative, on the thread's solid node. |
| Turn ending (Stopped, halted) | A short rule, then small dim text. |
| Folded turn (an ended turn of two steps or more) | One small dim row on a double-ring node: what the steps did ("Read 3 files, edited 1 file, ran 1 command"), "N steps" for a fold of other steps only, then the failed and rejected counts in words, then the chevron; it wraps, never cut. |
| Replacing (Edit on the last message) | The last turn dimmed as a group under one line in the full foreground saying that sending replaces it, with Cancel; not dimmed in high contrast. |
| Summarized (a summary, and the entries it replaces) | A separator of dim words between two rules above the summary; the entries before it dimmed as a group under one dim line saying they are no longer sent (not dimmed in high contrast); the turn's message an automatic summary quotes undimmed, with a dim line saying it is still sent. |

### Motion

Small, and never needed to understand a state: the breathing of a loading text (opacity, 1.6s), the turn of a
chevron and the color change of a button (0.12s, ease-out). Two tokens carry it: `--bc-breathe`, the animation's name, and `--bc-fast`,
the duration of a transition. The reveal of controls shown on hover or focus (a code block's header) fades their
opacity over `--bc-fast`. Under `prefers-reduced-motion: reduce`, and when VS Code sets `vscode-reduce-motion` on
`body`, they become `none` and `0s`, so new motion that reads them stops there too.

### Keyboard and focus

- Every control is a native element in the tab order; the DOM order is the visual order.
- A control revealed on hover is also revealed while the focus is inside its block (`:focus-within`), and hides with
  `opacity` only, never `visibility` or `display`, so it stays in the tab order, and its room stays reserved, so the
  reveal moves nothing. On a device without hover it always shows. A code block's Copy and Insert at cursor follow
  this rule, and neither moves the focus when clicked.
- One focus ring: `1px solid var(--vscode-focusBorder)`. It sits inside a field or a row (offset -1px), which fill
  their line, and outside a button (offset 2px), where a ring on the button's own fill would not show. The message
  box shows it on the border of its rounded field.
- A folded turn's row is a native `<summary>`: Tab reaches it, Enter and Space open and close it, with no key handler
  of ours. Folding at turn end moves no focus.
- Focus never moves on its own. When an approval request opens, the focused element stays focused, so a key pressed
  at that moment cannot accept a write or run a command. A webview test pins this. Written exceptions: opening
  History moves the focus into its search field, since the user asked for History and no approval control sits
  there. Escape in an empty search field closes History and gives the focus back to the History button. And a draft
  from the editor ("Add selection to chat", the quick fix "Fix with broke-code") closes History and moves the focus
  into the message box, since the user asked for it from the editor and the message box sends nothing on its own. The
  workbench may focus the panel just after the draft did, leaving nothing focused inside it; until the user clicks or
  presses a key in the panel, the message box takes that focus back. Edit on a queued message moves the focus
  into the message box, where its text comes back, since the user asked to edit it and the row they clicked goes.
  Edit on the last message moves the focus into the message box, where its text lands, since the user asked to edit
  there; the mention menu stays closed when the caret lands on a mention. Cancel on Retry's confirmation gives the
  focus back to Retry, since the button it was on goes; the confirmation itself renames the button the focus is on and
  moves nothing. Last, Cancel on Edit's mark gives the focus back to Edit, for the same reason. Quote moves the focus
  into the message box, caret at the end, since the user asked for it and the message box sends nothing on its own;
  when the Quote button goes while it holds the focus, no focus is moved.
  Queuing a message moves no focus, and neither do the queued texts that come back to the box after New chat, an
  open, or a delete, or that the queue could not take: the request came from the panel, which already has the focus
  where the user put it, and History stays open. Such a text that arrives while the panel has no message box (no
  provider) waits and lands in the box when it comes back; an editor draft is dropped instead.
- From the message box, Shift+Tab reaches Reject, then Accept or Run, then the reason field: the reason field comes
  first in the DOM, then Accept or Run, then Reject, and nothing focusable may be added between them and the message
  box. The mode selector therefore comes after the message box: Tab from the message box reaches it, then Send, then
  Stop while a reply is in flight, then the queued messages' controls, which sit under the box for the same reason. A
  webview test pins this order, with and without a queue.
- The `@` and `/` menus keep the focus in the message box (`aria-activedescendant`); the highlighted row is the
  visible focus there, so it must differ from its neighbours in every theme.
- The message box takes the focus back when a reply ends, unless History is open: the focus then stays where the user
  has it, so a key meant for the History search never edits or sends the message.

## Do's and Don'ts

### Do

- Take every color from a `--vscode-*` variable, through a token, and prefer the variable that names the job.
- Give every new filled surface `--bc-edge`, every new selected row `--bc-edge-active`, every drawn line `--bc-line`.
- Read `--vscode-*` variables in the token layer only, under a role name.
- Use the editor font only for what is code.
- Keep one primary button per region.
- Look at a change in Default Light Modern, Default Dark Modern, and Default High Contrast before calling it done.

### Don't

- Don't write a literal color, an inline `style`, or a rule that depends on a theme's name. The two exceptions read
  `body.vscode-high-contrast`: the dim text strength and the status-colored alert text.
- Don't mark a state with color alone, or with a colored side stripe. The thread is a 1px neutral line, not a
  stripe on a block.
- Don't put the button colors on anything but a primary button and the latest user message.
- Don't add an icon font, a component kit, or Unicode glyphs as icons; draw the mark in CSS.
- Don't move the focus from code when the conversation changes.
- Don't let content set the panel's width.
