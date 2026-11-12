import { describe, expect, test } from "bun:test";
import {
  type ChatState,
  chatStateOf,
  MAX_MENTION_PATH_LENGTH,
  MAX_QUERY_LENGTH,
  parseWebviewMessage,
  REPLY_MAX_LENGTH,
} from "./protocol";

describe("parseWebviewMessage", () => {
  test("accepts the messages without fields and those with a string field", () => {
    expect(parseWebviewMessage({ type: "stop" })).toEqual({ type: "stop" });
    expect(parseWebviewMessage({ type: "addProvider", name: "ignored" })).toEqual({ type: "addProvider" });
    expect(parseWebviewMessage({ type: "chooseModel", model: "ignored" })).toEqual({ type: "chooseModel" });
    expect(parseWebviewMessage({ type: "selectModel", model: "m" })).toEqual({ type: "selectModel", model: "m" });
    expect(parseWebviewMessage({ type: "setApiKey", provider: "P" })).toEqual({ type: "setApiKey", provider: "P" });
  });

  test("accepts a context size request for a named model only", () => {
    expect(parseWebviewMessage({ type: "setContextSize", model: "qwen3:8b" })).toEqual({
      type: "setContextSize",
      model: "qwen3:8b",
    });
    for (const model of [undefined, "", 3]) {
      expect(parseWebviewMessage({ type: "setContextSize", model })).toBeUndefined();
    }
  });

  test("rejects a non-object, an unknown type, and a missing string field", () => {
    for (const raw of [
      null,
      "send",
      3,
      { type: "nope" },
      { type: "selectModel" },
      { type: "setApiKey", provider: 1 },
    ]) {
      expect(parseWebviewMessage(raw)).toBeUndefined();
    }
  });

  test("accepts a send with its picked mention paths", () => {
    expect(parseWebviewMessage({ type: "send", text: "hi @my file.ts", mentions: ["my file.ts"] })).toEqual({
      type: "send",
      text: "hi @my file.ts",
      mentions: ["my file.ts"],
    });
  });

  test("accepts any number of picked mentions, since the text bounds which ones count", () => {
    const picked = Array.from({ length: 101 }, (_, index) => `my file ${index}.ts`);
    expect(parseWebviewMessage({ type: "send", text: "hi", mentions: picked })).toMatchObject({ mentions: picked });
  });

  test("rejects a send whose mentions are missing, not strings, empty, or too long", () => {
    const send = (mentions: unknown) => parseWebviewMessage({ type: "send", text: "hi", mentions });
    expect(send(undefined)).toBeUndefined();
    expect(send("a.ts")).toBeUndefined();
    expect(send([1])).toBeUndefined();
    expect(send([""])).toBeUndefined();
    expect(send(["a".repeat(MAX_MENTION_PATH_LENGTH + 1)])).toBeUndefined();
    expect(send(["a".repeat(MAX_MENTION_PATH_LENGTH)])).toBeDefined();
  });

  test("accepts opening and deleting a conversation by its id", () => {
    const id = "0b0d4c1e-8f9a-4c3b-9d2e-1a2b3c4d5e6f";
    expect(parseWebviewMessage({ type: "openConversation", id })).toEqual({ type: "openConversation", id });
    expect(parseWebviewMessage({ type: "deleteConversation", id })).toEqual({ type: "deleteConversation", id });
  });

  test("rejects a conversation id that is not one the host makes, so no other file can be named", () => {
    for (const type of ["openConversation", "deleteConversation"]) {
      for (const id of [undefined, 3, "", "../x", "a/b", "0b0d4c1e-8f9a-4c3b-9d2e-1a2b3c4d5e6f.json", "conversation"]) {
        expect(parseWebviewMessage({ type, id })).toBeUndefined();
      }
    }
  });

  test("accepts a file query with an integer id", () => {
    expect(parseWebviewMessage({ type: "queryFiles", query: "src/co", id: 7 })).toEqual({
      type: "queryFiles",
      query: "src/co",
      id: 7,
    });
    expect(parseWebviewMessage({ type: "queryFiles", query: "", id: 0 })).toBeDefined();
  });

  test("rejects a file query with a bad id or an over-long query", () => {
    const query = (fields: Record<string, unknown>) => parseWebviewMessage({ type: "queryFiles", ...fields });
    expect(query({ query: "a" })).toBeUndefined();
    expect(query({ query: "a", id: "1" })).toBeUndefined();
    expect(query({ query: "a", id: 1.5 })).toBeUndefined();
    expect(query({ query: "a", id: -1 })).toBeUndefined();
    expect(query({ id: 1 })).toBeUndefined();
    expect(query({ query: "a".repeat(MAX_QUERY_LENGTH + 1), id: 1 })).toBeUndefined();
  });

  test("accepts a skill query with an integer id and drops one without a valid id", () => {
    expect(parseWebviewMessage({ type: "querySkills", id: 4 })).toEqual({ type: "querySkills", id: 4 });
    expect(parseWebviewMessage({ type: "querySkills", id: 0 })).toEqual({ type: "querySkills", id: 0 });
    for (const id of [undefined, "4", 1.5, -1, Number.NaN]) {
      expect(parseWebviewMessage({ type: "querySkills", id })).toBeUndefined();
    }
  });

  test("accepts an approval decision by its request id, a rejection with or without a reason", () => {
    expect(parseWebviewMessage({ type: "approve", id: 3 })).toEqual({ type: "approve", id: 3 });
    expect(parseWebviewMessage({ type: "reject", id: 3 })).toEqual({ type: "reject", id: 3 });
    expect(parseWebviewMessage({ type: "reject", id: 3, reason: "Keep the old name." })).toEqual({
      type: "reject",
      id: 3,
      reason: "Keep the old name.",
    });
  });

  test("rejects an approval decision with a bad id or a reason that is not text", () => {
    for (const id of [undefined, "3", 1.5, -1, Number.NaN]) {
      expect(parseWebviewMessage({ type: "approve", id })).toBeUndefined();
      expect(parseWebviewMessage({ type: "reject", id })).toBeUndefined();
    }
    for (const reason of [null, 3, ["no"]]) {
      expect(parseWebviewMessage({ type: "reject", id: 3, reason })).toBeUndefined();
    }
  });
  test("accepts an insert of a code block's text up to the reply length cap, the empty text included", () => {
    expect(parseWebviewMessage({ type: "insertCode", text: "a\nb" })).toEqual({ type: "insertCode", text: "a\nb" });
    expect(parseWebviewMessage({ type: "insertCode", text: "" })).toEqual({ type: "insertCode", text: "" });
    const atCap = "a".repeat(REPLY_MAX_LENGTH);
    expect(parseWebviewMessage({ type: "insertCode", text: atCap })).toEqual({ type: "insertCode", text: atCap });
  });

  test("drops an insert without text, with text that is not a string, or with text over the cap", () => {
    expect(parseWebviewMessage({ type: "insertCode" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "insertCode", text: 3 })).toBeUndefined();
    expect(parseWebviewMessage({ type: "insertCode", text: ["a"] })).toBeUndefined();
    expect(parseWebviewMessage({ type: "insertCode", text: "a".repeat(REPLY_MAX_LENGTH + 1) })).toBeUndefined();
  });
  test("accepts a mode pick of Ask, Auto-edit, or Plan", () => {
    expect(parseWebviewMessage({ type: "setMode", mode: "ask" })).toEqual({ type: "setMode", mode: "ask" });
    expect(parseWebviewMessage({ type: "setMode", mode: "autoEdit" })).toEqual({ type: "setMode", mode: "autoEdit" });
    expect(parseWebviewMessage({ type: "setMode", mode: "plan" })).toEqual({ type: "setMode", mode: "plan" });
  });

  test("accepts a queued message with its picked mention paths, as a send", () => {
    expect(parseWebviewMessage({ type: "queueMessage", text: "then @my file.ts", mentions: ["my file.ts"] })).toEqual({
      type: "queueMessage",
      text: "then @my file.ts",
      mentions: ["my file.ts"],
    });
  });

  test("drops a queued message with a bad shape", () => {
    for (const raw of [
      { type: "queueMessage", text: 5, mentions: [] },
      { type: "queueMessage", mentions: [] },
      { type: "queueMessage", text: "hi" },
      { type: "queueMessage", text: "hi", mentions: [""] },
      { type: "queueMessage", text: "hi", mentions: ["a".repeat(MAX_MENTION_PATH_LENGTH + 1)] },
    ]) {
      expect(parseWebviewMessage(raw)).toBeUndefined();
    }
  });

  test("accepts removing and sending now a queued message by its id, and drops any other id", () => {
    for (const type of ["removeQueued", "sendQueued"] as const) {
      expect(parseWebviewMessage({ type, id: 3 })).toEqual({ type, id: 3 });
      for (const id of [undefined, "3", -1, 1.5, Number.NaN, null]) {
        expect(parseWebviewMessage({ type, id })).toBeUndefined();
      }
    }
  });

  test("drops a mode pick of an unknown mode", () => {
    for (const mode of [undefined, "Plan", "Ask", "auto", "", true, 1, ["ask"]]) {
      expect(parseWebviewMessage({ type: "setMode", mode })).toBeUndefined();
    }
  });
});

describe("chatStateOf", () => {
  const state: ChatState = {
    providers: [],
    skipped: [],
    skillWarnings: [],
    provider: undefined,
    models: { status: "noProvider" },
    model: undefined,
    conversationId: "0b0d4c1e-8f9a-4c3b-9d2e-1a2b3c4d5e6f",
    entries: [],
    conversations: [],
    listFailed: undefined,
    storageProblem: undefined,
    context: { used: 0, size: 32768, known: false },
    mode: "ask",
    modePending: false,
    queue: [],
  };

  test("takes the chat state from init and state messages", () => {
    expect(chatStateOf({ type: "init", l10n: undefined, state })).toBe(state);
    expect(chatStateOf({ type: "state", state })).toBe(state);
  });

  test("leaves the chat state alone for file and skill suggestions", () => {
    expect(chatStateOf({ type: "fileSuggestions", id: 1, items: [], capped: false, failed: false })).toBeUndefined();
    expect(chatStateOf({ type: "skillSuggestions", id: 1, items: [], failed: false })).toBeUndefined();
  });

  test("leaves the chat state alone for a draft", () => {
    expect(chatStateOf({ type: "insertDraft", text: "@selection", mode: "caret", picked: [] })).toBeUndefined();
  });
});
