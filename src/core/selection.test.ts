import { describe, expect, test } from "bun:test";
import { formatMention } from "./mentions";
import { type EditorSelection, readSelection } from "./selection";
import type { WorkspaceRoot } from "./workspaceFiles";

const root: WorkspaceRoot = { name: "app", path: "/w/app" };

/** The primary selection of `/w/app/src/app.ts`, from `start` to `end` as 0-based `[line, character]`. */
const selected = (
  text: string,
  start: [number, number],
  end: [number, number],
  fields: Partial<EditorSelection> = {},
): EditorSelection => ({
  scheme: "file",
  path: "/w/app/src/app.ts",
  start: { line: start[0], character: start[1] },
  end: { line: end[0], character: end[1] },
  text,
  ...fields,
});

/** `@selection` read in `roots` with the active editor's selection `selection`, `undefined` for no active editor. */
const read = (selection: EditorSelection | undefined, roots: WorkspaceRoot[] = [root]) =>
  readSelection(roots, { read: async () => selection });

describe("readSelection", () => {
  test("attaches the selected text under a header giving the file and its line range, in a fence", async () => {
    const mention = await read(selected("const a = 1;\nconst b = 2;\nconst c = 3;", [9, 0], [11, 12]));
    expect(mention).toMatchObject({
      path: "selection",
      kind: "selection",
      status: "attached",
      lines: 3,
      range: { path: "src/app.ts", start: 10, end: 12 },
    });
    expect(formatMention(mention)).toBe(
      [
        "@selection (selection, src/app.ts lines 10-12, 3 lines)",
        "```",
        "const a = 1;",
        "const b = 2;",
        "const c = 3;",
        "```",
      ].join("\n"),
    );
  });

  test("writes one line as line N and 1 line", async () => {
    const mention = await read(selected("b = 2", [9, 6], [9, 11]));
    expect(mention.range).toEqual({ path: "src/app.ts", start: 10, end: 10 });
    expect(formatMention(mention)).toBe("@selection (selection, src/app.ts line 10, 1 line)\n```\nb = 2\n```");
  });

  test("does not count the line a selection ends on at its column 0", async () => {
    const mention = await read(selected("const a = 1;\nconst b = 2;\n", [9, 0], [11, 0]));
    expect(mention).toMatchObject({ lines: 2, range: { path: "src/app.ts", start: 10, end: 11 } });
    expect(formatMention(mention).split("\n")[0]).toBe("@selection (selection, src/app.ts lines 10-11, 2 lines)");
  });

  test("fences a selection holding backticks with a longer run", async () => {
    const mention = await read(selected("```ts\nx\n```", [0, 0], [2, 3]));
    expect(formatMention(mention)).toBe(
      "@selection (selection, src/app.ts lines 1-3, 3 lines)\n````\n```ts\nx\n```\n````",
    );
  });

  test("leads the path with its folder name in a multi-root workspace", async () => {
    const roots = [root, { name: "lib", path: "/w/lib" }];
    const mention = await read(selected("x", [0, 0], [0, 1], { path: "/w/lib/x.ts" }), roots);
    expect(mention.range).toEqual({ path: "lib/x.ts", start: 1, end: 1 });
  });

  test("attaches nothing without an active text editor, as noEditor", async () => {
    const mention = await read(undefined);
    expect(mention).toEqual({ path: "selection", kind: "selection", status: "noEditor", content: "", omitted: 0 });
    expect(formatMention(mention)).toBe("@selection (selection, noEditor)\nNot attached: no text editor is active.");
  });

  test("attaches nothing for an empty selection, as emptySelection", async () => {
    const mention = await read(selected("", [4, 2], [4, 2]));
    expect(mention).toEqual({
      path: "selection",
      kind: "selection",
      status: "emptySelection",
      content: "",
      omitted: 0,
    });
    expect(formatMention(mention)).toBe(
      "@selection (selection, emptySelection)\nNot attached: the selection is empty.",
    );
  });

  test("attaches nothing from a file outside the workspace, an untitled document, or another scheme", async () => {
    const outside = [
      selected("x", [0, 0], [0, 1], { path: "/elsewhere/x.ts" }),
      selected("x", [0, 0], [0, 1], { scheme: "untitled", path: "Untitled-1" }),
      selected("x", [0, 0], [0, 1], { scheme: "broke-code-diff" }),
    ];
    for (const selection of outside) {
      const mention = await read(selection);
      expect(mention).toEqual({
        path: "selection",
        kind: "selection",
        status: "outsideWorkspace",
        content: "",
        omitted: 0,
      });
      expect(formatMention(mention)).toBe(
        "@selection (selection, outsideWorkspace)\nNot attached: the selected file is outside the workspace folders.",
      );
    }
  });

  test("reports a failing source unreadable with its cause", async () => {
    const mention = await readSelection([root], {
      read: async () => {
        throw new Error("no editor API");
      },
    });
    expect(formatMention(mention)).toBe(
      "@selection (selection, unreadable)\nNot attached: the selection could not be read (no editor API).",
    );
  });

  test("cuts over 2,000 lines with the truncation notice, the range still the whole selection", async () => {
    const text = Array.from({ length: 2003 }, (_, line) => `line ${line + 1}`).join("\n");
    const mention = await read(selected(text, [0, 0], [2002, 9]));
    expect(mention).toMatchObject({
      status: "truncated",
      lines: 2000,
      omitted: 3,
      range: { path: "src/app.ts", start: 1, end: 2003 },
    });
    const block = formatMention(mention);
    expect(
      block.startsWith("@selection (selection, src/app.ts lines 1-2003, 2000 lines, truncated)\n```\nline 1\n"),
    ).toBe(true);
    expect(block.endsWith("line 2000\n```\n[truncated: 3 more lines not shown]")).toBe(true);
  });

  test("cuts over 1 MiB between characters, never refused", async () => {
    // Each line holds about 96,000 bytes: ten fit in 1 MiB, the eleventh is cut between two characters.
    const text = Array.from({ length: 12 }, () => "€".repeat(32_000)).join("\n");
    const mention = await read(selected(text, [0, 0], [11, 32_000]));
    expect(mention).toMatchObject({ status: "truncated", lines: 10, omitted: 2 });
    expect(Buffer.byteLength(mention.content)).toBeLessThanOrEqual(1024 * 1024);
    expect(mention.content.endsWith("€")).toBe(true);
    expect(formatMention(mention).endsWith("\n[truncated: 2 more lines not shown]")).toBe(true);
  });
});
