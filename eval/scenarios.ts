/**
 * @module scenarios
 * The eval scenarios and the verdict of one run. A scenario is a fixture workspace, the message sent, the files the
 * turn must write, and an optional check of a turn that ended `done`; `judge` adds what every scenario shares: halts,
 * failed replies, format failures, and the workspace after the run against the one expected. The verdict reads the
 * entries and the workspace files after the run, never the wording of the answer beyond the value a scenario asks for.
 */
import type { ChatEntry } from "../src/core/protocol";
import type { ProviderError } from "../src/core/providerError";

/** Workspace files by relative POSIX path: a scenario's fixture, or the throwaway copy read back after a run. */
export type WorkspaceFiles = Record<string, string>;

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
 * `files`: the fixture workspace, copied fresh for each run. `message`: what the user sends. `writes`: the files the
 * turn must leave, each with its exact text, byte for byte; every other fixture file must stay as it is and no other
 * file may appear. Empty for a scenario that changes nothing. `check`: what else a turn that ended `done` with the
 * expected workspace must show, from its entries; absent when the workspace says it all.
 */
export type Scenario = {
  name: string;
  files: WorkspaceFiles;
  message: string;
  writes: WorkspaceFiles;
  check?(entries: readonly ChatEntry[]): Verdict;
};

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
    const answer = lastReply(entries).content;
    if (!answer.includes(ROUTE_SEED)) {
      return { pass: false, category: "wrongAnswer", detail: `answer: ${excerpt(answer)}` };
    }
    return { pass: true };
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

/** Every scenario the bench plays, in order. */
export const SCENARIOS: readonly Scenario[] = [READ_SCENARIO, EDIT_SCENARIO, CREATE_SCENARIO];

/**
 * The verdict of one run of `scenario`: `entries` are the conversation after `send` resolved, `after` the workspace
 * files then. Throws on a turn that did not end, or ended stopped: the bench never stops a turn, so that is its bug.
 */
export function judge(scenario: Scenario, entries: readonly ChatEntry[], after: WorkspaceFiles): Verdict {
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
function workspaceVerdict(scenario: Scenario, after: WorkspaceFiles): Verdict | undefined {
  const expected = { ...scenario.files, ...scenario.writes };
  const differing = Object.keys(workspaceChanges(expected, after));
  const wrong = differing.filter((path) => path in scenario.writes);
  const changed = differing.filter((path) => !(path in scenario.writes));
  const changedText = changed.length > 0 ? `changed: ${changed.join(", ")}` : undefined;
  if (wrong.length > 0) {
    const misses = wrong.map((path) => `${path} ${fileDifference(expected[path] ?? "", after[path])}`);
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
 * The files of `after` that differ from `before`, sorted by path: an added or changed file with its text, a removed
 * one with `null`. Empty when they match. The dump records it, so a write's result reads without replaying the run.
 */
export function workspaceChanges(before: WorkspaceFiles, after: WorkspaceFiles): Record<string, string | null> {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes: Record<string, string | null> = {};
  for (const path of paths) {
    if (before[path] !== after[path]) changes[path] = after[path] ?? null;
  }
  return changes;
}

/** Where `actual` first departs from `expected`, as one line: missing, or the first differing line of each. */
function fileDifference(expected: string, actual: string | undefined): string {
  if (actual === undefined) return "missing";
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
