/**
 * @module conversationFiles
 * File access for the conversation store: the `ConversationFiles` port, and its implementation over a local directory
 * with `node:fs`. The host passes the path of `ExtensionContext.storageUri`, a `file:` URI in the desktop extension
 * host. Not `workspace.fs`: its rename with overwrite deletes the destination before moving, so it is not atomic.
 */
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isConversationId } from "./conversation";

/** Flat file access in the storage directory. Names carry no path separator. */
export type ConversationFiles = {
  /** Names of the regular files in the directory; empty when it does not exist yet. */
  names(): Promise<string[]>;
  /** Text of `name`; `undefined` when it does not exist. */
  read(name: string): Promise<string | undefined>;
  /** Replace `name` whole, atomically: a crash leaves the old text or the new, never a mix. */
  write(name: string, text: string): Promise<void>;
  /** Delete `name`; no error when it does not exist. */
  remove(name: string): Promise<void>;
};

/** Length of a conversation id and of the uuid in a temporary file's name. */
const UUID_LENGTH = 36;

/** Temporary file a write of `name` goes through: unique per write, never ending in `.json`. */
function temporaryName(name: string): string {
  return `${name}.${crypto.randomUUID()}.tmp`;
}

/**
 * True for a leftover temporary file of a conversation's record or summary: `<id>[.summary].json.<uuid>.tmp`.
 * Cuts fixed-length parts from the end instead of matching a pattern, so any name costs time linear in its length:
 * the listing tests every name of the storage directory in the extension host.
 */
export function isTemporaryName(name: string): boolean {
  const stem = withoutSuffix(name, ".tmp");
  if (stem === undefined) return false;
  const uuid = stem.slice(-UUID_LENGTH);
  const target = withoutSuffix(stem.slice(0, -UUID_LENGTH), ".");
  if (target === undefined || !isConversationId(uuid)) return false;
  const base = withoutSuffix(target, ".json");
  if (base === undefined) return false;
  return isConversationId(withoutSuffix(base, ".summary") ?? base);
}

function withoutSuffix(text: string, suffix: string): string | undefined {
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : undefined;
}

/** Files in `directory`; `undefined` without a storage directory, so conversations stay in memory. */
export function directoryFiles(directory: string | undefined): ConversationFiles | undefined {
  if (directory === undefined) return undefined;
  const path = (name: string) => join(directory, name);
  return {
    // [>]: A symbolic link or a directory is not listed.
    names: async () => {
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
      } catch (error) {
        if (isFileNotFound(error)) return [];
        throw error;
      }
    },
    read: async (name) => {
      try {
        return await readFile(path(name), "utf8");
      } catch (error) {
        if (isFileNotFound(error)) return undefined;
        throw error;
      }
    },
    // [>]: Atomic: a new temporary file with a unique name, flushed to disk, then `rename(2)` over the final one, which
    // replaces it in one step. A crash leaves the old file or the new one; the store deletes a leftover temporary
    // file when it first lists.
    write: async (name, text) => {
      await mkdir(directory, { recursive: true });
      const temp = path(temporaryName(name));
      try {
        const handle = await open(temp, "wx");
        try {
          await handle.writeFile(text, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, path(name));
      } catch (error) {
        await unlink(temp).catch(() => {
          // [>]: Cleanup only; the write error below is what the caller must see.
        });
        throw error;
      }
    },
    remove: async (name) => {
      try {
        await unlink(path(name));
      } catch (error) {
        if (!isFileNotFound(error)) throw error;
      }
    },
  };
}

function isFileNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}
