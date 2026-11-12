import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendProvider, parseProviders, readCandidate } from "./providers";

describe("parseProviders", () => {
  test("keeps valid providers in order and drops a trailing slash from the base URL", () => {
    const result = parseProviders([
      { name: "Ollama", baseUrl: "http://localhost:11434/v1/" },
      { name: "Internal", baseUrl: "https://llm.example.com/api/v1" },
    ]);
    expect(result.providers).toEqual([
      { name: "Ollama", baseUrl: "http://localhost:11434/v1" },
      { name: "Internal", baseUrl: "https://llm.example.com/api/v1" },
    ]);
    expect(result.skipped).toEqual([]);
  });

  test("skips a provider whose base URL is not an http or https URL, and says why", () => {
    const result = parseProviders([
      { name: "Typo", baseUrl: "localhost:11434" },
      { name: "Relative", baseUrl: "/v1" },
      { name: "File", baseUrl: "file:///tmp/v1" },
      { name: "Ollama", baseUrl: "http://localhost:11434/v1" },
    ]);
    expect(result.providers).toEqual([{ name: "Ollama", baseUrl: "http://localhost:11434/v1" }]);
    expect(result.skipped).toEqual([
      { position: 1, name: "Typo", reason: "invalidUrl" },
      { position: 2, name: "Relative", reason: "invalidUrl" },
      { position: 3, name: "File", reason: "invalidUrl" },
    ]);
  });

  test("keeps the first provider of a duplicate name and skips the later ones", () => {
    const result = parseProviders([
      { name: "Ollama", baseUrl: "http://localhost:11434/v1" },
      { name: "Ollama", baseUrl: "http://other:11434/v1" },
    ]);
    expect(result.providers).toEqual([{ name: "Ollama", baseUrl: "http://localhost:11434/v1" }]);
    expect(result.skipped).toEqual([{ position: 2, name: "Ollama", reason: "duplicateName" }]);
  });

  test("skips an entry without a usable name", () => {
    const result = parseProviders([
      { baseUrl: "http://localhost:11434/v1" },
      { name: "  ", baseUrl: "http://a/v1" },
      "Ollama",
    ]);
    expect(result.providers).toEqual([]);
    expect(result.skipped).toEqual([
      { position: 1, reason: "missingName" },
      { position: 2, reason: "missingName" },
      { position: 3, reason: "missingName" },
    ]);
  });

  test("trims the name so a stray space cannot create a second provider", () => {
    const result = parseProviders([
      { name: "Ollama ", baseUrl: "http://localhost:11434/v1" },
      { name: "Ollama", baseUrl: "http://localhost:11434/v1" },
    ]);
    expect(result.providers).toEqual([{ name: "Ollama", baseUrl: "http://localhost:11434/v1" }]);
    expect(result.skipped).toEqual([{ position: 2, name: "Ollama", reason: "duplicateName" }]);
  });

  test("treats a setting that is not an array as no providers", () => {
    expect(parseProviders(undefined)).toEqual({ providers: [], skipped: [] });
    expect(parseProviders({ name: "Ollama" })).toEqual({ providers: [], skipped: [] });
  });

  test("keeps an absolute CA file path and expands a leading ~/ to the home directory", () => {
    const result = parseProviders([
      { name: "Absolute", baseUrl: "https://a.example/v1", caFile: "/etc/ssl/corp.pem" },
      { name: "Home", baseUrl: "https://b.example/v1", caFile: " ~/certs/corp.pem " },
    ]);
    expect(result.providers).toEqual([
      { name: "Absolute", baseUrl: "https://a.example/v1", caFile: "/etc/ssl/corp.pem" },
      { name: "Home", baseUrl: "https://b.example/v1", caFile: join(homedir(), "certs/corp.pem") },
    ]);
  });

  test("keeps a relative CA file path as written, to be reported when the provider is used", () => {
    const result = parseProviders([
      { name: "Relative", baseUrl: "https://a.example/v1", caFile: "certs/corp.pem" },
      { name: "OtherUser", baseUrl: "https://b.example/v1", caFile: "~bob/corp.pem" },
    ]);
    expect(result.providers.map((provider) => provider.caFile)).toEqual(["certs/corp.pem", "~bob/corp.pem"]);
    expect(result.skipped).toEqual([]);
  });

  test("treats a missing, empty, or non-string CA file as no CA file", () => {
    const result = parseProviders([
      { name: "None", baseUrl: "https://a.example/v1" },
      { name: "Empty", baseUrl: "https://b.example/v1", caFile: "  " },
      { name: "Number", baseUrl: "https://c.example/v1", caFile: 42 },
    ]);
    expect(result.providers).toEqual([
      { name: "None", baseUrl: "https://a.example/v1" },
      { name: "Empty", baseUrl: "https://b.example/v1" },
      { name: "Number", baseUrl: "https://c.example/v1" },
    ]);
  });
});

describe("readCandidate", () => {
  const current = [
    { name: "Internal", baseUrl: "https://llm.example.com/v1" },
    { name: "Broken", baseUrl: "not a url" },
  ];

  test("reads an entry the parser keeps as the provider it yields, its base URL without trailing slashes", () => {
    expect(readCandidate(current, { name: " Local ", baseUrl: " http://localhost:8080/v1// " })).toEqual({
      provider: { name: "Local", baseUrl: "http://localhost:8080/v1" },
    });
  });

  test("gives the parser's reason when it skips the entry", () => {
    expect(readCandidate(current, { name: "  ", baseUrl: "http://x/v1" })).toEqual({ reason: "missingName" });
    expect(readCandidate(current, { name: "Internal", baseUrl: "http://x/v1" })).toEqual({ reason: "duplicateName" });
    expect(readCandidate(current, { name: "New", baseUrl: "localhost:11434" })).toEqual({ reason: "invalidUrl" });
  });

  test("accepts a name used only by a skipped entry, and reads a non-array value as no entry", () => {
    expect(readCandidate(current, { name: "Broken", baseUrl: "http://x/v1" })).toEqual({
      provider: { name: "Broken", baseUrl: "http://x/v1" },
    });
    expect(readCandidate({ name: "Internal" }, { name: "Internal", baseUrl: "http://x/v1" })).toEqual({
      provider: { name: "Internal", baseUrl: "http://x/v1" },
    });
  });
});

describe("appendProvider", () => {
  test("keeps every existing entry as it is, skipped ones and caFile included, and appends the new one", () => {
    const current = [
      { name: "A", baseUrl: "https://a/v1", caFile: "~/ca.pem" },
      { baseUrl: "https://nameless/v1" },
      "garbage",
    ];
    const next = appendProvider(current, { name: "B", baseUrl: "http://b/v1" });
    expect(next).toEqual([...current, { name: "B", baseUrl: "http://b/v1" }]);
    expect(current).toHaveLength(3);
  });

  test("replaces a value that is not an array with the one-entry array", () => {
    for (const current of [undefined, null, { name: "A" }, "x"]) {
      expect(appendProvider(current, { name: "B", baseUrl: "http://b/v1" })).toEqual([
        { name: "B", baseUrl: "http://b/v1" },
      ]);
    }
  });
});
