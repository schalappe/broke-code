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
import { SerialQueue } from "./serialQueue";

/** Flat file access in the storage directory. Names carry no path separator. */
export type ConversationFiles = {
  /** Names of the files in the directory; empty when it does not exist yet. */
  names(): Promise<string[]>;
  /** Text of `name`; `undefined` when it does not exist. */
  read(name: string): Promise<string | undefined>;
  /** Replace `name` whole, atomically: a crash leaves the old text or the new, never a mix. */
  write(name: string, text: string): Promise<void>;
  /** Delete `name`; no error when it does not exist. */
  remove(name: string): Promise<void>;
};

const FILE_PATTERN = /^(.+)\.json$/;

export class ConversationStore {
  /** Writes and removes run one at a time, in call order. */
  private readonly queue = new SerialQueue();
  /** Ids removed in this session. Ids are never reused, so a late save of one is dropped instead of resurrecting it. */
  private readonly removed = new Set<string>();

  /** `files`: `undefined` without a storage directory (no folder open): nothing is kept, the list is empty. */
  constructor(private readonly files: ConversationFiles | undefined) {}

  /** Summaries of the saved conversations, newest first. An unreadable or invalid file is logged and skipped. */
  async list(): Promise<ConversationSummary[]> {
    if (!this.files) return [];
    const ids = (await this.files.names()).flatMap((name) => {
      const id = FILE_PATTERN.exec(name)?.[1];
      return isConversationId(id) ? [id] : [];
    });
    const records = await Promise.all(ids.map((id) => this.load(id).catch((error: unknown) => logSkipped(id, error))));
    return records
      .filter((record) => record !== undefined)
      .map(summarize)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The saved conversation `id`; `undefined` when missing or invalid (logged). Rejects on a read failure. */
  async load(id: string): Promise<ConversationRecord | undefined> {
    const name = fileName(id);
    if (!this.files) return undefined;
    const text = await this.files.read(name);
    if (text === undefined) return undefined;
    const parsed = parseConversation(text);
    if (!parsed.ok) return logSkipped(id, parsed.reason);
    if (parsed.record.id !== id) return logSkipped(id, `holds id ${parsed.record.id}`);
    return parsed.record;
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

  /** Delete the conversation `id`; later saves of it are dropped. Rejects when the delete fails. */
  async remove(id: string): Promise<void> {
    const name = fileName(id);
    this.removed.add(id);
    const files = this.files;
    if (!files) return;
    return this.queue.run(() => files.remove(name));
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
