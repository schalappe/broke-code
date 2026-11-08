/**
 * @module conversationFiles
 * Host wiring of the conversation files: `workspace.fs` in the extension's per-workspace storage directory
 * (`ExtensionContext.storageUri`), which VS Code gives only when a folder or workspace is open. Logic: core.
 */
import * as vscode from "vscode";
import { type ConversationFiles, directoryFiles } from "../core/conversationFiles";

export function workspaceConversationFiles(directory: vscode.Uri | undefined): ConversationFiles | undefined {
  return directoryFiles<vscode.Uri>(
    directory && {
      fs: vscode.workspace.fs,
      uri: directory,
      join: (parent, name) => vscode.Uri.joinPath(parent, name),
      isFileNotFound: (error) => error instanceof vscode.FileSystemError && error.code === "FileNotFound",
    },
  );
}
