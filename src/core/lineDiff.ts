/**
 * @module lineDiff
 * The added and removed line counts of a change, as "Changed files" shows them: those of a minimal line diff, found
 * with Myers' algorithm within a fixed work limit. No dependency and nothing of `vscode`.
 */

/** Lines a change added and removed. */
export type LineCounts = { added: number; removed: number };

/**
 * Most steps the search for a minimal diff takes: one per diagonal visited and one per line matched along it. Its cost
 * grows with the product of the lines left and the size of the diff, and a read or write may hold 1 MiB, so a million
 * lines a side: unbounded, two such texts would take minutes. 4 million steps run in tens of milliseconds, enough for
 * a minimal diff of up to about 2,800 changed lines whatever the file's size.
 */
export const LINE_DIFF_WORK_LIMIT = 4_000_000;

/**
 * The lines `after` adds to `before` and removes from it (`before` `undefined`: a created file, every line added). A
 * line is the text up to and including its line break, the last one maybe without, compared byte for byte, so a
 * changed line ending or final line break counts as one line removed and one added; an empty text has no line. The
 * counts are those of a minimal line diff while it is found within `LINE_DIFF_WORK_LIMIT`; past it, the lines left
 * after the common first and last lines count as all removed and all added: still a true diff, no longer the smallest.
 */
export function lineDiffCount(before: string | undefined, after: string): LineCounts {
  const old = lines(before ?? "");
  const now = lines(after);
  let start = 0;
  while (start < old.length && start < now.length && old[start] === now[start]) start++;
  let oldEnd = old.length;
  let nowEnd = now.length;
  while (oldEnd > start && nowEnd > start && old[oldEnd - 1] === now[nowEnd - 1]) {
    oldEnd--;
    nowEnd--;
  }
  const n = oldEnd - start;
  const m = nowEnd - start;
  if (n === 0 || m === 0) return { added: m, removed: n };
  const ids = new Map<string, number>();
  const id = (line: string) => {
    let known = ids.get(line);
    if (known === undefined) {
      known = ids.size;
      ids.set(line, known);
    }
    return known;
  };
  const a = Int32Array.from(old.slice(start, oldEnd), id);
  const b = Int32Array.from(now.slice(start, nowEnd), id);
  const distance = editDistance(a, b);
  // [>]: A minimal diff of `distance` edits keeps (n + m - distance) / 2 lines of each side.
  if (distance === undefined) return { added: m, removed: n };
  const kept = (n + m - distance) / 2;
  return { added: m - kept, removed: n - kept };
}

/** `text` cut after each line break, each piece keeping its break; the last piece may have none. */
function lines(text: string): string[] {
  if (text === "") return [];
  const pieces = text.split("\n").map((piece) => `${piece}\n`);
  const last = pieces.at(-1);
  // [>]: The split leaves an empty last piece when the text ends with a break; otherwise the last line has none.
  if (last === "\n") pieces.pop();
  else pieces[pieces.length - 1] = text.slice(text.lastIndexOf("\n") + 1);
  return pieces;
}

/**
 * The number of lines removed plus added by a minimal diff of `a` into `b` (Myers, forward pass only), or `undefined`
 * once the search passes `LINE_DIFF_WORK_LIMIT` steps.
 */
function editDistance(a: Int32Array, b: Int32Array): number | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  // [>]: Visiting level d costs d + 1 steps, so within the limit d stays under sqrt(2 * limit): the array stays small.
  const reach = Math.min(max, Math.ceil(Math.sqrt(2 * LINE_DIFF_WORK_LIMIT)) + 1);
  const offset = reach + 1;
  const v = new Int32Array(2 * reach + 3);
  let work = 0;
  for (let d = 0; d <= reach; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
        work++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return d;
      if (++work > LINE_DIFF_WORK_LIMIT) return undefined;
    }
  }
  return undefined;
}
