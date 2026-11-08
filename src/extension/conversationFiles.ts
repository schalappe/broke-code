/**
 * @module conversationFiles
 * Host side of the conversation store: `ConversationFiles` on `workspace.fs` in the extension's per-workspace
 * storage directory (`ExtensionContext.storageUri`), which VS Code gives only when a folder or workspace is open.
 */
import * as vscode from "vscode";
import type { ConversationFiles } from "../core/conversationStore";

/** Files in `directory`; `undefined` without one, so conversations stay in memory. */
export function workspaceConversationFiles(directory: vscode.Uri | undefined): ConversationFiles | undefined {
  if (!directory) return undefined;
  const { fs } = vscode.workspace;
  const uri = (name: string) => vscode.Uri.joinPath(directory, name);
  return {
    names: async () => {
      try {
        const entries = await fs.readDirectory(directory);
        return entries.filter(([, type]) => type === vscode.FileType.File).map(([name]) => name);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
    },
    read: async (name) => {
      try {
        return new TextDecoder().decode(await fs.readFile(uri(name)));
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    // [>]: Atomic: a temporary file with a unique name, then a rename over the final one. A crash leaves the old
    // file or the new one; a leftover temporary file does not end in `.json`, so the store never lists it.
    write: async (name, text) => {
      await fs.createDirectory(directory);
      const temp = uri(`${name}.${crypto.randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, new TextEncoder().encode(text));
        await fs.rename(temp, uri(name), { overwrite: true });
      } catch (error) {
        await fs.delete(temp).then(undefined, () => {
          // [>]: Cleanup only; the write error below is what the caller must see.
        });
        throw error;
      }
    },
    remove: async (name) => {
      try {
        await fs.delete(uri(name));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}
