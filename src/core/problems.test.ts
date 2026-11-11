import { describe, expect, test } from "bun:test";
import { formatMention } from "./mentions";
import { type Diagnostic, readProblems } from "./problems";
import type { WorkspaceRoot } from "./workspaceFiles";

const root: WorkspaceRoot = { name: "app", path: "/w/app" };

/** A diagnostic of `/w/app/<path>` with defaults for an error at the file's start. */
const at = (path: string, fields: Partial<Diagnostic> = {}): Diagnostic => ({
  scheme: "file",
  path: `/w/app/${path}`,
  line: 0,
  character: 0,
  severity: "error",
  message: "Broken.",
  ...fields,
});

/** The `@problems` block for `diagnostics` read in `roots`. */
async function block(diagnostics: Diagnostic[], roots: WorkspaceRoot[] = [root]): Promise<string> {
  return formatMention(await readProblems(roots, { read: async () => diagnostics }));
}

describe("readProblems", () => {
  test("attaches one line per problem under a header counting them, in a fence", async () => {
    const diagnostics = [
      at("src/util.ts", {
        line: 2,
        severity: "warning",
        message: "'x' is declared but never used.",
        source: "eslint",
      }),
      at("src/app.ts", {
        line: 11,
        character: 4,
        message: "Type 'string' is not assignable to type 'number'.",
        source: "ts",
      }),
    ];
    expect(await block(diagnostics)).toBe(
      [
        "@problems (problems, 2 problems)",
        "```",
        "src/app.ts:12:5 error Type 'string' is not assignable to type 'number'. (ts)",
        "src/util.ts:3:1 warning 'x' is declared but never used. (eslint)",
        "```",
      ].join("\n"),
    );
  });

  test("counts one problem in the singular, and writes no source when it has none", async () => {
    expect(await block([at("a.ts")])).toBe("@problems (problems, 1 problem)\n```\na.ts:1:1 error Broken.\n```");
  });

  test("sorts by path, then line, then column", async () => {
    const diagnostics = [
      at("b.ts"),
      at("a.ts", { line: 9, character: 3 }),
      at("a.ts", { line: 9, character: 0 }),
      at("a.ts", { line: 1, character: 7 }),
    ];
    expect((await readProblems([root], { read: async () => diagnostics })).content).toBe(
      ["a.ts:2:8 error Broken.", "a.ts:10:1 error Broken.", "a.ts:10:4 error Broken.", "b.ts:1:1 error Broken."].join(
        "\n",
      ),
    );
  });

  test("writes a message of several lines on one line, each line break a space", async () => {
    const mention = await readProblems([root], { read: async () => [at("a.ts", { message: "One\ntwo\r\nthree" })] });
    expect(mention.content).toBe("a.ts:1:1 error One two three");
  });

  test("leaves out information and hints, documents that are not files, and files outside the workspace", async () => {
    const mention = await readProblems([root], {
      read: async () => [
        at("info.ts", { severity: "information" }),
        at("hint.ts", { severity: "hint" }),
        at("untitled.ts", { scheme: "untitled" }),
        { ...at("x.ts"), path: "/w/other/x.ts" },
        { ...at("x.ts"), path: "/w/app" },
        at("kept.ts"),
      ],
    });
    expect(mention.content).toBe("kept.ts:1:1 error Broken.");
  });

  test("leads each path with its folder name in a multi-root workspace, the deepest folder winning", async () => {
    const roots = [root, { name: "lib", path: "/w/app/lib" }];
    const mention = await readProblems(roots, { read: async () => [at("lib/x.ts"), at("main.ts")] });
    expect(mention.content).toBe("app/main.ts:1:1 error Broken.\nlib/x.ts:1:1 error Broken.");
  });

  test("attaches nothing without an error or warning, saying so, as noProblems", async () => {
    const mention = await readProblems([root], { read: async () => [at("a.ts", { severity: "hint" })] });
    expect(mention).toEqual({ path: "problems", kind: "problems", status: "noProblems", content: "", omitted: 0 });
    expect(formatMention(mention)).toBe(
      "@problems (problems, noProblems)\nNot attached: VS Code holds no error or warning for the workspace files.",
    );
  });

  test("reports a failing source unreadable with its cause", async () => {
    const mention = await readProblems([root], {
      read: async () => {
        throw new Error("no diagnostics");
      },
    });
    expect(mention).toMatchObject({ kind: "problems", status: "unreadable", cause: "no diagnostics" });
    expect(formatMention(mention)).toBe(
      "@problems (problems, unreadable)\nNot attached: the problems could not be read (no diagnostics).",
    );
  });

  test("cuts over 2,000 problems with the truncation notice", async () => {
    const diagnostics = Array.from({ length: 2003 }, (_, line) => at("a.ts", { line }));
    const mention = await readProblems([root], { read: async () => diagnostics });
    expect(mention).toMatchObject({ status: "truncated", lines: 2000, omitted: 3 });
    const text = formatMention(mention);
    expect(text.startsWith("@problems (problems, 2000 problems, truncated)\n```\na.ts:1:1 error Broken.\n")).toBe(true);
    expect(text.endsWith("a.ts:2000:1 error Broken.\n```\n[truncated: 3 more lines not shown]")).toBe(true);
  });

  test("cuts over 1 MiB between characters, the cut line counted as not shown", async () => {
    // Each line holds about 96,000 bytes: ten fit in 1 MiB, the eleventh is cut between two characters.
    const message = "€".repeat(32_000);
    const diagnostics = Array.from({ length: 12 }, (_, line) => at("a.ts", { line, message }));
    const mention = await readProblems([root], { read: async () => diagnostics });
    expect(mention).toMatchObject({ status: "truncated", lines: 10, omitted: 2 });
    expect(Buffer.byteLength(mention.content)).toBeLessThanOrEqual(1024 * 1024);
    expect(mention.content.endsWith("€")).toBe(true);
    expect(formatMention(mention).endsWith("\n[truncated: 2 more lines not shown]")).toBe(true);
  });
});
