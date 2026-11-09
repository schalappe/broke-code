/**
 * @module conversationStore
 * Saved conversations of one workspace, in a directory the host provides: per conversation, the record `<id>.json` and
 * its summary `<id>.summary.json`, the history row. The list is derived from the directory and reads the summaries;
 * it parses a record only when its summary is missing or invalid. A save deletes the summary before it writes the
 * record, so a summary that exists always matches its record. vscode-free: the host passes file access through
 * `ConversationFiles`.
 */
import {
  type ConversationRecord,
  type ConversationSummary,
  isConversationId,
  parseConversation,
  parseSummary,
  serializeConversation,
  serializeSummary,
  summarize,
} from "./conversation";
import { type ConversationFiles, isTemporaryName } from "./conversationFiles";
import { SerialQueue } from "./serialQueue";

const RECORD_PATTERN = /^(.+)\.json$/;
const SUMMARY_PATTERN = /^(.+)\.summary\.json$/;

/**
 * The saved conversations, newest first, and the records that could not be read (a technical failure, apart from an
 * invalid or unknown-version record, which is logged and skipped). `cause`: runtime error text.
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
   * Conversations with at least one entry, from their summaries, or their records when the summary is missing or
   * invalid. The first listing also deletes leftover temporary files of crashed writes; queued, so no write in flight
   * has one. Rejects when the directory cannot be listed.
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
      const present = new Set(names);
      const orphans = names.filter((name) => {
        const id = SUMMARY_PATTERN.exec(name)?.[1];
        return isConversationId(id) && !present.has(fileName(id));
      });
      await Promise.all(orphans.map((name) => files.remove(name).catch(logOrphan)));
      const ids = names.flatMap((name) => {
        const id = RECORD_PATTERN.exec(name)?.[1];
        return isConversationId(id) && !this.removed.has(id) ? [id] : [];
      });
      const listing: ConversationListing = { conversations: [], unreadable: [] };
      const reads = ids.map(async (id) => {
        const summary = present.has(summaryName(id)) ? await this.readSummary(files, id) : undefined;
        if (summary) {
          listing.conversations.push(summary);
          return;
        }
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
   * Delete the summary, write `record`, then its new summary. Resolves `false` when nothing was written: no storage,
   * no entries, or the conversation was removed. Rejects when the old summary cannot be deleted or the record write
   * fails; a failed summary write is logged only.
   */
  async save(record: ConversationRecord): Promise<boolean> {
    const name = fileName(record.id);
    const files = this.files;
    if (!files || record.entries.length === 0) return false;
    const text = serializeConversation(record);
    const summary = serializeSummary(record);
    return this.queue.run(async () => {
      if (this.removed.has(record.id)) return false;
      // [>]: The list trusts a valid summary, and the prune deletes by its `updatedAt`, so a summary must never be
      // older than its record. Deleting it first means a crash or a failed write below leaves no summary, and the list
      // parses the record. When it cannot be deleted, the record is not written either: the save fails as a failed
      // record write does, the error is shown, and both files stay as the last save left them.
      await files.remove(summaryName(record.id));
      await files.write(name, text);
      try {
        await files.write(summaryName(record.id), summary);
      } catch (error) {
        // [>]: The record landed, so the conversation is saved; without a summary the list parses the record.
        console.error("broke-code: could not write a conversation summary", record.id, error);
      }
      return true;
    });
  }

  /**
   * Delete the conversation `id`, record then summary; saves called after it are dropped. Rejects when the record
   * delete fails, and then both files stay and later saves still land.
   */
  async remove(id: string): Promise<void> {
    const name = fileName(id);
    const files = this.files;
    return this.queue.run(async () => {
      await files?.remove(name);
      this.removed.add(id);
      await files?.remove(summaryName(id)).catch((error: unknown) => {
        // [>]: The record is gone, so the conversation is: a summary without its record is never listed, and the
        // next listing deletes it.
        console.error("broke-code: could not delete a conversation summary", id, error);
      });
    });
  }

  /** Unqueued summary read; `undefined` when missing, unreadable (logged), invalid, or not of `id`. */
  private async readSummary(files: ConversationFiles, id: string): Promise<ConversationSummary | undefined> {
    let text: string | undefined;
    try {
      text = await files.read(summaryName(id));
    } catch (error) {
      // [>]: The record read that follows reports the conversation if it cannot be read either.
      console.error("broke-code: could not read a conversation summary", id, error);
      return undefined;
    }
    const summary = text === undefined ? undefined : parseSummary(text);
    return summary?.id === id ? summary : undefined;
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

/** Summary file of conversation `id`; callers pass an id `fileName` already checked. */
function summaryName(id: string): string {
  return `${id}.summary.json`;
}

function logSkipped(id: string, reason: unknown): undefined {
  console.error("broke-code: skipped saved conversation", id, reason);
  return undefined;
}

function logOrphan(error: unknown): void {
  // [>]: A summary without its record is never listed; failing to delete it costs disk space only.
  console.error("broke-code: could not delete the summary of a removed conversation", error);
}

function logLeftover(error: unknown): void {
  // [>]: A leftover temporary file is never listed; failing to delete it costs disk space only.
  console.error("broke-code: could not delete a leftover temporary conversation file", error);
}
