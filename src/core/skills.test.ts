import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerSkillQuery,
  describeSkillDiscovery,
  findSlashSkill,
  LOAD_SKILL_TOOL,
  loadSkill,
  loadSkillText,
  MAX_SKILL_ENTRIES,
  readSkills,
} from "./skills";
import type { Skill } from "./systemPrompt";
import type { WorkspaceEntry } from "./workspaceFiles";

let base: string;
let home: string;
let personal: string;
let workspace: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "broke-code-skills-")));
  home = join(base, "home");
  personal = join(home, ".agents", "skills");
  workspace = join(base, "workspace");
  await mkdir(personal, { recursive: true });
  await mkdir(join(workspace, ".agents", "skills"), { recursive: true });
});

afterEach(async () => {
  // [>]: A test may lock a folder; unlock it so the cleanup can remove it.
  await chmod(join(home, ".agents", "skills"), 0o755).catch(() => {});
  await rm(base, { recursive: true, force: true });
});

/** Write `<folder>/<directory>/SKILL.md` with `text`; returns the skill folder. */
async function writeSkill(folder: string, directory: string, text: string): Promise<string> {
  const root = join(folder, directory);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "SKILL.md"), text);
  return root;
}

const skillText = (name: string, description: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# Body\n`;

const single = () => [{ name: "workspace", path: workspace }];
const workspaceSkills = () => join(workspace, ".agents", "skills");

describe("readSkills", () => {
  test("reads plain, quoted, folded, and literal descriptions, ignoring nested maps and unknown keys", async () => {
    await writeSkill(personal, "plain", "---\nname: plain\ndescription: Plain text # a comment\n---\nBody\n");
    await writeSkill(
      personal,
      "double",
      '---\nname: "double"\ndescription: "Say \\"hi\\": tabs\\tand \\u00e9"\nlicense: MIT\n---\n',
    );
    await writeSkill(personal, "single", "---\nname: 'single'\ndescription: 'It''s quoted: yes'\n---\n");
    await writeSkill(
      personal,
      "folded",
      "---\nname: folded\nmetadata:\n  author: me\n  description: nested, ignored\ndescription: >\n  First line\n  second line.\n\n  New paragraph.\nallowed-tools: Read\n---\n",
    );
    await writeSkill(
      personal,
      "literal",
      "---\r\nname: literal\r\ndescription: |-\r\n  Line one\r\n  Line two\r\n---\r\n",
    );

    const { skills, warnings } = await readSkills(home, []);
    expect(warnings).toEqual([]);
    const described = Object.fromEntries(skills.map((skill) => [skill.name, skill.description]));
    expect(described).toEqual({
      double: 'Say "hi": tabs\tand é',
      folded: "First line second line.\nNew paragraph.",
      literal: "Line one\nLine two",
      plain: "Plain text",
      single: "It's quoted: yes",
    });
  });

  test("gives each skill its folder's real path, listed to the model, sorted by name", async () => {
    await writeSkill(personal, "zeta", skillText("zeta", "Last."));
    await writeSkill(personal, "alpha", skillText("alpha", "First."));
    expect(await readSkills(home, [])).toEqual({
      skills: [
        { name: "alpha", description: "First.", root: join(personal, "alpha"), listedToModel: true },
        { name: "zeta", description: "Last.", root: join(personal, "zeta"), listedToModel: true },
      ],
      warnings: [],
    });
  });

  test("skips each invalid skill with a warning naming its file and the problem; the valid ones still load", async () => {
    const cases: Record<string, string> = {
      "no-name": "---\ndescription: Something.\n---\n",
      "no-description": "---\nname: no-description\n---\n",
      "empty-description": "---\nname: empty-description\ndescription:   \n---\n",
      mismatch: skillText("other-name", "Something."),
      Upper: skillText("Upper", "Something."),
      "-lead": skillText("-lead", "Something."),
      "trail-": skillText("trail-", "Something."),
      "double--hyphen": skillText("double--hyphen", "Something."),
      ["a".repeat(65)]: skillText("a".repeat(65), "Something."),
      "long-description": skillText("long-description", "d".repeat(1025)),
      "no-frontmatter": "# Just a body\n",
      unclosed: "---\nname: unclosed\ndescription: Never closed.\n",
      unparsable: '---\nname: unparsable\ndescription: "Never closed\n---\n',
    };
    for (const [directory, text] of Object.entries(cases)) await writeSkill(personal, directory, text);
    await writeSkill(personal, "valid", skillText("valid", "d".repeat(1024)));

    const { skills, warnings } = await readSkills(home, []);
    expect(skills.map((skill) => skill.name)).toEqual(["valid"]);
    const file = (directory: string) => `~/.agents/skills/${directory}/SKILL.md`;
    expect(warnings).toEqual(
      expect.arrayContaining([
        { path: file("no-name"), problem: { kind: "missingName" } },
        { path: file("no-description"), problem: { kind: "missingDescription" } },
        { path: file("empty-description"), problem: { kind: "missingDescription" } },
        { path: file("mismatch"), problem: { kind: "nameMismatch", name: "other-name", directory: "mismatch" } },
        { path: file("Upper"), problem: { kind: "invalidName" } },
        { path: file("-lead"), problem: { kind: "invalidName" } },
        { path: file("trail-"), problem: { kind: "invalidName" } },
        { path: file("double--hyphen"), problem: { kind: "invalidName" } },
        { path: file("a".repeat(65)), problem: { kind: "nameTooLong" } },
        { path: file("long-description"), problem: { kind: "descriptionTooLong" } },
        { path: file("no-frontmatter"), problem: { kind: "noFrontmatter" } },
        { path: file("unclosed"), problem: { kind: "noFrontmatter" } },
        { path: file("unparsable"), problem: { kind: "unparsableField", field: "description" } },
      ]),
    );
    expect(warnings).toHaveLength(Object.keys(cases).length);
  });

  test("passes silently over a folder without SKILL.md, a stray file, and missing skills folders", async () => {
    await mkdir(join(personal, "synced"));
    await writeFile(join(personal, "README.md"), "Notes.");
    await mkdir(join(workspaceSkills(), "empty"));
    expect(await readSkills(home, single())).toEqual({ skills: [], warnings: [] });

    const bare = join(base, "bare");
    await mkdir(bare);
    expect(await readSkills(join(base, "nobody"), [{ name: "bare", path: bare }])).toEqual({
      skills: [],
      warnings: [],
    });
  });

  test("a workspace skill hides a personal skill of the same name, with no warning", async () => {
    await writeSkill(personal, "review", skillText("review", "Personal review."));
    await writeSkill(personal, "notes", skillText("notes", "Personal notes."));
    await writeSkill(workspaceSkills(), "review", skillText("review", "Workspace review."));

    const { skills, warnings } = await readSkills(home, single());
    expect(warnings).toEqual([]);
    expect(skills).toEqual([
      { name: "notes", description: "Personal notes.", root: join(personal, "notes"), listedToModel: true },
      {
        name: "review",
        description: "Workspace review.",
        root: join(workspaceSkills(), "review"),
        listedToModel: true,
      },
    ]);
  });

  test("between two workspace folders the earlier wins, and warnings name the folder", async () => {
    const other = join(base, "other");
    await writeSkill(join(other, ".agents", "skills"), "review", skillText("review", "Other review."));
    await writeSkill(join(other, ".agents", "skills"), "broken", "no frontmatter");
    await writeSkill(workspaceSkills(), "review", skillText("review", "App review."));
    const roots = [
      { name: "app", path: workspace },
      { name: "lib", path: other },
    ];

    const { skills, warnings } = await readSkills(home, roots);
    expect(skills.map((skill) => skill.description)).toEqual(["App review."]);
    expect(warnings).toEqual([{ path: "lib/.agents/skills/broken/SKILL.md", problem: { kind: "noFrontmatter" } }]);
  });

  test("a hidden skill gives no warning, from a personal folder or a later workspace folder", async () => {
    const other = join(base, "other");
    await writeSkill(workspaceSkills(), "review", skillText("review", "App review."));
    await writeSkill(personal, "review", "# Broken, but hidden");
    await writeSkill(join(other, ".agents", "skills"), "review", "---\nname: review\n---\n");
    const roots = [
      { name: "app", path: workspace },
      { name: "lib", path: other },
    ];

    const { skills, warnings } = await readSkills(home, roots);
    expect(skills.map((skill) => skill.description)).toEqual(["App review."]);
    expect(warnings).toEqual([]);
  });

  test("an invalid workspace skill hides nothing: the valid personal one wins and the workspace one warns", async () => {
    await writeSkill(workspaceSkills(), "review", "# Broken");
    await writeSkill(personal, "review", skillText("review", "Personal review."));

    const { skills, warnings } = await readSkills(home, single());
    expect(skills.map((skill) => skill.description)).toEqual(["Personal review."]);
    expect(warnings).toEqual([{ path: ".agents/skills/review/SKILL.md", problem: { kind: "noFrontmatter" } }]);
  });

  test("skips a workspace skill folder linked into another workspace folder, with the outside warning", async () => {
    const other = join(base, "other");
    await writeSkill(join(other, "tools"), "cross", skillText("cross", "Lives in lib."));
    await symlink(join(other, "tools", "cross"), join(workspaceSkills(), "cross"));
    const roots = [
      { name: "app", path: workspace },
      { name: "lib", path: other },
    ];

    expect(await readSkills(home, roots)).toEqual({
      skills: [],
      warnings: [{ path: "app/.agents/skills/cross/SKILL.md", problem: { kind: "outsideWorkspace" } }],
    });
  });

  test("skips a workspace skill folder linked into another workspace folder even when its SKILL.md links back", async () => {
    const other = join(base, "other");
    await mkdir(join(other, "tools", "cross"), { recursive: true });
    await mkdir(join(workspace, "docs"));
    await writeFile(join(workspace, "docs", "cross.md"), skillText("cross", "Linked back."));
    await symlink(join(workspace, "docs", "cross.md"), join(other, "tools", "cross", "SKILL.md"));
    await symlink(join(other, "tools", "cross"), join(workspaceSkills(), "cross"));
    const roots = [
      { name: "app", path: workspace },
      { name: "lib", path: other },
    ];

    expect(await readSkills(home, roots)).toEqual({
      skills: [],
      warnings: [{ path: "app/.agents/skills/cross/SKILL.md", problem: { kind: "outsideWorkspace" } }],
    });
  });

  test("reads a key with an empty head and a nested map after blank lines as no string", async () => {
    await writeSkill(personal, "nested", "---\nname: nested\ndescription:\n\n  summary: Nested.\n---\n");
    expect((await readSkills(home, [])).warnings).toEqual([
      { path: "~/.agents/skills/nested/SKILL.md", problem: { kind: "missingDescription" } },
    ]);
  });

  test("reads a key whose head or first line is only a comment, then a nested map, as no string", async () => {
    await writeSkill(personal, "head", "---\nname: head\ndescription: # comment\n  summary: Nested.\n---\n");
    await writeSkill(personal, "line", "---\nname: line\ndescription:\n  # comment\n  summary: Nested.\n---\n");
    await writeSkill(personal, "text", "---\nname: text\ndescription: # comment\n  Plain text.\n---\n");

    const { skills, warnings } = await readSkills(home, []);
    expect(skills.map(({ name, description }) => ({ name, description }))).toEqual([
      { name: "text", description: "Plain text." },
    ]);
    expect(warnings).toEqual([
      { path: "~/.agents/skills/head/SKILL.md", problem: { kind: "missingDescription" } },
      { path: "~/.agents/skills/line/SKILL.md", problem: { kind: "missingDescription" } },
    ]);
  });

  test("reads a flow map or sequence as no string, on the head or after an empty head, and keeps a quoted one", async () => {
    await writeSkill(workspaceSkills(), "same", "---\nname: same\ndescription: {summary: Nested.}\n---\n");
    await writeSkill(personal, "same", skillText("same", "Personal."));
    await writeSkill(personal, "seq", "---\nname: seq\ndescription: [first, second]\n---\n");
    await writeSkill(personal, "map-line", "---\nname: map-line\ndescription:\n  {summary: Nested.}\n---\n");
    await writeSkill(personal, "seq-line", "---\nname: seq-line\ndescription:\n\n  [first, second]\n---\n");
    await writeSkill(personal, "quoted", '---\nname: quoted\ndescription: "[x] {text}"\n---\n');

    const { skills, warnings } = await readSkills(home, single());
    expect(skills.map(({ name, description }) => ({ name, description }))).toEqual([
      { name: "quoted", description: "[x] {text}" },
      { name: "same", description: "Personal." },
    ]);
    const missing = { kind: "missingDescription" } as const;
    expect(warnings).toEqual([
      { path: "~/.agents/skills/map-line/SKILL.md", problem: missing },
      { path: "~/.agents/skills/seq/SKILL.md", problem: missing },
      { path: "~/.agents/skills/seq-line/SKILL.md", problem: missing },
      { path: ".agents/skills/same/SKILL.md", problem: missing },
    ]);
  });

  test("parses long whitespace runs without a comment in linear time", async () => {
    // [>]: 200,000 characters: the backtracking regexes took tens of seconds here, and a 1 MiB file, minutes.
    const spaces = " ".repeat(200_000);
    await writeSkill(personal, "stall", skillText("stall", `a${spaces}b`));
    await writeSkill(personal, "separator", skillText("separator", "Kept.", `notes:${spaces} \n`));

    const started = performance.now();
    const { skills, warnings } = await readSkills(home, []);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(skills.map((skill) => skill.name)).toEqual(["separator"]);
    expect(warnings).toEqual([{ path: "~/.agents/skills/stall/SKILL.md", problem: { kind: "descriptionTooLong" } }]);
  });

  test("skips a workspace skill folder linked out of the workspace, and follows a linked personal one", async () => {
    const outside = join(base, "outside");
    await writeSkill(outside, "escape", skillText("escape", "Outside."));
    await writeSkill(outside, "dotfile", skillText("dotfile", "Linked personal."));
    await symlink(join(outside, "escape"), join(workspaceSkills(), "escape"));
    await symlink(join(outside, "dotfile"), join(personal, "dotfile"));

    const { skills, warnings } = await readSkills(home, single());
    expect(skills).toEqual([
      { name: "dotfile", description: "Linked personal.", root: join(outside, "dotfile"), listedToModel: true },
    ]);
    expect(warnings).toEqual([{ path: ".agents/skills/escape/SKILL.md", problem: { kind: "outsideWorkspace" } }]);
  });

  test("skips a personal skill whose SKILL.md links out of its folder, with a warning, and keeps the others", async () => {
    await mkdir(join(personal, "linked"));
    await writeFile(join(base, "linked.md"), skillText("linked", "Lives elsewhere."));
    await symlink(join(base, "linked.md"), join(personal, "linked", "SKILL.md"));
    await writeSkill(personal, "notes", skillText("notes", "Notes."));

    const { skills, warnings } = await readSkills(home, []);
    expect(skills.map((skill) => skill.name)).toEqual(["notes"]);
    expect(warnings).toEqual([{ path: "~/.agents/skills/linked/SKILL.md", problem: { kind: "outsideSkillFolder" } }]);
  });

  test("skips a workspace skill whose SKILL.md links elsewhere in its workspace folder; it hides nothing", async () => {
    await mkdir(join(workspaceSkills(), "review"));
    await mkdir(join(workspace, "docs"));
    await writeFile(join(workspace, "docs", "review.md"), skillText("review", "Workspace review."));
    await symlink(join(workspace, "docs", "review.md"), join(workspaceSkills(), "review", "SKILL.md"));
    await writeSkill(personal, "review", skillText("review", "Personal review."));

    const { skills, warnings } = await readSkills(home, single());
    expect(skills.map((skill) => skill.description)).toEqual(["Personal review."]);
    expect(warnings).toEqual([{ path: ".agents/skills/review/SKILL.md", problem: { kind: "outsideSkillFolder" } }]);
  });

  test("keeps a disable-model-invocation skill out of the model's list, but discovered", async () => {
    await writeSkill(personal, "manual", skillText("manual", "By hand only.", "disable-model-invocation: true\n"));
    await writeSkill(personal, "auto", skillText("auto", "Any time.", "disable-model-invocation: false\n"));
    const { skills } = await readSkills(home, []);
    expect(skills.map(({ name, listedToModel }) => ({ name, listedToModel }))).toEqual([
      { name: "auto", listedToModel: true },
      { name: "manual", listedToModel: false },
    ]);
  });

  test("warns about a SKILL.md over 1 MiB, binary, unreadable, or a folder", async () => {
    await writeSkill(personal, "binary", skillText("binary", "a\0b"));
    await writeSkill(personal, "huge", skillText("huge", "x".repeat(1024 * 1024)));
    const locked = await writeSkill(personal, "locked", skillText("locked", "Locked."));
    await chmod(join(locked, "SKILL.md"), 0o000);
    await mkdir(join(personal, "nested", "SKILL.md"), { recursive: true });

    const { skills, warnings } = await readSkills(home, []);
    expect(skills).toEqual([]);
    expect(warnings).toEqual([
      { path: "~/.agents/skills/binary/SKILL.md", problem: { kind: "binary" } },
      { path: "~/.agents/skills/huge/SKILL.md", problem: { kind: "tooLarge" } },
      { path: "~/.agents/skills/locked/SKILL.md", problem: { kind: "unreadable", cause: "EACCES" } },
      { path: "~/.agents/skills/nested/SKILL.md", problem: { kind: "unreadable", cause: "not a file" } },
    ]);
  });

  /** A discovery seam that runs `change` once, right after the one skill's `SKILL.md` was read whole. */
  const afterRead = (change: () => Promise<void>) => async (read: () => Promise<WorkspaceEntry>) => {
    const entry = await read();
    expect(entry.status).toBe("ok");
    await change();
    return entry;
  };

  test("a SKILL.md deleted after its read, before its real path check, is no skill and no warning", async () => {
    const gone = await writeSkill(personal, "gone", skillText("gone", "Gone."));
    const aroundRead = afterRead(() => unlink(join(gone, "SKILL.md")));
    expect(await readSkills(home, [], { aroundRead })).toEqual({ skills: [], warnings: [] });
  });

  test("a SKILL.md whose real path check fails otherwise after its read warns with the cause", async () => {
    const looped = await writeSkill(personal, "looped", skillText("looped", "Looped."));
    const file = join(looped, "SKILL.md");
    const aroundRead = afterRead(async () => {
      await unlink(file);
      await symlink(file, file);
    });
    expect(await readSkills(home, [], { aroundRead })).toEqual({
      skills: [],
      warnings: [{ path: "~/.agents/skills/looped/SKILL.md", problem: { kind: "unreadable", cause: "ELOOP" } }],
    });
  });

  test("reads a block scalar of 200,000 lines under 1 MiB, in an unknown field or the description", async () => {
    const block = `|\n${"  x\n".repeat(200_000)}`;
    await writeSkill(personal, "notes", skillText("notes", "Has notes.", `notes: ${block}`));
    await writeSkill(personal, "long-block", `---\nname: long-block\ndescription: ${block}---\n`);
    await writeSkill(personal, "other", skillText("other", "Other."));

    const { skills, warnings } = await readSkills(home, []);
    expect(skills.map((skill) => skill.name)).toEqual(["notes", "other"]);
    expect(warnings).toEqual([
      { path: "~/.agents/skills/long-block/SKILL.md", problem: { kind: "descriptionTooLong" } },
    ]);
  });

  test("warns about a skills folder that exists but cannot be listed, and still reads the others", async () => {
    await writeSkill(workspaceSkills(), "kept", skillText("kept", "Kept."));
    await chmod(personal, 0o000);
    const { skills, warnings } = await readSkills(home, single());
    expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
    expect(warnings).toEqual([{ path: "~/.agents/skills", problem: { kind: "folderUnreadable", cause: "EACCES" } }]);
  });

  test("reads one SKILL.md at a time, however many skill folders hold one", async () => {
    // [>]: The finding's shape: many skill folders whose `SKILL.md` links to one large file inside the workspace.
    const large = join(workspace, "large.md");
    await writeFile(large, `${skillText("shared", "Shared.")}${"x".repeat(1024 * 1024 - 100)}`);
    for (let index = 0; index < 50; index += 1) {
      const folder = join(workspaceSkills(), `s${index}`);
      await mkdir(folder);
      await symlink(large, join(folder, "SKILL.md"));
      await mkdir(join(personal, `p${index}`));
      await symlink(large, join(personal, `p${index}`, "SKILL.md"));
    }
    let running = 0;
    let most = 0;
    let reads = 0;
    const aroundRead = async (read: () => Promise<WorkspaceEntry>) => {
      running += 1;
      reads += 1;
      most = Math.max(most, running);
      try {
        await Bun.sleep(1);
        return await read();
      } finally {
        running -= 1;
      }
    };

    await readSkills(home, single(), { aroundRead });
    expect(reads).toBe(100);
    expect(most).toBe(1);
  });

  test("reads only the first entries of a skills folder by name, and warns once naming the folder", async () => {
    const names = Array.from({ length: MAX_SKILL_ENTRIES + 2 }, (_, index) => `s${String(index).padStart(3, "0")}`);
    for (const name of names) await writeSkill(workspaceSkills(), name, skillText(name, "Repository skill."));
    const last = names.at(-1)!;
    await writeSkill(personal, last, skillText(last, "Personal skill."));
    let reads = 0;

    const { skills, warnings } = await readSkills(home, single(), {
      aroundRead: (read) => {
        reads += 1;
        return read();
      },
    });
    expect(reads).toBe(MAX_SKILL_ENTRIES + 1);
    expect(skills.map((skill) => skill.name)).toEqual([...names.slice(0, MAX_SKILL_ENTRIES), last]);
    // [>]: A skill past the cap is never read, so it hides nothing: the personal skill of its name is listed.
    expect(skills.at(-1)?.description).toBe("Personal skill.");
    expect(warnings).toEqual([
      { path: ".agents/skills", problem: { kind: "tooManyEntries", entries: MAX_SKILL_ENTRIES + 2 } },
    ]);
  });
});

describe("describeSkillDiscovery", () => {
  test("names the listed skills with their folders, the skills kept from the model, and the skipped count", () => {
    const line = describeSkillDiscovery({
      skills: [
        { name: "auto", description: "Any time.", root: "/w/.agents/skills/auto", listedToModel: true },
        { name: "manual", description: "By hand.", root: "/h/.agents/skills/manual", listedToModel: false },
        { name: "review", description: "Review.", root: "/h/.agents/skills/review", listedToModel: true },
      ],
      warnings: [{ path: "~/.agents/skills/broken/SKILL.md", problem: { kind: "noFrontmatter" } }],
    });
    expect(line).toBe(
      "broke-code: skills listed to the model: auto (/w/.agents/skills/auto), review (/h/.agents/skills/review); kept from the model: manual; skipped: 1",
    );
  });

  test("says none for an empty list", () => {
    expect(describeSkillDiscovery({ skills: [], warnings: [] })).toBe(
      "broke-code: skills listed to the model: none; kept from the model: none; skipped: 0",
    );
  });
});

describe("answerSkillQuery", () => {
  test("answers with the query's id and each discovered skill's name and description, those kept from the model included", async () => {
    await writeSkill(personal, "grilling", "---\nname: grilling\ndescription: Grill the plan.\n---\nAsk.\n");
    await writeSkill(
      personal,
      "release",
      "---\nname: release\ndescription: Cut a release.\ndisable-model-invocation: true\n---\nShip.\n",
    );
    await writeSkill(personal, "broken", "---\nname: broken\n---\nNo description.\n");
    const answer = await answerSkillQuery(9, () => readSkills(home, []));
    expect(answer).toEqual({
      type: "skillSuggestions",
      id: 9,
      items: [
        { name: "grilling", description: "Grill the plan." },
        { name: "release", description: "Cut a release." },
      ],
      failed: false,
    });
  });

  test("a skills folder that cannot be listed fails the answer, which keeps the skills found elsewhere", async () => {
    await writeSkill(workspaceSkills(), "kept", skillText("kept", "Kept."));
    await writeSkill(personal, "broken", "---\nname: broken\n---\nNo description.\n");
    await chmod(personal, 0o000);
    const answer = await answerSkillQuery(7, () => readSkills(home, single()));
    expect(answer).toEqual({
      type: "skillSuggestions",
      id: 7,
      items: [{ name: "kept", description: "Kept." }],
      failed: true,
    });
  });

  test("a skipped skill is no listing failure", async () => {
    await writeSkill(personal, "grilling", skillText("grilling", "Grill the plan."));
    await writeSkill(personal, "broken", "---\nname: broken\n---\nNo description.\n");
    const answer = await answerSkillQuery(4, () => readSkills(home, []));
    expect(answer).toEqual({
      type: "skillSuggestions",
      id: 4,
      items: [{ name: "grilling", description: "Grill the plan." }],
      failed: false,
    });
  });

  test("a reader that fails gives a failed answer with the query's id and no row", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const answer = await answerSkillQuery(3, () => Promise.reject(new Error("boom")));
      expect(answer).toEqual({ type: "skillSuggestions", id: 3, items: [], failed: true });
    } finally {
      console.error = original;
    }
  });
});

describe("LOAD_SKILL_TOOL", () => {
  test("says only a skill folder outside the workspace is read-only", () => {
    expect(LOAD_SKILL_TOOL.description).toContain("; a skill folder outside the workspace is read-only.");
    expect(LOAD_SKILL_TOOL.description).not.toContain("cannot be changed");
  });
});

describe("loadSkill", () => {
  const header = (name: string, root: string) =>
    `Skill ${name} loaded; its files live in ${root}; read them by that absolute path.`;

  test("returns the header with the real folder path, then the body without its frontmatter", async () => {
    const root = await writeSkill(
      personal,
      "review",
      "---\nname: review\ndescription: Review.\n---\n\n# Steps\n\nRead reference.md.\n",
    );
    const { skills } = await readSkills(home, []);
    expect(await loadSkill("review", skills, [])).toEqual({
      status: "ok",
      text: `${header("review", root)}\n\n# Steps\n\nRead reference.md.\n`,
    });
  });

  test("an unknown name, or a skill kept from the model, gives an error listing the names the model may load", async () => {
    await writeSkill(personal, "review", skillText("review", "Review."));
    await writeSkill(personal, "deploy", skillText("deploy", "Deploy.", "disable-model-invocation: true\n"));
    await writeSkill(personal, "release", skillText("release", "Release."));
    await writeSkill(personal, "broken", "---\nname: other\ndescription: Mismatched.\n---\n");
    const { skills } = await readSkills(home, []);
    for (const name of ["nope", "deploy", "broken"]) {
      expect(await loadSkill(name, skills, [])).toEqual({
        status: "error",
        text: `load_skill: ${name}: no skill of that name can be loaded. Skills you can load: release, review.`,
      });
    }
  });

  test("says when no skill can be loaded at all", async () => {
    expect(await loadSkill("review", [], [])).toEqual({
      status: "error",
      text: "load_skill: review: no skill of that name can be loaded. No skill can be loaded.",
    });
  });

  test("a skill already loaded gives ok, saying so, without the body", async () => {
    const root = await writeSkill(personal, "review", skillText("review", "Review."));
    const { skills } = await readSkills(home, []);
    expect(await loadSkill("review", skills, [root])).toEqual({
      status: "ok",
      text: `Skill review is already loaded; its files live in ${root}; read them by that absolute path.`,
    });
  });

  test("cuts a body over 2,000 lines to its first 2,000, with the mention notice", async () => {
    const lines = Array.from({ length: 2500 }, (_, index) => `step ${index + 1}`).join("\n");
    const root = await writeSkill(personal, "long", `---\nname: long\ndescription: Long.\n---\n${lines}\n`);
    const { skills } = await readSkills(home, []);
    const result = await loadSkill("long", skills, []);
    expect(result.status).toBe("ok");
    expect(result.text).toStartWith(`${header("long", root)}\n\nstep 1\n`);
    expect(result.text).toEndWith("\nstep 2000\n[truncated: 500 more lines not shown]");
  });

  test("counts CR-only line breaks toward the 2,000-line cut", async () => {
    const lines = Array.from({ length: 2500 }, (_, index) => `step ${index + 1}`).join("\r");
    await writeSkill(personal, "classic", `---\rname: classic\rdescription: CR lines.\r---\r${lines}\r`);
    const { skills } = await readSkills(home, []);
    const result = await loadSkill("classic", skills, []);
    expect(result.status).toBe("ok");
    expect(result.text).toEndWith("\rstep 2000\n[truncated: 500 more lines not shown]");
  });

  test("an unreadable SKILL.md at load gives an error with its cause", async () => {
    const root = await writeSkill(personal, "review", skillText("review", "Review."));
    const { skills } = await readSkills(home, []);
    await chmod(join(root, "SKILL.md"), 0o000);
    expect(await loadSkill("review", skills, [])).toEqual({
      status: "error",
      text: "load_skill: review: its SKILL.md could not be read (the path could not be read (EACCES)).",
    });
  });

  test("refuses a SKILL.md gone since discovery, or swapped for a link out of its folder", async () => {
    const root = await writeSkill(personal, "review", skillText("review", "Review."));
    await writeFile(join(base, "outside.md"), skillText("review", "Elsewhere."));
    const { skills } = await readSkills(home, []);
    await unlink(join(root, "SKILL.md"));
    expect(await loadSkill("review", skills, [])).toEqual({
      status: "error",
      text: "load_skill: review: its SKILL.md could not be read (no such file).",
    });
    await symlink(join(base, "outside.md"), join(root, "SKILL.md"));
    expect(await loadSkill("review", skills, [])).toEqual({
      status: "error",
      text: "load_skill: review: its SKILL.md could not be read (it links outside the skill's folder).",
    });
  });
});

describe("findSlashSkill", () => {
  const review: Skill = { name: "review", description: "Review.", root: "/s/review", listedToModel: true };
  const deploy: Skill = { name: "deploy", description: "Deploy.", root: "/s/deploy", listedToModel: false };
  const skills = [review, deploy];

  test("finds the skill a message starts with, and the text after its name, trimmed, as its arguments", () => {
    expect(findSlashSkill("/review  the parser\nand its tests ", skills)).toEqual({
      skill: review,
      args: "the parser\nand its tests",
    });
    expect(findSlashSkill("/review", skills)).toEqual({ skill: review, args: "" });
    expect(findSlashSkill("/review\tnow", skills)).toEqual({ skill: review, args: "now" });
  });

  test("finds a skill kept from the model too", () => {
    expect(findSlashSkill("/deploy prod", skills)).toEqual({ skill: deploy, args: "prod" });
  });

  test("a name no skill has, a name followed by more than whitespace, or a slash not first is no skill", () => {
    for (const text of [
      "/nothing here",
      "/new",
      "/model",
      "/review/x",
      "/review.",
      "/Review",
      "say /review",
      "review",
    ]) {
      expect(findSlashSkill(text, skills)).toBeUndefined();
    }
  });
});

describe("loadSkillText with the user's arguments", () => {
  const header = (name: string, root: string) =>
    `Skill ${name} loaded; its files live in ${root}; read them by that absolute path.`;

  async function discovered(name: string, body: string): Promise<{ skill: Skill; root: string }> {
    const root = await writeSkill(personal, name, `${skillText(name, "D.").replace("\n# Body\n", "")}${body}`);
    const { skills } = await readSkills(home, []);
    return { skill: skills.find((skill) => skill.name === name)!, root };
  }

  test("replaces every $ARGUMENTS of the body with the arguments, taken literally", async () => {
    const { skill, root } = await discovered("grilling", "Grill: $ARGUMENTS\nAgain: $ARGUMENTS\n");
    expect(await loadSkillText(skill, "my $& idea")).toEqual({
      status: "ok",
      text: `${header("grilling", root)}\n\nGrill: my $& idea\nAgain: my $& idea\n`,
    });
  });

  test("replaces $ARGUMENTS with the empty string when there are no arguments", async () => {
    const { skill, root } = await discovered("grilling", "Grill: $ARGUMENTS.\n");
    expect(await loadSkillText(skill, "")).toEqual({ status: "ok", text: `${header("grilling", root)}\n\nGrill: .\n` });
  });

  test("without $ARGUMENTS in the body, a blank line then the arguments follow it; nothing when there are none", async () => {
    const { skill, root } = await discovered("grilling", "Grill the user.\n\n");
    expect(await loadSkillText(skill, "my idea")).toEqual({
      status: "ok",
      text: `${header("grilling", root)}\n\nGrill the user.\n\nmy idea`,
    });
    expect(await loadSkillText(skill, "")).toEqual({
      status: "ok",
      text: `${header("grilling", root)}\n\nGrill the user.\n\n`,
    });
  });

  test("substitutes before the 2,000-line cut, so arguments holding lines cannot push the notice", async () => {
    const lines = Array.from({ length: 1999 }, (_, index) => `step ${index + 1}`).join("\n");
    const { skill } = await discovered("long", `$ARGUMENTS\n${lines}\n`);
    const result = await loadSkillText(skill, "a\nb");
    expect(result.text).toContain("\n\na\nb\nstep 1\n");
    expect(result.text).toEndWith("\nstep 1998\n[truncated: 1 more lines not shown]");
  });

  test("an unreadable SKILL.md says the skill could not be loaded, then the arguments", async () => {
    const { skill, root } = await discovered("grilling", "Grill: $ARGUMENTS\n");
    await unlink(join(root, "SKILL.md"));
    expect(await loadSkillText(skill, "my idea")).toEqual({
      status: "error",
      text: "Skill grilling could not be loaded: its SKILL.md could not be read (no such file).\n\nmy idea",
    });
    expect(await loadSkillText(skill, "")).toEqual({
      status: "error",
      text: "Skill grilling could not be loaded: its SKILL.md could not be read (no such file).",
    });
  });

  test("the model's load keeps $ARGUMENTS as written", async () => {
    const { skill, root } = await discovered("grilling", "Grill: $ARGUMENTS\n");
    expect(await loadSkillText(skill)).toEqual({
      status: "ok",
      text: `${header("grilling", root)}\n\nGrill: $ARGUMENTS\n`,
    });
  });
});
