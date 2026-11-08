import { describe, expect, test } from "bun:test";
import type { Suggestion } from "../core/suggestions";
import { composerKeyAction, type MenuAnswer, menuView } from "./composer";

const file = (path: string): Suggestion => ({ path, kind: "file" });

describe("menuView", () => {
  const answer: MenuAnswer = { query: "a", items: [file("a.ts"), file("ab.ts"), file("src/b.ts")], capped: false };

  test("shows the rows of the answer to the current query", () => {
    expect(menuView(answer, "a")).toEqual({ items: answer.items, capped: false });
  });

  test("while the answer to a new query is pending, shows only the earlier rows that match it", () => {
    expect(menuView(answer, "ab")).toEqual({ items: [file("ab.ts")], capped: false });
    expect(menuView(answer, "B")).toEqual({ items: [file("ab.ts"), file("src/b.ts")], capped: false });
  });

  test("shows no menu while pending when no earlier row matches, nor before any answer", () => {
    expect(menuView(answer, "zzz")).toBeUndefined();
    expect(menuView(undefined, "a")).toBeUndefined();
  });

  test("keeps the index limit while pending", () => {
    expect(menuView({ ...answer, capped: true }, "ab")).toEqual({ items: [file("ab.ts")], capped: true });
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
