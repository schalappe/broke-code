/**
 * @module conversationStore
 * Saved conversations of one workspace: one `<id>.json` file per conversation in a directory the host provides.
 * The list is derived from the directory. vscode-free: the host passes file access through `ConversationFiles`.
 */
import {
  type ConversationRecord,
  type ConversationSummary,
  isConversationId,
  parseConversation,
  serializeConversation,
  summarize,
} from "./conversation";
import { type ConversationFiles, isTemporaryName } from "./conversationFiles";
import { SerialQueue } from "./serialQueue";

const FILE_PATTERN = /^(.+)\.json$/;

/**
 * The saved conversations, newest first, and the files that could not be read (a technical failure, apart from an
 * invalid or unknown-version file, which is logged and skipped). `cause`: runtime error text.
 */
export type ConversationListing = {
  conversations: ConversationSummary[];
  unreadable: { id: string; cause: string }[];
};

export class ConversationStore {
  /**
   * Every read, write, and remove runs one at a time, in call order: a read sees every write and remove asked
   * before it, and an older write never lands over a newer one.
   */
  private readonly queue = new SerialQueue();
  /** Ids removed in this session. Ids are never reused, so a late save of one is dropped instead of resurrecting it. */
  private readonly removed = new Set<string>();
  /** Leftover temporary files are deleted at the first listing only. */
  private listed = false;

  /** `files`: `undefined` without a storage directory (no folder open): nothing is kept, the list is empty. */
  constructor(private readonly files: ConversationFiles | undefined) {}

  /**
   * Conversations with at least one entry. The first listing also deletes leftover temporary files of crashed
   * writes; queued, so no write in flight has one. Rejects when the directory cannot be listed.
   */
  list(): Promise<ConversationListing> {
    const files = this.files;
    if (!files) return Promise.resolve({ conversations: [], unreadable: [] });
    return this.queue.run(async () => {
      const names = await files.names();
      if (!this.listed) {
        this.listed = true;
        await Promise.all(names.filter(isTemporaryName).map((name) => files.remove(name).catch(logLeftover)));
      }
      const ids = names.flatMap((name) => {
        const id = FILE_PATTERN.exec(name)?.[1];
        return isConversationId(id) ? [id] : [];
      });
      const listing: ConversationListing = { conversations: [], unreadable: [] };
      const reads = ids.map(async (id) => {
        try {
          const record = await this.read(files, id);
          if (record && record.entries.length > 0) listing.conversations.push(summarize(record));
        } catch (error) {
          listing.unreadable.push({ id, cause: String(error) });
        }
      });
      await Promise.all(reads);
      listing.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
      return listing;
    });
  }

  /** The saved conversation `id`; `undefined` when missing or invalid (logged). Rejects on a read failure. */
  async load(id: string): Promise<ConversationRecord | undefined> {
    fileName(id);
    const files = this.files;
    if (!files) return undefined;
    return this.queue.run(() => this.read(files, id));
  }

  /**
   * Write `record`. Resolves `false` when nothing was written: no storage, no entries, or the conversation was
   * removed. Rejects when the write fails.
   */
  async save(record: ConversationRecord): Promise<boolean> {
    const name = fileName(record.id);
    const files = this.files;
    if (!files || record.entries.length === 0) return false;
    const text = serializeConversation(record);
    return this.queue.run(async () => {
      if (this.removed.has(record.id)) return false;
      await files.write(name, text);
      return true;
    });
  }

  /**
   * Delete the conversation `id`; saves called after it are dropped. Rejects when the delete fails, and then later
   * saves still land, since the file is still there.
   */
  async remove(id: string): Promise<void> {
    const name = fileName(id);
    const files = this.files;
    return this.queue.run(async () => {
      await files?.remove(name);
      this.removed.add(id);
    });
  }

  /** Unqueued read; callers run it inside the queue. */
  private async read(files: ConversationFiles, id: string): Promise<ConversationRecord | undefined> {
    if (this.removed.has(id)) return undefined;
    const text = await files.read(fileName(id));
    if (text === undefined) return undefined;
    const parsed = parseConversation(text);
    if (!parsed.ok) return logSkipped(id, parsed.reason);
    if (parsed.record.id !== id) return logSkipped(id, `holds id ${parsed.record.id}`);
    return parsed.record;
  }
}

/** File of conversation `id`. Throws on anything but an id `newConversationId` makes, so no other file is touched. */
function fileName(id: string): string {
  if (!isConversationId(id)) throw new Error(`invalid conversation id ${JSON.stringify(id)}`);
  return `${id}.json`;
}

function logSkipped(id: string, reason: unknown): undefined {
  console.error("broke-code: skipped saved conversation", id, reason);
  return undefined;
}

function logLeftover(error: unknown): void {
  // [>]: A leftover temporary file is never listed; failing to delete it costs disk space only.
  console.error("broke-code: could not delete a leftover temporary conversation file", error);
}
