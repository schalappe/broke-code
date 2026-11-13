import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChatEntry } from "../src/core/protocol";
import { readSkills } from "../src/core/skills";
import {
  ASK_SCENARIO,
  COMMAND_SCENARIO,
  CREATE_SCENARIO,
  DEFAULT_ANSWER,
  EDIT_SCENARIO,
  fileAt,
  HIDDEN_SCENARIO,
  judge,
  RANGE_SCENARIO,
  READ_SCENARIO,
  SCENARIOS,
  SKILL_SCENARIO,
  SLASH_SCENARIO,
  withoutAskUser,
  workspaceChanges,
} from "./scenarios";

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

  test("wrongEdit: the file to write was replaced by a symlink, which the detail names", () => {
    const linked = { ...renamed, [PRICING]: { symlink: "pricing.py" } };
    expect(judge(EDIT_SCENARIO, edited, linked)).toEqual({
      pass: false,
      category: "wrongEdit",
      detail: `${PRICING} is a symlink to "pricing.py"`,
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

const DISPATCH_CODE = "LYN-7Q42-ORCA";
const SKILL_FILE = ".agents/skills/depot-codes/SKILL.md";
const DECOY_FILE = ".agents/skills/release-notes/SKILL.md";
const SKILL_ROOT = "/tmp/home/.agents/skills/depot-codes";
const skillHome = SKILL_SCENARIO.home ?? {};
const skillUser: ChatEntry = { role: "user", content: SKILL_SCENARIO.message, mentions: [] };
const loadCall: Reply = {
  role: "assistant",
  reasoning: "",
  content: "<load_skill>\n<name>depot-codes</name>\n</load_skill>",
  status: "done",
  call: { name: "load_skill", args: { name: "depot-codes" }, start: 0, end: 0 },
};
const loadStep = (status: "ok" | "error" = "ok"): ChatEntry => ({
  role: "tool",
  name: "load_skill",
  args: { name: "depot-codes" },
  status,
  text: `Skill depot-codes loaded; its files live in ${SKILL_ROOT}; read them by that absolute path.`,
});
const depotsPath = `${SKILL_ROOT}/reference/depots.md`;
const depotsRead = [
  callReply("read_file", depotsPath),
  step(
    "read_file",
    depotsPath,
    `@${depotsPath} (file)\n${fileAt(skillHome, ".agents/skills/depot-codes/reference/depots.md")}`,
  ),
];
const skillUntouched = { ...SKILL_SCENARIO.files };

describe("skill scenario fixture", () => {
  test("holds one personal skill whose reference file alone holds the value", () => {
    const holders = Object.entries({ ...SKILL_SCENARIO.files, ...skillHome })
      .filter(([, text]) => text.includes(DISPATCH_CODE))
      .map(([path]) => path);
    expect(holders).toEqual([".agents/skills/depot-codes/reference/depots.md"]);
    expect(SKILL_SCENARIO.message).not.toContain(DISPATCH_CODE);
    expect(fileAt(skillHome, SKILL_FILE)).toStartWith("---\nname: depot-codes\ndescription: ");
  });

  test("never names the tool or the skill's folder in the message", () => {
    for (const hint of ["load_skill", "skill", "depots.md", ".agents"])
      expect(SKILL_SCENARIO.message).not.toContain(hint);
  });
});

describe("judge on the skill scenario", () => {
  test("passes a turn that loaded the skill, read its reference file, and answered with the value", () => {
    const entries = [skillUser, loadCall, loadStep(), ...depotsRead, answer(`The Lyon code is ${DISPATCH_CODE}.`)];
    expect(judge(SKILL_SCENARIO, entries, skillUntouched)).toEqual({ pass: true });
  });

  test("wrongTool: the turn read the value without an ok load_skill step", () => {
    const failedLoad = [skillUser, loadCall, loadStep("error"), ...depotsRead, answer(DISPATCH_CODE)];
    const verdict = judge(SKILL_SCENARIO, failedLoad, skillUntouched);
    expect(verdict).toMatchObject({ pass: false, category: "wrongTool" });
    expect(verdict).toMatchObject({ detail: expect.stringContaining("load_skill(name=depot-codes) error") });
    const noLoad = [skillUser, ...depotsRead, answer(DISPATCH_CODE)];
    expect(judge(SKILL_SCENARIO, noLoad, skillUntouched)).toMatchObject({ pass: false, category: "wrongTool" });
  });

  test("wrongTool: the turn loaded the skill but no read step got the value", () => {
    const entries = [skillUser, loadCall, loadStep(), answer(DISPATCH_CODE)];
    expect(judge(SKILL_SCENARIO, entries, skillUntouched)).toMatchObject({ pass: false, category: "wrongTool" });
  });

  test("wrongAnswer: the turn loaded the skill and read the file but the answer lacks the value", () => {
    const entries = [skillUser, loadCall, loadStep(), ...depotsRead, answer("The Lyon code is LYN-7Q42.")];
    expect(judge(SKILL_SCENARIO, entries, skillUntouched)).toMatchObject({ pass: false, category: "wrongAnswer" });
  });

  test("workspaceChanged: the turn passed the check but changed a workspace file", () => {
    const entries = [skillUser, loadCall, loadStep(), ...depotsRead, answer(DISPATCH_CODE)];
    const changed = { ...skillUntouched, "notes.txt": DISPATCH_CODE };
    expect(judge(SKILL_SCENARIO, entries, changed)).toMatchObject({ pass: false, category: "workspaceChanged" });
  });
});

const slashUser: ChatEntry = {
  role: "user",
  content: SLASH_SCENARIO.message,
  mentions: [],
  skill: { name: "depot-codes", status: "loaded" },
};

describe("slash scenario fixture", () => {
  test("loads the skill scenario's skill with /depot-codes, then asks the same question", () => {
    expect(SLASH_SCENARIO.files).toEqual(SKILL_SCENARIO.files);
    expect(SLASH_SCENARIO.home).toEqual(SKILL_SCENARIO.home);
    expect(SLASH_SCENARIO.message).toBe(`/depot-codes ${SKILL_SCENARIO.message}`);
  });
});

describe("judge on the slash scenario", () => {
  test("passes a turn that read the reference file and answered with the value, with no load_skill step", () => {
    const entries = [slashUser, ...depotsRead, answer(`The Lyon code is ${DISPATCH_CODE}.`)];
    expect(judge(SLASH_SCENARIO, entries, skillUntouched)).toEqual({ pass: true });
  });

  test("passes a turn that also loaded the skill with load_skill", () => {
    const entries = [slashUser, loadCall, loadStep(), ...depotsRead, answer(DISPATCH_CODE)];
    expect(judge(SLASH_SCENARIO, entries, skillUntouched)).toEqual({ pass: true });
  });

  test("wrongAnswer: the turn read the file but the answer lacks the value", () => {
    const entries = [slashUser, ...depotsRead, answer("The Lyon code is LYN-7Q42.")];
    expect(judge(SLASH_SCENARIO, entries, skillUntouched)).toMatchObject({ pass: false, category: "wrongAnswer" });
  });

  test("wrongTool: no read step got the value", () => {
    const entries = [slashUser, answer(DISPATCH_CODE)];
    expect(judge(SLASH_SCENARIO, entries, skillUntouched)).toMatchObject({ pass: false, category: "wrongTool" });
  });

  test("wrongTool: the message loaded no skill, whatever the turn did after", () => {
    const { skill: _, ...unloaded } = slashUser as ChatEntry & { role: "user" };
    const failed: ChatEntry = { ...unloaded, skill: { name: "depot-codes", status: "failed" } };
    for (const user of [unloaded, failed]) {
      const verdict = judge(SLASH_SCENARIO, [user, ...depotsRead, answer(DISPATCH_CODE)], skillUntouched);
      expect(verdict).toMatchObject({
        pass: false,
        category: "wrongTool",
        detail: expect.stringContaining("/depot-codes"),
      });
    }
  });

  test("workspaceChanged: the turn passed the check but changed a workspace file", () => {
    const entries = [slashUser, ...depotsRead, answer(DISPATCH_CODE)];
    const changed = { ...skillUntouched, "notes.txt": DISPATCH_CODE };
    expect(judge(SLASH_SCENARIO, entries, changed)).toMatchObject({ pass: false, category: "workspaceChanged" });
  });
});

const hiddenUser: ChatEntry = { ...slashUser, content: HIDDEN_SCENARIO.message };

describe("hidden scenario fixture", () => {
  test("is the slash scenario with its skill kept from the model, beside one unrelated listed skill", () => {
    expect(HIDDEN_SCENARIO.files).toEqual(SLASH_SCENARIO.files);
    expect(HIDDEN_SCENARIO.message).toBe(SLASH_SCENARIO.message);
    const home = HIDDEN_SCENARIO.home ?? {};
    expect(fileAt(home, SKILL_FILE)).toBe(
      fileAt(skillHome, SKILL_FILE)?.replace("\n---\n", "\ndisable-model-invocation: true\n---\n"),
    );
    expect(Object.keys(home).sort()).toEqual([...Object.keys(skillHome), DECOY_FILE].sort());
    const decoy = fileAt(home, DECOY_FILE) ?? "";
    expect(decoy).toStartWith("---\nname: release-notes\ndescription: ");
    for (const hint of ["depot", "dispatch", DISPATCH_CODE])
      expect(decoy.toLowerCase()).not.toContain(hint.toLowerCase());
  });

  test("its depot skill is discovered and not listed to the model; the decoy is listed, so load_skill is offered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "broke-code-hidden-"));
    try {
      for (const [path, text] of Object.entries(HIDDEN_SCENARIO.home ?? {})) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      const { skills, warnings } = await readSkills(dir, []);
      expect(warnings).toEqual([]);
      const listed = skills.map(({ name, listedToModel }) => ({ name, listedToModel }));
      expect(listed.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: "depot-codes", listedToModel: false },
        { name: "release-notes", listedToModel: true },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("judge on the hidden scenario", () => {
  test("passes a turn whose load_skill of the skill the user loaded answered already loaded", () => {
    const alreadyLoaded: ChatEntry = {
      role: "tool",
      name: "load_skill",
      args: { name: "depot-codes" },
      status: "ok",
      text: `Skill depot-codes is already loaded; its files live in ${SKILL_ROOT}; read them by that absolute path.`,
    };
    const entries = [hiddenUser, loadCall, alreadyLoaded, ...depotsRead, answer(DISPATCH_CODE)];
    expect(judge(HIDDEN_SCENARIO, entries, skillUntouched)).toEqual({ pass: true });
  });

  test("passes a turn that read the reference file and answered with the value", () => {
    const entries = [hiddenUser, ...depotsRead, answer(`The Lyon code is ${DISPATCH_CODE}.`)];
    expect(judge(HIDDEN_SCENARIO, entries, skillUntouched)).toEqual({ pass: true });
  });

  test("wrongAnswer: the turn read the file but the answer lacks the value", () => {
    const entries = [hiddenUser, ...depotsRead, answer("I cannot use that skill.")];
    expect(judge(HIDDEN_SCENARIO, entries, skillUntouched)).toMatchObject({ pass: false, category: "wrongAnswer" });
  });

  test("wrongTool: no read step got the value, or the message loaded no skill", () => {
    expect(judge(HIDDEN_SCENARIO, [hiddenUser, answer(DISPATCH_CODE)], skillUntouched)).toMatchObject({
      pass: false,
      category: "wrongTool",
    });
    const { skill: _, ...unloaded } = hiddenUser as ChatEntry & { role: "user" };
    const verdict = judge(HIDDEN_SCENARIO, [unloaded, ...depotsRead, answer(DISPATCH_CODE)], skillUntouched);
    expect(verdict).toMatchObject({
      pass: false,
      category: "wrongTool",
      detail: expect.stringContaining("/depot-codes"),
    });
  });

  test("workspaceChanged: the turn passed the check but changed a workspace file", () => {
    const entries = [hiddenUser, ...depotsRead, answer(DISPATCH_CODE)];
    const changed = { ...skillUntouched, "notes.txt": DISPATCH_CODE };
    expect(judge(HIDDEN_SCENARIO, entries, changed)).toMatchObject({ pass: false, category: "workspaceChanged" });
  });
});

const FILE_COUNT = 61;
const commandUser: ChatEntry = { role: "user", content: COMMAND_SCENARIO.message, mentions: [] };
const COUNT_COMMAND = "find logs -type f | wc -l";
const commandCall: Reply = {
  role: "assistant",
  reasoning: "",
  content: `<run_command>\n<command>${COUNT_COMMAND}</command>\n</run_command>`,
  status: "done",
  call: { name: "run_command", args: { command: COUNT_COMMAND }, start: 0, end: 0 },
};
const commandStep = (status: "ok" | "error", text: string): ChatEntry => ({
  role: "tool",
  name: "run_command",
  args: { command: COUNT_COMMAND },
  status,
  text,
});
const counted = [commandCall, commandStep("ok", `exit code 0\nstdout:\n      ${FILE_COUNT}\nstderr: (empty)`)];
const commandUntouched = { ...COMMAND_SCENARIO.files };

describe("command scenario fixture", () => {
  test("holds 61 files under logs/, nested two folders deep, none hidden", () => {
    const logs = Object.keys(COMMAND_SCENARIO.files).filter((path) => path.startsWith("logs/"));
    expect(logs).toHaveLength(FILE_COUNT);
    expect(logs.every((path) => path.split("/").length === 4)).toBe(true);
    expect(logs.some((path) => path.split("/").some((part) => part.startsWith(".")))).toBe(false);
  });

  test("spreads them over more folders than the step limit lets the model list one by one", () => {
    const folders = new Set(
      Object.keys(COMMAND_SCENARIO.files)
        .filter((path) => path.startsWith("logs/"))
        .flatMap((path) => [path.split("/").slice(0, 2).join("/"), path.split("/").slice(0, 3).join("/")]),
    );
    expect(folders.size).toBeGreaterThan(10);
  });

  test("asks for the count, subfolders included, without naming the tool or the count", () => {
    expect(COMMAND_SCENARIO.message).toContain("logs");
    expect(COMMAND_SCENARIO.message).toContain("subfolders");
    for (const hint of ["run_command", String(FILE_COUNT)]) expect(COMMAND_SCENARIO.message).not.toContain(hint);
    expect(COMMAND_SCENARIO.writes).toEqual({});
  });
});

describe("judge on the command scenario", () => {
  test("passes a turn that ran a command and answered with the count", () => {
    const entries = [commandUser, ...counted, answer(`The logs folder holds ${FILE_COUNT} files.`)];
    expect(judge(COMMAND_SCENARIO, entries, commandUntouched)).toEqual({ pass: true });
  });

  test("passes a turn whose first command failed and a later one succeeded", () => {
    const entries = [
      commandUser,
      commandCall,
      commandStep("error", "exit code 1\nstdout: (empty)\nstderr:\nfind: logz: No such file or directory"),
      ...counted,
      answer(String(FILE_COUNT)),
    ];
    expect(judge(COMMAND_SCENARIO, entries, commandUntouched)).toEqual({ pass: true });
  });

  test("passes the count as a whole number token, also before a sentence's final period", () => {
    for (const right of [
      `There are ${FILE_COUNT}.`,
      `${FILE_COUNT}`,
      `**${FILE_COUNT}** files`,
      `(${FILE_COUNT}), done`,
      `${FILE_COUNT} files`,
      `${FILE_COUNT}, including the nested files`,
      `The logs folder holds ${FILE_COUNT} files, in 18 month folders.`,
    ]) {
      const entries = [commandUser, ...counted, answer(right)];
      expect(judge(COMMAND_SCENARIO, entries, commandUntouched)).toEqual({ pass: true });
    }
  });

  test("wrongAnswer: the turn ran the command but answered another count, also one the right count prefixes", () => {
    for (const wrong of [
      "There are 60 files.",
      "There are 610 files.",
      "There are 161 files.",
      "There are 61,000 files.",
      "There are 1,061 files.",
      "There are 61.5 files.",
      "There are 0.61 files.",
      "There are -61 files.",
      "There are \u221261 files.",
      "There are +61 files.",
      "There are 61e3 files.",
      "There are 61k files.",
      "There are 0,61 files.",
      "There are .61 files.",
      "There are 61E3 files.",
      "There are 61_000 files.",
    ]) {
      const entries = [commandUser, ...counted, answer(wrong)];
      expect(judge(COMMAND_SCENARIO, entries, commandUntouched)).toMatchObject({
        pass: false,
        category: "wrongAnswer",
        detail: `answer: ${wrong}`,
      });
    }
  });

  test("wrongTool: the turn answered with the count without any command step", () => {
    const entries = [
      commandUser,
      callReply("list_files", "logs"),
      step("list_files", "logs", "@logs (folder, 2 entries)\n2024/\n2025/"),
      answer(`${FILE_COUNT} files.`),
    ];
    expect(judge(COMMAND_SCENARIO, entries, commandUntouched)).toMatchObject({
      pass: false,
      category: "wrongTool",
      detail: "steps: list_files(path=logs) ok",
    });
  });

  test("wrongTool: the command was rejected, with the step's first line as the detail", () => {
    const rejected = commandStep("error", "The user rejected this command.\nToo slow.");
    const entries = [commandUser, commandCall, rejected, answer(`${FILE_COUNT} files.`)];
    expect(judge(COMMAND_SCENARIO, entries, commandUntouched)).toMatchObject({
      pass: false,
      category: "wrongTool",
      detail: "The user rejected this command.; steps: run_command(command=find logs -type f | wc -l) error",
    });
  });

  test("wrongTool: the command timed out, with the step's first line as the detail", () => {
    const timedOut = commandStep("error", "stopped after 10 seconds\nstdout: (empty)\nstderr: (empty)");
    const entries = [commandUser, commandCall, timedOut, answer("I could not count them.")];
    expect(judge(COMMAND_SCENARIO, entries, commandUntouched)).toMatchObject({
      pass: false,
      category: "wrongTool",
      detail: "stopped after 10 seconds; steps: run_command(command=find logs -type f | wc -l) error",
    });
  });

  test("workspaceChanged: the count is right but the command left a file behind", () => {
    const entries = [commandUser, ...counted, answer(String(FILE_COUNT))];
    const changed = { ...commandUntouched, "count.txt": `${FILE_COUNT}\n` };
    expect(judge(COMMAND_SCENARIO, entries, changed)).toMatchObject({
      pass: false,
      category: "workspaceChanged",
      detail: "changed: count.txt",
    });
  });
});

const DISPATCH_LOG = "dispatch.log";
const LAST_CODE = "VX7Q-K2RM";
const logText = fileAt(RANGE_SCENARIO.files, DISPATCH_LOG) ?? "";
const rangeUser: ChatEntry = { role: "user", content: RANGE_SCENARIO.message, mentions: [] };
const readLog = (args: Record<string, string>, text: string): ChatEntry[] => [
  { ...callReply("read_file", DISPATCH_LOG), call: { name: "read_file", args, start: 0, end: 0 } },
  { role: "tool", name: "read_file", args, status: "ok", text },
];
const firstPart = readLog(
  { path: DISPATCH_LOG },
  `@${DISPATCH_LOG} (file, lines 1-2000 of 2400)\n\`\`\`\n...\n\`\`\`\n[truncated: 400 more lines not shown; read on with start_line 2001]`,
);
const lastPart = readLog(
  { path: DISPATCH_LOG, start_line: "2001" },
  `@${DISPATCH_LOG} (file, lines 2001-2400 of 2400)\n\`\`\`\n...\nnice seal ${LAST_CODE}\n\`\`\``,
);
const rangeUntouched = { ...RANGE_SCENARIO.files };

describe("range scenario fixture", () => {
  test("holds a log of 2,400 lines of at most 24 characters each, line break included", () => {
    const lines = logText.split(/(?<=\n)/);
    expect(lines).toHaveLength(2400);
    expect(lines.every((line) => line.endsWith("\n") && line.length <= 24)).toBe(true);
  });

  test("holds the code once in the workspace, on the log's last line, past line 2,000", () => {
    const holders = Object.entries(RANGE_SCENARIO.files).filter(([, text]) => text.includes(LAST_CODE));
    expect(holders.map(([path]) => path)).toEqual([DISPATCH_LOG]);
    expect(logText.split(LAST_CODE)).toHaveLength(2);
    expect(logText.endsWith(`\nnice seal ${LAST_CODE}\n`)).toBe(true);
  });

  test("names the log in a short README", () => {
    expect(fileAt(RANGE_SCENARIO.files, "README.md")).toContain(DISPATCH_LOG);
    expect(Object.keys(RANGE_SCENARIO.files).sort()).toEqual(["README.md", DISPATCH_LOG]);
  });

  test("asks to read the log without naming the tool, its arguments, a line number, or a word of the line", () => {
    expect(RANGE_SCENARIO.message).toContain(DISPATCH_LOG);
    for (const hint of [
      "read_file",
      "start_line",
      "end_line",
      "2400",
      "2,400",
      "2000",
      "2001",
      "nice",
      "seal",
      "VX7Q",
    ]) {
      expect(RANGE_SCENARIO.message).not.toContain(hint);
    }
    expect(RANGE_SCENARIO.writes).toEqual({});
  });
});

test("only the range and ask scenarios reject commands", () => {
  expect(SCENARIOS.filter((scenario) => scenario.rejectCommands).map((scenario) => scenario.name)).toEqual([
    "range",
    "ask",
  ]);
});

describe("judge on the range scenario", () => {
  test("passes a turn that read on with start_line and answered with the code", () => {
    const entries = [rangeUser, ...firstPart, ...lastPart, answer(`The code on the last line is ${LAST_CODE}.`)];
    expect(judge(RANGE_SCENARIO, entries, rangeUntouched)).toEqual({ pass: true });
  });

  test("fails as wrongTool a turn that found the code without a ranged read_file", () => {
    const searched: ChatEntry[] = [
      { ...callReply("search", "."), call: { name: "search", args: { pattern: "seal" }, start: 0, end: 0 } },
      {
        role: "tool",
        name: "search",
        args: { pattern: "seal" },
        status: "ok",
        text: `${DISPATCH_LOG}:2400:nice seal ${LAST_CODE}`,
      },
    ];
    const entries = [rangeUser, ...firstPart, ...searched, answer(LAST_CODE)];
    expect(judge(RANGE_SCENARIO, entries, rangeUntouched)).toMatchObject({ pass: false, category: "wrongTool" });
  });

  test("fails as wrongTool a turn whose ranged read missed the code", () => {
    const middle = readLog({ path: DISPATCH_LOG, start_line: "1000", end_line: "1100" }, "@dispatch.log (file, ...)");
    const entries = [rangeUser, ...firstPart, ...middle, answer(LAST_CODE)];
    expect(judge(RANGE_SCENARIO, entries, rangeUntouched)).toMatchObject({ pass: false, category: "wrongTool" });
  });

  test("fails as wrongAnswer a turn that read the code but answered without it", () => {
    const entries = [rangeUser, ...firstPart, ...lastPart, answer("The log ends with a dispatch from nice.")];
    expect(judge(RANGE_SCENARIO, entries, rangeUntouched)).toMatchObject({ pass: false, category: "wrongAnswer" });
  });
});

const ASKED_FILE = "src/parcels/labels.py";
const OTHER_FILE = "src/depots/labels.py";
const askUser: ChatEntry = { role: "user", content: ASK_SCENARIO.message, mentions: [] };
const asked: ChatEntry[] = [
  {
    ...answer("<ask_user>\n<question>Which build_label?</question>\n</ask_user>"),
    call: { name: "ask_user", args: { question: "Which build_label?" }, start: 0, end: 0 },
  },
  {
    role: "tool",
    name: "ask_user",
    args: { question: "Which build_label?" },
    status: "ok",
    text: `The user answered: ${ASK_SCENARIO.answer}`,
  },
];
const renameStep: ChatEntry[] = [callReply("edit_file", ASKED_FILE), step("edit_file", ASKED_FILE, "replaced")];
const renamedFiles = { ...ASK_SCENARIO.files, ...ASK_SCENARIO.writes };
const renamedIn = (path: string) => ({
  ...ASK_SCENARIO.files,
  [path]: (fileAt(ASK_SCENARIO.files, path) ?? "").replace("def build_label(", "def make_label("),
});

describe("ask scenario fixture", () => {
  test("defines build_label once in each of two files, and the message names neither file", () => {
    const definers = Object.entries(ASK_SCENARIO.files).filter(([, text]) => text.includes("def build_label("));
    expect(definers.map(([path]) => path).sort()).toEqual([OTHER_FILE, ASKED_FILE]);
    for (const [, text] of definers) expect(text.split("build_label")).toHaveLength(2);
    expect(ASK_SCENARIO.message).toContain("the function build_label");
    for (const hint of ["depot", "parcel", "src/", "labels.py"]) {
      expect(ASK_SCENARIO.message.toLowerCase()).not.toContain(hint);
    }
  });

  test("answers with the file to change, and expects the rename there alone", () => {
    expect(ASK_SCENARIO.answer).toContain(ASKED_FILE);
    expect(Object.keys(ASK_SCENARIO.writes)).toEqual([ASKED_FILE]);
    expect(fileAt(ASK_SCENARIO.writes, ASKED_FILE)).toBe(fileAt(renamedIn(ASKED_FILE), ASKED_FILE));
  });

  test("a scenario without its own answer gets the default one", () => {
    expect(DEFAULT_ANSWER).toBe("Decide yourself.");
    expect(SCENARIOS.filter((scenario) => scenario.answer !== undefined).map((scenario) => scenario.name)).toEqual([
      "ask",
    ]);
  });
});

describe("judge on the ask scenario", () => {
  test("passes a turn that asked, then renamed the function in the answered file", () => {
    const entries = [askUser, ...asked, ...renameStep, answer("Renamed.")];
    expect(judge(ASK_SCENARIO, entries, renamedFiles)).toEqual({ pass: true });
  });

  test("wrongTool: the right rename without an ok ask_user step before the first write", () => {
    const entries = [askUser, ...renameStep, ...asked, answer("Renamed.")];
    expect(judge(ASK_SCENARIO, entries, renamedFiles)).toMatchObject({ pass: false, category: "wrongTool" });
    const refused = asked.map((entry) => (entry.role === "tool" ? { ...entry, status: "error" as const } : entry));
    expect(judge(ASK_SCENARIO, [askUser, ...refused, ...renameStep, answer("Renamed.")], renamedFiles)).toMatchObject({
      pass: false,
      category: "wrongTool",
    });
  });

  test("wrongEdit: the rename went to the other file, or to both", () => {
    const entries = [askUser, ...asked, ...renameStep, answer("Renamed.")];
    expect(judge(ASK_SCENARIO, entries, renamedIn(OTHER_FILE))).toMatchObject({ pass: false, category: "wrongEdit" });
    const both = { ...renamedFiles, [OTHER_FILE]: fileAt(renamedIn(OTHER_FILE), OTHER_FILE) ?? "" };
    expect(judge(ASK_SCENARIO, entries, both)).toMatchObject({
      pass: false,
      category: "workspaceChanged",
      detail: `changed: ${OTHER_FILE}`,
    });
  });

  test("without the tool offered, judges the workspace alone", () => {
    const baseline = withoutAskUser(SCENARIOS).find((scenario) => scenario.name === "ask");
    if (baseline === undefined) throw new Error("no ask scenario");
    expect(judge(baseline, [askUser, ...renameStep, answer("Renamed.")], renamedFiles)).toEqual({ pass: true });
    expect(judge(baseline, [askUser, ...renameStep, answer("Renamed.")], renamedIn(OTHER_FILE))).toMatchObject({
      pass: false,
      category: "wrongEdit",
    });
  });

  test("without the tool offered, every other scenario is judged as it is", () => {
    const others = SCENARIOS.filter((scenario) => scenario.name !== "ask");
    expect(withoutAskUser(SCENARIOS).filter((scenario) => scenario.name !== "ask")).toEqual(others);
  });
});

test("SCENARIOS holds read, edit, create, skill, command, slash, hidden, range, and ask, in that order", () => {
  expect(SCENARIOS.map((scenario) => scenario.name)).toEqual([
    "read",
    "edit",
    "create",
    "skill",
    "command",
    "slash",
    "hidden",
    "range",
    "ask",
  ]);
});

describe("workspaceChanges", () => {
  test("gives each added or changed file its new text and each removed one null, by path", () => {
    const fixture = { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" };
    const after = { "a.txt": "a\n", "c.txt": "C\n", "d/e.txt": "" };
    expect(workspaceChanges(fixture, after)).toEqual({ "b.txt": null, "c.txt": "C\n", "d/e.txt": "" });
    expect(workspaceChanges(fixture, { ...fixture })).toEqual({});
  });

  test("tells a symlink or a FIFO from a file holding the same text, and records a changed target", () => {
    const fixture = { "a.txt": "target", "b.txt": "b\n" };
    const after = { "a.txt": { symlink: "target" }, "b.txt": { special: "fifo" }, link: { symlink: "b.txt" } };
    expect(workspaceChanges(fixture, after)).toEqual(after);
    expect(workspaceChanges(after, structuredClone(after))).toEqual({});
    expect(workspaceChanges(after, { ...after, link: { symlink: "a.txt" } })).toEqual({ link: { symlink: "a.txt" } });
  });

  test("records a file named __proto__ like any other: added, changed, or removed", () => {
    const withProto = JSON.parse('{"__proto__": "x\\n"}') as Record<string, string>;
    expect(Object.entries(workspaceChanges({}, withProto))).toEqual([["__proto__", "x\n"]]);
    expect(Object.entries(workspaceChanges(withProto, {}))).toEqual([["__proto__", null]]);
    expect(Object.entries(workspaceChanges(withProto, { ...withProto }))).toEqual([]);
  });
});

describe("judge on a file named __proto__", () => {
  const done = [answer("Done.")];
  const expected = { ...CREATE_SCENARIO.files, ...CREATE_SCENARIO.writes };
  const proto = JSON.parse('{"__proto__": "unrequested file\\n"}') as Record<string, string>;

  test("workspaceChanged: the files asked for are right but a file named __proto__ appeared", () => {
    expect(judge(CREATE_SCENARIO, done, { ...expected, ...proto })).toMatchObject({
      pass: false,
      category: "workspaceChanged",
      detail: "changed: __proto__",
    });
  });

  test("wrongEdit: a scenario asking for a file named __proto__ that is missing", () => {
    const scenario = { ...CREATE_SCENARIO, writes: proto };
    expect(judge(scenario, done, CREATE_SCENARIO.files)).toMatchObject({
      pass: false,
      category: "wrongEdit",
      detail: "__proto__ missing",
    });
    expect(judge(scenario, done, { ...CREATE_SCENARIO.files, ...proto })).toEqual({ pass: true });
  });
});
