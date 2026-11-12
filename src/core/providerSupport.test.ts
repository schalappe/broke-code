import { describe, expect, test } from "bun:test";
import { ProviderSupport } from "./providerSupport";

const provider = { name: "Work", baseUrl: "https://llm.example/v1" };

describe("ProviderSupport usage field", () => {
  test("starts unknown", () => {
    expect(new ProviderSupport().usageField(provider, "m")).toBe("unknown");
  });

  test("A's refusal and resend, then B's started stream, leave the model accepting the field", () => {
    const support = new ProviderSupport();
    // A and B both left with the field while the model was unknown.
    support.usageFieldRefused(provider, "m");
    expect(support.usageField(provider, "m")).toBe("refuses");
    support.usageFieldAccepted(provider, "m");
    expect(support.usageField(provider, "m")).toBe("accepts");
  });

  test("B's started stream before A's refusal keeps the model accepting the field", () => {
    const support = new ProviderSupport();
    support.usageFieldAccepted(provider, "m");
    // A's 400 arrives now: the client resends only while the model is not "accepts".
    expect(support.usageField(provider, "m")).toBe("accepts");
    support.usageFieldRefused(provider, "m");
    expect(support.usageField(provider, "m")).toBe("accepts");
  });

  test("keeps models, base URLs, and names apart", () => {
    const support = new ProviderSupport();
    support.usageFieldRefused(provider, "m");
    expect(support.usageField(provider, "other")).toBe("unknown");
    expect(support.usageField({ ...provider, baseUrl: "https://llm2.example/v1" }, "m")).toBe("unknown");
    expect(support.usageField({ ...provider, name: "Home" }, "m")).toBe("unknown");
  });
});

describe("ProviderSupport characters per token", () => {
  /** The ratio after one sample of `characters` and `promptTokens` on a model that starts at `before`. */
  function after(before: number | undefined, characters: number, promptTokens: number): number {
    const support = new ProviderSupport();
    // [>]: A sample of exactly `before` at the floor: reaches the starting ratio without a second code path.
    if (before !== undefined) support.learnRatio(provider, "m", Math.round(before * 1000), 1000);
    support.learnRatio(provider, "m", characters, promptTokens);
    return support.ratio(provider, "m");
  }

  test.each([
    [undefined, 40_000, 12_500, 3.2],
    [undefined, 87_553, 23_350, 3.7],
    [3.7, 23_612, 6_711, 3.5],
    [3.5, 24_000, 5_934, 3.5],
    [undefined, 137_553, 16_387, 4],
    [undefined, 2_500, 1_500, 2],
    [undefined, 1_000, 600, 4],
  ])("from %p, %p characters for %p prompt tokens give %p", (before, characters, promptTokens, expected) => {
    expect(after(before, characters, promptTokens)).toBe(expected);
  });

  test("a model without a sample has 4", () => {
    expect(new ProviderSupport().ratio(provider, "m")).toBe(4);
  });

  test("samples 3.7, 3.5, then 3.9 leave 3.5", () => {
    const support = new ProviderSupport();
    support.learnRatio(provider, "m", 37_000, 10_000);
    support.learnRatio(provider, "m", 35_000, 10_000);
    support.learnRatio(provider, "m", 39_000, 10_000);
    expect(support.ratio(provider, "m")).toBe(3.5);
  });

  test("says whether the ratio went down", () => {
    const support = new ProviderSupport();
    expect(support.learnRatio(provider, "m", 35_000, 10_000)).toBe(true);
    expect(support.learnRatio(provider, "m", 35_000, 10_000)).toBe(false);
    expect(support.learnRatio(provider, "m", 39_000, 10_000)).toBe(false);
    expect(support.learnRatio(provider, "m", 2_000, 999)).toBe(false);
  });

  test("keeps models, base URLs, and names apart", () => {
    const support = new ProviderSupport();
    support.learnRatio(provider, "m", 32_000, 10_000);
    expect(support.ratio(provider, "m")).toBe(3.2);
    expect(support.ratio(provider, "other")).toBe(4);
    expect(support.ratio({ ...provider, baseUrl: "https://llm2.example/v1" }, "m")).toBe(4);
    expect(support.ratio({ ...provider, name: "Home" }, "m")).toBe(4);
  });

  test("the ratio and the usage field of one model live side by side", () => {
    const support = new ProviderSupport();
    support.usageFieldRefused(provider, "m");
    support.learnRatio(provider, "m", 32_000, 10_000);
    expect(support.usageField(provider, "m")).toBe("refuses");
    expect(support.ratio(provider, "m")).toBe(3.2);
  });
});
