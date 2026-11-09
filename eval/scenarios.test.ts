import { describe, expect, test } from "bun:test";
import type { ChatEntry } from "../src/core/protocol";
import { CREATE_SCENARIO, EDIT_SCENARIO, judge, READ_SCENARIO, SCENARIOS, workspaceChanges } from "./scenarios";

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

const PRICING = "src/pricing.py";
const OLD_NAME = "compute_surcharge_v2";
const NEW_NAME = "distance_surcharge";
const editUser: ChatEntry = { role: "user", content: EDIT_SCENARIO.message, mentions: [] };
const editCall: Reply = {
  role: "assistant",
  reasoning: "",
  content: "<edit_file>…</edit_file>",
  status: "done",
  call: { name: "edit_file", args: { path: PRICING, old: OLD_NAME, new: NEW_NAME }, start: 0, end: 0 },
};
const editStep: ChatEntry = {
  role: "tool",
  name: "edit_file",
  args: { path: PRICING, old: OLD_NAME, new: NEW_NAME },
  status: "ok",
  text: `edit_file: replaced the passage in ${PRICING}.`,
};
const edited = [editUser, editCall, editStep, answer(`Renamed ${OLD_NAME} to ${NEW_NAME}.`)];
const pricingBefore = EDIT_SCENARIO.files[PRICING] ?? "";
const renamed = { ...EDIT_SCENARIO.files, [PRICING]: pricingBefore.replace(OLD_NAME, NEW_NAME) };

describe("edit scenario fixture", () => {
  test("names the identifier once, on one line, so exactly that line changes", () => {
    expect(pricingBefore.split(OLD_NAME)).toHaveLength(2);
    expect(pricingBefore).not.toContain(NEW_NAME);
    expect(EDIT_SCENARIO.message).toContain(OLD_NAME);
    expect(EDIT_SCENARIO.message).toContain(NEW_NAME);
    expect(EDIT_SCENARIO.writes[PRICING]).toBe(
      pricingBefore.replace(`def ${OLD_NAME}(distance_km):`, `def ${NEW_NAME}(distance_km):`),
    );
  });
});

describe("judge on the edit scenario", () => {
  test("passes a done turn that renamed the identifier and changed nothing else", () => {
    expect(judge(EDIT_SCENARIO, edited, renamed)).toEqual({ pass: true });
  });

  test("passes a whole-file rewrite that leaves the same bytes", () => {
    const step: ChatEntry = { role: "tool", name: "write_file", args: {}, status: "ok", text: "write_file: replaced." };
    expect(judge(EDIT_SCENARIO, [editUser, editCall, step, answer("Done.")], renamed)).toEqual({ pass: true });
  });

  test("wrongEdit: the line changed but another byte of the file did too, with the first differing line", () => {
    const sloppy = { ...renamed, [PRICING]: `${renamed[PRICING]}\n` };
    const verdict = judge(EDIT_SCENARIO, edited, sloppy);
    expect(verdict).toMatchObject({ pass: false, category: "wrongEdit", detail: expect.stringContaining(PRICING) });
    const reformatted = { ...renamed, [PRICING]: (renamed[PRICING] ?? "").replace("    return 0.1", "  return 0.1") };
    expect(judge(EDIT_SCENARIO, edited, reformatted)).toMatchObject({
      category: "wrongEdit",
      detail: `${PRICING} line 15: expected "    return 0.1 * distance_km", got "  return 0.1 * distance_km"`,
    });
  });

  test("wrongEdit: the file was left as it was, even when the rename went to another file", () => {
    expect(judge(EDIT_SCENARIO, edited, EDIT_SCENARIO.files)).toMatchObject({ pass: false, category: "wrongEdit" });
    const elsewhere = { ...EDIT_SCENARIO.files, "pricing.py": renamed[PRICING] ?? "" };
    expect(judge(EDIT_SCENARIO, edited, elsewhere)).toMatchObject({
      category: "wrongEdit",
      detail: expect.stringContaining("pricing.py"),
    });
  });

  test("workspaceChanged: the rename is right but another file changed", () => {
    const extra = { ...renamed, "src/main.py": "" };
    expect(judge(EDIT_SCENARIO, edited, extra)).toMatchObject({
      pass: false,
      category: "workspaceChanged",
      detail: "changed: src/main.py",
    });
  });

  test("a turn that did not end done fails on its own category, whatever the file holds", () => {
    const halted = [...edited.slice(0, -1), { ...answer(""), status: "halted", haltReason: "stepLimit" } as Reply];
    expect(judge(EDIT_SCENARIO, halted, renamed)).toMatchObject({ pass: false, category: "stepLimit" });
    const failed = [...edited.slice(0, -1), { ...answer(""), status: "failed" } as Reply];
    expect(judge(EDIT_SCENARIO, failed, renamed)).toMatchObject({ pass: false, category: "providerError" });
  });

  test("malformed: a wrong edit after a malformed call", () => {
    const entries: ChatEntry[] = [
      editUser,
      answer("<edit_file>\n<path>src/pricing.py</path>"),
      { role: "tool", name: "edit_file", args: {}, status: "malformed", text: "<edit_file> is not closed." },
      answer("I could not edit the file."),
    ];
    expect(judge(EDIT_SCENARIO, entries, EDIT_SCENARIO.files)).toMatchObject({
      pass: false,
      category: "malformed",
      detail: expect.stringContaining(PRICING),
    });
  });
});

const NOTE = "docs/call-format.md";
const noteText = CREATE_SCENARIO.writes[NOTE] ?? "";
const createUser: ChatEntry = { role: "user", content: CREATE_SCENARIO.message, mentions: [] };
const writeStep: ChatEntry = {
  role: "tool",
  name: "write_file",
  args: { path: NOTE, content: noteText.slice(0, -1) },
  status: "ok",
  text: `write_file: created ${NOTE}.`,
};
const created = [createUser, callReply("write_file", NOTE), writeStep, answer(`Created ${NOTE}.`)];
const withNote = { ...CREATE_SCENARIO.files, [NOTE]: noteText };

describe("create scenario fixture", () => {
  test("asks for a new file holding quotes, backslashes, the call's own tags, and a code fence", () => {
    expect(CREATE_SCENARIO.files[NOTE]).toBeUndefined();
    for (const piece of ['"', "\\", "<content>", "</content>", "</write_file>", "\n```python\n"]) {
      expect(noteText).toContain(piece);
    }
  });

  test("states the content in the message, so the expected file is that text plus one line break", () => {
    const fence = "````";
    const stated = CREATE_SCENARIO.message.split(`${fence}\n`)[1]?.split(`\n${fence}`)[0];
    expect(stated).toBeDefined();
    expect(`${stated}\n`).toBe(noteText);
  });
});

describe("judge on the create scenario", () => {
  test("passes a done turn that created the file with exactly that content", () => {
    expect(judge(CREATE_SCENARIO, created, withNote)).toEqual({ pass: true });
  });

  test("wrongEdit: the content has its backslashes doubled, with the first differing line", () => {
    const doubled = { ...withNote, [NOTE]: noteText.replaceAll("\\", "\\\\") };
    expect(judge(CREATE_SCENARIO, created, doubled)).toMatchObject({
      pass: false,
      category: "wrongEdit",
      detail: expect.stringMatching(/^docs\/call-format\.md line \d+: expected /),
    });
  });

  test("wrongEdit: the file is missing, or went to another path, which the detail names", () => {
    expect(judge(CREATE_SCENARIO, created, CREATE_SCENARIO.files)).toMatchObject({
      category: "wrongEdit",
      detail: `${NOTE} missing`,
    });
    const elsewhere = { ...CREATE_SCENARIO.files, "call-format.md": noteText };
    expect(judge(CREATE_SCENARIO, created, elsewhere)).toMatchObject({
      category: "wrongEdit",
      detail: `${NOTE} missing; changed: call-format.md`,
    });
  });

  test("workspaceChanged: the file is right but a fixture file changed too", () => {
    const extra = { ...withNote, "README.md": "# Courier\n" };
    expect(judge(CREATE_SCENARIO, created, extra)).toMatchObject({
      pass: false,
      category: "workspaceChanged",
      detail: "changed: README.md",
    });
  });

  test("a turn that did not end done fails on its own category, whatever the file holds", () => {
    const halted = [...created.slice(0, -1), { ...answer(""), status: "halted", haltReason: "contextFull" } as Reply];
    expect(judge(CREATE_SCENARIO, halted, withNote)).toMatchObject({ pass: false, category: "contextFull" });
  });
});

test("SCENARIOS holds read, edit, and create, in that order", () => {
  expect(SCENARIOS.map((scenario) => scenario.name)).toEqual(["read", "edit", "create"]);
});

describe("workspaceChanges", () => {
  test("gives each added or changed file its new text and each removed one null, by path", () => {
    const fixture = { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" };
    const after = { "a.txt": "a\n", "c.txt": "C\n", "d/e.txt": "" };
    expect(workspaceChanges(fixture, after)).toEqual({ "b.txt": null, "c.txt": "C\n", "d/e.txt": "" });
    expect(workspaceChanges(fixture, { ...fixture })).toEqual({});
  });
});
