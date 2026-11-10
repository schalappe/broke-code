import { describe, expect, test } from "bun:test";
import { MAX_QUERY_LENGTH } from "../core/protocol";
import type { SlashCommand, Suggestion } from "../core/suggestions";
import {
  builtInCommand,
  composerKeyAction,
  type MenuAnswer,
  menuToken,
  menuView,
  openMenuToken,
  pickedInText,
  replaceToken,
  slashMenuView,
} from "./composer";

const file = (path: string): Suggestion => ({ path, kind: "file" });

describe("menuView", () => {
  const answer: MenuAnswer = {
    query: "a",
    items: [file("a.ts"), file("ab.ts"), file("src/b.ts")],
    capped: false,
    failed: false,
  };

  test("shows the rows of the answer to the current query", () => {
    expect(menuView(answer, "a")).toEqual({ items: answer.items, capped: false, failed: false });
  });

  test("while the answer to a new query is pending, shows only the earlier rows that match it", () => {
    expect(menuView(answer, "ab")).toEqual({ items: [file("ab.ts")], capped: false, failed: false });
    expect(menuView(answer, "B")).toEqual({ items: [file("ab.ts"), file("src/b.ts")], capped: false, failed: false });
  });

  test("shows no menu while pending when no earlier row matches, nor before any answer", () => {
    expect(menuView(answer, "zzz")).toBeUndefined();
    expect(menuView(undefined, "a")).toBeUndefined();
  });

  test("shows a failed answer to the current query, and nothing of it while the next one is pending", () => {
    const failed: MenuAnswer = { query: "a", items: [], capped: false, failed: true };
    expect(menuView(failed, "a")).toEqual({ items: [], capped: false, failed: true });
    expect(menuView(failed, "ab")).toBeUndefined();
  });

  test("keeps the index limit while pending", () => {
    expect(menuView({ ...answer, capped: true }, "ab")).toEqual({
      items: [file("ab.ts")],
      capped: true,
      failed: false,
    });
  });
});

describe("composerKeyAction", () => {
  const key = (name: string, fields: { shift?: boolean; composing?: boolean } = {}) => ({
    key: name,
    shift: fields.shift ?? false,
    composing: fields.composing ?? false,
  });

  test("Escape dismisses an open menu, rows or not, and does nothing without one", () => {
    expect(composerKeyAction(key("Escape"), 3)).toEqual({ type: "dismiss" });
    expect(composerKeyAction(key("Escape"), 0)).toEqual({ type: "dismiss" });
    expect(composerKeyAction(key("Escape"), undefined)).toEqual({ type: "none" });
  });

  test("ArrowDown and ArrowUp move the highlight in opposite directions", () => {
    expect(composerKeyAction(key("ArrowDown"), 3)).toEqual({ type: "move", step: 1 });
    expect(composerKeyAction(key("ArrowUp"), 3)).toEqual({ type: "move", step: -1 });
  });

  test("Enter and Tab pick the highlighted row when the menu has rows", () => {
    expect(composerKeyAction(key("Enter"), 2)).toEqual({ type: "pick" });
    expect(composerKeyAction(key("Tab"), 2)).toEqual({ type: "pick" });
  });

  test("Shift+Enter inserts a new line, with or without the menu", () => {
    expect(composerKeyAction(key("Enter", { shift: true }), 2)).toEqual({ type: "none" });
    expect(composerKeyAction(key("Enter", { shift: true }), undefined)).toEqual({ type: "none" });
  });

  test("IME composition never triggers a menu action or a send", () => {
    for (const name of ["Escape", "ArrowDown", "ArrowUp", "Enter", "Tab"]) {
      expect(composerKeyAction(key(name, { composing: true }), 2)).toEqual({ type: "none" });
    }
    expect(composerKeyAction(key("Enter", { composing: true }), undefined)).toEqual({ type: "none" });
  });

  test("Enter sends when the menu is closed or shows no row, and Tab and arrows keep their default", () => {
    expect(composerKeyAction(key("Enter"), undefined)).toEqual({ type: "send" });
    expect(composerKeyAction(key("Enter"), 0)).toEqual({ type: "send" });
    for (const name of ["Tab", "ArrowDown", "ArrowUp"]) {
      expect(composerKeyAction(key(name), 0)).toEqual({ type: "none" });
      expect(composerKeyAction(key(name), undefined)).toEqual({ type: "none" });
    }
  });
});

describe("pickedInText", () => {
  test("keeps the picked paths whose @path text is still in the message, and drops a deleted one", () => {
    expect(pickedInText(["my file.ts", "gone.ts", "src/"], "see @my file.ts and @src/ now")).toEqual([
      "my file.ts",
      "src/",
    ]);
    expect(pickedInText(["gone.ts"], "the mention was deleted, gone.ts stays as a word")).toEqual([]);
  });
});

describe("menuToken", () => {
  test("is the @ token at the caret, read with the picked paths set aside", () => {
    expect(menuToken("see @sr", 7, [])).toEqual({ trigger: "@", start: 4, query: "sr" });
    expect(menuToken("@a`b.ts @q", 10, ["a`b.ts"])).toEqual({ trigger: "@", start: 8, query: "q" });
    expect(menuToken("plain word", 10, [])).toBeUndefined();
  });

  test("takes a query up to MAX_QUERY_LENGTH characters, and none past it", () => {
    const atLimit = `@${"a".repeat(MAX_QUERY_LENGTH)}`;
    expect(menuToken(atLimit, atLimit.length, [])).toEqual({
      trigger: "@",
      start: 0,
      query: "a".repeat(MAX_QUERY_LENGTH),
    });
    expect(menuToken(`${atLimit}a`, atLimit.length + 1, [])).toBeUndefined();
  });

  test("is the / token at the start of the message, and an @ token after it once whitespace follows the /", () => {
    expect(menuToken("/", 1, [])).toEqual({ trigger: "/", start: 0, query: "" });
    expect(menuToken("/gri", 4, [])).toEqual({ trigger: "/", start: 0, query: "gri" });
    expect(menuToken("/grilling @sr", 13, [])).toEqual({ trigger: "@", start: 10, query: "sr" });
    expect(menuToken("see /etc", 8, [])).toBeUndefined();
  });
});

describe("openMenuToken", () => {
  const token = { trigger: "@" as const, start: 4, query: "sr" };

  test("opens the menu of the token while the message box has focus", () => {
    expect(openMenuToken(token, true, undefined)).toEqual(token);
    expect(openMenuToken(token, false, undefined)).toBeUndefined();
    expect(openMenuToken(undefined, true, undefined)).toBeUndefined();
  });

  test("keeps closed the token dismissed with Escape, and opens one at another place or with another query", () => {
    expect(openMenuToken(token, true, { ...token })).toBeUndefined();
    expect(openMenuToken(token, true, { ...token, start: 9 })).toEqual(token);
    expect(openMenuToken(token, true, { ...token, query: "s" })).toEqual(token);
  });

  test("a / token is another token than an @ token at the same place with the same query", () => {
    const slash = { trigger: "/" as const, start: 0, query: "x" };
    expect(openMenuToken(slash, true, { ...slash, trigger: "@" })).toEqual(slash);
    expect(openMenuToken(slash, true, { ...slash })).toBeUndefined();
  });
});

describe("slashMenuView", () => {
  const command = (name: string): SlashCommand => ({ name, description: `${name} text` });
  const builtIns = [command("new"), command("model")];
  const skills = { items: [command("grilling"), command("notes")], failed: false };

  test("lists the built-in commands, then the skills, those whose name starts with the query", () => {
    expect(slashMenuView(builtIns, skills, "")).toEqual({ items: [...builtIns, ...skills.items], failed: false });
    expect(slashMenuView(builtIns, skills, "n")).toEqual({
      items: [command("new"), command("notes")],
      failed: false,
    });
    expect(slashMenuView(builtIns, skills, "zz")).toEqual({ items: [], failed: false });
  });

  test("shows at most MAX_SUGGESTIONS rows", () => {
    const many = { items: Array.from({ length: 30 }, (_, index) => command(`skill-${index}`)), failed: false };
    expect(slashMenuView(builtIns, many, "")?.items).toHaveLength(20);
  });

  test("while the skills are pending, shows the matching built-ins, and no menu when none match", () => {
    expect(slashMenuView(builtIns, undefined, "m")).toEqual({ items: [command("model")], failed: false });
    expect(slashMenuView(builtIns, undefined, "gr")).toBeUndefined();
  });

  test("when the skills could not be listed, still shows the built-ins and says so", () => {
    const failed = { items: [], failed: true };
    expect(slashMenuView(builtIns, failed, "")).toEqual({ items: builtIns, failed: true });
    expect(slashMenuView(builtIns, failed, "gr")).toEqual({ items: [], failed: true });
  });
});

describe("builtInCommand", () => {
  test("is the built-in command a message is exactly, trimmed", () => {
    expect(builtInCommand("/new")).toBe("new");
    expect(builtInCommand("  /model \n")).toBe("model");
  });

  test("is none for a command with words after it, another word, or another case", () => {
    for (const text of ["/new words", "/model gpt", "/news", "/grilling", "new", "/New", "see /new"]) {
      expect(builtInCommand(text)).toBeUndefined();
    }
  });
});

describe("replaceToken", () => {
  test("replaces the token up to the caret and puts the caret after the inserted text", () => {
    expect(replaceToken("/gr", { start: 0 }, 3, "/grilling ")).toEqual({ text: "/grilling ", caret: 10 });
    expect(replaceToken("see @sr now", { start: 4 }, 7, "@src/ ")).toEqual({ text: "see @src/  now", caret: 10 });
  });
});
