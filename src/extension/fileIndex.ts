/**
 * @module fileIndex
 * Host side of the mention menu's file index: `findFiles` as the scan and a file watcher feeding
 * `core/fileIndex`, which holds the logic.
 */
import * as vscode from "vscode";
import { FileIndex, type FileQueryAnswer, type FileScan } from "../core/fileIndex";
import { INDEX_EXCLUDE_GLOB } from "../core/suggestions";

export class WorkspaceFileIndex implements vscode.Disposable {
  private readonly index = new FileIndex(scanWorkspace);
  private readonly disposables: vscode.Disposable[] = [];

  query(query: string): Promise<FileQueryAnswer> {
    if (this.disposables.length === 0) this.watch();
    return this.index.query(query);
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.index.invalidate();
  }

  /** Created with the first query, so a window that never opens the menu runs no watcher. */
  private watch(): void {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*", false, true, false);
    const changed = (uri: vscode.Uri) => this.index.fileChanged(vscode.workspace.asRelativePath(uri, false));
    this.disposables.push(
      watcher,
      watcher.onDidCreate(changed),
      watcher.onDidDelete(changed),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.index.invalidate()),
    );
  }
}

/**
 * Explicit exclude glob: VS Code applies it on top of `files.exclude` (only `null` drops the defaults).
 * Paths as `asRelativePath` with its default prefix (folder name only in a multi-root workspace), which is
 * what the mention resolver accepts. Folders of other schemes hold nothing the local reader can attach.
 */
const scanWorkspace: FileScan = async (limit) => {
  const uris = await vscode.workspace.findFiles("**/*", INDEX_EXCLUDE_GLOB, limit);
  const local = uris.filter((uri) => uri.scheme === "file").map((uri) => vscode.workspace.asRelativePath(uri));
  return { local, found: uris.length };
};
