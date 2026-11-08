/**
 * @module markdownCode
 * Where a message holds Markdown code, which never holds mentions. No `node:` or `vscode` import, since the webview
 * bundle loads it.
 */

/** Stands in for code characters; not whitespace, so a token cannot start right after masked code. */
export const MASK = "\0";

/** `text` with fenced blocks and inline code spans masked, lengths and newlines kept. */
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

/** A run of N backticks opens a span closed by the next run of exactly N; an unmatched run is literal. */
function maskCodeSpans(text: string): string {
  const runs = [...text.matchAll(/`+/g)];
  let masked = text;
  for (let open = 0; open < runs.length; open++) {
    const length = runs[open]![0].length;
    const close = runs.findIndex((run, index) => index > open && run[0].length === length);
    if (close === -1) continue;
    const start = runs[open]!.index;
    const end = runs[close]!.index + length;
    masked = masked.slice(0, start) + masked.slice(start, end).replace(/[^\n]/g, MASK) + masked.slice(end);
    open = close;
  }
  return masked;
}
