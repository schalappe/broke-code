/**
 * @module progress
 * The cancellable progress notification the commands outside the chat run their request under.
 */
import * as vscode from "vscode";

/** Run `task` under a progress notification titled `title`; its Cancel aborts the signal `task` gets. */
export function withCancellableProgress<T>(title: string, task: (cancelled: AbortSignal) => Promise<T>): Promise<T> {
  return Promise.resolve(
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (_, token) => {
        const cancel = new AbortController();
        token.onCancellationRequested(() => cancel.abort());
        return task(cancel.signal);
      },
    ),
  );
}
