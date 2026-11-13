/**
 * @module notifications
 * What the chat controller reports while the user may be looking elsewhere (`TurnEvent`), and the notification the
 * host shows for it. No `vscode` import: the host passes what it reads and shows.
 */
import type { ApprovalRequest, InspectedSetting } from "./approval";
import type { Translator } from "./modelList";
import type { HaltReason } from "./protocol";
import { describeProviderError, type ProviderError } from "./providerError";
import { describeEmptySummary, describeHalt } from "./turnEndText";

/** How a turn ended, for the ends that are reported; a turn that ends `stopped` reports nothing. */
export type TurnEnd =
  | { status: "done" }
  | { status: "failed"; error: ProviderError }
  | { status: "halted"; reason: HaltReason };

/**
 * An event of the chat the user may want to hear of.
 *
 * `approvalRequested`: an approval request opened and waits for the user; `request` is its kind and `summary` what it
 * acts on, a write's displayed path or a whole command. A write accepted by the auto-approve setting opens no request.
 *
 * `turnEnded`: an agent turn or a `/compact` ended, once per turn, reported when the published state holds its final
 * status. `summary`: the reply that ended it is a summary entry, a `/compact`'s or an automatic summary that failed
 * and so ended its turn. `empty`: that reply's text is empty once trimmed.
 */
export type TurnEvent =
  | { kind: "approvalRequested"; request: ApprovalRequest["kind"]; summary: string }
  | ({ kind: "turnEnded"; summary: boolean; empty: boolean } & TurnEnd);

/** A notification to show: its severity, its text, and the label of its one button. */
export type Notification = { severity: "information" | "warning"; message: string; button: string };

/**
 * What a notification needs from the host, each read at the event. `chatVisible`: the chat view is visible, `false`
 * for a view never opened in this window. `windowFocused`: the editor's window has the focus. `setting`: what
 * `inspect` gives for `brokeCode.notifications`. `show`: shows the notification and settles with the label of the
 * button clicked, or `undefined` when it closed without a click. `showChat`: focuses the chat view, as the editor
 * entry points do. `showError`: shows an error message.
 */
export type NotificationHost = {
  chatVisible(): boolean;
  windowFocused(): boolean;
  setting(): InspectedSetting | undefined;
  show(notification: Notification): PromiseLike<string | undefined>;
  showChat(): PromiseLike<unknown>;
  showError(message: string): void;
};

/**
 * Whether `brokeCode.notifications` is on, from what `inspect` gives for it. User settings only, like the other
 * settings: only a user (`globalValue`) value `false` turns the notifications off, so a value set in a workspace, or
 * one that is not a boolean, leaves them on.
 */
export function notificationsEnabled(inspected: InspectedSetting | undefined): boolean {
  return inspected?.globalValue !== false;
}

/**
 * Notify the user of `event` unless the chat is in view (the view visible and the window focused) or the setting is
 * off, all read once, now: at most one notification, never repeated or withdrawn. Its "Show chat" button shows the
 * chat and does nothing else. `l10n`: the host's translator. Never rejects: a notification that cannot show is
 * logged, since the event it tells is already in the chat; a chat that cannot be shown after the click is logged and
 * said in an error message, since the user asked for it.
 */
export async function notifyTurnEvent(event: TurnEvent, host: NotificationHost, l10n: Translator): Promise<void> {
  try {
    if (host.chatVisible() && host.windowFocused()) return;
    if (!notificationsEnabled(host.setting())) return;
    const notification = describeTurnEvent(event, l10n);
    if ((await host.show(notification)) !== notification.button) return;
  } catch (error) {
    console.error("broke-code: could not notify of a turn event", event.kind, error);
    return;
  }
  try {
    await host.showChat();
  } catch (error) {
    console.error("broke-code: could not show the chat from a notification", error);
    host.showError(l10n.t("Could not open the chat: {0}", String(error)));
  }
}

/** The notification that tells `event`, translated by `l10n`. */
function describeTurnEvent(event: TurnEvent, l10n: Translator): Notification {
  const button = l10n.t("Show chat");
  if (event.kind === "approvalRequested") {
    const subject = event.request === "command" ? firstCommandLine(event.summary) : event.summary;
    return {
      severity: "information",
      message: l10n.t("broke-code is waiting for your decision: {0}", subject),
      button,
    };
  }
  switch (event.status) {
    case "done":
      if (!event.summary) return { severity: "information", message: l10n.t("broke-code finished its turn."), button };
      if (event.empty) return { severity: "warning", message: describeEmptySummary(l10n), button };
      return { severity: "information", message: l10n.t("broke-code summarized the conversation."), button };
    case "failed": {
      const { message } = describeProviderError(event.error, l10n);
      return { severity: "warning", message: l10n.t("broke-code failed: {0}", message), button };
    }
    case "halted":
      return { severity: "warning", message: describeHalt(event.reason, event.summary, l10n), button };
  }
}

/** The most UTF-16 units of a command a notification shows. */
const MAX_COMMAND_LENGTH = 80;

/**
 * The first line of `command`, its leading whitespace and line breaks dropped, for a notification: whole when it is
 * at most 80 UTF-16 units and nothing but whitespace follows it; otherwise cut to at most 79 units, never inside a
 * surrogate pair, with `…` added.
 */
function firstCommandLine(command: string): string {
  const [first = "", ...rest] = command.trimStart().split(/\r?\n/);
  const line = first.trimEnd();
  const more = rest.some((following) => following.trim() !== "");
  if (!more && line.length <= MAX_COMMAND_LENGTH) return line;
  const kept = line.slice(0, MAX_COMMAND_LENGTH - 1);
  const splitsPair = /[\uD800-\uDBFF]$/.test(kept) && kept.length < line.length;
  return `${splitsPair ? kept.slice(0, -1) : kept}…`;
}
