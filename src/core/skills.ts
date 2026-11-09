/**
 * @module skills
 * Skill discovery: the direct children of `~/.agents/skills/` and of each workspace folder's `.agents/skills/` that
 * hold a `SKILL.md`, read at each send. A skill is valid when its frontmatter holds a `name` and a `description` that
 * follow the Agent Skills specification (agentskills.io/specification); any other skill is skipped with a warning.
 * No other tool's folder (`.claude/`, `.codex/`) is ever read.
 */
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { SkillProblem, SkillWarning } from "./protocol";
import type { Skill } from "./systemPrompt";
import {
  compareNames,
  readFileOutsideWorkspace,
  readWorkspaceEntryAt,
  type WorkspaceEntry,
  type WorkspaceRoot,
} from "./workspaceFiles";

/** What a send discovers: the valid skills, by name, and a warning per skipped skill or unreadable skills folder. */
export type SkillDiscovery = { skills: Skill[]; warnings: SkillWarning[] };

const FILE_NAME = "SKILL.md";
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
/** Lowercase letters and digits in groups joined by single hyphens: no hyphen first, last, or twice in a row. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** One skills folder: `label` shows it to the user; `read` reads a `SKILL.md` under it with its boundary policy. */
type SkillSource = { folder: string; label: string; read: (path: string) => Promise<WorkspaceEntry> };

/**
 * The skills of `~/.agents/skills/` under `home`, then of each of `roots`' `.agents/skills/`. A workspace skill hides
 * a personal skill of the same name, and an earlier workspace folder a later one; a hidden skill gives no warning.
 * A personal skill folder follows symlinks (dotfiles are often linked); a workspace one is held to the workspace
 * boundary, as instruction files are. A folder without `SKILL.md`, a stray file, and a missing skills folder pass
 * silently; any other failure is a warning. Never rejects.
 */
export async function readSkills(home: string, roots: WorkspaceRoot[]): Promise<SkillDiscovery> {
  const personal: SkillSource = {
    folder: join(home, ".agents", "skills"),
    label: "~/.agents/skills",
    read: readFileOutsideWorkspace,
  };
  const workspace = roots.map(
    (root): SkillSource => ({
      folder: join(root.path, ".agents", "skills"),
      label: roots.length > 1 ? `${root.name}/.agents/skills` : ".agents/skills",
      // [>]: At its absolute path, never through folder names, as for instruction files (see `instructions.ts`).
      read: (path) => readWorkspaceEntryAt(roots, path),
    }),
  );
  const found = await Promise.all([...workspace, personal].map(readSource));

  // [>]: Sources in precedence order: the first skill of a name wins.
  const byName = new Map<string, Skill>();
  for (const skill of found.flatMap((source) => source.skills)) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  // [>]: Warnings in discovery order: personal first, then each workspace folder.
  const warnings = [found.at(-1)!, ...found.slice(0, -1)].flatMap((source) => source.warnings);
  return { skills: [...byName.values()].sort((a, b) => compareNames(a.name, b.name)), warnings };
}

async function readSource(source: SkillSource): Promise<SkillDiscovery> {
  let children: string[];
  try {
    children = (await readdir(source.folder)).sort(compareNames);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { skills: [], warnings: [] };
    return {
      skills: [],
      warnings: [{ path: source.label, problem: { kind: "folderUnreadable", cause: causeOf(error) } }],
    };
  }
  const outcomes = await Promise.all(children.map((directory) => readSkill(source, directory)));
  const discovery: SkillDiscovery = { skills: [], warnings: [] };
  for (const outcome of outcomes) {
    if (outcome?.kind === "skill") discovery.skills.push(outcome.skill);
    if (outcome?.kind === "warning") discovery.warnings.push(outcome.warning);
  }
  return discovery;
}

/** The skill in `directory` of `source`, a warning, or `undefined` when it holds no `SKILL.md`. */
async function readSkill(
  source: SkillSource,
  directory: string,
): Promise<{ kind: "skill"; skill: Skill } | { kind: "warning"; warning: SkillWarning } | undefined> {
  const folder = join(source.folder, directory);
  const warn = (problem: SkillProblem) => ({
    kind: "warning" as const,
    warning: { path: `${source.label}/${directory}/${FILE_NAME}`, problem },
  });
  // [>]: A stray file in the skills folder reads as missing too (`ENOTDIR`).
  const entry = await source.read(join(folder, FILE_NAME));
  if (entry.status === "missing") return undefined;
  if (entry.status === "unreadable") return warn({ kind: "unreadable", cause: entry.cause });
  if (entry.status !== "ok") return warn({ kind: entry.status });
  if (entry.kind !== "file") return warn({ kind: "unreadable", cause: "not a file" });

  const parsed = validate(entry.text, directory);
  if ("problem" in parsed) return warn(parsed.problem);
  try {
    return { kind: "skill", skill: { ...parsed, root: await realpath(folder) } };
  } catch (error) {
    return warn({ kind: "unreadable", cause: causeOf(error) });
  }
}

/** The skill `text` describes in the folder `directory`, without its root, or the first problem found. */
function validate(text: string, directory: string): Omit<Skill, "root"> | { problem: SkillProblem } {
  const fields = parseFrontmatter(text);
  if (fields === undefined) return { problem: { kind: "noFrontmatter" } };

  const name = fields.get("name");
  if (name === null) return { problem: { kind: "unparsableField", field: "name" } };
  if (name === undefined || name === "") return { problem: { kind: "missingName" } };
  if ([...name].length > MAX_NAME_LENGTH) return { problem: { kind: "nameTooLong" } };
  if (!NAME_PATTERN.test(name)) return { problem: { kind: "invalidName" } };
  if (name !== directory) return { problem: { kind: "nameMismatch", name, directory } };

  const description = fields.get("description");
  if (description === null) return { problem: { kind: "unparsableField", field: "description" } };
  if (description === undefined || description.trim() === "") return { problem: { kind: "missingDescription" } };
  if ([...description].length > MAX_DESCRIPTION_LENGTH) return { problem: { kind: "descriptionTooLong" } };

  // [>]: Outside the specification: a skill only the user loads, with `/<name>` (#11).
  const listedToModel = !["true", "True", "TRUE"].includes(fields.get("disable-model-invocation") ?? "");
  return { name, description, listedToModel };
}

/**
 * The top-level fields of the frontmatter: the lines between a first line `---` and the next line `---`. A value is
 * a plain scalar (with continuation lines and `#` comments), a single- or double-quoted scalar closed on its line,
 * or a `>` or `|` block scalar on the following indented lines. Nested maps, lists, and other keys' errors are
 * ignored; `null`: a value of another form. `undefined` when there is no frontmatter.
 *
 * A YAML subset by design: a skill needs two strings, and a YAML library would be a dependency for that alone.
 */
function parseFrontmatter(text: string): Map<string, string | null> | undefined {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  if (lines[0]?.trimEnd() !== "---") return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1) return undefined;

  const fields = new Map<string, string | null>();
  const body = lines.slice(1, end);
  let index = 0;
  while (index < body.length) {
    const match = /^([A-Za-z0-9_.-]+)[ \t]*:(?:[ \t]+(.*))?$/.exec(body[index]!);
    index += 1;
    if (!match) continue;
    // [>]: The indented lines that follow belong to this key: a block scalar, a continuation, or a nested map.
    const start = index;
    while (index < body.length && (body[index]!.trim() === "" || /^[ \t]/.test(body[index]!))) index += 1;
    const value = scalarValue((match[2] ?? "").trim(), body.slice(start, index));
    if (value !== undefined) fields.set(match[1]!, value);
  }
  return fields;
}

/**
 * The value of a key whose line holds `head`, followed by the indented or blank lines `rest`; `undefined` for a nested
 * map or list.
 */
function scalarValue(head: string, rest: string[]): string | null | undefined {
  const block = /^([>|])(?:[+-]?[1-9]?|[1-9][+-])(?:[ \t]+#.*)?$/.exec(head);
  if (block) {
    const indent = Math.min(...rest.filter((line) => line.trim() !== "").map((line) => line.search(/\S/)));
    const content = rest.map((line) => line.slice(indent).trimEnd());
    while (content.at(-1) === "") content.pop();
    return block[1] === "|" ? content.join("\n") : fold(content);
  }
  if (head.startsWith('"')) return doubleQuoted(head);
  if (head.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'[ \t]*(?:#.*)?$/.exec(head);
    return match ? match[1]!.replaceAll("''", "'") : null;
  }
  // [>]: An empty head followed by `key:` or `- item` lines opens a nested map or list: not a string.
  const continuation = rest.map((line) => line.trim());
  if (head === "" && /^(?:[^\s:#][^:]*:(?:\s|$)|-(?:\s|$))/.test(continuation.find((line) => line !== "") ?? "")) {
    return undefined;
  }
  while (continuation.at(-1) === "") continuation.pop();
  return fold([head, ...continuation].map(withoutComment)).trim();
}

/** Folded lines: a line break between two lines becomes a space; each blank line, a line break. */
function fold(lines: string[]): string {
  let text = "";
  let previous: "start" | "text" | "blank" = "start";
  for (const line of lines) {
    if (line === "") {
      text += "\n";
      previous = "blank";
    } else {
      text += previous === "text" ? ` ${line}` : line;
      previous = "text";
    }
  }
  return text;
}

function withoutComment(line: string): string {
  return line.startsWith("#") ? "" : line.replace(/[ \t]+#.*$/, "");
}

const ESCAPES: Record<string, string> = {
  "0": "\0",
  n: "\n",
  t: "\t",
  r: "\r",
  '"': '"',
  "\\": "\\",
  "/": "/",
  " ": " ",
};

/** A double-quoted scalar closed on its line, escapes decoded; `null` when it does not close or is followed by text. */
function doubleQuoted(head: string): string | null {
  let value = "";
  for (let index = 1; index < head.length; index += 1) {
    const char = head[index]!;
    if (char === '"') return /^[ \t]*(?:#.*)?$/.test(head.slice(index + 1)) ? value : null;
    if (char !== "\\") {
      value += char;
      continue;
    }
    const next = head[index + 1] ?? "";
    const hex = { x: 2, u: 4, U: 8 }[next];
    if (hex !== undefined) {
      const digits = head.slice(index + 2, index + 2 + hex);
      const point = Number.parseInt(digits, 16);
      if (!/^[0-9a-fA-F]+$/.test(digits) || digits.length !== hex || point > 0x10ffff) return null;
      value += String.fromCodePoint(point);
      index += 1 + hex;
    } else if (next in ESCAPES) {
      value += ESCAPES[next];
      index += 1;
    } else {
      return null;
    }
  }
  return null;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function causeOf(error: unknown): string {
  return errorCode(error) ?? String(error);
}
