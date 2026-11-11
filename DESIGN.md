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
[twinny](https://github.com/twinnydotdev/twinny)'s minimal look: the user's message is a soft filled block, the reply
runs flush on the panel, whitespace separates the turns, and greys do most of the work. It must look native in any
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
- No icon font, no component kit, no Tailwind. Marks (chevron, dot, file, folder, and problems markers, the rule before a turn
  ending) are drawn in CSS from borders and backgrounds.
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
| `--bc-fill` | 6% of the foreground | A surface a shade off the panel: the user's message, a code block, the decision block. |
| `--bc-fill-strong` | 11% of the foreground | One step stronger: inline code, chips, a hovered or pressed secondary button. |

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
  covers the user's message, code blocks (the frame of a block with its header included), command blocks, chips,
  buttons, and the warning and error blocks.
- `--bc-edge-active` is `var(--vscode-contrastActiveBorder, transparent)`. The highlighted menu row and the current
  History row carry it as a solid outline; a hovered row, as a dashed one.
- `--bc-line` is `var(--vscode-contrastBorder, var(--bc-rule))`: a line that is drawn in every theme (a secondary
  button, the decision block, a rule) becomes the contrast border in high contrast.
- In high contrast an error and a warning block share the same border and no fill, so their text takes the status
  color (`--bc-error-text`, `--bc-warning-text`); elsewhere the fill says it and the text stays the foreground.

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
  and focus"); the two size tokens, `--bc-row` (22px, the least height of a one-line row) and `--bc-mark` (6px, a
  dot or a chevron drawn in CSS), with the file and folder markers sized in `em`; and Markdown's vertical rhythm,
  set in `em` so it follows the text size.
- Whitespace separates turns: 12px between entries, 8px more above a user's message; the replies and tool steps of
  one turn sit 4px apart, and so do a folded turn's row and its final reply. Opened, the fold lays its entries out in
  a column of its own with the same spacing, 4px under its row.
- Long content never widens the panel: a path or a title on one line is cut with an ellipsis; a message, a command,
  and a chip wrap anywhere; a code block, a step result, and a table scroll inside themselves.
- The header wraps: the two pickers share the first line; the usage and the buttons drop below once the pickers
  would fall under 16em.
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

- Primary (Send, Stop, Accept, Run, Set API key, Add provider in the empty state): the theme's button colors. At most one per region; in the
  conversation, only the decision block has one.
- Secondary (New chat, History, Delete, Reject, Retry, Add provider under the skipped providers): a hairline box on the panel (`--bc-line`), the foreground as
  text; `--bc-fill-strong` when hovered or pressed (`aria-expanded="true"`).
- Link (Open provider settings, Set context size): the link color, underlined.
- Code block action (Copy, Insert at cursor): a secondary button two pixels down (`--bc-fs-xs`), at least a row high
  (`--bc-row`). Never primary, so the decision block keeps the conversation's one primary button. Copy shows its
  outcome, "Copied" or "Copy failed", in place of its label for about two seconds.
- Disabled: half opacity. Header and History buttons are one size down.

### Fields

Inputs and selects use the theme's input and dropdown colors, a 1px border, radius 4px. The message box, the mode
selector, and Send or Stop share one large rounded field (radius 10px): the text area on its own line, then the
selector at the left and the button at the right. The field's border takes the focus color while the text area has
focus.

The mode selector is a native select one size down (`--bc-fs-sm`), "Ask", "Auto-edit", or "Plan", its tooltip saying
what the mode does. It shows the mode the host holds (Plan from the workspace, the others from the setting): a pick
shows only once the host has applied it, and a failed write leaves it as it was, with the error in a notification. Disabled (half opacity) while a reply is in flight, like the
pickers, and while a mode change is being written, when Send is disabled too (Enter sends nothing).

### The conversation

- User message: `--bc-fill`, radius 10px, full width. Its chips sit under the text: a path in the editor font on
  `--bc-fill-strong`, then its status in dim text; a failed chip is drawn in the error color. A chip that found
  nothing to attach without failing (`@problems` with no error or warning) is neutral: no fill and dim text, its
  edge kept for high contrast, its status in words. Its kind marker is a ring.
- Reply: Markdown flush on the panel, inside `.answer`, the only place the Markdown rules apply.
- Code block of a reply: once its text is final, its frame (`.code-block`: `--bc-fill`, `--bc-edge`, radius 6px)
  holds a header (`.code-actions`) with Copy and Insert at cursor at the right, then the code, which scrolls inside
  itself under the header. A block still growing renders as a bare code block, without the header.
- Reasoning: a small dim row with a chevron; opened, its text sits behind a 1px rule.
- Tool step: one small dim line: chevron, tool name, main argument, status at the right. It opens to its result in a
  code block. A command shows whole in a block under its line. A failed status is in the error color.
- A call without a result has a dot where the chevron would be: filled and breathing while it runs, hollow when it
  ended with no result.
- Folded turn: an ended turn's steps and intermediate replies under one small dim row with the reasoning chevron,
  between the user's message and the final reply: "3 steps, 1 failed, 1 rejected", the counts in words, never in color
  alone. Closed when the turn ends; opened, the entries show exactly as they rendered before. Its rules use the child
  combinator (`.turn-fold > summary`), so the reasoning and step rows inside keep their own chevrons.

### The decision block

The call that waits for the user and its controls share one filled, outlined block (`.decision`): the one element
of the conversation that asks for attention. Its row is in the full foreground with a solid dot, "waiting for your
decision" in weight 600, and it wraps so the path or command is never cut. Under it: the reason field, then Accept
or Run (primary) and Reject (secondary).

### Menus and History

- The `@` and `/` menus overlay the conversation above the message box. The highlighted row takes the theme's active
  selection, or `--bc-fill-strong` where the theme has none, and `--bc-edge-active` in high contrast.
- History: the filter field ("Filter by title") on top, at full width, then one row per conversation, title over
  date, Delete at the right. Only the rows scroll; the field stays in place. The current row has a fill, a title in
  weight 600, and `--bc-edge-active` in high contrast. With no conversation saved, History shows its empty line and
  no field; with no row left by the filter, "No match" as one dim centered line under the field.

### States

Each kind of state has one look, distinct from the others at a glance:

| State | Look |
| --- | --- |
| Loading (waiting for the reply, thinking, tool running, models loading) | Dim text that breathes; a line of its own leads with a dot. The pickers and the mode selector are disabled. While a mode change is being written, the mode selector and Send are disabled, with no other sign: the write takes a moment. |
| Empty (no provider, new conversation, empty History, no History row left by the filter) | One dim line, centered in the room it has; a link under it when there is something to do. No provider: Add provider (primary) and the Open provider settings link side by side under it. |
| Notice (unknown context size, older tool results left out of the next request) | One small dim line, with a link when there is something to do (Set context size). Nothing went wrong, so no block. |
| Warning (skipped providers and skills) | A block on the theme's warning fill; under skipped providers, Add provider (secondary) below the block, only while a valid provider exists: without one, the empty state's Add provider is the panel's only one. |
| Error (models unavailable, failed reply, storage and listing problems) | A block on the theme's error fill: the message, its technical detail in the editor font, then its actions. |
| Failed step or chip | The error color on the status text; no block. |
| Waiting for a decision | The decision block. |
| Turn ending (Stopped, halted) | A short rule, then small dim text. |
| Folded turn (an ended turn of two steps or more) | One small dim row with a chevron, "N steps", then the failed and rejected counts in words. |

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
  at that moment cannot accept a write or run a command. A webview test pins this. One written exception: opening
  History moves the focus into its filter field, since the user asked for History and no approval control sits
  there. Escape in an empty filter field closes History and gives the focus back to the History button.
- From the message box, Shift+Tab reaches Reject, then Accept or Run, then the reason field: the reason field comes
  first in the DOM, then Accept or Run, then Reject, and nothing focusable may be added between them and the message
  box. The mode selector therefore comes after the message box: Tab from the message box reaches it, then Send or
  Stop. A webview test pins this order.
- The `@` and `/` menus keep the focus in the message box (`aria-activedescendant`); the highlighted row is the
  visible focus there, so it must differ from its neighbours in every theme.
- The message box takes the focus back when a reply ends, unless History is open: the focus then stays where the user
  has it, so a key meant for the History filter never edits or sends the message.

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
- Don't mark a state with color alone, or with a colored side stripe.
- Don't add an icon font, a component kit, or Unicode glyphs as icons; draw the mark in CSS.
- Don't move the focus from code when the conversation changes.
- Don't let content set the panel's width.
