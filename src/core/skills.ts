/**
 * @module skills
 * Skill discovery: the direct children of `~/.agents/skills/` and of each workspace folder's `.agents/skills/` that
 * hold a `SKILL.md`, read at each send. A skill is valid when its frontmatter holds a `name` and a `description` that
 * follow the Agent Skills specification (agentskills.io/specification); any other skill is skipped with a warning.
 * No other tool's folder (`.claude/`, `.codex/`) is ever read. Also skill loading: the `load_skill` tool, the `/<name>`
 * a user message loads, and the text a loaded skill gives the model. Model-facing text is English and never localized.
 */
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { accessFailureReason, MAX_MENTION_LINES, truncationNotice } from "./mentions";
import type { HostMessage, SkillProblem, SkillWarning } from "./protocol";
import type { Skill } from "./systemPrompt";
import type { ToolSpec } from "./toolCalls";
import { excerpt, type ToolResult } from "./tools";
import {
  type AccessFailure,
  compareNames,
  isInside,
  locateWorkspacePath,
  readFileOutsideWorkspace,
  readWorkspaceEntry,
  readWorkspaceEntryAt,
  truncateLines,
  type WorkspaceEntry,
  type WorkspaceRoot,
} from "./workspaceFiles";

/** What a send discovers: the valid skills, by name, and a warning per skipped skill or unreadable skills folder. */
export type SkillDiscovery = { skills: Skill[]; warnings: SkillWarning[] };

/** Test seam: `aroundRead` wraps each `SKILL.md` read, to observe how many run at once. */
export type SkillReadSeam = { aroundRead?: (read: () => Promise<WorkspaceEntry>) => Promise<WorkspaceEntry> };

/**
 * How many entries of one skills folder a send reads, the first by name; the rest are skipped with one warning. A
 * repository controls its own skills folder, so without a cap it could make every send read thousands of `SKILL.md`
 * files of up to 1 MiB each. Real folders hold tens of skills; 200 keeps them all and bounds a send to 200 reads per
 * skills folder.
 */
export const MAX_SKILL_ENTRIES = 200;

const FILE_NAME = "SKILL.md";
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
/** Lowercase letters and digits in groups joined by single hyphens: no hyphen first, last, or twice in a row. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * One skills folder: `label` shows it to the user; `read` reads a `SKILL.md` under it and `locate` resolves a skill
 * folder under it, each with the folder's boundary policy. `locate` rejects on a disk error other than a missing path.
 */
type SkillSource = {
  folder: string;
  label: string;
  read: (path: string) => Promise<WorkspaceEntry>;
  locate: (folder: string) => Promise<{ status: "ok"; realPath: string } | { status: "missing" | "outsideWorkspace" }>;
};

/** A skipped candidate's warning with its directory name, or a skills folder's warning (no directory). */
type SourceWarning = { directory?: string; warning: SkillWarning };

/** What one skills folder holds: its valid skills and its warnings. */
type SourceDiscovery = { skills: Skill[]; warnings: SourceWarning[] };

/**
 * The skills of `~/.agents/skills/` under `home`, then of each of `roots`' `.agents/skills/`. A workspace skill hides
 * a personal skill of the same name, and an earlier workspace folder a later one; a hidden candidate gives no warning,
 * valid or not. A skipped candidate hides nothing: a valid one of its name from a later source is listed, and the
 * skipped one warns. A personal skill folder follows symlinks (dotfiles are often linked); a workspace one, the folder
 * and its `SKILL.md` alike, is held to its own workspace folder, as instruction files are. Either way `SKILL.md` must
 * resolve inside the skill folder's real path, the one folder a loaded skill's files are read from. A folder without `SKILL.md`, a stray file, and a missing skills
 * folder pass silently; any other failure is a warning. Only the first `MAX_SKILL_ENTRIES` entries of a skills folder
 * are read, and one `SKILL.md` at a time, so the files a repository holds cannot multiply the reads of a send. Never
 * rejects.
 */
export async function readSkills(
  home: string,
  roots: WorkspaceRoot[],
  seam: SkillReadSeam = {},
): Promise<SkillDiscovery> {
  const personal: SkillSource = {
    folder: join(home, ".agents", "skills"),
    label: "~/.agents/skills",
    read: readFileOutsideWorkspace,
    locate: (folder) =>
      realpath(folder).then(
        (realPath) => ({ status: "ok" as const, realPath }),
        (error: unknown) => {
          if (errorCode(error) === "ENOENT") return { status: "missing" as const };
          throw error;
        },
      ),
  };
  const workspace = roots.map(
    (root): SkillSource => ({
      folder: join(root.path, ".agents", "skills"),
      label: roots.length > 1 ? `${root.name}/.agents/skills` : ".agents/skills",
      // [>]: At its absolute path, never through folder names, as for instruction files (see `instructions.ts`).
      read: (path) => readWorkspaceEntryAt([root], path),
      // [>]: The folder too, not only its `SKILL.md`: a folder linked out with a `SKILL.md` linked back is outside.
      locate: (folder) => locateWorkspacePath([root], folder),
    }),
  );
  // [>]: Sources in precedence order: the first skill of a name wins.
  const found: SourceDiscovery[] = [];
  for (const source of [...workspace, personal]) found.push(await readSource(source, seam));

  const winners = new Map<string, { skill: Skill; source: number }>();
  found.forEach((source, index) => {
    for (const skill of source.skills) if (!winners.has(skill.name)) winners.set(skill.name, { skill, source: index });
  });
  const hidden = (entry: SourceWarning, source: number) => {
    const winner = entry.directory === undefined ? undefined : winners.get(entry.directory);
    return winner !== undefined && winner.source < source;
  };
  const warnings = found.map((source, index) =>
    source.warnings.filter((entry) => !hidden(entry, index)).map((entry) => entry.warning),
  );
  return {
    skills: [...winners.values()].map((winner) => winner.skill).sort((a, b) => compareNames(a.name, b.name)),
    // [>]: Warnings in discovery order: personal first, then each workspace folder.
    warnings: [warnings.at(-1)!, ...warnings.slice(0, -1)].flat(),
  };
}

/**
 * The host's answer to the `/` menu's `querySkills` `id`: the name and description of each skill `read` discovers, those
 * kept from the model included, since the user may still load them with `/<name>`. Skipped skills are left out and
 * their warnings dropped: the next send shows them. A reader that fails is logged and answers `failed`, so the menu
 * says so and still shows the built-in commands.
 */
export async function answerSkillQuery(
  id: number,
  read: () => Promise<SkillDiscovery>,
): Promise<HostMessage & { type: "skillSuggestions" }> {
  try {
    const { skills } = await read();
    const items = skills.map(({ name, description }) => ({ name, description }));
    return { type: "skillSuggestions", id, items, failed: false };
  } catch (error) {
    console.error("broke-code: could not list the skills for the / menu", error);
    return { type: "skillSuggestions", id, items: [], failed: true };
  }
}

/**
 * The line the extension logs at each send, so the skills the model sees can be checked in the extension host log:
 * each listed skill with its folder, the skills kept from the model, and how many were skipped.
 */
export function describeSkillDiscovery(discovery: SkillDiscovery): string {
  const listed = discovery.skills
    .filter((skill) => skill.listedToModel)
    .map((skill) => `${skill.name} (${skill.root})`);
  const kept = discovery.skills.filter((skill) => !skill.listedToModel).map((skill) => skill.name);
  return `broke-code: skills listed to the model: ${listed.join(", ") || "none"}; kept from the model: ${kept.join(", ") || "none"}; skipped: ${discovery.warnings.length}`;
}

async function readSource(source: SkillSource, seam: SkillReadSeam): Promise<SourceDiscovery> {
  let children: string[];
  try {
    children = (await readdir(source.folder)).sort(compareNames);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { skills: [], warnings: [] };
    return {
      skills: [],
      warnings: [{ warning: { path: source.label, problem: { kind: "folderUnreadable", cause: causeOf(error) } } }],
    };
  }
  const discovery: SourceDiscovery = { skills: [], warnings: [] };
  if (children.length > MAX_SKILL_ENTRIES) {
    discovery.warnings.push({
      warning: { path: source.label, problem: { kind: "tooManyEntries", entries: children.length } },
    });
  }
  // [!]: One read at a time: each holds a 1 MiB buffer and a file descriptor until it settles.
  for (const directory of children.slice(0, MAX_SKILL_ENTRIES)) {
    const outcome = await readSkill(source, directory, seam);
    if (outcome?.kind === "skill") discovery.skills.push(outcome.skill);
    if (outcome?.kind === "warning") discovery.warnings.push({ directory, warning: outcome.warning });
  }
  return discovery;
}

/** The skill in `directory` of `source`, a warning, or `undefined` when it holds no `SKILL.md`. */
async function readSkill(
  source: SkillSource,
  directory: string,
  seam: SkillReadSeam,
): Promise<{ kind: "skill"; skill: Skill } | { kind: "warning"; warning: SkillWarning } | undefined> {
  const folder = join(source.folder, directory);
  const warn = (problem: SkillProblem) => ({
    kind: "warning" as const,
    warning: { path: `${source.label}/${directory}/${FILE_NAME}`, problem },
  });
  // [>]: A stray file in the skills folder reads as missing too (`ENOTDIR`).
  const read = () => source.read(join(folder, FILE_NAME));
  const entry = await (seam.aroundRead ? seam.aroundRead(read) : read());
  if (entry.status === "missing") return undefined;
  if (entry.status === "unreadable") return warn({ kind: "unreadable", cause: entry.cause });
  if (entry.status !== "ok") return warn({ kind: entry.status });
  if (entry.kind !== "file") return warn({ kind: "unreadable", cause: "not a file" });

  try {
    const located = await source.locate(folder);
    if (located.status !== "ok") {
      // [>]: Gone since its `SKILL.md` was read: as a folder without one.
      return located.status === "missing" ? undefined : warn({ kind: "outsideWorkspace" });
    }
    // [!]: Every file of a skill lies in its own folder, `SKILL.md` included, so the folder the model may read once
    // the skill is loaded holds all of it. The folder itself may be a link (its real path is the root).
    const file = await realpath(join(located.realPath, FILE_NAME)).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (file === undefined) return undefined;
    if (!isInside(located.realPath, file)) return warn({ kind: "outsideSkillFolder" });
    // [>]: Inside the `try`, so a parser bug skips this skill with a warning rather than the whole discovery.
    const parsed = validate(entry.text, directory);
    if ("problem" in parsed) return warn(parsed.problem);
    return { kind: "skill", skill: { ...parsed, root: located.realPath } };
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

/** The frontmatter fields `validate` reads; any other key is skipped undecoded. */
const FIELDS = new Set(["name", "description", "disable-model-invocation"]);

/**
 * The top-level `FIELDS` of the frontmatter: the lines between a first line `---` and the next line `---`. A value is
 * a plain scalar (with continuation lines and `#` comments), a single- or double-quoted scalar closed on its line,
 * or a `>` or `|` block scalar on the following indented lines. Nested maps, lists, and other keys are ignored;
 * `null`: a value of another form. `undefined` when there is no frontmatter.
 *
 * A YAML subset by design: a skill needs two strings, and a YAML library would be a dependency for that alone.
 */
function parseFrontmatter(text: string): Map<string, string | null> | undefined {
  const split = splitFrontmatter(text);
  if (split === undefined) return undefined;

  const fields = new Map<string, string | null>();
  const body = split.frontmatter;
  let index = 0;
  while (index < body.length) {
    // [!]: `s`, so `.` takes U+2028 and U+2029 too: without it, a whitespace run before one backtracks quadratically.
    const match = /^([A-Za-z0-9_.-]+)[ \t]*:(?:[ \t]+(.*))?$/s.exec(body[index]!);
    index += 1;
    if (!match) continue;
    // [>]: The indented lines that follow belong to this key: a block scalar, a continuation, or a nested map.
    const start = index;
    while (index < body.length && (body[index]!.trim() === "" || /^[ \t]/.test(body[index]!))) index += 1;
    if (!FIELDS.has(match[1]!)) continue;
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
    // [!]: A loop, not `Math.min(...lines)`: V8 throws a RangeError on 200,000 arguments, which a 1 MiB block holds.
    let indent = Number.POSITIVE_INFINITY;
    for (const line of rest) if (line.trim() !== "") indent = Math.min(indent, line.search(/\S/));
    const content = rest.map((line) => line.slice(indent).trimEnd());
    while (content.at(-1) === "") content.pop();
    return block[1] === "|" ? content.join("\n") : fold(content);
  }
  if (head.startsWith('"')) return doubleQuoted(head);
  if (head.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'[ \t]*(?:#.*)?$/.exec(head);
    return match ? match[1]!.replaceAll("''", "'") : null;
  }
  const [first = "", ...continuation] = [head, ...rest].map((line) => withoutComment(line.trim()));
  // [>]: A head empty but for a comment, followed by `key:` or `- item` lines, opens a nested map or list: not a string.
  if (first === "" && /^(?:[^\s:#][^:]*:(?:\s|$)|-(?:\s|$))/.test(continuation.find((line) => line !== "") ?? "")) {
    return undefined;
  }
  // [>]: An unquoted value that opens with `{` or `[`, on the head or the first line after an empty head, is a flow map
  // or sequence: not a string either.
  if (/^[{[]/.test(first === "" ? (continuation.find((line) => line !== "") ?? "") : first)) return undefined;
  while (continuation.at(-1) === "") continuation.pop();
  return fold([first, ...continuation]).trim();
}

/**
 * The lines between a first line `---` and the next line `---`, and the text after that closing line, its line breaks
 * kept as written; `undefined` when there is no frontmatter. A byte order mark before the first line is dropped.
 */
function splitFrontmatter(text: string): { frontmatter: string[]; rest: string } | undefined {
  // [>]: Lines at even indexes, each followed by the line break that ends it at the next odd index.
  const parts = text.replace(/^\ufeff/, "").split(/(\r\n|\r|\n)/);
  if (parts[0]?.trimEnd() !== "---") return undefined;
  for (let index = 2; index < parts.length; index += 2) {
    if (parts[index]!.trimEnd() !== "---") continue;
    const frontmatter = parts.filter((_, part) => part % 2 === 0).slice(1, index / 2);
    return { frontmatter, rest: parts.slice(index + 2).join("") };
  }
  return undefined;
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

/**
 * `line` cut at its comment: a `#` that starts the line or follows a space or tab, through the end of the line.
 *
 * [!]: A loop, not `/[ \t]+#.*$/`: that regex backtracks quadratically over a long whitespace run without `#`, and a
 * repository's `SKILL.md` would freeze the extension host at each send.
 */
function withoutComment(line: string): string {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "#" && (index === 0 || line[index - 1] === " " || line[index - 1] === "\t")) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line;
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

/** The `load_skill` tool as the model sees it: for the system prompt and the body tool call parser. */
export const LOAD_SKILL_TOOL: ToolSpec = {
  name: "load_skill",
  description:
    "Load a skill listed under Skills: returns its instructions and the absolute path of its folder. Read the other files of a loaded skill with read_file, list_files, or search, by the absolute path the result gives; a skill folder outside the workspace is read-only. Load a skill once per conversation.",
  args: [{ name: "name", required: true, description: "The skill's name, as listed under Skills." }],
};

/**
 * The model's `load_skill` of `name`: the skill of that name among `skills` (the send's discovery) that is listed to
 * the model. A skill whose folder is in `loadedRoots` (the real folders of the skills loaded in the conversation) is
 * already loaded: `ok`, saying so, without the body. An unknown name, a skipped skill, and one kept from the model give
 * an `error` naming the skills the model may load. Never rejects.
 */
export async function loadSkill(
  name: string,
  skills: readonly Skill[],
  loadedRoots: readonly string[],
): Promise<ToolResult> {
  const loadable = skills.filter((skill) => skill.listedToModel);
  const skill = loadable.find((candidate) => candidate.name === name);
  if (skill === undefined) {
    const names = loadable.map((candidate) => candidate.name).sort(compareNames);
    const choice = names.length > 0 ? `Skills you can load: ${names.join(", ")}.` : "No skill can be loaded.";
    return { status: "error", text: `load_skill: ${excerpt(name)}: no skill of that name can be loaded. ${choice}` };
  }
  if (loadedRoots.includes(skill.root)) {
    return { status: "ok", text: `Skill ${skill.name} is already loaded; ${whereFilesLive(skill)}` };
  }
  return loadSkillText(skill);
}

/** A message that loads a skill: the skill its `/<name>` names, and the text after the name, trimmed. */
export type SlashSkill = { skill: Skill; args: string };

/**
 * The skill `text` loads, when its trimmed text starts with `/`, a skill name, then whitespace or nothing: the skill of
 * that name among `skills` (the send's discovery), listed to the model or not. `undefined` for any other text, so an
 * unknown `/word` goes to the model as typed.
 */
export function findSlashSkill(text: string, skills: readonly Skill[]): SlashSkill | undefined {
  const match = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const skill = match ? skills.find((candidate) => candidate.name === match[1]) : undefined;
  if (match === null || skill === undefined) return undefined;
  return { skill, args: match[2] ?? "" };
}

/** The placeholder of a skill body that a user load replaces with the text after `/<name>`. */
const ARGUMENTS = "$ARGUMENTS";

/**
 * What loading `skill` gives the model, whoever loads it: a header naming the real path of its folder, then its
 * `SKILL.md` body, frontmatter and the blank lines after it removed, cut to the mention caps (1 MiB, 2,000 lines) with
 * the usual notice. `SKILL.md` is read as the files of a loaded skill are: inside the skill's real folder, symlinks
 * resolved. An `error` when it cannot be read. Never rejects.
 *
 * `args`: given when the user loads the skill with `/<name> args` (empty without arguments), absent for `load_skill`.
 * Every `$ARGUMENTS` of the body becomes `args`, before the cut; a body without one is followed by a blank line and
 * `args`, unless empty. The error then says the skill could not be loaded, followed by `args` the same way, since the
 * message still goes.
 */
export async function loadSkillText(skill: Skill, args?: string): Promise<ToolResult> {
  const withArgs = (text: string) => (args ? `${text}\n\n${args}` : text);
  // [>]: Discovery already refused a `SKILL.md` linked out; this read is the boundary, should it be swapped since.
  const entry = await readWorkspaceEntry([], join(skill.root, FILE_NAME), {}, [skill.root]);
  if (entry.status !== "ok" || entry.kind !== "file") {
    const reason =
      entry.status === "ok" ? "it is a folder" : skillFileFailure(entry.status, "cause" in entry ? entry.cause : "");
    const failure = `its ${FILE_NAME} could not be read (${reason}).`;
    if (args === undefined) return { status: "error", text: `load_skill: ${skill.name}: ${failure}` };
    return { status: "error", text: withArgs(`Skill ${skill.name} could not be loaded: ${failure}`) };
  }
  const written = (splitFrontmatter(entry.text)?.rest ?? entry.text).replace(/^(?:[ \t]*(?:\r\n|\r|\n))+/, "");
  const substitutes = args !== undefined && written.includes(ARGUMENTS);
  // [!]: A function, not the string: `replaceAll` reads `$&` and the like in a replacement string as patterns.
  const body = substitutes ? written.replaceAll(ARGUMENTS, () => args) : written;
  const header = `Skill ${skill.name} loaded; ${whereFilesLive(skill)}`;
  const cut = truncateLines(body, MAX_MENTION_LINES);
  const notice = cut.omitted > 0 ? `\n${truncationNotice(cut.omitted)}` : "";
  const text = body === "" ? header : `${header}\n\n${cut.text}${notice}`;
  if (substitutes || !args) return { status: "ok", text };
  return { status: "ok", text: withArgs(text.replace(/(?:\r\n|\r|\n)+$/, "")) };
}

function whereFilesLive(skill: Skill): string {
  return `its files live in ${skill.root}; read them by that absolute path.`;
}

function skillFileFailure(failure: AccessFailure, cause: string): string {
  if (failure === "outsideWorkspace") return "it links outside the skill's folder";
  if (failure === "missing") return "no such file";
  return accessFailureReason(failure, cause);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function causeOf(error: unknown): string {
  return errorCode(error) ?? String(error);
}
