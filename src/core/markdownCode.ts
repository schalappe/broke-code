/**
 * @module markdownCode
 * Where a message holds Markdown code, which never holds mentions or body tool calls. No `node:` or `vscode` import, since the webview
 * bundle loads it.
 */

/** Stands in for code characters; not whitespace, so a token cannot start right after masked code. */
export const MASK = "\0";

/** Stands in for a picked `@<path>` token outside code: no whitespace, no backtick, no `@`. */
export const PICKED = "\u0001";

/** A picked path standing as a whole `@<path>` token outside code. `index`: where its `@` is. */
export type PickedMention = { path: string; index: number };

/**
 * `text` with fenced blocks and inline code spans masked, lengths and newlines kept. Each `picked` path (chosen in
 * the menu, so it may hold spaces or backticks) standing as a whole `@<path>` token is set aside first, so its
 * backticks pair with nothing. `masked`: those tokens outside code filled with `PICKED`, so no typed token is read
 * in them, and code masked where either reading, with or without picked paths set aside, finds it. `picked`: those
 * tokens, in no set order.
 */
export function maskMessage(text: string, picked: readonly string[]): { masked: string; picked: PickedMention[] } {
  const found: PickedMention[] = [];
  let placed = text;
  // [>]: Longest first, so a picked `a b.ts` wins over a picked `a` at the same `@`.
  for (const path of picked.filter((path) => path !== "").sort((a, b) => b.length - a.length)) {
    const token = `@${path}`;
    for (let index = placed.indexOf(token); index !== -1; index = placed.indexOf(token, index + token.length)) {
      if (!standsAlone(placed, index, token.length)) continue;
      found.push({ path, index });
      placed = placed.slice(0, index) + PICKED.repeat(token.length) + placed.slice(index + token.length);
    }
  }
  const asidePicked = maskCode(placed);
  // [>]: A backtick in a picked path makes the text read two ways: as typed, its backtick may close real code; set
  // aside, real code may lose its closing backtick. The user chose a picked path, so it follows the set-aside
  // reading; a typed token counts only outside code in both, so text that may be code is never attached.
  const asTyped = maskCode(text);
  const masked = asidePicked
    .split("")
    .map((char, index) => (asTyped[index] === MASK ? MASK : char))
    .join("");
  return { masked, picked: found.filter((mention) => asidePicked.charAt(mention.index) !== MASK) };
}

/**
 * True when the `length` characters at `index` stand as a whole token: after the start or whitespace, then trailing
 * `.,;:!?)` at most before whitespace or the end.
 */
function standsAlone(text: string, index: number, length: number): boolean {
  const before = text.charAt(index - 1);
  return (before === "" || /\s/.test(before)) && /^[.,;:!?)]*(\s|$)/.test(text.slice(index + length));
}

/** `text` with fenced blocks and inline code spans masked with `MASK`, lengths and newlines kept. */
export function maskCode(text: string): string {
  return maskCodeSpans(maskFences(text));
}

function maskFences(text: string): string {
  let fence: { char: string; length: number } | undefined;
  return text
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (!fence) {
        if (!marker) return line;
        fence = { char: marker[0]!, length: marker.length };
      } else if (marker?.[0] === fence.char && marker.length >= fence.length && line.trim() === marker) {
        fence = undefined;
      }
      return MASK.repeat(line.length);
    })
    .join("\n");
}

/**
 * A run of N backticks opens a span closed by the next run of exactly N in the same paragraph (no blank line
 * between); an unmatched run is literal. A backslash escapes the first backtick of an opening run, but not a closing
 * one, as in CommonMark.
 */
function maskCodeSpans(text: string): string {
  const runs = [...text.matchAll(/`+/g)];
  let masked = text;
  for (let open = 0; open < runs.length; open++) {
    const escaped = backslashesBefore(text, runs[open]!.index) % 2 === 1;
    const start = runs[open]!.index + (escaped ? 1 : 0);
    const length = runs[open]![0].length - (escaped ? 1 : 0);
    if (length === 0) continue;
    const blankLine = text.slice(start).search(/\n[ \t\r]*\n/);
    const paragraphEnd = blankLine === -1 ? text.length : start + blankLine;
    const close = runs.findIndex((run, index) => index > open && run.index < paragraphEnd && run[0].length === length);
    if (close === -1) continue;
    const end = runs[close]!.index + length;
    masked = masked.slice(0, start) + masked.slice(start, end).replace(/[^\n]/g, MASK) + masked.slice(end);
    open = close;
  }
  return masked;
}

function backslashesBefore(text: string, index: number): number {
  let count = 0;
  while (text.charAt(index - 1 - count) === "\\") count++;
  return count;
}
