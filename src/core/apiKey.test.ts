import { describe, expect, test } from "bun:test";
import { apiKeyBox, isHeaderSafeKey } from "./apiKey";

describe("isHeaderSafeKey", () => {
  test("accepts an empty key and visible ASCII keys", () => {
    expect(isHeaderSafeKey("")).toBe(true);
    expect(isHeaderSafeKey("sk-abc_123.XYZ~!")).toBe(true);
  });

  test("refuses characters an HTTP header cannot carry", () => {
    for (const key of ["k€y", "line\nbreak", "with space", "tab\tkey", "nul\u0000"]) {
      expect(isHeaderSafeKey(key)).toBe(false);
    }
  });
});

describe("apiKeyBox", () => {
  const french = { t: (message: string, ...args: (string | number | boolean)[]) => `fr:${message}|${args.join(",")}` };

  test("describes the password box of a provider's key, a new one or a change, through the translator", () => {
    const fresh = apiKeyBox("Lab", "new", french);
    expect(fresh.title).toBe("fr:API key for {0}|Lab");
    expect(fresh.prompt).toBe("fr:broke-code sends this key to {0} as a bearer token.|Lab");
    expect(fresh.placeholder).toBe("fr:Leave empty for a provider that needs no key, such as Ollama|");
    expect(apiKeyBox("Lab", "change", french).prompt).toBe(
      "fr:Enter a new key to set or replace it. Leave empty to clear it.|",
    );
  });

  test("accepts what the shape check accepts once trimmed, the empty key included", () => {
    const { validate } = apiKeyBox("Lab", "new", french);
    expect(validate(" sk-1 ")).toBeUndefined();
    expect(validate("")).toBeUndefined();
    expect(validate("sk 1")).toBe(
      "fr:An API key can contain only visible ASCII characters, with no spaces or accents.|",
    );
  });
});
