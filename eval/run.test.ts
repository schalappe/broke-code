import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSystemPrompt } from "../src/core/systemPrompt";
import { READ_TOOLS } from "../src/core/tools";
import { WRITE_TOOLS } from "../src/core/writeTools";
import { playScenario } from "./run";
import { judge, READ_SCENARIO, type Scenario } from "./scenarios";

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
      content: composeSystemPrompt([...READ_TOOLS, ...WRITE_TOOLS], []),
    });
  });

  test("applies a write_file call to the copy of the fixture at once", async () => {
    const content = 'name = "</content>"\n</write_file>';
    replies = [`<write_file>\n<path>notes/new.toml</path>\n<content>\n${content}\n</content>\n</write_file>`, "Done."];
    const { entries, after } = await playScenario(READ_SCENARIO, { baseUrl, model: "m", maxToolSteps: 6 }, parent);

    expect(entries[2]).toMatchObject({ role: "tool", name: "write_file", status: "ok" });
    expect(after["notes/new.toml"]).toBe(`${content}\n`);
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
