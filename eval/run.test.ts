import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSystemPrompt } from "../src/core/systemPrompt";
import { READ_TOOLS } from "../src/core/tools";
import { WRITE_TOOLS } from "../src/core/writeTools";
import { playScenario } from "./run";
import { CREATE_SCENARIO, EDIT_SCENARIO, judge, READ_SCENARIO, type Scenario } from "./scenarios";

const event = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const READ_CALL = "<read_file>\n<path>config/settings.toml</path>\n</read_file>";

/** Chat request bodies, in order. Each request gets the next of `replies`. */
const requests: { model: string; messages: { role: string; content: string }[] }[] = [];
let replies: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "m" }, { id: "n" }] });
    requests.push(await request.json());
    const content = replies.shift() ?? "script exhausted";
    return new Response(`${event(content)}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});
const baseUrl = `http://localhost:${server.port}/v1`;
const parent = mkdtempSync(join(tmpdir(), "broke-code-eval-test-"));
afterAll(() => {
  server.stop(true);
  rmSync(parent, { recursive: true, force: true });
});

describe("playScenario", () => {
  test("runs the turn on the chosen model with the read tools over a copy of the fixture, then removes the copy", async () => {
    requests.length = 0;
    replies = [READ_CALL, "The value is kestrel-4471-vanta."];
    const { entries, after } = await playScenario(READ_SCENARIO, { baseUrl, model: "n", maxToolSteps: 6 }, parent);

    expect(judge(READ_SCENARIO, entries, after)).toEqual({ pass: true });
    expect(requests.map((request) => request.model)).toEqual(["n", "n"]);
    expect(entries[2]).toMatchObject({ role: "tool", name: "read_file", status: "ok" });
    expect(readdirSync(parent)).toEqual([]);
  });

  test("sends the system prompt of the read and write tools without any instruction file", async () => {
    requests.length = 0;
    replies = ["No idea."];
    await playScenario(READ_SCENARIO, { baseUrl, model: "m", maxToolSteps: 6 }, parent);

    expect(requests[0]?.messages[0]).toEqual({
      role: "system",
      content: composeSystemPrompt([...READ_TOOLS, ...WRITE_TOOLS], [], []),
    });
  });

  test("applies a write_file call to the copy of the fixture at once", async () => {
    const content = 'name = "</content>"\n</write_file>';
    replies = [`<write_file>\n<path>notes/new.toml</path>\n<content>\n${content}\n</content>\n</write_file>`, "Done."];
    const { entries, after } = await playScenario(READ_SCENARIO, { baseUrl, model: "m", maxToolSteps: 6 }, parent);

    expect(entries[2]).toMatchObject({ role: "tool", name: "write_file", status: "ok" });
    expect(after["notes/new.toml"]).toBe(`${content}\n`);
  });

  test("reads back a file named __proto__ the turn wrote, so the judge sees the unrequested file", async () => {
    replies = ["<write_file>\n<path>__proto__</path>\n<content>\nx\n</content>\n</write_file>", "Done."];
    const { entries, after } = await playScenario(EDIT_SCENARIO, { baseUrl, model: "m", maxToolSteps: 6 }, parent);

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
    const { entries, after } = await playScenario(EDIT_SCENARIO, { baseUrl, model: "m", maxToolSteps: 6 }, parent);

    expect(entries[2]).toMatchObject({ role: "tool", name: "edit_file", status: "ok" });
    expect(judge(EDIT_SCENARIO, entries, after)).toEqual({ pass: true });
  });

  test("passes the create scenario on a write_file call that holds the content raw, tags and fences included", async () => {
    const [path, text] = Object.entries(CREATE_SCENARIO.writes)[0] ?? ["", ""];
    replies = [`<write_file>\n<path>${path}</path>\n<content>\n${text}</content>\n</write_file>`, "Created."];
    const { entries, after } = await playScenario(CREATE_SCENARIO, { baseUrl, model: "m", maxToolSteps: 6 }, parent);

    expect(entries[2]).toMatchObject({ role: "tool", name: "write_file", status: "ok" });
    expect(judge(CREATE_SCENARIO, entries, after)).toEqual({ pass: true });
  });

  test("passes the create scenario when the content opens on the tag's line and ends with an empty line", async () => {
    const [path, text] = Object.entries(CREATE_SCENARIO.writes)[0] ?? ["", ""];
    replies = [`<write_file>\n<path>${path}</path>\n<content>${text}\n</content>\n</write_file>`, "Created."];
    const { entries, after } = await playScenario(CREATE_SCENARIO, { baseUrl, model: "m", maxToolSteps: 6 }, parent);

    expect(judge(CREATE_SCENARIO, entries, after)).toEqual({ pass: true });
  });

  test("halts at the step limit it is given", async () => {
    replies = [READ_CALL, READ_CALL, READ_CALL];
    const { entries, after } = await playScenario(READ_SCENARIO, { baseUrl, model: "m", maxToolSteps: 2 }, parent);

    expect(judge(READ_SCENARIO, entries, after)).toMatchObject({ category: "stepLimit" });
  });

  test("removes the copy when the run throws", async () => {
    const broken: Scenario = { ...READ_SCENARIO, files: { a: "file", "a/b": "a file under a file" } };
    await expect(playScenario(broken, { baseUrl, model: "m", maxToolSteps: 6 }, parent)).rejects.toThrow();
    expect(readdirSync(parent)).toEqual([]);
  });

  test("throws when the provider does not list the model", async () => {
    await expect(playScenario(READ_SCENARIO, { baseUrl, model: "absent", maxToolSteps: 6 }, parent)).rejects.toThrow(
      "absent",
    );
  });
});
