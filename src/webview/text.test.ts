import { describe, expect, test } from "bun:test";
import { describeProviderError } from "./text";

describe("describeProviderError", () => {
  test("names the model list, not a reply, when the list download is cut off", () => {
    const text = describeProviderError({ kind: "cutOff", provider: "Ollama", reason: "listDropped", cause: "socket closed" });
    expect(text).toEqual({ message: "The model list from Ollama was cut off: the connection dropped.", detail: "socket closed" });
  });

  test("says a rejected request's body could not be read, with the cause", () => {
    const text = describeProviderError({ kind: "rejected", provider: "Ollama", status: 500, detail: "", bodyReadError: "socket closed" });
    expect(text).toEqual({
      message: "Ollama rejected the request (HTTP 500).",
      detail: "The response body could not be read: socket closed",
    });
  });

  test("shows a rejected request's body detail when it was read", () => {
    const text = describeProviderError({ kind: "rejected", provider: "Ollama", status: 404, detail: "model 'nope' not found" });
    expect(text).toEqual({ message: "Ollama rejected the request (HTTP 404).", detail: "model 'nope' not found" });
  });
});
