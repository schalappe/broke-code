/**
 * @module scenarios
 * The eval scenarios and the verdict of one run. A scenario is a fixture workspace, the message sent, and a check of
 * a turn that ended `done`; `judge` adds what every scenario shares: halts, failed replies, and format failures. The
 * verdict reads the entries and the workspace files after the run, never the wording of the answer beyond the value
 * a scenario asks for.
 */
import type { ChatEntry } from "../src/core/protocol";
import type { ProviderError } from "../src/core/providerError";

/** Workspace files by relative POSIX path: a scenario's fixture, or the throwaway copy read back after a run. */
export type WorkspaceFiles = Record<string, string>;

/**
 * Why a run failed, one per failed run. `malformed`: a malformed call halted the turn, or the turn had one and missed
 * the check. `wrongTool`: no tool step got what the scenario needed. `wrongAnswer`: the turn ended `done` without the
 * value. `stepLimit`, `contextFull`: the turn halted on that limit. `providerError`: a reply failed. `workspaceChanged`:
 * the workspace after the run is not what the scenario expects.
 */
export type FailureCategory =
  | "malformed"
  | "wrongTool"
  | "wrongAnswer"
  | "stepLimit"
  | "contextFull"
  | "providerError"
  | "workspaceChanged";

/** `detail`: one line for the report, enough to tell what the model did. */
export type Verdict = { pass: true } | { pass: false; category: FailureCategory; detail: string };

/**
 * `files`: the fixture workspace, copied fresh for each run. `message`: what the user sends. `check`: the verdict of a
 * turn that ended `done`, from its entries and the workspace files after the run.
 */
export type Scenario = {
  name: string;
  files: WorkspaceFiles;
  message: string;
  check(entries: readonly ChatEntry[], after: WorkspaceFiles): Verdict;
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
  check(entries, after) {
    const changed = workspaceChanges(READ_FILES, after);
    if (changed) return { pass: false, category: "workspaceChanged", detail: changed };
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

/** Every scenario the bench plays, in order. */
export const SCENARIOS: readonly Scenario[] = [READ_SCENARIO];

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
      const category: FailureCategory =
        reply.haltReason === "malformedCalls" ? "malformed" : (reply.haltReason ?? "stepLimit");
      const steps = entries.filter((entry) => entry.role === "tool");
      return { pass: false, category, detail: `steps: ${describeSteps(steps)}` };
    }
    case "done":
      break;
    default:
      throw new Error(`The turn ended ${reply.status}, which the bench never causes.`);
  }
  const verdict = scenario.check(entries, after);
  if (verdict.pass) return verdict;
  // [>]: A format failure explains the miss better than the check does, so it wins; the check's detail stays.
  const malformed = entries.find((entry) => entry.role === "tool" && entry.status === "malformed");
  if (malformed?.role === "tool" && verdict.category !== "workspaceChanged") {
    return { pass: false, category: "malformed", detail: `${excerpt(malformed.text)}; ${verdict.detail}` };
  }
  return verdict;
}

/** The paths that differ between `fixture` and `after`, added and removed ones included; `undefined` when none. */
function workspaceChanges(fixture: WorkspaceFiles, after: WorkspaceFiles): string | undefined {
  const paths = [...new Set([...Object.keys(fixture), ...Object.keys(after)])].sort();
  const changed = paths.filter((path) => fixture[path] !== after[path]);
  return changed.length > 0 ? `changed: ${changed.join(", ")}` : undefined;
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
