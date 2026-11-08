import { describe, expect, test } from "bun:test";
import { parseProviders } from "./providers";

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
    const result = parseProviders([{ baseUrl: "http://localhost:11434/v1" }, { name: "  ", baseUrl: "http://a/v1" }, "Ollama"]);
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
});
