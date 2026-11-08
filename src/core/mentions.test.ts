import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeUserMessage, findMentions, formatMention, type ReadMention, readMention } from "./mentions";
import type { WorkspaceRoot } from "./workspaceFiles";

describe("findMentions", () => {
  test("finds each @path token in order, once", () => {
    expect(findMentions("explain @src/core/sse.ts and @src/ then @src/core/sse.ts again")).toEqual([
      "src/core/sse.ts",
      "src/",
    ]);
  });

  test("takes a token at the start of the text or of a line", () => {
    expect(findMentions("@a.ts\n@b.ts\tand\t@c.ts")).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("ignores an @ inside a word, such as an email address, and a bare @", () => {
    expect(findMentions("mail me at me@example.com or @ alone")).toEqual([]);
  });

  test("strips trailing sentence punctuation from the token", () => {
    expect(findMentions("see @a.ts, @b.ts. (and @c.ts) @d.ts: @e.ts?! @f.ts;")).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
      "d.ts",
      "e.ts",
      "f.ts",
    ]);
    expect(findMentions("@...")).toEqual([]);
  });

  test("ignores tokens inside fenced code blocks of backticks or tildes", () => {
    const text = [
      "@before.ts",
      "````ts",
      "@inside.ts",
      "```",
      "still @inside2.ts",
      "````",
      "~~~",
      "@tilde.ts",
      "~~~",
      "@after.ts",
    ].join("\n");
    expect(findMentions(text)).toEqual(["before.ts", "after.ts"]);
  });

  test("ignores tokens inside an unclosed fence", () => {
    expect(findMentions("@a.ts\n```\n@b.ts")).toEqual(["a.ts"]);
  });

  test("ignores tokens inside inline code spans, and keeps those after an unmatched backtick", () => {
    expect(findMentions("run `cat @x.ts` and ``a ` @y.ts`` on @z.ts")).toEqual(["z.ts"]);
    expect(findMentions("a ` lone backtick @w.ts")).toEqual(["w.ts"]);
  });
});

describe("findMentions with picked paths", () => {
  test("takes a picked path with a space whole, with no mention for its first word", () => {
    expect(findMentions("explain @my file.ts please", ["my file.ts"])).toEqual(["my file.ts"]);
  });

  test("merges picked and typed mentions in order of first appearance, each once", () => {
    expect(findMentions("@b.ts then @my notes.md and @b.ts, @c.ts @my notes.md.", ["my notes.md", "c.ts"])).toEqual([
      "b.ts",
      "my notes.md",
      "c.ts",
    ]);
  });

  test("drops a picked path whose @path text is gone or was edited into another word", () => {
    expect(findMentions("nothing left", ["my file.ts"])).toEqual([]);
    expect(findMentions("see @src/a.tsx", ["src/a.ts"])).toEqual(["src/a.tsx"]);
  });

  test("takes a picked path only at the start of the text or after whitespace, and outside code", () => {
    expect(findMentions("mail x@my file.ts", ["my file.ts"])).toEqual([]);
    expect(findMentions("run `cat @my file.ts`", ["my file.ts"])).toEqual([]);
  });

  test("masks the longer of two overlapping picked paths first", () => {
    expect(findMentions("@a b c.ts", ["a", "a b c.ts"])).toEqual(["a b c.ts"]);
  });
});

/** A read mention with defaults for an attached file. */
const read = (fields: Partial<ReadMention> & Pick<ReadMention, "path">): ReadMention => ({
  kind: "file",
  status: "attached",
  content: "",
  omitted: 0,
  ...fields,
});

describe("formatMention", () => {
  test("puts an attached file under a path header with its line count, in a fence", () => {
    expect(formatMention(read({ path: "src/a.ts", lines: 2, content: "one\ntwo\n" }))).toBe(
      "@src/a.ts (file, 2 lines)\n```\none\ntwo\n```",
    );
    expect(formatMention(read({ path: "one.txt", lines: 1, content: "x" }))).toBe(
      "@one.txt (file, 1 line)\n```\nx\n```",
    );
  });

  test("counts a folder in entries", () => {
    expect(formatMention(read({ path: "src/", kind: "folder", lines: 2, content: "core/\nmain.ts" }))).toBe(
      "@src/ (folder, 2 entries)\n```\ncore/\nmain.ts\n```",
    );
  });

  test("fences content with a fence longer than any backtick run inside it", () => {
    const content = "before\n```js\nx\n```\n`````\nafter";
    const block = formatMention(read({ path: "doc.md", lines: 6, content }));
    expect(block).toBe(`@doc.md (file, 6 lines)\n\`\`\`\`\`\`\n${content}\n\`\`\`\`\`\``);
  });

  test("ends a truncated file with the count of lines not shown, after the fence", () => {
    const block = formatMention(read({ path: "big.txt", status: "truncated", lines: 2000, omitted: 1, content: "x" }));
    expect(block).toBe("@big.txt (file, 2000 lines, truncated)\n```\nx\n```\n[truncated: 1 more lines not shown]");
  });

  test("gives a one-line notice instead of content for each error status", () => {
    const notice = (fields: Partial<ReadMention>) => formatMention(read({ path: "p", ...fields }));
    expect(notice({ status: "missing" })).toBe(
      "@p (file, missing)\nNot attached: no such file or folder in the workspace.",
    );
    expect(notice({ status: "missing", kind: "folder" })).toBe(
      "@p (folder, missing)\nNot attached: no such file or folder in the workspace.",
    );
    expect(notice({ status: "outsideWorkspace" })).toBe(
      "@p (file, outsideWorkspace)\nNot attached: the path is outside the workspace folders.",
    );
    expect(notice({ status: "binary" })).toBe("@p (file, binary)\nNot attached: the file is binary.");
    expect(notice({ status: "tooLarge" })).toBe("@p (file, tooLarge)\nNot attached: the file is larger than 1 MiB.");
    expect(notice({ status: "unreadable", cause: "EACCES" })).toBe(
      "@p (file, unreadable)\nNot attached: the path could not be read (EACCES).",
    );
  });
});

describe("composeUserMessage", () => {
  test("sends the text alone when nothing is mentioned", () => {
    expect(composeUserMessage("Hi", [])).toBe("Hi");
  });

  test("puts the text first, then one block per mention in mention order", () => {
    const mentions = [read({ path: "a.ts", lines: 1, content: "A" }), read({ path: "gone.txt", status: "missing" })];
    expect(composeUserMessage("explain @a.ts and @gone.txt", mentions)).toBe(
      [
        "explain @a.ts and @gone.txt",
        "",
        "@a.ts (file, 1 line)",
        "```",
        "A",
        "```",
        "",
        "@gone.txt (file, missing)",
        "Not attached: no such file or folder in the workspace.",
      ].join("\n"),
    );
  });
});

describe("readMention", () => {
  let root: WorkspaceRoot;
  beforeAll(async () => {
    root = { name: "w", path: await mkdtemp(join(tmpdir(), "broke-code-mentions-")) };
    await writeFile(join(root.path, "small.ts"), "a\nb\n");
    await writeFile(
      join(root.path, "long.txt"),
      Array.from({ length: 2001 }, (_, index) => `line ${index + 1}`).join("\n"),
    );
    await mkdir(join(root.path, "src"));
    await writeFile(join(root.path, "src", "x.ts"), "");
  });
  afterAll(() => rm(root.path, { recursive: true, force: true }));

  test("attaches a file whole with its line count", async () => {
    expect(await readMention([root], "small.ts")).toEqual({
      path: "small.ts",
      kind: "file",
      status: "attached",
      lines: 2,
      content: "a\nb\n",
      omitted: 0,
    });
  });

  test("cuts a 2,001-line file to 2,000 lines, with status truncated and a notice to the model", async () => {
    const mention = await readMention([root], "long.txt");
    expect(mention).toMatchObject({ status: "truncated", lines: 2000, omitted: 1 });
    expect(mention.content.split("\n")).toHaveLength(2000);
    expect(formatMention(mention).endsWith("line 2000\n```\n[truncated: 1 more lines not shown]")).toBe(true);
  });

  test("attaches a folder's listing, counted in entries", async () => {
    expect(await readMention([root], "src/")).toEqual({
      path: "src/",
      kind: "folder",
      status: "attached",
      lines: 1,
      content: "x.ts",
      omitted: 0,
    });
  });

  test("attaches nothing for a path it cannot read, keeping the reason", async () => {
    expect(await readMention([root], "../elsewhere.txt")).toEqual({
      path: "../elsewhere.txt",
      kind: "file",
      status: "outsideWorkspace",
      content: "",
      omitted: 0,
    });
    expect(await readMention([root], "gone/")).toMatchObject({ kind: "folder", status: "missing", content: "" });
  });
});
