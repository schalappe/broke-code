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
