/**
 * @module draftQueue
 * The editor drafts on their way to the chat webview ("Add selection to chat", "Fix with broke-code"): queued only once
 * the chat shows, delivered when the webview is ready and visible, in order, each once, and kept for its next `ready`
 * when a post does not reach it. The host's chat view wires it to `postMessage`.
 */
import type { DraftInsert } from "./protocol";

/**
 * The webview as the queue sees it. `canDeliver`: ready and visible. `send`: post one draft; resolves `false`, or
 * rejects, when the webview did not get it.
 */
export type DraftPort = { canDeliver(): boolean; send(draft: DraftInsert): Promise<boolean> };

/** How one draft reaches the chat. `show`: reveal the chat view; may reject. */
export type DraftTarget = { hasProvider: boolean; show(): Promise<void> };

export class DraftQueue {
  private readonly queued: DraftInsert[] = [];
  /** A delivery is running; another one asked meanwhile runs right after it, so no draft is posted twice. */
  private delivering = false;
  private again = false;

  constructor(private readonly port: DraftPort) {}

  /**
   * Show the chat, then queue `draft` and deliver what can be. `noProvider`: the panel has no message box, so the draft
   * is dropped; the caller says so. A `show` that rejects queues nothing and rejects, so a retry delivers it once.
   */
  async insert(draft: DraftInsert, target: DraftTarget): Promise<"queued" | "noProvider"> {
    await target.show();
    if (!target.hasProvider) return "noProvider";
    this.queued.push(draft);
    await this.deliver();
    return "queued";
  }

  /**
   * Post the queued drafts, oldest first, while the webview can take them. A draft not delivered stays first in the
   * queue, those behind it after it, until the next call (the webview's next `ready`).
   */
  async deliver(): Promise<void> {
    if (this.delivering) {
      this.again = true;
      return;
    }
    this.delivering = true;
    try {
      do {
        this.again = false;
        await this.postQueued();
      } while (this.again);
    } finally {
      this.delivering = false;
    }
  }

  private async postQueued(): Promise<void> {
    for (let next = this.queued[0]; next && this.port.canDeliver(); next = this.queued[0]) {
      const delivered = await this.port.send(next).catch(() => false);
      if (!delivered) return;
      this.queued.shift();
    }
  }
}
