import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_COMMAND_TOOL } from "../src/core/commands";
import { composeSystemPrompt } from "../src/core/systemPrompt";
import { READ_TOOLS } from "../src/core/tools";
import { WRITE_TOOLS } from "../src/core/writeTools";
import { BENCH_SANDBOX_PROFILE, benchCommandEnv, playScenario } from "./run";
import {
  COMMAND_SCENARIO,
  CREATE_SCENARIO,
  EDIT_SCENARIO,
  judge,
  RANGE_SCENARIO,
  READ_SCENARIO,
  type Scenario,
  SKILL_SCENARIO,
  type WorkspaceSnapshot,
} from "./scenarios";

const event = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const READ_CALL = "<read_file>\n<path>config/settings.toml</path>\n</read_file>";

type ChatRequest = { model: string; messages: { role: string; content: string }[] };
/**
 * Chat request bodies, in order. Each request gets the next of `replies`: a text, or a function of the request when
 * the reply depends on what the run sent, such as a path under the run's temporary folder.
 */
const requests: ChatRequest[] = [];
/** The `Authorization` header of each request, models listings included, in order. */
const authorizations: (string | null)[] = [];
let replies: (string | ((request: ChatRequest) => string))[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    authorizations.push(request.headers.get("authorization"));
    if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "m" }, { id: "n" }] });
    const body: ChatRequest = await request.json();
    requests.push(body);
    const next = replies.shift() ?? "script exhausted";
    const content = typeof next === "string" ? next : next(body);
    return new Response(`${event(content)}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});
const baseUrl = `http://localhost:${server.port}/v1`;
const parent = mkdtempSync(join(tmpdir(), "broke-code-eval-test-"));

/**
 * Runs `command` as the first call of a `command` scenario run, its answer "61", and returns the step's text; `inspect`
 * reads the workspace after the run.
 */
async function commandStep(command: string, inspect?: (after: WorkspaceSnapshot) => void): Promise<string> {
  replies = [`<run_command>\n<command>${command}</command>\n</run_command>`, "61"];
  const { entries, after } = await playScenario(
    COMMAND_SCENARIO,
    { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 6 },
    parent,
  );
  inspect?.(after);
  const step = entries[2];
  expect(step).toMatchObject({ role: "tool", name: "run_command" });
  return step?.role === "tool" ? step.text : "";
}

/** The stdout lines of a command step's text. */
function stdoutLines(text: string): string[] {
  const stdout = /\nstdout:\n([\s\S]*)\nstderr:/.exec(text)?.[1];
  return stdout === undefined ? [] : stdout.split("\n");
}

/**
 * Runs `body` with `values` set in the bench's environment and every other `LANG` and `LC_*` variable unset, then
 * puts the environment back.
 */
async function withBenchEnv(values: Record<string, string>, body: () => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) if (name === "LANG" || name.startsWith("LC_")) delete process.env[name];
  Object.assign(process.env, values);
  try {
    await body();
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}
afterAll(() => {
  server.stop(true);
  rmSync(parent, { recursive: true, force: true });
});

describe("playScenario", () => {
  test("runs the turn on the chosen model with the read tools over a copy of the fixture, then removes the copy", async () => {
    requests.length = 0;
    replies = [READ_CALL, "The value is kestrel-4471-vanta."];
    const { entries, after } = await playScenario(
      READ_SCENARIO,
      { baseUrl, apiKey: undefined, model: "n", maxToolSteps: 6 },
      parent,
    );

    expect(judge(READ_SCENARIO, entries, after)).toEqual({ pass: true });
    expect(requests.map((request) => request.model)).toEqual(["n", "n"]);
    expect(entries[2]).toMatchObject({ role: "tool", name: "read_file", status: "ok" });
    expect(readdirSync(parent)).toEqual([]);
  });

  test("sends the target's key to the server on every request, and none without one", async () => {
    authorizations.length = 0;
    replies = ["No idea."];
    await playScenario(READ_SCENARIO, { baseUrl, apiKey: "bench-key", model: "m", maxToolSteps: 6 }, parent);
    expect(authorizations.length).toBeGreaterThan(1);
    expect(new Set(authorizations)).toEqual(new Set(["Bearer bench-key"]));

    authorizations.length = 0;
    replies = ["No idea."];
    await playScenario(READ_SCENARIO, { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 6 }, parent);
    expect(new Set(authorizations)).toEqual(new Set([null]));
  });

  test("sends the system prompt of the read and write tools and run_command without any instruction file", async () => {
    requests.length = 0;
    replies = ["No idea."];
    await playScenario(READ_SCENARIO, { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 6 }, parent);

    expect(requests[0]?.messages[0]).toEqual({
      role: "system",
      content: composeSystemPrompt([...READ_TOOLS, ...WRITE_TOOLS, RUN_COMMAND_TOOL], [], []),
    });
  });

  test("rejects every command of the range scenario as the user's Reject does, and approves one elsewhere", async () => {
    const tail = "<run_command>\n<command>tail -n 1 dispatch.log</command>\n</run_command>";
    const target = { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 6 };
    replies = [tail, "I could not read it."];
    const rejected = (await playScenario(RANGE_SCENARIO, target, parent)).entries[2];
    replies = ["<run_command>\n<command>tail -n 1 README.md</command>\n</run_command>", "61"];
    const approved = (await playScenario(COMMAND_SCENARIO, target, parent)).entries[2];

    expect(rejected).toEqual({
      role: "tool",
      name: "run_command",
      args: { command: "tail -n 1 dispatch.log" },
      status: "error",
      text: "The user rejected this command.",
    });
    expect(approved).toMatchObject({ role: "tool", name: "run_command", status: "ok" });
    expect(approved?.role === "tool" ? approved.text : "").toContain("config/settings.toml");
  });

  test("runs a run_command call at once with /bin/sh in the copy of the fixture, its command and output in the step", async () => {
    const command = 'find logs -type f | wc -l | tr -d " "; echo "$0"; pwd -P';
    replies = [`<run_command>\n<command>${command}</command>\n</run_command>`, "The logs folder holds 61 files."];
    const { entries, after } = await playScenario(
      COMMAND_SCENARIO,
      { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 6 },
      parent,
    );

    const ran = entries[2];
    expect(ran).toMatchObject({ role: "tool", name: "run_command", args: { command }, status: "ok" });
    const text = ran?.role === "tool" ? ran.text : "";
    expect(text).toStartWith("exit code 0\nstdout:\n61\n/bin/sh\n");
    expect(text).toContain(`${realpathSync(parent)}/`);
    expect(text).toEndWith("/workspace\nstderr: (empty)");
    expect(judge(COMMAND_SCENARIO, entries, after)).toEqual({ pass: true });
    expect(readdirSync(parent)).toEqual([]);
  });

  test("reads back each entry a command added that is not a folder, so the judge sees an added symlink or FIFO", async () => {
    const command =
      "find logs -type f | wc -l; ln -s config/settings.toml alias; ln -s logs logs-link; mkfifo pipe; mkdir empty";
    replies = [`<run_command>\n<command>${command}</command>\n</run_command>`, "61"];
    const { entries, after } = await playScenario(
      COMMAND_SCENARIO,
      { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 6 },
      parent,
    );

    expect(entries[2]).toMatchObject({ role: "tool", name: "run_command", status: "ok" });
    expect(after.alias).toEqual({ symlink: "config/settings.toml" });
    expect(after["logs-link"]).toEqual({ symlink: "logs" });
    expect(after.pipe).toEqual({ special: "fifo" });
    expect(Object.keys(after).filter((path) => path.startsWith("logs-link/") || path.startsWith("empty"))).toEqual([]);
    expect(judge(COMMAND_SCENARIO, entries, after)).toEqual({
      pass: false,
      category: "workspaceChanged",
      detail: "changed: alias, logs-link, pipe",
    });
  });

  test("runs a command with only PATH, the locale, its own HOME and TMPDIR, and what /bin/sh sets", () =>
    withBenchEnv(
      { LANG: "fr_FR.UTF-8", LC_ALL: "fr_FR.UTF-8", BENCH_API_KEY: "bench-secret", UNRELATED: "x" },
      async () => {
        const text = await commandStep("env | cut -d= -f1");
        expect(stdoutLines(text).sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH", "PWD", "SHLVL", "TMPDIR", "_"]);
      },
    ));

  test("gives a command the run's home copy as HOME and a folder of the run beside the workspace as TMPDIR, removed with it", async () => {
    const command = [
      'echo "$HOME"; echo "$TMPDIR"',
      'echo scratch > "$TMPDIR/scratch.txt"',
      "cat <<EOF\nhere-document\nEOF",
      "find logs -type f | wc -l",
    ].join("\n");
    replies = [`<run_command>\n<command>${command}</command>\n</run_command>`, "61"];
    const { entries, after } = await playScenario(
      COMMAND_SCENARIO,
      { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 6 },
      parent,
    );

    const ran = entries[2];
    expect(ran).toMatchObject({ role: "tool", name: "run_command", status: "ok" });
    const [home, temporary, here] = stdoutLines(ran?.role === "tool" ? ran.text : "");
    const runFolder = `${realpathSync(parent)}/broke-code-eval-`;
    expect(home).toStartWith(runFolder);
    expect(home).toEndWith("/home");
    expect(temporary).toBe(`${home?.slice(0, -"/home".length)}/tmp`);
    expect(here).toBe("here-document");
    expect(judge(COMMAND_SCENARIO, entries, after)).toEqual({ pass: true });
    expect(readdirSync(parent)).toEqual([]);
  });

  test("keeps the bench's environment from a command reading its parent's with ps", () =>
    withBenchEnv({ BENCH_API_KEY: "bench-secret-ps", UNRELATED: "unrelated-ps" }, async () => {
      const text = await commandStep("ps eww -p $PPID; ps eww -p $$");
      expect(text).not.toContain("bench-secret-ps");
      expect(text).not.toContain("unrelated-ps");
      expect(text).toContain("Operation not permitted");
    }));

  test("refuses a command reading the user's home folder or the per-user temporary folders", async () => {
    const userHome = realpathSync(homedir());
    const text = await commandStep(
      `ls "${userHome}" 2>&1; echo "home $?"; ls /private/var/folders 2>&1; echo "folders $?"`,
    );
    const lines = stdoutLines(text);
    expect(lines.filter((line) => line.includes("Operation not permitted"))).toHaveLength(2);
    expect(lines.filter((line) => /^(home|folders) [1-9]/.test(line))).toHaveLength(2);
  });

  test("refuses a command writing outside the run's folder, and still lets it add any entry to the workspace", async () => {
    const outside = join(realpathSync(parent), "outside.txt");
    const command = `echo x > "${outside}"; echo "outside $?"; echo made > made.txt; ln -s made.txt alias; mkfifo pipe; mkdir folder`;
    const text = await commandStep(command, (after) => {
      expect(after["made.txt"]).toBe("made\n");
      expect(after.alias).toEqual({ symlink: "made.txt" });
      expect(after.pipe).toEqual({ special: "fifo" });
    });
    expect(stdoutLines(text)).toEqual(["outside 1"]);
    expect(existsSync(outside)).toBe(false);
  });

  test("refuses a command any network access", async () => {
    let hits = 0;
    const local = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1;
        return new Response("reached");
      },
    });
    try {
      const text = await commandStep(`curl -s -m 5 http://localhost:${local.port}/; echo "curl $?"`);
      expect(text).not.toContain("reached");
      expect(stdoutLines(text).at(-1)).toMatch(/^curl [1-9]/);
      expect(hits).toBe(0);
    } finally {
      local.stop(true);
    }
  });

  test("stops a command past the bench's 10 seconds with its whole process group", async () => {
    const text = await commandStep("echo $$; sleep 30 & sleep 30");
    expect(text).toStartWith("stopped after 10 seconds\nstdout:\n");
    const pgid = Number(stdoutLines(text)[0]);
    expect(pgid).toBeGreaterThan(1);
    expect(() => process.kill(-pgid, 0)).toThrow();
  }, 20_000);

  test("discovers the skills of a copy of the scenario's home fixture, never the real home, and removes the copy", async () => {
    requests.length = 0;
    const lastText = (request: ChatRequest) => request.messages.at(-1)?.content ?? "";
    replies = [
      "<load_skill>\n<name>depot-codes</name>\n</load_skill>",
      (request) => {
        const root = /its files live in (\S+);/.exec(lastText(request))?.[1] ?? "no root";
        return `<read_file>\n<path>${root}/reference/depots.md</path>\n</read_file>`;
      },
      "The Lyon dispatch code is LYN-7Q42-ORCA.",
    ];
    const { entries, after } = await playScenario(
      SKILL_SCENARIO,
      { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 6 },
      parent,
    );

    expect(requests[0]?.messages[0]?.content).toContain("\n- depot-codes: Look up the dispatch code");
    const loaded = entries[2];
    expect(loaded).toMatchObject({ role: "tool", name: "load_skill", status: "ok" });
    const text = loaded?.role === "tool" ? loaded.text : "";
    expect(text).toContain(`${realpathSync(parent)}/`);
    expect(text).not.toContain(homedir());
    expect(judge(SKILL_SCENARIO, entries, after)).toEqual({ pass: true });
    expect(readdirSync(parent)).toEqual([]);
  });

  test("applies a write_file call to the copy of the fixture at once", async () => {
    const content = 'name = "</content>"\n</write_file>';
    replies = [`<write_file>\n<path>notes/new.toml</path>\n<content>\n${content}\n</content>\n</write_file>`, "Done."];
    const { entries, after } = await playScenario(
      READ_SCENARIO,
      { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 6 },
      parent,
    );

    expect(entries[2]).toMatchObject({ role: "tool", name: "write_file", status: "ok" });
    expect(after["notes/new.toml"]).toBe(`${content}\n`);
  });

  test("returns each change handed to the applier, in call order, with the applier's status", async () => {
    replies = [
      "<write_file>\n<path>notes/a.txt</path>\n<content>\none\n</content>\n</write_file>",
      "<edit_file>\n<path>notes/a.txt</path>\n<old>one</old>\n<new>two</new>\n</edit_file>",
      "<write_file>\n<path>notes/a.txt</path>\n<content>\none\n</content>\n</write_file>",
      "Done.",
    ];
    const { planned, after } = await playScenario(
      READ_SCENARIO,
      { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 6 },
      parent,
    );

    expect(planned).toEqual([
      { tool: "write_file", path: "notes/a.txt", before: null, after: "one\n", status: "ok" },
      { tool: "edit_file", path: "notes/a.txt", before: "one\n", after: "two\n", status: "ok" },
      { tool: "write_file", path: "notes/a.txt", before: "two\n", after: "one\n", status: "ok" },
    ]);
    expect(after["notes/a.txt"]).toBe("one\n");
  });

  test("records no change for a call refused before planning", async () => {
    replies = ["<edit_file>\n<path>README.md</path>\n<old>absent text</old>\n<new>x</new>\n</edit_file>", "Done."];
    const { entries, planned } = await playScenario(
      READ_SCENARIO,
      { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 6 },
      parent,
    );

    expect(entries[2]).toMatchObject({ role: "tool", name: "edit_file", status: "error" });
    expect(planned).toEqual([]);
  });

  test("reads back a file named __proto__ the turn wrote, so the judge sees the unrequested file", async () => {
    replies = ["<write_file>\n<path>__proto__</path>\n<content>\nx\n</content>\n</write_file>", "Done."];
    const { entries, after } = await playScenario(
      EDIT_SCENARIO,
      { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 6 },
      parent,
    );

    expect(Object.hasOwn(after, "__proto__")).toBe(true);
    expect(judge({ ...EDIT_SCENARIO, writes: {} }, entries, after)).toEqual({
      pass: false,
      category: "workspaceChanged",
      detail: "changed: __proto__",
    });
  });

  test("passes the edit scenario on an edit_file call that renames the function", async () => {
    const old = "def compute_surcharge_v2(distance_km):";
    const edit = `<edit_file>\n<path>src/pricing.py</path>\n<old>${old}</old>\n<new>def distance_surcharge(distance_km):</new>\n</edit_file>`;
    replies = [edit, "Renamed."];
    const { entries, after } = await playScenario(
      EDIT_SCENARIO,
      { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 6 },
      parent,
    );

    expect(entries[2]).toMatchObject({ role: "tool", name: "edit_file", status: "ok" });
    expect(judge(EDIT_SCENARIO, entries, after)).toEqual({ pass: true });
  });

  test("passes the create scenario on a write_file call that holds the content raw, tags and fences included", async () => {
    const [path, text] = Object.entries(CREATE_SCENARIO.writes)[0] ?? ["", ""];
    replies = [`<write_file>\n<path>${path}</path>\n<content>\n${text}</content>\n</write_file>`, "Created."];
    const { entries, after } = await playScenario(
      CREATE_SCENARIO,
      { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 6 },
      parent,
    );

    expect(entries[2]).toMatchObject({ role: "tool", name: "write_file", status: "ok" });
    expect(judge(CREATE_SCENARIO, entries, after)).toEqual({ pass: true });
  });

  test("passes the create scenario when the content opens on the tag's line and ends with an empty line", async () => {
    const [path, text] = Object.entries(CREATE_SCENARIO.writes)[0] ?? ["", ""];
    replies = [`<write_file>\n<path>${path}</path>\n<content>${text}\n</content>\n</write_file>`, "Created."];
    const { entries, after } = await playScenario(
      CREATE_SCENARIO,
      { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 6 },
      parent,
    );

    expect(judge(CREATE_SCENARIO, entries, after)).toEqual({ pass: true });
  });

  test("halts at the step limit it is given", async () => {
    replies = [READ_CALL, READ_CALL, READ_CALL];
    const { entries, after } = await playScenario(
      READ_SCENARIO,
      { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 2 },
      parent,
    );

    expect(judge(READ_SCENARIO, entries, after)).toMatchObject({ category: "stepLimit" });
  });

  test("removes the copy when the run throws", async () => {
    const broken: Scenario = { ...READ_SCENARIO, files: { a: "file", "a/b": "a file under a file" } };
    await expect(
      playScenario(broken, { baseUrl, apiKey: undefined, model: "m", maxToolSteps: 6 }, parent),
    ).rejects.toThrow();
    expect(readdirSync(parent)).toEqual([]);
  });

  test("throws when the provider does not list the model", async () => {
    await expect(
      playScenario(READ_SCENARIO, { baseUrl, apiKey: undefined, model: "absent", maxToolSteps: 6 }, parent),
    ).rejects.toThrow("absent");
  });
});

describe("benchCommandEnv", () => {
  const paths = { runFolder: "/r/run", home: "/r/run/home", tmp: "/r/run/tmp", userHome: "/Users/someone" };

  test("keeps PATH and the locale of the bench's environment, nothing else, and sets HOME and TMPDIR to the run's", () => {
    const bench = {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_CTYPE: "UTF-8",
      BENCH_API_KEY: "k",
      HOME: "/Users/x",
      TERM: "t",
    };
    expect(benchCommandEnv(paths, bench).environment).toEqual({
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_CTYPE: "UTF-8",
      HOME: "/r/run/home",
      TMPDIR: "/r/run/tmp",
    });
    expect(benchCommandEnv(paths, {}).environment).toEqual({ HOME: "/r/run/home", TMPDIR: "/r/run/tmp" });
  });

  test("runs /bin/sh under sandbox-exec, the paths given as parameters, never in the profile's text", () => {
    const env = benchCommandEnv(paths, {});
    expect(env.shell).toBe("/bin/sh");
    expect(env.timeoutMs).toBe(10_000);
    expect(env.launcher).toEqual([
      "/usr/bin/sandbox-exec",
      "-p",
      BENCH_SANDBOX_PROFILE,
      "-D",
      "HOME_DIR=/Users/someone",
      "-D",
      "RUN_DIR=/r/run",
    ]);
    expect(BENCH_SANDBOX_PROFILE).not.toContain("/r/run");
    expect(BENCH_SANDBOX_PROFILE).not.toContain("/Users");
  });
});
