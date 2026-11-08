/**
 * @module fileIndex
 * Workspace files and folders offered by the mention menu. Built on the first query, marked stale by a file
 * watcher on create and delete, rebuilt on the next query. Logic lives in `core/suggestions`.
 */
import * as vscode from "vscode";
import {
  filterSuggestions,
  INDEX_EXCLUDE_GLOB,
  indexEntries,
  isExcludedFromIndex,
  MAX_INDEXED_FILES,
  MAX_SUGGESTIONS,
  type Suggestion,
} from "../core/suggestions";

type Snapshot = { entries: Suggestion[]; capped: boolean };

export class FileIndex implements vscode.Disposable {
  /** Build in flight or done; `undefined` when stale. Concurrent queries share it. */
  private build: Promise<Snapshot> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  /** Entries matching `query`, at most `MAX_SUGGESTIONS`. `capped`: the index stopped at `MAX_INDEXED_FILES`. */
  async query(query: string): Promise<{ items: Suggestion[]; capped: boolean }> {
    if (this.disposables.length === 0) this.watch();
    this.build ??= this.scan();
    const build = this.build;
    try {
      const { entries, capped } = await build;
      return { items: filterSuggestions(entries, query, MAX_SUGGESTIONS), capped };
    } catch (error) {
      // [>]: A failed scan must not stick: the next query tries again.
      if (this.build === build) this.build = undefined;
      throw error;
    }
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.build = undefined;
  }

  /** Created with the first query, so a window that never opens the menu runs no watcher. */
  private watch(): void {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*", false, true, false);
    const stale = (uri: vscode.Uri) => {
      if (!isExcludedFromIndex(vscode.workspace.asRelativePath(uri, false))) this.build = undefined;
    };
    this.disposables.push(
      watcher,
      watcher.onDidCreate(stale),
      watcher.onDidDelete(stale),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.build = undefined;
      }),
    );
  }

  /**
   * Explicit exclude glob: VS Code applies it on top of `files.exclude` (only `null` drops the defaults).
   * Paths as `asRelativePath` with its default prefix (folder name only in a multi-root workspace), which is
   * what the mention resolver accepts.
   */
  private async scan(): Promise<Snapshot> {
    const uris = await vscode.workspace.findFiles("**/*", INDEX_EXCLUDE_GLOB, MAX_INDEXED_FILES);
    const files = uris.filter((uri) => uri.scheme === "file").map((uri) => vscode.workspace.asRelativePath(uri));
    return { entries: indexEntries(files), capped: uris.length >= MAX_INDEXED_FILES };
  }
}
