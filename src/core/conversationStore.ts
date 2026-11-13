/**
 * @module conversationStore
 * Saved conversations of one workspace, in a directory the host provides: per conversation, the record `<id>.json` and
 * its summary `<id>.summary.json`, the history row. The list is derived from the directory and reads the summaries;
 * it parses a record only when its summary is missing or invalid. A save deletes the summary before it writes the
 * record, so a summary that exists always matches its record. vscode-free: the host passes file access through
 * `ConversationFiles`.
 */
import {
  type ConversationMatch,
  type ConversationRecord,
  type ConversationSummary,
  conversationExcerpt,
  isConversationId,
  MAX_CONVERSATIONS,
  parseConversation,
  parseSummary,
  serializeConversation,
  serializeSummary,
  summarize,
} from "./conversation";
import { type ConversationFiles, isTemporaryName } from "./conversationFiles";
import { searchNeedle } from "./protocol";
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

/**
 * A History content search's answer: the matching conversations in the order searched, and how many records could
 * not be searched (a failed read, an invalid or unknown-version record). A record gone meanwhile is not counted.
 */
export type ConversationSearchAnswer = { items: ConversationMatch[]; unreadableCount: number };

/** One record read for the search: read, gone (missing or removed), or unreadable (failed read, invalid). */
type SearchRead = { kind: "read"; record: ConversationRecord } | { kind: "gone" } | { kind: "unreadable" };

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
  /** Grows with each `search`, so an older one stops at its next read. */
  private latestSearch = 0;

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

  /**
   * The History content search: the conversations `ids` (the listed ones, newest first; the first 50 only) whose
   * messages hold `query` once made a needle (`searchNeedle`), each with its excerpt (`conversationExcerpt`). Records
   * are read one at a time through the queue, each read queued when the one before has ended, so a save waits behind
   * one read of a search at most. Resolves `undefined`, without an answer, for a query that is not searchable or when
   * a newer search started meanwhile; its remaining reads are never queued. Never rejects for a record and changes
   * nothing on disk.
   */
  async search(ids: readonly string[], query: string): Promise<ConversationSearchAnswer | undefined> {
    const run = ++this.latestSearch;
    const { needle, searchable } = searchNeedle(query);
    if (!searchable) return undefined;
    const files = this.files;
    const answer: ConversationSearchAnswer = { items: [], unreadableCount: 0 };
    if (!files) return answer;
    for (const id of ids.slice(0, MAX_CONVERSATIONS)) {
      if (run !== this.latestSearch) return undefined;
      const read = await this.queue.run(() => this.readForSearch(files, id));
      if (read.kind === "unreadable") answer.unreadableCount += 1;
      if (read.kind !== "read") continue;
      const excerpt = conversationExcerpt(read.record.entries, needle);
      if (excerpt !== undefined) answer.items.push({ id, excerpt });
    }
    return run === this.latestSearch ? answer : undefined;
  }

  /** Unqueued read for the search; never rejects: a failed read is logged and unreadable. */
  private async readForSearch(files: ConversationFiles, id: string): Promise<SearchRead> {
    try {
      return await this.readRecord(files, id);
    } catch (error) {
      console.error("broke-code: could not read a saved conversation to search it", id, error);
      return { kind: "unreadable" };
    }
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

  /** Unqueued read; callers run it inside the queue. `undefined` when gone or unreadable (logged). */
  private async read(files: ConversationFiles, id: string): Promise<ConversationRecord | undefined> {
    const read = await this.readRecord(files, id);
    return read.kind === "read" ? read.record : undefined;
  }

  /** Unqueued read of the record `id`; an invalid one is logged and unreadable. Rejects on a read failure. */
  private async readRecord(files: ConversationFiles, id: string): Promise<SearchRead> {
    if (this.removed.has(id)) return { kind: "gone" };
    const text = await files.read(fileName(id));
    if (text === undefined) return { kind: "gone" };
    const parsed = parseConversation(text);
    if (!parsed.ok) return logSkipped(id, parsed.reason);
    if (parsed.record.id !== id) return logSkipped(id, `holds id ${parsed.record.id}`);
    return { kind: "read", record: parsed.record };
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

function logSkipped(id: string, reason: unknown): SearchRead {
  console.error("broke-code: skipped saved conversation", id, reason);
  return { kind: "unreadable" };
}

function logOrphan(error: unknown): void {
  // [>]: A summary without its record is never listed; failing to delete it costs disk space only.
  console.error("broke-code: could not delete the summary of a removed conversation", error);
}

function logLeftover(error: unknown): void {
  // [>]: A leftover temporary file is never listed; failing to delete it costs disk space only.
  console.error("broke-code: could not delete a leftover temporary conversation file", error);
}
