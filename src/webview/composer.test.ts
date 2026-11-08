import { describe, expect, test } from "bun:test";
import type { Suggestion } from "../core/suggestions";
import { type MenuAnswer, menuView } from "./composer";

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
