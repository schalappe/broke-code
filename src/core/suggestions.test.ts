import { describe, expect, test } from "bun:test";
import {
  filterSlashCommands,
  filterSuggestions,
  findMentionToken,
  findSlashToken,
  INDEX_EXCLUDE_GLOB,
  indexEntries,
  isExcludedFromIndex,
  type SlashCommand,
} from "./suggestions";

describe("findMentionToken", () => {
  test("finds an @ token ending at the caret at the start of the text", () => {
    expect(findMentionToken("@sse", 4)).toEqual({ start: 0, query: "sse" });
  });

  test("finds an @ token after whitespace", () => {
    expect(findMentionToken("look at @src/co", 15)).toEqual({ start: 8, query: "src/co" });
    expect(findMentionToken("line\n@a", 7)).toEqual({ start: 5, query: "a" });
  });

  test("finds a bare @ with an empty query", () => {
    expect(findMentionToken("see @", 5)).toEqual({ start: 4, query: "" });
  });

  test("uses only the text before the caret as the query", () => {
    expect(findMentionToken("@src/core", 4)).toBeUndefined();
    expect(findMentionToken("@src rest", 4)).toEqual({ start: 0, query: "src" });
  });

  test("ignores an @ inside a word, such as an email address", () => {
    expect(findMentionToken("a@b", 3)).toBeUndefined();
    expect(findMentionToken("mail me@host.com", 16)).toBeUndefined();
  });

  test("ignores an @ inside an inline code span or a fenced block, where a mention never counts", () => {
    expect(findMentionToken("run `cat @sse` now", 13)).toBeUndefined();
    expect(findMentionToken("```\n@sse", 8)).toBeUndefined();
    expect(findMentionToken("```\n@x\n```\n@sse", 15)).toEqual({ start: 11, query: "sse" });
    expect(findMentionToken("a ` lone backtick @sse", 22)).toEqual({ start: 18, query: "sse" });
  });

  test("opens the menu after escaped backticks and across paragraphs, where no code span forms", () => {
    const escaped = "a \\` then @a \\`";
    expect(findMentionToken(escaped, escaped.indexOf("@a") + 2)).toEqual({ start: 10, query: "a" });
    const paragraphs = "x `\n\n@a\n\ny `";
    expect(findMentionToken(paragraphs, 7)).toEqual({ start: 5, query: "a" });
  });

  test("opens no menu where either reading, with or without picked paths, puts the token in code", () => {
    expect(findMentionToken("@a`b.ts @q", 10, ["a`b.ts"])).toEqual({ start: 8, query: "q" });
    expect(findMentionToken("@a`b.ts @q `", 10, ["a`b.ts"])).toBeUndefined();
    const text = "run `cat @secret.ts @a` now";
    expect(findMentionToken(text, text.indexOf(" @a"), ["a`"])).toBeUndefined();
  });

  test("ignores a caret after whitespace or with no @ token before it", () => {
    expect(findMentionToken("@sse ", 5)).toBeUndefined();
    expect(findMentionToken("plain text", 10)).toBeUndefined();
    expect(findMentionToken("", 0)).toBeUndefined();
  });
});

describe("findSlashToken", () => {
  test("a / at the very start with the caret after it is a token with an empty query", () => {
    expect(findSlashToken("/", 1)).toEqual({ query: "" });
  });

  test("the query is the text between the / and the caret", () => {
    expect(findSlashToken("/gri", 4)).toEqual({ query: "gri" });
    expect(findSlashToken("/gri rest", 4)).toEqual({ query: "gri" });
  });

  test("a / anywhere but the very start is no token", () => {
    expect(findSlashToken("see /etc", 8)).toBeUndefined();
    expect(findSlashToken("a /x", 4)).toBeUndefined();
    expect(findSlashToken(" /new", 5)).toBeUndefined();
  });

  test("is no token once whitespace stands between the / and the caret, or before the caret ends the word", () => {
    expect(findSlashToken("/new ", 5)).toBeUndefined();
    expect(findSlashToken("/new\nx", 6)).toBeUndefined();
    expect(findSlashToken("/model", 3)).toBeUndefined();
    expect(findSlashToken("/x", 0)).toBeUndefined();
    expect(findSlashToken("", 0)).toBeUndefined();
  });
});

describe("filterSlashCommands", () => {
  const command = (name: string): SlashCommand => ({ name, description: `${name} text` });
  const commands = ["new", "model", "grilling", "notes", "tdd", "Nightly"].map(command);

  test("keeps the rows whose name starts with the query, ignoring case, in the order given", () => {
    expect(filterSlashCommands(commands, "n", 20).map((row) => row.name)).toEqual(["new", "notes", "Nightly"]);
    expect(filterSlashCommands(commands, "GR", 20).map((row) => row.name)).toEqual(["grilling"]);
  });

  test("matches the start of the name only", () => {
    expect(filterSlashCommands(commands, "ill", 20)).toEqual([]);
  });

  test("an empty query keeps every row up to the limit", () => {
    expect(filterSlashCommands(commands, "", 20)).toEqual(commands);
    expect(filterSlashCommands(commands, "", 2).map((row) => row.name)).toEqual(["new", "model"]);
  });
});

describe("indexEntries", () => {
  test("lists each file and every folder above it once, folders suffixed with /", () => {
    expect(indexEntries(["src/core/sse.ts", "src/core/sse.test.ts", "src/main.ts", "README.md"])).toEqual([
      { path: "src/", kind: "folder" },
      { path: "src/core/", kind: "folder" },
      { path: "src/core/sse.ts", kind: "file" },
      { path: "src/core/sse.test.ts", kind: "file" },
      { path: "src/main.ts", kind: "file" },
      { path: "README.md", kind: "file" },
    ]);
  });

  test("derives no folder inside a multi-root folder name holding a slash", () => {
    expect(indexEntries(["libs/core/x.ts", "libs/core/src/y.ts", "app/z.ts"], ["libs/core", "app"])).toEqual([
      { path: "libs/core/", kind: "folder" },
      { path: "libs/core/x.ts", kind: "file" },
      { path: "libs/core/src/", kind: "folder" },
      { path: "libs/core/src/y.ts", kind: "file" },
      { path: "app/", kind: "folder" },
      { path: "app/z.ts", kind: "file" },
    ]);
  });

  test("yields nothing for an empty workspace", () => {
    expect(indexEntries([])).toEqual([]);
  });
});

describe("filterSuggestions", () => {
  const entries = indexEntries([
    "src/core/sse.ts",
    "src/core/sse.test.ts",
    "src/core/client.ts",
    "src/webview/App.tsx",
    "docs/SSE notes.md",
  ]);

  test("matches a substring of the path, shorter paths first", () => {
    expect(filterSuggestions(entries, "sse", 20).map((entry) => entry.path)).toEqual([
      "src/core/sse.ts",
      "docs/SSE notes.md",
      "src/core/sse.test.ts",
    ]);
  });

  test("ignores case", () => {
    expect(filterSuggestions(entries, "APP", 20).map((entry) => entry.path)).toEqual(["src/webview/App.tsx"]);
  });

  test("puts a matching folder before its longer files", () => {
    expect(filterSuggestions(entries, "src/co", 20)).toEqual([
      { path: "src/core/", kind: "folder" },
      { path: "src/core/sse.ts", kind: "file" },
      { path: "src/core/client.ts", kind: "file" },
      { path: "src/core/sse.test.ts", kind: "file" },
    ]);
  });

  test("orders paths of equal length alphabetically", () => {
    const tied = indexEntries(["b.ts", "c.ts", "a.ts"]);
    expect(filterSuggestions(tied, ".ts", 20).map((entry) => entry.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("returns at most the limit", () => {
    const many = indexEntries(Array.from({ length: 30 }, (_, index) => `file${index}.ts`));
    const found = filterSuggestions(many, "file", 20);
    expect(found).toHaveLength(20);
    expect(found[0]!.path).toBe("file0.ts");
  });

  test("returns the shortest entries for an empty query, and nothing when no path matches", () => {
    expect(filterSuggestions(entries, "", 2).map((entry) => entry.path)).toEqual(["src/", "docs/"]);
    expect(filterSuggestions(entries, "zzz", 20)).toEqual([]);
  });
});

describe("index exclusions", () => {
  test("the exclude glob names every excluded folder at any depth", () => {
    expect(INDEX_EXCLUDE_GLOB).toBe("**/{node_modules,.git,dist,out,build}/**");
  });

  test("a path inside an excluded folder at any depth is excluded", () => {
    for (const path of ["node_modules/x/index.js", ".git/HEAD", "pkg/dist/a.js", "a/out/b", "build/c"]) {
      expect(isExcludedFromIndex(path)).toBe(true);
    }
  });

  test("a path that only resembles an excluded folder is kept", () => {
    for (const path of ["src/build.ts", "distribution/a.ts", "out.txt", ".gitignore", "src/core/sse.ts"]) {
      expect(isExcludedFromIndex(path)).toBe(false);
    }
  });
});
