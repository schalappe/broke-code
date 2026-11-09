import { describe, expect, test } from "bun:test";
import type { ChatEntry } from "../src/core/protocol";
import { judge, READ_SCENARIO } from "./scenarios";

const VALUE = "kestrel-4471-vanta";
const user: ChatEntry = { role: "user", content: READ_SCENARIO.message, mentions: [] };
type Reply = ChatEntry & { role: "assistant" };
const callReply = (name: string, path: string): Reply => ({
  role: "assistant",
  reasoning: "",
  content: `<${name}>\n<path>${path}</path>\n</${name}>`,
  status: "done",
  call: { name, args: { path }, start: 0, end: 0 },
});
const step = (name: string, path: string, text: string, status: "ok" | "error" = "ok"): ChatEntry => ({
  role: "tool",
  name,
  args: { path },
  status,
  text,
});
const answer = (content: string): Reply => ({ role: "assistant", reasoning: "", content, status: "done" });
const settingsText = `@config/settings.toml (file, 9 lines)\n\`\`\`\n${READ_SCENARIO.files["config/settings.toml"]}\`\`\``;
const readTarget = [
  callReply("read_file", "config/settings.toml"),
  step("read_file", "config/settings.toml", settingsText),
];
const untouched = { ...READ_SCENARIO.files };

describe("read scenario fixture", () => {
  test("holds the value in the settings file only, so a tool result holding it read that file", () => {
    const holders = Object.entries(READ_SCENARIO.files)
      .filter(([, text]) => text.includes(VALUE))
      .map(([path]) => path);
    expect(holders).toEqual(["config/settings.toml"]);
    expect(READ_SCENARIO.message).not.toContain(VALUE);
  });
});

describe("judge on the read scenario", () => {
  test("passes a turn that read the settings file and answered with the value", () => {
    const entries = [user, ...readTarget, answer(`The route seed is \`${VALUE}\`.`)];
    expect(judge(READ_SCENARIO, entries, untouched)).toEqual({ pass: true });
  });

  test("passes a turn that recovered from a malformed call", () => {
    const entries: ChatEntry[] = [
      user,
      answer("<read_file>\n<path>config/settings.toml</path>"),
      { role: "tool", name: "read_file", args: {}, status: "malformed", text: "<read_file> is not closed." },
      ...readTarget,
      answer(VALUE),
    ];
    expect(judge(READ_SCENARIO, entries, untouched)).toEqual({ pass: true });
  });

  test("wrongAnswer: the turn read the file but the answer lacks the value", () => {
    const entries = [user, ...readTarget, answer("The route seed is 4471.")];
    expect(judge(READ_SCENARIO, entries, untouched)).toMatchObject({ pass: false, category: "wrongAnswer" });
  });

  test("wrongTool: the turn ended without a tool result holding the value, whatever the answer", () => {
    const entries = [
      user,
      callReply("read_file", "README.md"),
      step("read_file", "README.md", "@README.md (file, 3 lines)"),
      answer(`It is ${VALUE}.`),
    ];
    const verdict = judge(READ_SCENARIO, entries, untouched);
    expect(verdict).toMatchObject({ pass: false, category: "wrongTool" });
    expect(verdict).toMatchObject({ detail: expect.stringContaining("read_file(path=README.md) ok") });
  });

  test("malformed: a done turn that misses the check after a malformed call", () => {
    const entries: ChatEntry[] = [
      user,
      answer("<read_file>\n<path>config/settings.toml</path>"),
      { role: "tool", name: "read_file", args: {}, status: "malformed", text: "<read_file> is not closed." },
      answer("I could not read the file."),
    ];
    expect(judge(READ_SCENARIO, entries, untouched)).toMatchObject({ pass: false, category: "malformed" });
  });

  test("malformed: a turn halted after three malformed calls in a row", () => {
    const malformed: ChatEntry = { role: "tool", name: "unknown", args: {}, status: "malformed", text: "No call." };
    const entries: ChatEntry[] = [
      user,
      answer("<x"),
      malformed,
      answer("<x"),
      malformed,
      { ...answer("<x"), status: "halted", haltReason: "malformedCalls" },
      malformed,
    ];
    expect(judge(READ_SCENARIO, entries, untouched)).toMatchObject({ pass: false, category: "malformed" });
  });

  test("stepLimit: a turn halted at its step limit", () => {
    const entries: ChatEntry[] = [
      user,
      callReply("list_files", "."),
      step("list_files", ".", "@. (folder, 2 entries)"),
      { ...callReply("list_files", "."), status: "halted", haltReason: "stepLimit" },
      step("list_files", ".", "@. (folder, 2 entries)"),
    ];
    expect(judge(READ_SCENARIO, entries, untouched)).toMatchObject({ pass: false, category: "stepLimit" });
  });

  test("contextFull: a turn halted before a request that would fill the context", () => {
    const entries: ChatEntry[] = [user, ...readTarget, { ...answer(""), status: "halted", haltReason: "contextFull" }];
    expect(judge(READ_SCENARIO, entries, untouched)).toMatchObject({ pass: false, category: "contextFull" });
  });

  test("providerError: a failed reply, with its error in the detail", () => {
    const entries: ChatEntry[] = [
      user,
      {
        ...answer(""),
        status: "failed",
        error: { kind: "unreachable", provider: "Ollama", baseUrl: "http://localhost:11434/v1", cause: "ECONNREFUSED" },
      },
    ];
    const verdict = judge(READ_SCENARIO, entries, untouched);
    expect(verdict).toMatchObject({ pass: false, category: "providerError" });
    expect(verdict).toMatchObject({ detail: expect.stringContaining("ECONNREFUSED") });
  });

  test("workspaceChanged: the fixture copy differs from the fixture after the run", () => {
    const entries = [user, ...readTarget, answer(VALUE)];
    const changed = { ...untouched, "config/settings.toml": "route_seed = 1\n" };
    expect(judge(READ_SCENARIO, entries, changed)).toMatchObject({
      pass: false,
      category: "workspaceChanged",
      detail: expect.stringContaining("config/settings.toml"),
    });
    const added = { ...untouched, "notes.txt": "" };
    expect(judge(READ_SCENARIO, entries, added)).toMatchObject({ category: "workspaceChanged" });
  });

  test("throws on a turn that never ended, since the bench never stops one", () => {
    const entries: ChatEntry[] = [user, { ...answer("Partial"), status: "stopped" }];
    expect(() => judge(READ_SCENARIO, entries, untouched)).toThrow("stopped");
  });
});
