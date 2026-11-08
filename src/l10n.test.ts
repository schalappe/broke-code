import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// Repository root: parent of src.
const root = join(import.meta.dir, "..");

async function readJson(path: string): Promise<Record<string, string>> {
  return Bun.file(join(root, path)).json();
}

/** Source files of host and webview, tests excluded. */
async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(join(root, "src"), { recursive: true });
  return entries.filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)).map((path) => join(root, "src", path));
}

/** Messages passed to `vscode.l10n.t` and `@vscode/l10n` `l10n.t`, by file. */
async function usedMessages(): Promise<{ messages: Set<string>; nonLiteralCalls: string[] }> {
  const messages = new Set<string>();
  const nonLiteralCalls: string[] = [];
  for (const file of await sourceFiles()) {
    const source = await Bun.file(file).text();
    const calls = source.match(/\bl10n\.t\(/g)?.length ?? 0;
    const literals = [...source.matchAll(/\bl10n\.t\(\s*("(?:[^"\\]|\\.)*")/g)].map((match) => JSON.parse(match[1]!) as string);
    if (literals.length !== calls) nonLiteralCalls.push(file);
    for (const message of literals) messages.add(message);
  }
  return { messages, nonLiteralCalls };
}

function placeholders(message: string): string[] {
  return [...new Set(message.match(/\{\d+\}/g) ?? [])].sort();
}

describe("localization", () => {
  test("every l10n.t call takes a double-quoted literal, so this test can see every key", async () => {
    const { messages, nonLiteralCalls } = await usedMessages();
    expect(nonLiteralCalls).toEqual([]);
    expect(messages.size).toBeGreaterThan(0);
  });

  test("the French bundle translates every message used by the host and the webview, and nothing else", async () => {
    const { messages } = await usedMessages();
    const french = await readJson("l10n/bundle.l10n.fr.json");
    expect(Object.keys(french).filter((key) => !messages.has(key))).toEqual([]);
    expect([...messages].filter((message) => !(message in french))).toEqual([]);
  });

  test("each French message keeps the placeholders of its English key", async () => {
    const french = await readJson("l10n/bundle.l10n.fr.json");
    const mismatched = Object.entries(french).filter(([key, value]) => placeholders(key).join() !== placeholders(value).join());
    expect(mismatched).toEqual([]);
  });

  test("package.nls.fr.json matches package.nls.json key for key", async () => {
    const english = Object.keys(await readJson("package.nls.json")).sort();
    const french = Object.keys(await readJson("package.nls.fr.json")).sort();
    expect(french).toEqual(english);
  });

  test("every %key% in package.json exists in package.nls.json", async () => {
    const manifest = await Bun.file(join(root, "package.json")).text();
    const english = await readJson("package.nls.json");
    const keys = [...manifest.matchAll(/"%([^%"]+)%"/g)].map((match) => match[1]!);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => !(key in english))).toEqual([]);
  });
});
