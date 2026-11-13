import { describe, expect, test } from "bun:test";
import { type ChatCommandPort, chatContext, runChatCommand } from "./chatCommands";
import type { ChatEntry, ChatState, PendingApproval } from "./protocol";

const ask: ChatEntry = { role: "user", content: "go", mentions: [] };
const streaming: ChatEntry = { role: "assistant", content: "", status: "streaming" } as ChatEntry;
const done: ChatEntry = { role: "assistant", content: "Done.", status: "done" } as ChatEntry;
const write: PendingApproval = { id: 4, kind: "write", tool: "edit_file", summary: "a.ts", preview: true };
const command: PendingApproval = { id: 5, kind: "command", tool: "run_command", summary: "bun test" };

const state = (entries: ChatEntry[], approval?: PendingApproval): ChatState =>
  ({ conversationId: "c", entries, ...(approval ? { approval } : {}) }) as ChatState;

/** A port over `snapshot` that records each call the commands make. */
function port(snapshot: ChatState) {
  const calls: string[] = [];
  const chat: ChatCommandPort = {
    snapshot,
    approve: (id) => void calls.push(`approve ${id}`),
    reject: (id) => void calls.push(`reject ${id}`),
    showChange: async (id) => void calls.push(`showChange ${id}`),
    stop: () => void calls.push("stop"),
    newChat: async () => void calls.push("newChat"),
  };
  return { chat, calls };
}

describe("chatContext", () => {
  test("names the open request's kind, a reply in flight, and a conversation with entries", () => {
    expect(chatContext(state([]))).toEqual({ approval: "none", replying: false, hasEntries: false });
    expect(chatContext(state([ask, streaming], write))).toEqual({
      approval: "write",
      replying: true,
      hasEntries: true,
    });
    expect(chatContext(state([ask, done])).approval).toBe("none");
    expect(chatContext(state([ask, streaming], command)).approval).toBe("command");
  });
});

describe("runChatCommand", () => {
  test("Accept accepts a write only, and Run a command only", async () => {
    for (const [approval, accepted, ran] of [
      [write, ["approve 4"], []],
      [command, [], ["approve 5"]],
    ] as const) {
      const accepting = port(state([ask, streaming], approval));
      await runChatCommand("acceptChange", accepting.chat);
      expect(accepting.calls).toEqual([...accepted]);
      const running = port(state([ask, streaming], approval));
      await runChatCommand("runCommand", running.chat);
      expect(running.calls).toEqual([...ran]);
    }
  });

  test("Reject rejects the request open, whatever its kind, without a reason", async () => {
    for (const approval of [write, command]) {
      const { chat, calls } = port(state([ask, streaming], approval));
      await runChatCommand("reject", chat);
      expect(calls).toEqual([`reject ${approval.id}`]);
    }
  });

  test("Show change applies to a request with a preview only", async () => {
    const shown = port(state([ask, streaming], write));
    await runChatCommand("showChange", shown.chat);
    expect(shown.calls).toEqual(["showChange 4"]);
    const none = port(state([ask, streaming], command));
    await runChatCommand("showChange", none.chat);
    expect(none.calls).toEqual([]);
  });

  test("Stop applies to a reply in flight, New chat to a conversation with entries", async () => {
    const flying = port(state([ask, streaming]));
    await runChatCommand("stop", flying.chat);
    await runChatCommand("newChat", flying.chat);
    expect(flying.calls).toEqual(["stop", "newChat"]);
    const empty = port(state([]));
    await runChatCommand("stop", empty.chat);
    await runChatCommand("newChat", empty.chat);
    expect(empty.calls).toEqual([]);
  });

  test("a command with nothing to act on does nothing, as the palette may lag the state", async () => {
    const { chat, calls } = port(state([ask, done]));
    for (const command of ["acceptChange", "runCommand", "reject", "showChange", "stop"] as const) {
      await runChatCommand(command, chat);
    }
    expect(calls).toEqual([]);
  });
});
