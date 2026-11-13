/**
 * @module chatCommands
 * The chat's commands in the editor's Command Palette, the keyboard path to the agent loop: Accept, Run, Reject, Show
 * change, Stop, and New chat. Each acts on the state the chat shows, as its button does, and applies only when that
 * button would: the context keys below hide the others from the palette. None has a default keybinding; the user may
 * bind them. In the panel itself, ⌘Enter and ⌘Backspace decide (see `useDecisionKeys` in the webview).
 */
import { type ChatState, isReplying } from "./protocol";

/** The command ids, as `package.json` contributes them. */
export const CHAT_COMMANDS = {
  acceptChange: "broke-code.acceptChange",
  runCommand: "broke-code.runCommand",
  reject: "broke-code.reject",
  showChange: "broke-code.showChange",
  stop: "broke-code.stop",
  newChat: "broke-code.newChat",
} as const;

export type ChatCommand = keyof typeof CHAT_COMMANDS;

/**
 * The `when` context of the commands. `approval`: the kind of the approval request open, `write` or `command`, or
 * `none`. `replying`: an agent turn is in flight. `hasEntries`: the conversation shown is not empty.
 */
export type ChatContext = { approval: "write" | "command" | "none"; replying: boolean; hasEntries: boolean };

/** The context key of each `ChatContext` field, as the `when` clauses in `package.json` name them. */
export const CHAT_CONTEXT_KEYS: { readonly [K in keyof ChatContext]: string } = {
  approval: "broke-code.approval",
  replying: "broke-code.replying",
  hasEntries: "broke-code.hasEntries",
};

export function chatContext(state: ChatState): ChatContext {
  return {
    approval: state.approval?.kind ?? "none",
    replying: isReplying(state),
    hasEntries: state.entries.length > 0,
  };
}

/** What the commands act through: the chat's state, and the controller's methods its buttons call. */
export type ChatCommandPort = {
  readonly snapshot: ChatState;
  approve(id: number): void;
  reject(id: number): void;
  showChange(id: number): Promise<void>;
  stop(): void;
  newChat(): Promise<void>;
};

/**
 * Run `command` on the chat's state now. A command that does not apply, such as Accept with a command waiting or
 * nothing open, does nothing: the palette may lag the state by one update. Accept and Run act only on the kind of
 * request they name, so Accept never runs a command.
 */
export async function runChatCommand(command: ChatCommand, chat: ChatCommandPort): Promise<void> {
  const state = chat.snapshot;
  const { approval } = state;
  switch (command) {
    case "acceptChange":
      if (approval?.kind === "write") chat.approve(approval.id);
      return;
    case "runCommand":
      if (approval?.kind === "command") chat.approve(approval.id);
      return;
    case "reject":
      if (approval) chat.reject(approval.id);
      return;
    case "showChange":
      if (approval?.preview) await chat.showChange(approval.id);
      return;
    case "stop":
      if (isReplying(state)) chat.stop();
      return;
    case "newChat":
      if (state.entries.length > 0) await chat.newChat();
      return;
  }
}
