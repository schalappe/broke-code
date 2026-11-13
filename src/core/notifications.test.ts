import { describe, expect, spyOn, test } from "bun:test";
import type { InspectedSetting } from "./approval";
import type { Translator } from "./modelList";
import {
  type Notification,
  type NotificationHost,
  notificationsEnabled,
  notifyTurnEvent,
  type TurnEvent,
} from "./notifications";

/** `message` with each `{n}` replaced by `args[n]`, as `l10n.t` does for English. */
const english: Translator = {
  t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)])),
};

const done: TurnEvent = { kind: "turnEnded", status: "done", summary: false, empty: false };
const command = (summary: string): TurnEvent => ({ kind: "approvalRequested", request: "command", summary });

/**
 * A host that records what it is asked: the chat hidden and the window focused unless `facts` says otherwise, the
 * setting unset, and `click` the button the user clicks on each notification, none by default.
 */
function fakeHost(facts: { visible?: boolean; focused?: boolean; setting?: InspectedSetting; click?: string } = {}) {
  const shown: Notification[] = [];
  const errors: string[] = [];
  let showChats = 0;
  const host: NotificationHost = {
    chatVisible: () => facts.visible ?? false,
    windowFocused: () => facts.focused ?? true,
    setting: () => facts.setting,
    show: async (notification) => {
      shown.push(notification);
      return facts.click;
    },
    showChat: async () => {
      showChats += 1;
    },
    showError: (message) => errors.push(message),
  };
  return { host, shown, errors, showChats: () => showChats };
}

/** The one notification `event` gives while the chat is not in view. */
async function notificationOf(event: TurnEvent): Promise<Notification> {
  const { host, shown } = fakeHost();
  await notifyTurnEvent(event, host, english);
  expect(shown).toHaveLength(1);
  return shown[0]!;
}

describe("notifyTurnEvent when the chat is in view", () => {
  test("shows nothing while the view is visible and the window focused", async () => {
    const { host, shown } = fakeHost({ visible: true, focused: true });
    await notifyTurnEvent(done, host, english);
    await notifyTurnEvent(command("ls"), host, english);
    expect(shown).toEqual([]);
  });

  test("shows one notification when the view is not visible", async () => {
    const { host, shown } = fakeHost({ visible: false, focused: true });
    await notifyTurnEvent(done, host, english);
    expect(shown).toHaveLength(1);
  });

  test("shows one notification when the window is not focused", async () => {
    const { host, shown } = fakeHost({ visible: true, focused: false });
    await notifyTurnEvent(done, host, english);
    expect(shown).toHaveLength(1);
  });
});

describe("the notifications setting", () => {
  test("shows nothing when the user value is false", async () => {
    const { host, shown } = fakeHost({ setting: { globalValue: false } });
    await notifyTurnEvent(done, host, english);
    expect(shown).toEqual([]);
  });

  test("shows one notification when false is set only in a workspace", async () => {
    for (const setting of [{ workspaceValue: false }, { workspaceFolderValue: false }]) {
      const { host, shown } = fakeHost({ setting });
      await notifyTurnEvent(done, host, english);
      expect(shown).toHaveLength(1);
    }
  });

  test("shows one notification when the user value is not a boolean", async () => {
    for (const globalValue of ["false", 0, null, {}]) {
      const { host, shown } = fakeHost({ setting: { globalValue } });
      await notifyTurnEvent(done, host, english);
      expect(shown).toHaveLength(1);
    }
  });

  test("is on unless the user value is false", () => {
    expect(notificationsEnabled(undefined)).toBe(true);
    expect(notificationsEnabled({})).toBe(true);
    expect(notificationsEnabled({ globalValue: true })).toBe(true);
    expect(notificationsEnabled({ globalValue: false })).toBe(false);
    expect(notificationsEnabled({ globalValue: true, workspaceValue: false })).toBe(true);
  });
});

describe("the notification of each event", () => {
  const button = "Show chat";

  test("a write approval names the path, never cut", async () => {
    const path = `src/${"deep/".repeat(30)}file.ts`;
    expect(await notificationOf({ kind: "approvalRequested", request: "write", summary: path })).toEqual({
      severity: "information",
      message: `broke-code is waiting for your decision: ${path}`,
      button,
    });
  });

  test("a command approval names the command", async () => {
    expect(await notificationOf(command("bun test"))).toEqual({
      severity: "information",
      message: "broke-code is waiting for your decision: bun test",
      button,
    });
  });

  test("a turn that ends done", async () => {
    expect(await notificationOf(done)).toEqual({
      severity: "information",
      message: "broke-code finished its turn.",
      button,
    });
  });

  test("a /compact that ends done with a summary text", async () => {
    expect(await notificationOf({ kind: "turnEnded", status: "done", summary: true, empty: false })).toEqual({
      severity: "information",
      message: "broke-code summarized the conversation.",
      button,
    });
  });

  test("a /compact that ends done with no text warns with the chat's sentence", async () => {
    expect(await notificationOf({ kind: "turnEnded", status: "done", summary: true, empty: true })).toEqual({
      severity: "warning",
      message: "The model's reply held no summary.",
      button,
    });
  });

  test("a turn that ends done with an empty reply still finished its turn", async () => {
    expect((await notificationOf({ kind: "turnEnded", status: "done", summary: false, empty: true })).message).toBe(
      "broke-code finished its turn.",
    );
  });

  test("a failed turn warns with the chat's message for the failure, without its technical detail", async () => {
    const error = { kind: "unreachable", provider: "Ollama", baseUrl: "http://localhost:1/v1", cause: "ECONNREFUSED" };
    for (const summary of [false, true]) {
      const event: TurnEvent = {
        kind: "turnEnded",
        status: "failed",
        error: { ...error } as never,
        summary,
        empty: true,
      };
      expect(await notificationOf(event)).toEqual({
        severity: "warning",
        message:
          "broke-code failed: Cannot reach Ollama at http://localhost:1/v1. Check its base URL, your network or VPN, and the http.proxy setting.",
        button,
      });
    }
  });

  test("each halt reason warns with the chat's sentence", async () => {
    const halted = (reason: "stepLimit" | "malformedCalls" | "contextFull", summary = false): TurnEvent => ({
      kind: "turnEnded",
      status: "halted",
      reason,
      summary,
      empty: true,
    });
    expect(await notificationOf(halted("stepLimit"))).toEqual({
      severity: "warning",
      message: "Stopped: the agent turn reached its tool step limit.",
      button,
    });
    expect(await notificationOf(halted("malformedCalls"))).toEqual({
      severity: "warning",
      message: "Stopped: the model sent three malformed tool calls in a row.",
      button,
    });
    expect(await notificationOf(halted("contextFull"))).toEqual({
      severity: "warning",
      message:
        "Stopped: the conversation fills the model's context. Summarize it with /compact, or start a new chat with New chat.",
      button,
    });
    expect(await notificationOf(halted("contextFull", true))).toEqual({
      severity: "warning",
      message:
        "Not summarized: the conversation does not fit the model's context, even with its tool results left out. Start a new chat with New chat.",
      button,
    });
  });
});

describe("the command of a command approval", () => {
  const lead = "broke-code is waiting for your decision: ";
  const shownFor = async (text: string) => (await notificationOf(command(text))).message.slice(lead.length);

  test("3 short lines give the first line and an ellipsis", async () => {
    expect(await shownFor("cd src\nbun test\nbun run build")).toBe("cd src…");
  });

  test("one line of 100 characters gives its first 79 and an ellipsis", async () => {
    const shown = await shownFor("a".repeat(100));
    expect(shown).toBe(`${"a".repeat(79)}…`);
    expect(shown).toHaveLength(80);
  });

  test("one line of exactly 80 characters is whole", async () => {
    expect(await shownFor("b".repeat(80))).toBe("b".repeat(80));
  });

  test("a first line of 80 characters followed by another is cut to 79", async () => {
    expect(await shownFor(`${"c".repeat(80)}\nls`)).toBe(`${"c".repeat(79)}…`);
  });

  test("a command starting with a line break gives its first non-empty line", async () => {
    expect(await shownFor("\n  \n  ls -la")).toBe("ls -la");
    expect(await shownFor("\r\n\tls -la\r\npwd")).toBe("ls -la…");
  });

  test("a line break at the end is not another line", async () => {
    expect(await shownFor("ls -la\n")).toBe("ls -la");
  });

  test("a blank line after the first one is another line", async () => {
    expect(await shownFor("ls\n\n")).toBe("ls…");
  });

  test("the whitespace that ends the first line counts toward the 80 units", async () => {
    expect(await shownFor(`${"a".repeat(79)}  `)).toBe(`${"a".repeat(79)}…`);
  });

  test("the cut never splits a character in two", async () => {
    const shown = await shownFor(`${"d".repeat(78)}😀${"d".repeat(10)}`);
    expect(shown).toBe(`${"d".repeat(78)}…`);
  });
});

describe("Show chat", () => {
  test("shows the chat once when the button is clicked", async () => {
    const { host, showChats } = fakeHost({ click: "Show chat" });
    await notifyTurnEvent(done, host, english);
    expect(showChats()).toBe(1);
  });

  test("does nothing when the notification is closed without a click", async () => {
    const { host, shown, showChats } = fakeHost();
    await notifyTurnEvent(done, host, english);
    expect(shown).toHaveLength(1);
    expect(showChats()).toBe(0);
  });

  test("does nothing before the click", async () => {
    let click: (button: string | undefined) => void = () => {};
    const { host, showChats } = fakeHost();
    host.show = () => new Promise((resolve) => (click = resolve));
    const notified = notifyTurnEvent(done, host, english);
    await Bun.sleep(1);
    expect(showChats()).toBe(0);
    click("Show chat");
    await notified;
    expect(showChats()).toBe(1);
  });

  test("a chat that cannot be shown after the click says so, is logged, and never rejects", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { host, errors } = fakeHost({ click: "Show chat" });
      host.showChat = async () => {
        throw new Error("no view");
      };
      await notifyTurnEvent(done, host, english);
      expect(errors).toEqual(["Could not open the chat: Error: no view"]);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  test("a notification that cannot show is logged and never rejects", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { host, errors, showChats } = fakeHost();
      host.show = async () => {
        throw new Error("no window");
      };
      await notifyTurnEvent(done, host, english);
      expect(showChats()).toBe(0);
      expect(errors).toEqual([]);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });
});
