/**
 * @module serialQueue
 * Run async tasks one at a time, in call order.
 */

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Queue `task`; it starts once every earlier task has settled.
   * @returns Task result. Rejection reaches this caller only; later tasks still run.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => {
      // [>]: Failure already delivered to its own caller; queue must keep going.
    });
    return result;
  }
}
