/**
 * @module fileIndex
 * Workspace files and folders offered by the mention menu. Scanned on the first query, shared by the queries that
 * follow, dropped when a file outside the excluded folders is created or deleted, scanned again on the next query.
 * The host supplies the scan (`findFiles`) and forwards the watcher events.
 */
import {
  filterSuggestions,
  indexEntries,
  isExcludedFromIndex,
  MAX_INDEXED_FILES,
  MAX_SUGGESTIONS,
  type Suggestion,
} from "./suggestions";

/**
 * Search of the workspace files, stopping at `limit` results. `found`: results returned, local or not, so reaching
 * `limit` means the search stopped early. `local`: relative `/`-separated paths of those on disk.
 * `rootNames`: the workspace folder names starting those paths, in a multi-root workspace only.
 */
export type FileScan = (limit: number) => Promise<{ local: string[]; found: number; rootNames?: string[] }>;

/** Answer to a menu query. `capped`: the scan stopped at `MAX_INDEXED_FILES`, so matches may be missing. */
export type FileQueryAnswer = { items: Suggestion[]; capped: boolean };

type Snapshot = { entries: Suggestion[]; capped: boolean };

export class FileIndex {
  /** Scan in flight or done; `undefined` when stale. Concurrent queries share it. */
  private build: Promise<Snapshot> | undefined;

  constructor(private readonly scan: FileScan) {}

  /** Entries matching `query`, at most `MAX_SUGGESTIONS`. Rejects when the scan fails; the next query scans again. */
  async query(query: string): Promise<FileQueryAnswer> {
    this.build ??= this.snapshot();
    const build = this.build;
    try {
      const { entries, capped } = await build;
      return { items: filterSuggestions(entries, query, MAX_SUGGESTIONS), capped };
    } catch (error) {
      // [>]: A failed scan must not stick, but must not drop a newer scan already in flight either.
      if (this.build === build) this.build = undefined;
      throw error;
    }
  }

  /** A file at `relativePath` was created or deleted. One inside an excluded folder changes nothing offered. */
  fileChanged(relativePath: string): void {
    if (!isExcludedFromIndex(relativePath)) this.build = undefined;
  }

  /** Anything may have changed, such as the workspace folders. */
  invalidate(): void {
    this.build = undefined;
  }

  private async snapshot(): Promise<Snapshot> {
    const { local, found, rootNames } = await this.scan(MAX_INDEXED_FILES);
    return { entries: indexEntries(local, rootNames), capped: found >= MAX_INDEXED_FILES };
  }
}
