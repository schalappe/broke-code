/**
 * @module conversationFixture
 * In-memory `ConversationFiles` for tests: a map of file name to text, read counts per name, and hooks to fail or hold
 * a write and to hold a remove.
 */
import type { ConversationFiles } from "./conversationFiles";

export type MemoryFiles = ConversationFiles & {
  readonly files: Map<string, string>;
  /** Reads asked per name, missing names included. */
  readonly reads: Map<string, number>;
  /** Next writes reject with this error while set. */
  failWrites: Error | undefined;
  /** While set, each write waits for this promise before it lands. */
  holdWrites: Promise<void> | undefined;
  /** While set, each remove waits for this promise before it lands. */
  holdRemoves: Promise<void> | undefined;
};

export function memoryFiles(initial: Record<string, string> = {}): MemoryFiles {
  const files = new Map(Object.entries(initial));
  const reads = new Map<string, number>();
  const memory: MemoryFiles = {
    files,
    reads,
    failWrites: undefined,
    holdWrites: undefined,
    holdRemoves: undefined,
    names: async () => [...files.keys()],
    read: async (name) => {
      reads.set(name, (reads.get(name) ?? 0) + 1);
      return files.get(name);
    },
    write: async (name, text) => {
      const hold = memory.holdWrites;
      if (hold) await hold;
      if (memory.failWrites) throw memory.failWrites;
      files.set(name, text);
    },
    remove: async (name) => {
      const hold = memory.holdRemoves;
      if (hold) await hold;
      files.delete(name);
    },
  };
  return memory;
}
