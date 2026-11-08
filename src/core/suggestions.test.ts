import { describe, expect, test } from "bun:test";
import {
  filterSuggestions,
  findMentionToken,
  INDEX_EXCLUDE_GLOB,
  indexEntries,
  isExcludedFromIndex,
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

  test("reads code with picked paths set aside, so a backtick inside a picked path opens no code span", () => {
    expect(findMentionToken("@a`b.ts @q `", 10)).toBeUndefined();
    expect(findMentionToken("@a`b.ts @q `", 10, ["a`b.ts"])).toEqual({ start: 8, query: "q" });
  });

  test("ignores a caret after whitespace or with no @ token before it", () => {
    expect(findMentionToken("@sse ", 5)).toBeUndefined();
    expect(findMentionToken("plain text", 10)).toBeUndefined();
    expect(findMentionToken("", 0)).toBeUndefined();
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
