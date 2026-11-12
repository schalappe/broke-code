/**
 * @module recordedChanges
 * The file changes an applier wrote, recorded per file, and their restore: each file back to its text before its first
 * recorded write, or removed when the writes created it, file by file, through the checks of the atomic write. Opt-in:
 * only an applier wrapped in `recordingApplier` records, so the eval bench's `fileApplier` runs record nothing.
 */
import type { ChangeApplier } from "./writeTools";

/**
 * One file the recorded writes changed. `path`: as the model wrote it at the first write, for messages. `realPath`: its
 * folder's real path plus its name, the key, so two spellings of one file are one entry. `original`: its text before
 * the first recorded write, `undefined` when that write created it. `written`: the text the last recorded write left.
 */
export type RecordedFile = { path: string; realPath: string; original: string | undefined; written: string };

/** The files a set of writes changed, one entry per file, in the order of their first write. */
export class RecordedChanges {
  private readonly byPath = new Map<string, RecordedFile>();

  /** The recorded files, in the order of their first write. */
  get files(): RecordedFile[] {
    return [...this.byPath.values()];
  }

  /** Record that `after` was written to the file at `realPath`, which held `before` (`undefined`: did not exist). */
  record(path: string, realPath: string, before: string | undefined, after: string): void {
    const known = this.byPath.get(realPath);
    // [>]: A new object each time, so a restore running meanwhile sees that the entry it handled moved on.
    this.byPath.set(realPath, {
      path: known?.path ?? path,
      realPath,
      original: known ? known.original : before,
      written: after,
    });
  }
}

/** `apply`, recording into `changes` each change it reports `written`; its result is passed on unchanged. */
export function recordingApplier(apply: ChangeApplier, changes: RecordedChanges): ChangeApplier {
  return async (change) => {
    const result = await apply(change);
    if (result.written !== undefined) changes.record(change.path, result.written.realPath, change.before, change.after);
    return result;
  };
}
