/**
 * @module markdownCode
 * Where a message holds Markdown code, which never holds mentions or body tool calls. No `node:` or `vscode` import,
 * since the webview bundle loads it.
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
  const { masked, blockStarts } = maskFences(text);
  return maskCodeSpans(masked, blockStarts);
}

/** `text` with each fenced block masked whole. `blockStarts`: where each block's opening line starts, in order. */
function maskFences(text: string): { masked: string; blockStarts: number[] } {
  let fence: { char: string; length: number } | undefined;
  const blockStarts: number[] = [];
  let lineStart = 0;
  const masked = text
    .split("\n")
    .map((line) => {
      const start = lineStart;
      lineStart += line.length + 1;
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (!fence) {
        if (!marker) return line;
        fence = { char: marker[0]!, length: marker.length };
        blockStarts.push(start);
      } else if (marker?.[0] === fence.char && marker.length >= fence.length && line.trim() === marker) {
        fence = undefined;
      }
      return MASK.repeat(line.length);
    })
    .join("\n");
  return { masked, blockStarts };
}

/**
 * A run of N backticks opens a span closed by the next run of exactly N in the same paragraph (no blank line or
 * fenced block between, as a fenced block ends the paragraph in CommonMark); an unmatched run is literal. A backslash escapes the first backtick of an opening run, but not a closing
 * one, as in CommonMark. [>]: Each lookup moves forward only, so a message full of spans stays linear.
 */
function maskCodeSpans(text: string, blockStarts: readonly number[]): string {
  const runs = [...text.matchAll(/`+/g)].map((run) => ({ index: run.index, length: run[0].length }));
  const paragraphs = paragraphOf(text, runs, blockStarts);
  const runsByLength = new Map<number, { runs: number[]; next: number }>();
  runs.forEach((run, index) => {
    const entry = runsByLength.get(run.length) ?? { runs: [], next: 0 };
    entry.runs.push(index);
    runsByLength.set(run.length, entry);
  });
  let masked = "";
  let copied = 0;
  for (let open = 0; open < runs.length; open++) {
    const escaped = backslashesBefore(text, runs[open]!.index) % 2 === 1;
    const start = runs[open]!.index + (escaped ? 1 : 0);
    const length = runs[open]!.length - (escaped ? 1 : 0);
    if (length === 0) continue;
    const close = nextRunOfLength(runsByLength, length, open);
    if (close === -1 || paragraphs[close] !== paragraphs[open]) continue;
    const end = runs[close]!.index + length;
    masked += text.slice(copied, start) + text.slice(start, end).replace(/[^\n]/g, MASK);
    copied = end;
    open = close;
  }
  return masked + text.slice(copied);
}

/**
 * For each run, how many paragraph breaks (blank lines and fenced blocks) stand before it: runs with the same count
 * share a paragraph. A fenced block counts at its start, since its masked text holds no run.
 */
function paragraphOf(text: string, runs: readonly { index: number }[], blockStarts: readonly number[]): number[] {
  const blankLines = [...text.matchAll(/\n[ \t\r]*\n/g)].map((match) => match.index);
  const breaks = [...blankLines, ...blockStarts].sort((a, b) => a - b);
  let before = 0;
  return runs.map((run) => {
    while (before < breaks.length && breaks[before]! < run.index) before++;
    return before;
  });
}

/** The first run after `open` that is exactly `length` backticks long, or -1. `open` only grows between calls. */
function nextRunOfLength(runsByLength: Map<number, { runs: number[]; next: number }>, length: number, open: number) {
  const entry = runsByLength.get(length);
  if (entry === undefined) return -1;
  while (entry.next < entry.runs.length && entry.runs[entry.next]! <= open) entry.next++;
  return entry.runs[entry.next] ?? -1;
}

function backslashesBefore(text: string, index: number): number {
  let count = 0;
  while (text.charAt(index - 1 - count) === "\\") count++;
  return count;
}

/**
 * True when a code block the Markdown renderer drew can no longer grow as its reply streams: a fenced block whose
 * closing fence was written, or a block (fenced or indented) that rendered text follows, since the parser closed it.
 * `source`: the Markdown rendered. `start`, `end`: the block's offsets there (react-markdown's `node.position`), the
 * opening fence or the indent first.
 * [>]: An unclosed fence renders like a closed one, so closure is read from the source: the block's last line, less
 * the container prefixes its opening line had (blockquote markers, then a list item's indent), must be a closing
 * fence. Text after the block counts only past whitespace and `>`, since a stream may end on a container prefix.
 */
export function isCodeBlockClosed(source: string, start: number, end: number): boolean {
  if (/[^\s>]/.test(source.slice(end))) return true;
  const lines = source.slice(start, end).split(/\r\n|\r|\n/);
  const opening = /^(`{3,}|~{3,})/.exec(lines[0] ?? "")?.[1];
  if (!opening || lines.length < 2) return false;
  const lineStart = Math.max(source.lastIndexOf("\n", start - 1), source.lastIndexOf("\r", start - 1)) + 1;
  const prefix = source.slice(lineStart, start);
  const quotes = prefix.split(">").length - 1;
  const indent = stripQuotes(prefix, quotes).length;
  const last = stripQuotes(lines.at(-1)!, quotes);
  const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(last.replace(new RegExp(`^ {0,${indent}}`), ""))?.[1];
  return fence !== undefined && fence[0] === opening[0] && fence.length >= opening.length;
}

/** `line` less its first `count` blockquote markers, each with up to 3 spaces before it and one space after. */
function stripQuotes(line: string, count: number): string {
  let rest = line;
  for (let marker = 0; marker < count; marker++) rest = rest.replace(/^ {0,3}> ?/, "");
  return rest;
}

/** A code block's text as the user takes it: its rendered code less the final line break. */
export function codeBlockText(code: string): string {
  return code.endsWith("\n") ? code.slice(0, -1) : code;
}
