import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSkillDiscovery, readSkills } from "./skills";

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

  test("warns about a skills folder that exists but cannot be listed, and still reads the others", async () => {
    await writeSkill(workspaceSkills(), "kept", skillText("kept", "Kept."));
    await chmod(personal, 0o000);
    const { skills, warnings } = await readSkills(home, single());
    expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
    expect(warnings).toEqual([{ path: "~/.agents/skills", problem: { kind: "folderUnreadable", cause: "EACCES" } }]);
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
