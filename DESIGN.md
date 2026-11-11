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
  "5": 16px
  "6": 24px
---

# Design System: broke-code chat panel

## Overview

The chat panel is a tool people work in all day, in the VS Code side bar, beside their code. It follows
[twinny](https://github.com/twinnydotdev/twinny)'s minimal look: the user's message is a soft filled block, the reply
runs flush on the panel, whitespace separates the turns, and greys do most of the work. It must look native in any
VS Code theme, so it owns no color: every color comes from the active theme.

The stylesheet has two layers. The token layer (`--bc-*` custom properties on `:root`) comes first; every rule after
it reads tokens, or a `--vscode-*` variable that names the exact job (a button's background, an input's border). A
new screen follows the same order: pick tokens first, add a token only when no existing one says what you mean.

Constraints that shape everything here:

- The webview's Content Security Policy allows the bundled stylesheet only. An inline `style` attribute does nothing;
  all styling goes through classes.
- No icon font, no component kit, no Tailwind. Marks (chevron, dot, file and folder markers, the rule before a turn
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

### Theme colors used for their own job

- Primary button: `--vscode-button-background`, `-foreground`, `-hoverBackground`, `-border`.
- Fields: `--vscode-input-*` and `--vscode-dropdown-*`.
- Menus: `--vscode-quickInput-*`, `--vscode-list-hoverBackground`, `--vscode-list-activeSelection*`,
  `--vscode-widget-shadow`.
- Links: `--vscode-textLink-foreground` and `-activeForeground`. Links stay underlined, so color is never the only cue.
- Status: `--vscode-errorForeground`, `--vscode-editorWarning-foreground`, and the fills and borders of
  `--vscode-inputValidation-error*` and `-warning*`.
- Focus: `--vscode-focusBorder`, for the focus ring only.

### The high-contrast rule

Surfaces are set apart by a fill, never by a line drawn around them. A high-contrast theme flattens those fills: its
button, input, selection, code block, and validation backgrounds equal the panel or have no value. Only a
high-contrast theme defines `--vscode-contrastBorder` and `--vscode-contrastActiveBorder`. So:

- `--bc-edge` is `var(--vscode-contrastBorder, transparent)`. Every filled surface carries
  `border: 1px solid var(--bc-edge)`: invisible in light and dark themes, a visible boundary in high contrast. This
  covers the user's message, code blocks, command blocks, chips, buttons, and the warning and error blocks.
- `--bc-edge-active` is `var(--vscode-contrastActiveBorder, transparent)`. The highlighted menu row and the current
  History row carry it as a solid outline; a hovered row, as a dashed one.
- `--bc-line` is `var(--vscode-contrastBorder, var(--bc-rule))`: a line that is drawn in every theme (a secondary
  button, the decision block, a rule) becomes the contrast border in high contrast.
- In high contrast an error and a warning block share the same border and no fill, so their text takes the status
  color (`--bc-error-text`, `--bc-warning-text`); elsewhere the fill says it and the text stays the foreground.

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

- Spacing comes from the `--bc-space-*` scale (2, 4, 8, 12, 16, 24). Tight inside a group, wider between groups.
- Whitespace separates turns: 12px between entries, 8px more above a user's message; the replies and tool steps of
  one turn sit 4px apart.
- Long content never widens the panel: a path or a title on one line is cut with an ellipsis; a message, a command,
  and a chip wrap anywhere; a code block, a step result, and a table scroll inside themselves.
- The header wraps: the two pickers share the first line; the usage and the buttons drop below once the pickers
  would fall under 16em.
- The conversation keeps 4px of side padding inside its scroll box, so a focus ring on a row at its edge is not
  clipped.

## Elevation & Depth

Flat. Depth comes from fills, not shadows. The one shadow belongs to the `@` and `/` menus, which overlay the
conversation: `0 4px 12px var(--vscode-widget-shadow)`.

## Shapes

Three radii: 4px for controls and small tokens (buttons, fields, chips, inline code, menu rows), 6px for blocks (code
blocks, alerts, the decision block, the menu, History rows), 10px for the two large blocks (the message box, a
user's message). Borders and rules are 1px. No colored side stripe.

## Components

### Buttons

- Primary (Send, Stop, Accept, Run, Set API key): the theme's button colors. At most one per region; in the
  conversation, only the decision block has one.
- Secondary (New chat, History, Delete, Reject, Retry): a hairline box on the panel (`--bc-line`), the foreground as
  text; `--bc-fill-strong` when hovered or pressed (`aria-expanded="true"`).
- Link (Open provider settings, Set context size): the link color, underlined.
- Disabled: half opacity. Header and History buttons are one size down.

### Fields

Inputs and selects use the theme's input and dropdown colors, a 1px border, radius 4px. The message box and its
button share one large rounded field (radius 10px); its border takes the focus color while the text area has focus.

### The conversation

- User message: `--bc-fill`, radius 10px, full width. Its chips sit under the text: a path in the editor font on
  `--bc-fill-strong`, then its status in dim text; a failed chip is drawn in the error color.
- Reply: Markdown flush on the panel, inside `.answer`, the only place the Markdown rules apply.
- Reasoning: a small dim row with a chevron; opened, its text sits behind a 1px rule.
- Tool step: one small dim line: chevron, tool name, main argument, status at the right. It opens to its result in a
  code block. A command shows whole in a block under its line. A failed status is in the error color.
- A call without a result has a dot where the chevron would be: filled and breathing while it runs, hollow when it
  ended with no result.

### The decision block

The call that waits for the user and its controls share one filled, outlined block (`.decision`): the one element
of the conversation that asks for attention. Its row is in the full foreground with a solid dot, "waiting for your
decision" in weight 600, and it wraps so the path or command is never cut. Under it: the reason field, then Accept
or Run (primary) and Reject (secondary).

### Menus and History

- The `@` and `/` menus overlay the conversation above the message box. The highlighted row takes the theme's active
  selection, or `--bc-fill-strong` where the theme has none, and `--bc-edge-active` in high contrast.
- History: one row per conversation, title over date, Delete at the right. The current row has a fill, a title in
  weight 600, and `--bc-edge-active` in high contrast.

### States

Each kind of state has one look, distinct from the others at a glance:

| State | Look |
| --- | --- |
| Loading (waiting for the reply, thinking, tool running, models loading) | Dim text that breathes; a line of its own leads with a dot. The pickers are disabled. |
| Empty (no provider, new conversation, empty History) | One dim line, centered in the room it has; a link under it when there is something to do. |
| Notice (unknown context size) | One small dim line with a link. Nothing went wrong, so no block. |
| Warning (skipped providers and skills) | A block on the theme's warning fill. |
| Error (models unavailable, failed reply, storage and listing problems) | A block on the theme's error fill: the message, its technical detail in the editor font, then its actions. |
| Failed step or chip | The error color on the status text; no block. |
| Waiting for a decision | The decision block. |
| Turn ending (Stopped, halted) | A short rule, then small dim text. |

### Motion

Small, and never needed to understand a state: the breathing of a loading text (opacity, 1.6s), the turn of a
chevron and the color change of a button (0.12s, ease-out). Two tokens carry it: `--bc-breathe`, the animation's name, and `--bc-fast`,
the duration of a transition. Under `prefers-reduced-motion: reduce`, and when VS Code sets `vscode-reduce-motion` on
`body`, they become `none` and `0s`, so new motion that reads them stops there too.

### Keyboard and focus

- Every control is a native element in the tab order; the DOM order is the visual order.
- One focus ring: `1px solid var(--vscode-focusBorder)`. It sits inside a field or a row (offset -1px), which fill
  their line, and outside a button (offset 2px), where a ring on the button's own fill would not show. The message
  box shows it on the border of its rounded field.
- Focus never moves on its own. When an approval request opens, the focused element stays focused, so a key pressed
  at that moment cannot accept a write or run a command. A webview test pins this.
- From the message box, Shift+Tab reaches Reject, then Accept or Run, then the reason field: the reason field comes
  first in the DOM, then Accept or Run, then Reject, and nothing focusable may be added between them and the message
  box.
- The `@` and `/` menus keep the focus in the message box (`aria-activedescendant`); the highlighted row is the
  visible focus there, so it must differ from its neighbours in every theme.
- The message box takes the focus back when a reply ends.

## Do's and Don'ts

### Do

- Take every color from a `--vscode-*` variable, and prefer the variable that names the job.
- Give every new filled surface `--bc-edge`, every new selected row `--bc-edge-active`, every drawn line `--bc-line`.
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
