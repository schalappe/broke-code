import { describe, expect, test } from "bun:test";
import type { SkillProblem } from "../core/protocol";
import {
  describeContextUsage,
  describeFold,
  describeProviderError,
  describeSkillWarning,
  describeStorageProblem,
  formatConversationDate,
} from "./text";

describe("describeProviderError", () => {
  test("names the model list, not a reply, when the list download is cut off", () => {
    const text = describeProviderError({
      kind: "cutOff",
      provider: "Ollama",
      reason: "listDropped",
      cause: "socket closed",
    });
    expect(text).toEqual({
      message: "The model list from Ollama was cut off: the connection dropped.",
      detail: "socket closed",
    });
  });

  test("says a rejected request's body could not be read, with the cause", () => {
    const text = describeProviderError({
      kind: "rejected",
      provider: "Ollama",
      status: 500,
      detail: "",
      bodyReadError: "socket closed",
    });
    expect(text).toEqual({
      message: "Ollama rejected the request (HTTP 500).",
      detail: "The response body could not be read: socket closed",
    });
  });

  test("shows a rejected request's body detail when it was read", () => {
    const text = describeProviderError({
      kind: "rejected",
      provider: "Ollama",
      status: 404,
      detail: "model 'nope' not found",
    });
    expect(text).toEqual({ message: "Ollama rejected the request (HTTP 404).", detail: "model 'nope' not found" });
  });

  test("names the provider and the failure of an untrusted certificate, and points to the CA file setting", () => {
    const text = describeProviderError({
      kind: "certificate",
      provider: "Corp",
      baseUrl: "https://llm.corp/v1",
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
    expect(text).toEqual({
      message:
        "Corp presented a certificate that is not trusted (DEPTH_ZERO_SELF_SIGNED_CERT). If it uses a corporate or self-signed certificate, set its CA file in the provider settings.",
      detail: "https://llm.corp/v1",
    });
  });

  test("names the path of an unusable CA file, with the reason in the detail", () => {
    expect(
      describeProviderError({
        kind: "caFileInvalid",
        provider: "Corp",
        path: "/x.pem",
        reason: "unreadable",
        cause: "ENOENT",
      }),
    ).toEqual({
      message: "The CA file of Corp could not be read: /x.pem",
      detail: "ENOENT",
    });
    expect(
      describeProviderError({
        kind: "caFileInvalid",
        provider: "Corp",
        path: "/x.pem",
        reason: "notPem",
        cause: "no block",
      }),
    ).toEqual({
      message: "The CA file of Corp is not a PEM certificate: /x.pem",
      detail: "no block",
    });
    expect(
      describeProviderError({ kind: "caFileInvalid", provider: "Corp", path: "x.pem", reason: "relative" }),
    ).toEqual({
      message: "The CA file of Corp must be an absolute path or start with ~/: x.pem",
    });
  });

  test("names an unsupported compression instead of a wrong base URL, in listing and chat alike", () => {
    expect(describeProviderError({ kind: "invalidResponse", provider: "Corp", detail: "", encoding: "zstd" })).toEqual({
      message: "Corp answered with a compression that broke-code cannot read (Content-Encoding: zstd).",
    });
  });
});

describe("formatConversationDate", () => {
  const noon = new Date(2026, 10, 8, 12).getTime();

  test("writes the date in the display language", () => {
    expect(formatConversationDate(noon, "en")).toContain("Nov 8, 2026");
    expect(formatConversationDate(noon, "fr")).toContain("8 nov. 2026");
  });

  test("falls back to the runtime's language for a tag it cannot use", () => {
    expect(formatConversationDate(noon, "not a tag!")).toContain("2026");
  });
});

describe("describeStorageProblem", () => {
  test("says what failed, with the runtime cause as detail", () => {
    expect(describeStorageProblem({ kind: "saveFailed", cause: "Error: ENOSPC" })).toEqual({
      message: "Could not save the conversation.",
      detail: "Error: ENOSPC",
    });
  });

  test("says a conversation to open is gone, with no detail", () => {
    expect(describeStorageProblem({ kind: "notFound" })).toEqual({
      message: "This conversation is missing or unreadable; it was removed from the list.",
    });
  });
});

describe("describeContextUsage", () => {
  test("writes the estimate, the size, and the share used, in the display language", () => {
    expect(describeContextUsage({ used: 12345, size: 32768, known: true }, "en")).toBe("12,345 / 32,768 tokens (38%)");
    expect(describeContextUsage({ used: 12345, size: 32768, known: true }, "fr")).toBe(
      "12\u202f345 / 32\u202f768 tokens (38\u00a0%)",
    );
  });

  test("falls back to the runtime's language for a tag it cannot use", () => {
    expect(describeContextUsage({ used: 0, size: 1000, known: false }, "not a tag!")).toContain("0%");
  });
});

describe("describeSkillWarning", () => {
  test("names the file and each problem", () => {
    const path = "app/.agents/skills/x/SKILL.md";
    const text = (problem: SkillProblem) => describeSkillWarning({ path, problem });
    const prefix = `Skill ${path} is skipped: `;
    expect(text({ kind: "noFrontmatter" })).toBe(`${prefix}it has no frontmatter between --- lines.`);
    expect(text({ kind: "missingName" })).toBe(`${prefix}it lacks a name.`);
    expect(text({ kind: "nameTooLong" })).toBe(`${prefix}its name is longer than 64 characters.`);
    expect(text({ kind: "invalidName" })).toBe(
      `${prefix}its name is not lowercase letters, digits, and single hyphens, with no hyphen at either end.`,
    );
    expect(text({ kind: "nameMismatch", name: "y", directory: "x" })).toBe(
      `${prefix}its name y differs from its folder x.`,
    );
    expect(text({ kind: "unparsableField", field: "description" })).toBe(
      `${prefix}its description cannot be read; write it as plain, quoted, or > or | block text.`,
    );
    expect(text({ kind: "missingDescription" })).toBe(`${prefix}it lacks a description.`);
    expect(text({ kind: "descriptionTooLong" })).toBe(`${prefix}its description is longer than 1024 characters.`);
    expect(text({ kind: "tooLarge" })).toBe(`${prefix}the file is over 1 MiB.`);
    expect(text({ kind: "binary" })).toBe(`${prefix}the file is not text.`);
    expect(text({ kind: "outsideWorkspace" })).toBe(`${prefix}it links outside the workspace.`);
    expect(text({ kind: "unreadable", cause: "EACCES" })).toBe(`${prefix}the file cannot be read (EACCES).`);
  });

  test("names the skills folder whose entries past the cap are skipped", () => {
    expect(describeSkillWarning({ path: ".agents/skills", problem: { kind: "tooManyEntries", entries: 5000 } })).toBe(
      "Some skills in .agents/skills are skipped: the folder holds 5000 entries, and only the first 200 by name are read.",
    );
  });
});

describe("describeFold", () => {
  test("says the steps, then the failed and rejected ones when there are any", () => {
    expect(describeFold({ steps: 2, failed: 0, rejected: 0 })).toBe("2 steps");
    expect(describeFold({ steps: 3, failed: 1, rejected: 0 })).toBe("3 steps, 1 failed");
    expect(describeFold({ steps: 3, failed: 2, rejected: 1 })).toBe("3 steps, 2 failed, 1 rejected");
    expect(describeFold({ steps: 4, failed: 0, rejected: 1 })).toBe("4 steps, 1 rejected");
  });
});
