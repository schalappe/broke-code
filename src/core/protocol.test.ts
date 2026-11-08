import { describe, expect, test } from "bun:test";
import { MAX_MENTION_PATH_LENGTH, MAX_PICKED_MENTIONS, MAX_QUERY_LENGTH, parseWebviewMessage } from "./protocol";

describe("parseWebviewMessage", () => {
  test("accepts the messages without fields and those with a string field", () => {
    expect(parseWebviewMessage({ type: "stop" })).toEqual({ type: "stop" });
    expect(parseWebviewMessage({ type: "selectModel", model: "m" })).toEqual({ type: "selectModel", model: "m" });
    expect(parseWebviewMessage({ type: "setApiKey", provider: "P" })).toEqual({ type: "setApiKey", provider: "P" });
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

  test("rejects a send whose mentions are missing, not strings, empty, too long, or too many", () => {
    const send = (mentions: unknown) => parseWebviewMessage({ type: "send", text: "hi", mentions });
    expect(send(undefined)).toBeUndefined();
    expect(send("a.ts")).toBeUndefined();
    expect(send([1])).toBeUndefined();
    expect(send([""])).toBeUndefined();
    expect(send(["a".repeat(MAX_MENTION_PATH_LENGTH + 1)])).toBeUndefined();
    expect(send(Array.from({ length: MAX_PICKED_MENTIONS + 1 }, (_, index) => `f${index}`))).toBeUndefined();
    expect(send(["a".repeat(MAX_MENTION_PATH_LENGTH)])).toBeDefined();
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
});
