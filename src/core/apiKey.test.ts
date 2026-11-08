import { describe, expect, test } from "bun:test";
import { isHeaderSafeKey } from "./apiKey";

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
