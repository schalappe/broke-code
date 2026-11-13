import { describe, expect, test } from "bun:test";
import { describeProviderError } from "./providerError";

const french = { t: (message: string, ...args: (string | number | boolean)[]) => `fr:${message}|${args.join(",")}` };

describe("describeProviderError", () => {
  test("words the error through the translator it is given, with the provider's detail untranslated", () => {
    expect(
      describeProviderError(
        { kind: "rejected", provider: "Ollama", status: 404, detail: "model 'nope' not found" },
        french,
      ),
    ).toEqual({ message: "fr:{0} rejected the request (HTTP {1}).|Ollama,404", detail: "model 'nope' not found" });
  });

  test("translates a detail broke-code writes itself", () => {
    expect(
      describeProviderError(
        { kind: "rejected", provider: "Ollama", status: 500, detail: "", bodyReadError: "socket closed" },
        french,
      ),
    ).toEqual({
      message: "fr:{0} failed to answer the request (HTTP {1}).|Ollama,500",
      detail: "fr:The response body could not be read: {0}|socket closed",
    });
  });
});
