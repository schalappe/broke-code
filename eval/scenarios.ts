/**
 * @module scenarios
 * The eval scenarios and the verdict of one run. A scenario is a fixture workspace, the message sent, the files the
 * turn must write, and an optional check of a turn that ended `done`; `judge` adds what every scenario shares: halts,
 * failed replies, format failures, and the workspace after the run against the one expected. The verdict reads the
 * entries and the workspace files after the run, never the wording of the answer beyond the value a scenario asks for.
 */

import { RUN_COMMAND_TOOL } from "../src/core/commands";
import type { ChatEntry } from "../src/core/protocol";
import type { ProviderError } from "../src/core/providerError";
import { READ_TOOLS } from "../src/core/tools";

/**
 * Workspace files by relative POSIX path: a scenario's fixture, or the throwaway copy read back after a run. [!]: A
 * path is any file name, `__proto__` included, so look one up with `fileAt` and build one on `Object.create(null)`,
 * never with `files[path]` or `in` on a plain object.
 */
export type WorkspaceFiles = Record<string, string>;

/**
 * What a workspace holds at a path that is not a folder: a regular file's text, a symlink's target as written, or the
 * kind of any other entry (`fifo`, `socket`, `blockDevice`, `characterDevice`). Objects, so a symlink never equals a
 * file whose text is its target.
 */
export type WorkspaceEntry = string | { symlink: string } | { special: string };

/**
 * Every entry of the throwaway copy read back after a run, folders aside, by relative POSIX path. Keyed like
 * `WorkspaceFiles`, which it extends to entries a command can add.
 */
export type WorkspaceSnapshot = Record<string, WorkspaceEntry>;

/** The entry at `path` in `files`, `undefined` when there is none: own keys only, never the prototype's. */
export function fileAt<T>(files: Record<string, T>, path: string): T | undefined {
  return Object.hasOwn(files, path) ? files[path] : undefined;
}

/**
 * Why a run failed, one per failed run. `malformed`: a malformed call halted the turn, or the turn had one and missed
 * the check. `wrongTool`: no tool step got what the scenario needed. `wrongAnswer`: the turn ended `done` without the
 * value. `stepLimit`, `contextFull`: the turn halted on that limit. `providerError`: a reply failed. `wrongEdit`: a
 * file the scenario asks to write is missing or holds other text, so the write had the wrong content or went to the
 * wrong place (any other file it changed is named too). `workspaceChanged`: every file the scenario asks to write is
 * right, or it asks for none, but another file was added, removed, or changed.
 */
export type FailureCategory =
  | "malformed"
  | "wrongTool"
  | "wrongAnswer"
  | "stepLimit"
  | "contextFull"
  | "providerError"
  | "wrongEdit"
  | "workspaceChanged";

/** `detail`: one line for the report, enough to tell what the model did. */
export type Verdict = { pass: true } | { pass: false; category: FailureCategory; detail: string };

/**
 * `files`: the fixture workspace, copied fresh for each run. `home`: the fixture home folder, copied fresh for each run
 * and the only one the run's skills are discovered in (`.agents/skills/` under it); absent for an empty home, so the
 * model gets no skill. `message`: what the user sends. `writes`: the files the turn must leave in the workspace, each
 * with its exact text, byte for byte; every other fixture file must stay as it is and no other file may appear. Empty
 * for a scenario that changes nothing. `check`: what else a turn that ended `done` with the expected workspace must
 * show, from its entries; absent when the workspace says it all.
 */
export type Scenario = {
  name: string;
  files: WorkspaceFiles;
  home?: WorkspaceFiles;
  message: string;
  writes: WorkspaceFiles;
  check?(entries: readonly ChatEntry[]): Verdict;
};

/** The tools whose `ok` text is what the model read: a value in it came from a file. */
const READ_TOOL_NAMES = new Set(READ_TOOLS.map((tool) => tool.name));

const ROUTE_SEED = "kestrel-4471-vanta";

const READ_FILES: WorkspaceFiles = {
  "README.md": "# Courier\n\nRoutes parcels between depots. Settings live in config/settings.toml.\n",
  "config/settings.toml": [
    "[service]",
    'name = "courier"',
    "port = 8080",
    "",
    "[routing]",
    `route_seed = "${ROUTE_SEED}"`,
    "max_hops = 12",
    "",
    "",
  ].join("\n"),
  "src/main.py": 'from config import load\n\n\ndef main():\n    settings = load("config/settings.toml")\n',
};

/**
 * Read then answer: the value of a setting the model cannot guess. Passes when an `ok` tool step's text holds the
 * value (only the settings file does, so that step read it), the answer holds it, and no file changed.
 */
export const READ_SCENARIO: Scenario = {
  name: "read",
  files: READ_FILES,
  message: "What is the value of route_seed in config/settings.toml? Reply with the exact value.",
  writes: {},
  check(entries) {
    const steps = entries.filter((entry) => entry.role === "tool");
    if (!steps.some((step) => step.status === "ok" && step.text.includes(ROUTE_SEED))) {
      return { pass: false, category: "wrongTool", detail: `steps: ${describeSteps(steps)}` };
    }
    return answerHolds(entries, ROUTE_SEED);
  },
};

const PRICING_PATH = "src/pricing.py";
const pricing = (surcharge: string) =>
  [
    '"""Parcel pricing for the courier service."""',
    "",
    "BASE_FEE = 4.5",
    "PER_KG = 1.25",
    "MAX_WEIGHT_KG = 30",
    "",
    "",
    "def quote(weight_kg):",
    "    if weight_kg > MAX_WEIGHT_KG:",
    '        raise ValueError("parcel too heavy")',
    "    return BASE_FEE + PER_KG * weight_kg",
    "",
    "",
    `def ${surcharge}(distance_km):`,
    "    return 0.1 * distance_km",
    "",
  ].join("\n");

/**
 * Edit a precise line: rename a function named once in a small source file. Passes when exactly that line changed,
 * the rest of the file byte-identical, and no other file changed; `edit_file` and a faithful `write_file` both do.
 */
export const EDIT_SCENARIO: Scenario = {
  name: "edit",
  files: { ...READ_FILES, [PRICING_PATH]: pricing("compute_surcharge_v2") },
  message: `In ${PRICING_PATH}, rename the function compute_surcharge_v2 to distance_surcharge. Change nothing else.`,
  writes: { [PRICING_PATH]: pricing("distance_surcharge") },
};

const NOTE_PATH = "docs/call-format.md";
const NOTE_CONTENT = [
  "# Call format",
  "",
  'Write "route_seed" in double quotes. On Windows the logs sit in C:\\courier\\logs\\new.',
  "A value sits in <content>...</content>, and a call ends with </write_file>.",
  "",
  "```python",
  'pattern = re.compile(r"\\d+\\.\\d+")',
  'print("<tag>", pattern.pattern, "\\n")',
  "```",
].join("\n");

/**
 * Create a file with quotes and tags: a new file in a new folder whose content holds double quotes, backslashes,
 * `<tag>` text including the `write_file` call's own tags, and a fenced code block, as the parser of ADR 0001's
 * amendment must carry. The message states the content between fences longer than the inner one; passes when the file
 * holds exactly that text plus one line break and nothing else changed.
 */
export const CREATE_SCENARIO: Scenario = {
  name: "create",
  files: READ_FILES,
  message: [
    `Create the file ${NOTE_PATH} with exactly the text between the two lines of four backticks below. Copy it`,
    "character for character: keep every quote, backslash, and tag as written, and add nothing.",
    "",
    "````",
    NOTE_CONTENT,
    "````",
  ].join("\n"),
  writes: { [NOTE_PATH]: `${NOTE_CONTENT}\n` },
};

const DISPATCH_CODE = "LYN-7Q42-ORCA";
const DEPOT_SKILL = ".agents/skills/depot-codes";

/**
 * Follow a skill: a personal skill whose description matches the message, and whose body sends the model to a
 * reference file in the skill's folder, outside the workspace, for a value it cannot guess. Passes when an `ok`
 * `load_skill` step ran, an `ok` read step's text holds the value (only the reference file does, so that step read
 * it), the answer holds it, and no workspace file changed. The message names neither the tool nor the folder.
 */
export const SKILL_SCENARIO: Scenario = {
  name: "skill",
  files: READ_FILES,
  home: {
    [`${DEPOT_SKILL}/SKILL.md`]: [
      "---",
      "name: depot-codes",
      "description: Look up the dispatch code of a courier depot. Use when asked for a depot's dispatch code.",
      "---",
      "",
      "# Depot codes",
      "",
      "Every courier depot has a dispatch code. The codes are listed in reference/depots.md, in this skill's folder.",
      "",
      "1. Read reference/depots.md.",
      "2. Find the row of the depot asked for.",
      "3. Answer with its dispatch code, exactly as written in the table.",
      "",
    ].join("\n"),
    [`${DEPOT_SKILL}/reference/depots.md`]: [
      "# Depot dispatch codes",
      "",
      "| Depot | Dispatch code |",
      "| --- | --- |",
      "| Bordeaux | BDX-3K18-MIRA |",
      `| Lyon | ${DISPATCH_CODE} |`,
      "| Marseille | MRS-9T05-HALO |",
      "",
    ].join("\n"),
  },
  message: "What is the dispatch code of the Lyon depot? Reply with the exact code.",
  writes: {},
  check(entries) {
    const steps = entries.filter((entry) => entry.role === "tool");
    const loaded = steps.some((step) => step.name === "load_skill" && step.status === "ok");
    const read = steps.some(
      (step) => READ_TOOL_NAMES.has(step.name) && step.status === "ok" && step.text.includes(DISPATCH_CODE),
    );
    if (!loaded || !read) return { pass: false, category: "wrongTool", detail: `steps: ${describeSteps(steps)}` };
    return answerHolds(entries, DISPATCH_CODE);
  },
};

/** Log files per month under `logs/<year>/<month>/`, uneven so the total cannot be guessed from the folder count. */
const LOG_MONTHS: Record<string, readonly number[]> = {
  "2024": [3, 5, 2, 4, 6, 1, 3, 4, 2, 5, 3, 4],
  "2025": [4, 2, 5, 3, 1, 4],
};

/** One daily log per entry of `LOG_MONTHS`, days spread over the month. */
function logFiles(): WorkspaceFiles {
  const files: WorkspaceFiles = {};
  for (const [year, counts] of Object.entries(LOG_MONTHS)) {
    counts.forEach((count, index) => {
      const month = String(index + 1).padStart(2, "0");
      for (let file = 0; file < count; file += 1) {
        const day = String(1 + file * Math.floor(28 / count)).padStart(2, "0");
        files[`logs/${year}/${month}/${year}-${month}-${day}.log`] = `${year}-${month}-${day} courier: routes sent\n`;
      }
    });
  }
  return files;
}

const LOG_FILES = logFiles();
const LOG_FILE_COUNT = Object.keys(LOG_FILES).length;

/**
 * Count with a command: how many files a folder holds, subfolders included. The files sit in 18 month folders under
 * two year folders, more than the bench's step limit lets the model list one by one, and `list_files` counts one level
 * only, so a shell command is the way to the count. Passes when an `ok` `run_command` step ran, the answer holds the
 * count as a whole number, and no file changed; without such a step it is `wrongTool`, its detail led by the first line
 * of the last `run_command` step when one ran (a rejection, a timeout, an exit code). The message never names the tool.
 */
export const COMMAND_SCENARIO: Scenario = {
  name: "command",
  files: { ...READ_FILES, ...LOG_FILES },
  message: "How many files does the logs folder hold, counting the files in all its subfolders? Reply with the number.",
  writes: {},
  check(entries) {
    const steps = entries.filter((entry) => entry.role === "tool");
    const commands = steps.filter((step) => step.name === RUN_COMMAND_TOOL.name);
    if (!commands.some((step) => step.status === "ok")) {
      const last = commands.at(-1);
      const lead = last ? `${last.text.split("\n", 1)[0]}; ` : "";
      return { pass: false, category: "wrongTool", detail: `${lead}steps: ${describeSteps(steps)}` };
    }
    const answer = lastReply(entries).content;
    if (numberTokens(answer).includes(String(LOG_FILE_COUNT))) return { pass: true };
    return { pass: false, category: "wrongAnswer", detail: `answer: ${excerpt(answer)}` };
  },
};

/**
 * The numbers written in `text`, each whole as written: every longest run of digits, letters, `.`, `,`, `_`, signs,
 * and U+2212 that holds a digit, less its trailing `.` and `,` (sentence punctuation). A count passes only as a token
 * of its own, so `161`, `1,061`, `61,000`, `61.5`, `0,61`, `-61`, `\u221261`, `+61`, `61e3`, and `61k` never hold 61.
 */
function numberTokens(text: string): string[] {
  const runs = text.match(/[0-9A-Za-z.,_+\-\u2212]+/g) ?? [];
  return runs.filter((run) => /\d/.test(run)).map((run) => run.replace(/[.,]+$/, ""));
}

/** Every scenario the bench plays, in order. */
export const SCENARIOS: readonly Scenario[] = [
  READ_SCENARIO,
  EDIT_SCENARIO,
  CREATE_SCENARIO,
  SKILL_SCENARIO,
  COMMAND_SCENARIO,
];

/**
 * The verdict of one run of `scenario`: `entries` are the conversation after `send` resolved, `after` the workspace
 * files then. Throws on a turn that did not end, or ended stopped: the bench never stops a turn, so that is its bug.
 */
export function judge(scenario: Scenario, entries: readonly ChatEntry[], after: WorkspaceSnapshot): Verdict {
  const reply = lastReply(entries);
  switch (reply.status) {
    case "failed":
      return { pass: false, category: "providerError", detail: describeError(reply.error) };
    case "halted": {
      if (reply.haltReason === undefined) throw new Error("A halted reply has no halt reason.");
      const category = reply.haltReason === "malformedCalls" ? "malformed" : reply.haltReason;
      const steps = entries.filter((entry) => entry.role === "tool");
      return { pass: false, category, detail: `steps: ${describeSteps(steps)}` };
    }
    case "done":
      break;
    default:
      throw new Error(`The turn ended ${reply.status}, which the bench never causes.`);
  }
  const verdict = workspaceVerdict(scenario, after) ?? scenario.check?.(entries) ?? { pass: true };
  if (verdict.pass) return verdict;
  // [>]: A format failure explains the miss better than the check does, so it wins; the check's detail stays. A file
  // changed that the scenario never asked for stays its own failure, whatever caused it.
  const malformed = entries.find((entry) => entry.role === "tool" && entry.status === "malformed");
  if (malformed?.role === "tool" && verdict.category !== "workspaceChanged") {
    return { pass: false, category: "malformed", detail: `${excerpt(malformed.text)}; ${verdict.detail}` };
  }
  return verdict;
}

/** `after` against the workspace `scenario` expects: `wrongEdit`, `workspaceChanged`, or `undefined` when it matches. */
function workspaceVerdict(scenario: Scenario, after: WorkspaceSnapshot): Verdict | undefined {
  const expected = { ...scenario.files, ...scenario.writes };
  const differing = Object.keys(workspaceChanges(expected, after));
  const wrong = differing.filter((path) => Object.hasOwn(scenario.writes, path));
  const changed = differing.filter((path) => !Object.hasOwn(scenario.writes, path));
  const changedText = changed.length > 0 ? `changed: ${changed.join(", ")}` : undefined;
  if (wrong.length > 0) {
    const misses = wrong.map((path) => `${path} ${fileDifference(fileAt(expected, path) ?? "", fileAt(after, path))}`);
    return {
      pass: false,
      category: "wrongEdit",
      detail: [...misses, ...(changedText ? [changedText] : [])].join("; "),
    };
  }
  if (changedText) return { pass: false, category: "workspaceChanged", detail: changedText };
  return undefined;
}

/**
 * The entries of `after` that differ from `before`, sorted by path: an added or changed one with what it holds now, a
 * removed one with `null`. Empty when they match. The dump records it, so a write's result reads without replaying the
 * run.
 */
export function workspaceChanges(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): Record<string, WorkspaceEntry | null> {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes: Record<string, WorkspaceEntry | null> = Object.create(null);
  for (const path of paths) {
    const now = fileAt(after, path);
    if (!sameEntry(fileAt(before, path), now)) changes[path] = now ?? null;
  }
  return changes;
}

function sameEntry(a: WorkspaceEntry | undefined, b: WorkspaceEntry | undefined): boolean {
  if (typeof a !== "object" || typeof b !== "object") return a === b;
  if ("symlink" in a) return "symlink" in b && a.symlink === b.symlink;
  return "special" in b && a.special === b.special;
}

/** Where `actual` first departs from `expected`, as one line: missing, not a file, or the first differing line of each. */
function fileDifference(expected: string, actual: WorkspaceEntry | undefined): string {
  if (actual === undefined) return "missing";
  if (typeof actual !== "string") {
    return "symlink" in actual ? `is a symlink to ${JSON.stringify(actual.symlink)}` : `is a ${actual.special}`;
  }
  const want = expected.split("\n");
  const got = actual.split("\n");
  const index = want.findIndex((line, at) => line !== got[at]);
  const at = index === -1 ? want.length : index;
  // [>]: Not `excerpt`: it trims, and indentation is often the very difference.
  const show = (line: string | undefined) => {
    if (line === undefined) return "end of file";
    return JSON.stringify(line.length > 60 ? `${line.slice(0, 60)}…` : line);
  };
  return `line ${at + 1}: expected ${show(want[at])}, got ${show(got[at])}`;
}

/** A pass when the turn's last answer holds `value`, otherwise `wrongAnswer` with an excerpt of it. */
function answerHolds(entries: readonly ChatEntry[], value: string): Verdict {
  const answer = lastReply(entries).content;
  if (answer.includes(value)) return { pass: true };
  return { pass: false, category: "wrongAnswer", detail: `answer: ${excerpt(answer)}` };
}

function lastReply(entries: readonly ChatEntry[]): ChatEntry & { role: "assistant" } {
  const reply = entries.findLast((entry) => entry.role === "assistant");
  if (!reply) throw new Error("The conversation holds no reply.");
  return reply;
}

function describeSteps(steps: readonly (ChatEntry & { role: "tool" })[]): string {
  if (steps.length === 0) return "none";
  return steps
    .map((step) => {
      const args = Object.entries(step.args).map(([name, value]) => `${name}=${excerpt(value, 40)}`);
      return `${step.name}(${args.join(", ")}) ${step.status}`;
    })
    .join(", ");
}

export function describeError(error: ProviderError | undefined): string {
  if (!error) return "failed without an error";
  const { kind, ...fields } = error;
  return `${kind} ${JSON.stringify(fields)}`;
}

/** `text` on one line, cut after `max` characters. */
function excerpt(text: string, max = 160): string {
  const line = text.trim().replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
