/**
 * @module conversationFiles
 * File access for the conversation store: the `ConversationFiles` port, and its implementation over a directory of a
 * file system shaped like the `vscode.FileSystem` subset it uses. vscode-free: the host passes `workspace.fs`, its
 * URI join, and its "file not found" check.
 */
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

/** Subset of `vscode.FileSystem` used, over URIs of type `U`. Entry types as `vscode.FileType`. */
export type FileSystem<U> = {
  readDirectory(uri: U): PromiseLike<[string, number][]>;
  readFile(uri: U): PromiseLike<Uint8Array>;
  writeFile(uri: U, content: Uint8Array): PromiseLike<void>;
  rename(source: U, target: U, options: { overwrite: boolean }): PromiseLike<void>;
  delete(uri: U): PromiseLike<void>;
  /** Creates missing parents too; no error when it exists. */
  createDirectory(uri: U): PromiseLike<void>;
};

/** A storage directory: the file system, the directory, how to name a file in it, and which errors mean "missing". */
export type StorageDirectory<U> = {
  fs: FileSystem<U>;
  uri: U;
  join(directory: U, name: string): U;
  isFileNotFound(error: unknown): boolean;
};

/** `vscode.FileType.File`. A symbolic link or a directory is not listed. */
const REGULAR_FILE = 1;

const TEMPORARY_PATTERN = /^(.+)\.json\.([^./]+-[^./]+-[^./]+-[^./]+-[^./]+)\.tmp$/;

/** Temporary file a write of `name` goes through: unique per write, never ending in `.json`. */
function temporaryName(name: string): string {
  return `${name}.${crypto.randomUUID()}.tmp`;
}

/** True for a leftover temporary file of a conversation: `<id>.json.<uuid>.tmp`. */
export function isTemporaryName(name: string): boolean {
  const match = TEMPORARY_PATTERN.exec(name);
  return match !== null && isConversationId(match[1]) && isConversationId(match[2]);
}

/** Files of `storage`; `undefined` without a storage directory, so conversations stay in memory. */
export function directoryFiles<U>(storage: StorageDirectory<U> | undefined): ConversationFiles | undefined {
  if (!storage) return undefined;
  const { fs, uri: directory, isFileNotFound } = storage;
  const uri = (name: string) => storage.join(directory, name);
  return {
    names: async () => {
      try {
        const entries = await fs.readDirectory(directory);
        return entries.filter(([, type]) => type === REGULAR_FILE).map(([name]) => name);
      } catch (error) {
        if (isFileNotFound(error)) return [];
        throw error;
      }
    },
    read: async (name) => {
      try {
        return new TextDecoder().decode(await fs.readFile(uri(name)));
      } catch (error) {
        if (isFileNotFound(error)) return undefined;
        throw error;
      }
    },
    // [>]: Atomic: a temporary file with a unique name, then a rename over the final one. A crash leaves the old
    // file or the new one; the store deletes a leftover temporary file when it first lists.
    write: async (name, text) => {
      await fs.createDirectory(directory);
      const temp = uri(temporaryName(name));
      try {
        await fs.writeFile(temp, new TextEncoder().encode(text));
        await fs.rename(temp, uri(name), { overwrite: true });
      } catch (error) {
        await Promise.resolve(fs.delete(temp)).catch(() => {
          // [>]: Cleanup only; the write error below is what the caller must see.
        });
        throw error;
      }
    },
    remove: async (name) => {
      try {
        await fs.delete(uri(name));
      } catch (error) {
        if (!isFileNotFound(error)) throw error;
      }
    },
  };
}
