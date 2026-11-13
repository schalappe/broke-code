/**
 * @module notifications
 * The editor side of the turn notifications: the window's focus, the `brokeCode.notifications` setting, VS Code's
 * messages, and the chat view's focus command. What is notified, and when, is decided in `core/notifications.ts`.
 */
import * as vscode from "vscode";
import { type NotificationHost, notifyTurnEvent, type TurnEvent } from "../core/notifications";
import { CHAT_VIEW_ID } from "./chatView";

/**
 * The chat controller's events port: notifies of each event unless the chat is in view. `chatVisible`: whether the
 * chat view is visible now. The setting is read from the user settings only (see `notificationsEnabled`).
 */
export function turnNotifier(chatVisible: () => boolean): (event: TurnEvent) => void {
  const host: NotificationHost = {
    chatVisible,
    windowFocused: () => vscode.window.state.focused,
    setting: () => vscode.workspace.getConfiguration("brokeCode").inspect<unknown>("notifications"),
    show: ({ severity, message, button }) =>
      severity === "warning"
        ? vscode.window.showWarningMessage(message, button)
        : vscode.window.showInformationMessage(message, button),
    // [>]: The view's generated focus command resolves it on a first show, and reveals it when hidden.
    showChat: () => vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`),
    showError: (message) => void vscode.window.showErrorMessage(message),
  };
  // [>]: Not awaited: a notification stays up until the user closes it, and `notifyTurnEvent` never rejects.
  return (event) => void notifyTurnEvent(event, host, vscode.l10n);
}
