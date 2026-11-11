import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mentionReader } from "./mentionReader";
import { findMentions, type ReadMention } from "./mentions";
import type { Diagnostic } from "./problems";
import type { WorkspaceRoot } from "./workspaceFiles";

describe("mentionReader", () => {
  let root: WorkspaceRoot;
  let reads = 0;
  beforeAll(async () => {
    root = { name: "w", path: await mkdtemp(join(tmpdir(), "broke-code-reserved-")) };
    await writeFile(join(root.path, "problems"), "a file named problems\n");
  });
  afterAll(() => rm(root.path, { recursive: true, force: true }));

  const diagnostic: Diagnostic = {
    scheme: "file",
    path: "",
    line: 0,
    character: 0,
    severity: "error",
    message: "Broken.",
  };

  /** Each mention of `text`, read as the controller reads them: found first, then one read per path. */
  async function readAll(text: string): Promise<ReadMention[]> {
    const reader = mentionReader({
      roots: () => [root],
      diagnostics: {
        read: async () => {
          reads += 1;
          return [{ ...diagnostic, path: join(root.path, "src.ts") }];
        },
      },
    });
    return Promise.all(findMentions(text).map((path) => reader.read(path)));
  }

  test("reads @problems and @problems. as the reserved mention, not the workspace file of that name", async () => {
    for (const text of ["fix @problems", "fix @problems."]) {
      const [mention] = await readAll(text);
      expect(mention).toMatchObject({ path: "problems", kind: "problems", status: "attached", lines: 1 });
      expect(mention!.content).toBe("src.ts:1:1 error Broken.");
    }
  });

  test("reads @./problems as the workspace file of that name", async () => {
    expect(await readAll("see @./problems")).toEqual([
      {
        path: "./problems",
        kind: "file",
        status: "attached",
        lines: 1,
        content: "a file named problems\n",
        omitted: 0,
      },
    ]);
  });

  test("reads a token that is not exactly the lowercase name as a workspace path", async () => {
    const mentions = await readAll("@Problems @problems/x");
    expect(mentions.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "Problems", kind: "file" },
      { path: "problems/x", kind: "file" },
    ]);
  });

  test("reads @problems written twice once", async () => {
    reads = 0;
    expect(await readAll("@problems then @problems, again @problems")).toHaveLength(1);
    expect(reads).toBe(1);
  });

  test("finds no mention in @problems inside inline code or a fence", async () => {
    expect(await readAll("run `@problems` and\n```\n@problems\n```")).toEqual([]);
  });
});
