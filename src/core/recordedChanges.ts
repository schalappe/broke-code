/**
 * @module recordedChanges
 * The file changes an applier wrote, recorded per file, and their restore: each file back to its text before its first
 * recorded write, or removed when the writes created it, file by file, through the checks of the atomic write. Opt-in:
 * only an applier wrapped in `recordingApplier` records, so the eval bench's `fileApplier` runs record nothing.
 */
import {
  type RemoveOutcome,
  removeWorkspaceFile,
  resolveWorkspaceRoots,
  type WorkspaceRoot,
  type WriteFailure,
  type WriteOutcome,
  writeWorkspaceFile,
} from "./workspaceFiles";
import type { ChangeApplier, WriteApprovalHost } from "./writeTools";

/**
 * One file the recorded writes changed. `path`: as the model wrote it at the first write, for messages. `realPath`: its
 * folder's real path plus its name, the key, so two spellings of one file are one entry. `original`: its text before
 * the first recorded write, `undefined` when that write created it. `written`: the text the last recorded write left.
 */
export type RecordedFile = { path: string; realPath: string; original: string | undefined; written: string };

/**
 * Why a file was not restored; nothing of it was touched. `changed`: it holds neither the text the writes left nor its
 * original text (edited since, removed, made a folder, or no longer text). `unsaved`: an editor holds unsaved changes
 * to it. `symlink`: it is now a symbolic link. `outsideWorkspace`: it is in no workspace folder now, or its path leads
 * out of them. `failed`: the write or the removal failed on disk, or the file could not be read (`cause`).
 */
export type RestoreRefusal = "changed" | "unsaved" | "symlink" | "outsideWorkspace" | "failed";

/**
 * What restoring one file did. `restored`: it holds its original text again, now or already. `removed`: the writes
 * created it, and it is gone, now or already. `skipped`: see `RestoreRefusal`; it stays in the set. `leftover`: the
 * temporary file of the restoring write could not be removed (`cause`); it sits beside the file as `name`.
 */
export type RestoreOutcome = { path: string; realPath: string; leftover?: { name: string; cause: string } } & (
  | { status: "restored" }
  | { status: "removed" }
  | { status: "skipped"; reason: Exclude<RestoreRefusal, "failed"> }
  | { status: "skipped"; reason: "failed"; cause: string }
);

/**
 * The files a set of writes changed, one entry per file, in the order of their first write. `onRecord`: called after
 * each write is recorded with the file it changed, such as to hold the set once it has a file, or to tie the write's
 * step to that file.
 */
export class RecordedChanges {
  private readonly byPath = new Map<string, RecordedFile>();

  constructor(private readonly onRecord: (file: RecordedFile) => void = () => {}) {}

  /** Whether the file at `realPath` is in the set: recorded, and not restored since. */
  has(realPath: string): boolean {
    return this.byPath.has(realPath);
  }

  /** The recorded files, in the order of their first write. */
  get files(): RecordedFile[] {
    return [...this.byPath.values()];
  }

  /** Record that `after` was written to the file at `realPath`, which held `before` (`undefined`: did not exist). */
  record(path: string, realPath: string, before: string | undefined, after: string): void {
    const known = this.byPath.get(realPath);
    // [>]: A new object each time, so a restore running meanwhile sees that the entry it handled moved on.
    const original = known === undefined ? before : known.original;
    const file = { path: known?.path ?? path, realPath, original, written: after };
    this.byPath.set(realPath, file);
    this.onRecord(file);
  }

  /**
   * Restore each recorded file on its own, in order, inside `roots` as they are now: a file that still holds the text
   * the writes left gets its original text back through the atomic write (`writeWorkspaceFile`), or is removed with
   * the same checks (`removeWorkspaceFile`) when the writes created it; folders made for it stay. A file already back
   * counts as restored or removed. A file `host` reports unsaved in an editor, or any other refusal, is skipped
   * untouched (see `RestoreRefusal`). Restored and removed files leave the set; skipped ones stay, so a second run
   * retries only them. Each file holds its old text or the written one, never a mix, so running twice or after a crash
   * halfway is safe. Never rejects while `host` does not.
   */
  async restore(roots: WorkspaceRoot[], host: Pick<WriteApprovalHost, "hasUnsavedChanges">): Promise<RestoreOutcome[]> {
    // [>]: Real roots, so a recorded real path is inside them as written; a root that no longer resolves holds nothing.
    const realRoots = (await resolveWorkspaceRoots(roots)).resolved.map(({ root, realRoot }) => ({
      name: root.name,
      path: realRoot,
    }));
    const outcomes: RestoreOutcome[] = [];
    for (const file of this.files) {
      const outcome = await restoreFile(realRoots, file, host);
      // [>]: Only the entry handled: a write recorded meanwhile replaced it and is left for the next run.
      if (outcome.status !== "skipped" && this.byPath.get(file.realPath) === file) this.byPath.delete(file.realPath);
      outcomes.push(outcome);
    }
    return outcomes;
  }
}

async function restoreFile(
  realRoots: WorkspaceRoot[],
  file: RecordedFile,
  host: Pick<WriteApprovalHost, "hasUnsavedChanges">,
): Promise<RestoreOutcome> {
  const { path, realPath } = file;
  if (await host.hasUnsavedChanges(realPath)) return { path, realPath, status: "skipped", reason: "unsaved" };
  if (file.original === undefined) {
    return { path, realPath, ...removeResult(await removeWorkspaceFile(realRoots, realPath, file.written)) };
  }
  const written = await writeWorkspaceFile(realRoots, realPath, file.written, file.original);
  const leftover = written.leftover === undefined ? {} : { leftover: written.leftover };
  return { path, realPath, ...leftover, ...writeResult(written) };
}

/** A `RestoreOutcome` without the file it names. */
type FileResult = RestoreOutcome extends infer T ? (T extends unknown ? Omit<T, "path" | "realPath"> : never) : never;

function removeResult(outcome: RemoveOutcome): FileResult {
  switch (outcome.status) {
    case "removed":
    case "alreadyRemoved":
      return { status: "removed" };
    case "notRemoved":
      return { status: "skipped", reason: "failed", cause: outcome.cause };
    default:
      return refusal(outcome.status, "cause" in outcome ? outcome.cause : undefined);
  }
}

function writeResult(outcome: WriteOutcome): FileResult {
  switch (outcome.status) {
    case "written":
    case "alreadyWritten":
      return { status: "restored" };
    case "notWritten":
      return { status: "skipped", reason: "failed", cause: outcome.cause };
    case "unwritable":
      // [>]: Cannot happen for a text read back from the file; kept as a failure rather than assumed away.
      return { status: "skipped", reason: "failed", cause: `the original text is ${outcome.reason}` };
    default:
      return refusal(outcome.status, "cause" in outcome ? outcome.cause : undefined);
  }
}

/** A refusal of the write boundary's check, as a restore's reason. */
function refusal(status: WriteFailure | "changed", cause: string | undefined): FileResult {
  switch (status) {
    case "symlink":
    case "outsideWorkspace":
      return { status: "skipped", reason: status };
    case "unreadable":
      return { status: "skipped", reason: "failed", cause: cause ?? "unreadable" };
    default:
      // [>]: `changed`, `missing`, `folder`, `binary`, `tooLarge`, `notText`: the file holds something else now.
      return { status: "skipped", reason: "changed" };
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
