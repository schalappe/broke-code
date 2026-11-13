import { describe, expect, test } from "bun:test";
import { type ChatEntry, type ChatState, type DraftInsert, MAX_QUERY_LENGTH } from "../core/protocol";
import type { SlashCommand, Suggestion } from "../core/suggestions";
import {
  applyDraft,
  type ComposerBox,
  type ComposerKey,
  composerKeyAction,
  editDraft,
  type KeyAction,
  type MenuAnswer,
  mentionPick,
  menuToken,
  menuView,
  openMenuToken,
  pickedInText,
  pickKeepsToken,
  quoteDraft,
  recallHolds,
  replaceToken,
  slashMenuView,
  slashPick,
  stillReplacing,
} from "./composer";

type MentionResult = Extract<ChatEntry, { role: "user" }>["mentions"][number];

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

describe("menuView reserved rows", () => {
  const problems = { path: "problems", kind: "problems" } as const;
  const diff = { path: "diff", kind: "diff" } as const;
  const selection = { path: "selection", kind: "selection" } as const;
  const files = Array.from({ length: 20 }, (_, index) => file(`f${index}.ts`));

  test("lists the reserved names first, in order, then the files, 20 rows at most", () => {
    const view = menuView({ query: "", items: files, capped: false, failed: false }, "");
    expect(view?.items).toEqual([problems, diff, selection, ...files.slice(0, 17)]);
  });

  test("keeps @problems when its name starts with the query, ignoring case, and drops it otherwise", () => {
    const answer: MenuAnswer = { query: "pro", items: [file("src/pro.ts")], capped: false, failed: false };
    expect(menuView(answer, "pro")?.items).toEqual([problems, file("src/pro.ts")]);
    expect(menuView({ ...answer, query: "PRO" }, "PRO")?.items).toEqual([problems, file("src/pro.ts")]);
    expect(menuView({ ...answer, query: "e" }, "e")?.items).toEqual([file("src/pro.ts")]);
    expect(menuView({ ...answer, query: "Di" }, "Di")?.items).toEqual([diff, file("src/pro.ts")]);
  });

  test("shows the reserved rows before the files answer, and with a failed answer", () => {
    expect(menuView(undefined, "")).toEqual({ items: [problems, diff, selection], capped: false, failed: false });
    expect(menuView(undefined, "Sel")).toEqual({ items: [selection], capped: false, failed: false });
    expect(menuView(undefined, "prob")).toEqual({ items: [problems], capped: false, failed: false });
    expect(menuView(undefined, "x")).toBeUndefined();
    const failed: MenuAnswer = { query: "p", items: [], capped: false, failed: true };
    expect(menuView(failed, "p")).toEqual({ items: [problems], capped: false, failed: true });
  });
});

describe("mentionPick", () => {
  test("inserts a workspace entry named like a reserved mention as ./<name>, and records that path", () => {
    expect(mentionPick(file("problems"))).toEqual({ text: "@./problems ", picked: "./problems" });
    expect(mentionPick(file("selection"))).toEqual({ text: "@./selection ", picked: "./selection" });
    expect(mentionPick({ path: "problems/", kind: "folder" })).toEqual({ text: "@problems/ ", picked: "problems/" });
    expect(mentionPick(file("diff"))).toEqual({ text: "@./diff ", picked: "./diff" });
    expect(mentionPick(file("src/a.ts"))).toEqual({ text: "@src/a.ts ", picked: "src/a.ts" });
  });

  test("inserts a reserved row as @<name>, recording no path", () => {
    expect(mentionPick({ path: "problems", kind: "problems" })).toEqual({ text: "@problems " });
    expect(mentionPick({ path: "diff", kind: "diff" })).toEqual({ text: "@diff " });
    expect(mentionPick({ path: "selection", kind: "selection" })).toEqual({ text: "@selection " });
  });
});

describe("pickKeepsToken", () => {
  const at = (query: string) => ({ trigger: "@" as const, start: 0, query });

  test("holds when the token already is what the row inserts, so Enter sends", () => {
    expect(pickKeepsToken(file("src/a.ts"), at("src/a.ts"))).toBe(true);
    expect(pickKeepsToken({ path: "src/", kind: "folder" }, at("src/"))).toBe(true);
    expect(pickKeepsToken({ path: "diff", kind: "diff" }, at("diff"))).toBe(true);
  });

  test("fails for a partial path, another case, a reserved name the row turns into ./<name>, and a / token", () => {
    expect(pickKeepsToken(file("src/a.ts"), at("src/a"))).toBe(false);
    expect(pickKeepsToken(file("src/a.ts"), at("SRC/a.ts"))).toBe(false);
    expect(pickKeepsToken(file("problems"), at("problems"))).toBe(false);
    expect(pickKeepsToken(file("src/a.ts"), { trigger: "/", start: 0, query: "src/a.ts" })).toBe(false);
  });
});

describe("composerKeyAction", () => {
  const key = (name: string, fields: Partial<ComposerKey> = {}): ComposerKey => ({
    key: name,
    shift: false,
    alt: false,
    control: false,
    meta: false,
    composing: false,
    ...fields,
  });
  /** A box with no text and no recall, in a conversation with no user message. */
  const idle: ComposerBox = {
    text: "",
    selectionStart: 0,
    selectionEnd: 0,
    conversationId: "c1",
    entries: [],
    recalled: undefined,
    replying: false,
  };

  test("Escape dismisses an open menu, rows or not, and does nothing without one", () => {
    expect(composerKeyAction(key("Escape"), 3, idle)).toEqual({ type: "dismiss" });
    expect(composerKeyAction(key("Escape"), 0, idle)).toEqual({ type: "dismiss" });
    expect(composerKeyAction(key("Escape"), undefined, idle)).toEqual({ type: "none" });
  });

  test("a bare Escape in an empty box stops a reply in flight when no menu is open", () => {
    const replying = { ...idle, replying: true };
    expect(composerKeyAction(key("Escape"), undefined, replying)).toEqual({ type: "stop" });
    expect(composerKeyAction(key("Escape"), 2, replying)).toEqual({ type: "dismiss" });
    expect(composerKeyAction(key("Escape", { shift: true }), undefined, replying)).toEqual({ type: "none" });
    const typing = { ...replying, text: "@src/a.ts and then", selectionStart: 18, selectionEnd: 18 };
    expect(composerKeyAction(key("Escape"), undefined, typing)).toEqual({ type: "none" });
  });

  test("ArrowDown and ArrowUp move the highlight in opposite directions", () => {
    expect(composerKeyAction(key("ArrowDown"), 3, idle)).toEqual({ type: "move", step: 1 });
    expect(composerKeyAction(key("ArrowUp"), 3, idle)).toEqual({ type: "move", step: -1 });
  });

  test("Enter and Tab pick the highlighted row when the menu has rows", () => {
    expect(composerKeyAction(key("Enter"), 2, idle)).toEqual({ type: "pick" });
    expect(composerKeyAction(key("Tab"), 2, idle)).toEqual({ type: "pick" });
  });

  test("Shift+Enter inserts a new line, with or without the menu", () => {
    expect(composerKeyAction(key("Enter", { shift: true }), 2, idle)).toEqual({ type: "none" });
    expect(composerKeyAction(key("Enter", { shift: true }), undefined, idle)).toEqual({ type: "none" });
  });

  test("IME composition never triggers a menu action or a send", () => {
    for (const name of ["Escape", "ArrowDown", "ArrowUp", "Enter", "Tab"]) {
      expect(composerKeyAction(key(name, { composing: true }), 2, idle)).toEqual({ type: "none" });
    }
    expect(composerKeyAction(key("Enter", { composing: true }), undefined, idle)).toEqual({ type: "none" });
  });

  test("Enter sends when the menu is closed or shows no row, and Tab and arrows keep their default without a recall", () => {
    expect(composerKeyAction(key("Enter"), undefined, idle)).toEqual({ type: "send" });
    expect(composerKeyAction(key("Enter"), 0, idle)).toEqual({ type: "send" });
    for (const name of ["Tab", "ArrowDown", "ArrowUp"]) {
      expect(composerKeyAction(key(name), 0, idle)).toEqual({ type: "none" });
      expect(composerKeyAction(key(name), undefined, idle)).toEqual({ type: "none" });
    }
  });

  describe("recall", () => {
    const user = (content: string, mentions: MentionResult[] = []): ChatEntry => ({ role: "user", content, mentions });
    const reply = (content: string): ChatEntry => ({ role: "assistant", reasoning: "", content, status: "done" });
    /** `A`, then `b1⏎b2`, then `C`, each answered. */
    const entries = [user("A"), reply("a"), user("b1\nb2"), reply("b"), user("C"), reply("c")];
    const box = (fields: Partial<ComposerBox> = {}): ComposerBox => ({ ...idle, entries, ...fields });
    /** The box once `action`, a recall, applied, the caret at the end as a recall puts it. */
    const after = (action: KeyAction, base: ComposerBox = box()): ComposerBox => {
      if (action.type !== "recall") throw new Error(`expected a recall, got ${action.type}`);
      const { text, caret } = action.draft;
      return { ...base, text, selectionStart: caret, selectionEnd: caret, recalled: action.place };
    };
    /** What each key in `keys` does from `start`: the box's text after a recall, else what happened. */
    const texts = (start: ComposerBox, keys: string[]): string[] => {
      const seen: string[] = [];
      let current = start;
      for (const name of keys) {
        const action = composerKeyAction(key(name), undefined, current);
        if (action.type === "keep") seen.push("(kept)");
        else if (action.type === "none") {
          // The default behavior moves the caret to the first line's start or the last line's end.
          const caret = name === "ArrowUp" ? 0 : current.text.length;
          current = { ...current, selectionStart: caret, selectionEnd: caret };
          seen.push("(default)");
        } else {
          current = after(action, current);
          seen.push(current.text);
        }
      }
      return seen;
    };

    test("ArrowUp in a blank box recalls the newest message, the caret at its end, whitespace replaced", () => {
      const action = composerKeyAction(
        key("ArrowUp"),
        undefined,
        box({ text: "  \n ", selectionStart: 2, selectionEnd: 2 }),
      );
      expect(action).toEqual({
        type: "recall",
        draft: { text: "C", caret: 1, picked: [] },
        place: { conversationId: "c1", index: 4, text: "C" },
      });
    });

    test("repeated ArrowUp goes older and stops at the oldest; ArrowDown goes newer, then empties the box", () => {
      const keys = ["ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowDown"];
      expect(texts(box(), keys)).toEqual(["C", "b1\nb2", "(default)", "A", "(kept)", "b1\nb2", "C", ""]);
      const emptied = composerKeyAction(
        key("ArrowDown"),
        undefined,
        after(composerKeyAction(key("ArrowUp"), undefined, box())),
      );
      expect(emptied).toEqual({ type: "recall", draft: { text: "", caret: 0, picked: [] }, place: undefined });
    });

    test("an empty list and ArrowDown in a blank box keep the default", () => {
      expect(composerKeyAction(key("ArrowUp"), undefined, box({ entries: [reply("only a reply")] }))).toEqual({
        type: "none",
      });
      expect(composerKeyAction(key("ArrowDown"), undefined, box())).toEqual({ type: "none" });
    });

    test("consecutive identical messages count once, the newest giving the mentions", () => {
      const mention: MentionResult = { path: "a.ts", kind: "file", status: "attached", lines: 1 };
      const repeated = [user("X"), user("Go on"), reply("1"), user("Go on", [mention]), reply("2")];
      expect(texts(box({ entries: repeated }), ["ArrowUp", "ArrowUp", "ArrowUp"])).toEqual(["Go on", "X", "(kept)"]);
      const newest = composerKeyAction(key("ArrowUp"), undefined, box({ entries: repeated }));
      expect(newest).toMatchObject({ draft: { picked: ["a.ts"] }, place: { index: 3 } });
    });

    test("with messages A, B, A, three ArrowUp give A, B, A and a fourth changes nothing", () => {
      const aba = [user("A"), reply("1"), user("B"), reply("2"), user("A"), reply("3")];
      expect(texts(box({ entries: aba }), ["ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp"])).toEqual([
        "A",
        "B",
        "A",
        "(kept)",
      ]);
    });

    test("an open menu with rows and a composition take precedence", () => {
      expect(composerKeyAction(key("ArrowUp"), 2, box())).toEqual({ type: "move", step: -1 });
      expect(composerKeyAction(key("ArrowUp", { composing: true }), undefined, box())).toEqual({ type: "none" });
      const recalled = after(composerKeyAction(key("ArrowUp"), undefined, box()));
      expect(composerKeyAction(key("ArrowUp"), 2, recalled)).toEqual({ type: "move", step: -1 });
      expect(composerKeyAction(key("ArrowDown", { composing: true }), undefined, recalled)).toEqual({ type: "none" });
    });

    test("Shift, Alt, Control, or Meta held keeps the default", () => {
      const recalled = after(composerKeyAction(key("ArrowUp"), undefined, box()));
      for (const modifier of ["shift", "alt", "control", "meta"] as const) {
        expect(composerKeyAction(key("ArrowUp", { [modifier]: true }), undefined, box())).toEqual({ type: "none" });
        expect(composerKeyAction(key("ArrowUp", { [modifier]: true }), undefined, recalled)).toEqual({ type: "none" });
        expect(composerKeyAction(key("ArrowDown", { [modifier]: true }), undefined, recalled)).toEqual({
          type: "none",
        });
      }
    });

    test("a range selection keeps the default", () => {
      const recalled = after(composerKeyAction(key("ArrowUp"), undefined, box()));
      expect(composerKeyAction(key("ArrowUp"), undefined, { ...recalled, selectionStart: 0 })).toEqual({
        type: "none",
      });
      expect(composerKeyAction(key("ArrowDown"), undefined, { ...recalled, selectionStart: 0 })).toEqual({
        type: "none",
      });
    });

    test("a multi-line text needs the caret on its first line for ArrowUp and on its last line for ArrowDown", () => {
      const twoLines = after(
        composerKeyAction(key("ArrowUp"), undefined, after(composerKeyAction(key("ArrowUp"), undefined, box()))),
      );
      expect(twoLines.text).toBe("b1\nb2");
      const at = (caret: number) => ({ ...twoLines, selectionStart: caret, selectionEnd: caret });
      expect(composerKeyAction(key("ArrowUp"), undefined, at(5))).toEqual({ type: "none" });
      expect(composerKeyAction(key("ArrowUp"), undefined, at(2))).toMatchObject({ draft: { text: "A" } });
      expect(composerKeyAction(key("ArrowDown"), undefined, at(2))).toEqual({ type: "none" });
      expect(composerKeyAction(key("ArrowDown"), undefined, at(3))).toMatchObject({ draft: { text: "C" } });
    });

    test("a box whose text differs from the recalled message keeps the default, and an equal text resumes", () => {
      const recalled = after(composerKeyAction(key("ArrowUp"), undefined, box()));
      const edited = { ...recalled, text: "Cx", selectionStart: 2, selectionEnd: 2 };
      expect(composerKeyAction(key("ArrowUp"), undefined, edited)).toEqual({ type: "none" });
      expect(composerKeyAction(key("ArrowDown"), undefined, edited)).toEqual({ type: "none" });
      expect(composerKeyAction(key("ArrowUp"), undefined, recalled)).toMatchObject({ draft: { text: "b1\nb2" } });
    });

    test("a box erased by hand during a recall starts again from the newest message", () => {
      const older = after(
        composerKeyAction(key("ArrowUp"), undefined, after(composerKeyAction(key("ArrowUp"), undefined, box()))),
      );
      const erased = { ...older, text: "", selectionStart: 0, selectionEnd: 0 };
      expect(composerKeyAction(key("ArrowUp"), undefined, erased)).toMatchObject({ draft: { text: "C" } });
    });

    test("a recalled message removed from the entries, or another conversation shown, ends the recall", () => {
      const recalled = after(composerKeyAction(key("ArrowUp"), undefined, box()));
      const place = recalled.recalled;
      if (!place) throw new Error("expected a place");
      const state = { conversationId: "c1", entries };
      expect(recallHolds(place, state)).toBe(true);
      expect(recallHolds(place, { ...state, entries: entries.slice(0, 4) })).toBe(false);
      expect(recallHolds(place, { ...state, entries: [...entries.slice(0, 4), user("D")] })).toBe(false);
      expect(recallHolds(place, { ...state, conversationId: "c2" })).toBe(false);
      expect(composerKeyAction(key("ArrowUp"), undefined, { ...recalled, entries: entries.slice(0, 4) })).toEqual({
        type: "none",
      });
    });

    test("the picked paths are those Edit computes for the message, replace the box's, and clear when emptied", () => {
      const mentions: MentionResult[] = [
        { path: "my app.ts", kind: "file", status: "attached", lines: 3 },
        { path: "problems", kind: "problems", status: "noProblems" },
      ];
      const message = user("Fix this problem in @my app.ts, at line 12", mentions);
      const withMention = [message, reply("done"), user("plain"), reply("ok")];
      const start = box({ entries: withMention });
      const plain = after(composerKeyAction(key("ArrowUp"), undefined, start), start);
      expect(plain.text).toBe("plain");
      const action = composerKeyAction(key("ArrowUp"), undefined, plain);
      if (action.type !== "recall" || message.role !== "user") throw new Error("expected a recall");
      expect(action.draft).toEqual(applyDraft({ text: "", caret: 0, picked: [] }, editDraft(message)));
      expect(action.draft.picked).toEqual(["my app.ts"]);
      const back = after(composerKeyAction(key("ArrowDown"), undefined, after(action, plain)), plain);
      expect(composerKeyAction(key("ArrowDown"), undefined, back)).toMatchObject({ draft: { picked: [] } });
    });
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

describe("slashPick", () => {
  test("a built-in row runs its command when Send would act, and inserts /<name> and a space otherwise", () => {
    const row = { name: "new", description: "Start", builtIn: "new" as const };
    expect(slashPick(row, true, "")).toEqual({ type: "run", command: "new" });
    expect(slashPick({ ...row, name: "model", builtIn: "model" }, true, " \n")).toEqual({
      type: "run",
      command: "model",
    });
    expect(slashPick(row, false, "")).toEqual({ type: "insert", text: "/new " });
  });

  test("a built-in row inserts /<name> and a space when text follows the token, which running would discard", () => {
    const row = { name: "new", description: "Start", builtIn: "new" as const };
    expect(slashPick(row, true, " keep this draft")).toEqual({ type: "insert", text: "/new " });
  });

  test("a skill row inserts /<name> and a space for its arguments, even one named as a built-in", () => {
    const grilling = { name: "grilling", description: "Grill" };
    expect(slashPick(grilling, true, "")).toEqual({ type: "insert", text: "/grilling " });
    expect(slashPick({ name: "new", description: "A skill" }, true, "")).toEqual({ type: "insert", text: "/new " });
  });
});

describe("replaceToken", () => {
  test("replaces the token up to the caret and puts the caret after the inserted text", () => {
    expect(replaceToken("/gr", { start: 0 }, 3, "/grilling ")).toEqual({ text: "/grilling ", caret: 10 });
    expect(replaceToken("see @sr now", { start: 4 }, 7, "@src/ ")).toEqual({ text: "see @src/  now", caret: 10 });
  });
});

describe("applyDraft", () => {
  test("a focus draft leaves the text, the caret, and the picked paths as they are", () => {
    const draft = { text: "half typed", caret: 4, picked: ["a.ts"] };
    expect(applyDraft(draft, { text: "", mode: "focus", picked: [] })).toBe(draft);
  });

  /** The draft `marked`, its caret at `|`, after inserting `@selection` at the caret. */
  const atCaret = (marked: string): string => {
    const caret = marked.indexOf("|");
    const draft = { text: marked.replace("|", ""), caret, picked: [] };
    const next = applyDraft(draft, { text: "@selection", mode: "caret", picked: [] });
    return `${next.text.slice(0, next.caret)}|${next.text.slice(next.caret)}`;
  };

  test("inserts at the caret, with a space before it when the text before does not end with whitespace", () => {
    expect(atCaret("|")).toBe("@selection |");
    expect(atCaret("foo|")).toBe("foo @selection |");
    expect(atCaret("foo |")).toBe("foo @selection |");
    expect(atCaret("foo\n|")).toBe("foo\n@selection |");
  });

  test("adds a space after it only when the character after the caret is not whitespace", () => {
    expect(atCaret("foo|bar")).toBe("foo @selection |bar");
    // [>]: The caret goes past the space already there, so it follows a space and no menu opens.
    expect(atCaret("foo| bar")).toBe("foo @selection |bar");
    expect(atCaret("|bar")).toBe("@selection |bar");
  });

  test("a paragraph fills a blank box, else follows the text after a blank line, caret at the end", () => {
    const insert: DraftInsert = { text: "B\n\nC", mode: "paragraph", picked: ["c d.ts"] };
    expect(applyDraft({ text: " \n", caret: 1, picked: [] }, insert)).toEqual({
      text: "B\n\nC",
      caret: 4,
      picked: ["c d.ts"],
    });
    expect(applyDraft({ text: "foo", caret: 1, picked: ["a.ts"] }, insert)).toEqual({
      text: "foo\n\nB\n\nC",
      caret: 9,
      picked: ["a.ts", "c d.ts"],
    });
  });

  test("fills a box that is empty or holds only whitespace, caret at the end", () => {
    const insert: DraftInsert = { text: "Fix this problem", mode: "fillOrAppend", picked: [] };
    expect(applyDraft({ text: "", caret: 0, picked: [] }, insert)).toEqual({
      text: "Fix this problem",
      caret: 16,
      picked: [],
    });
    expect(applyDraft({ text: " \n\t", caret: 1, picked: [] }, insert).text).toBe("Fix this problem");
  });

  test("appends after one line break to a box holding a draft, caret at the end", () => {
    const next = applyDraft(
      { text: "First draft", caret: 2, picked: [] },
      { text: "Fix it", mode: "fillOrAppend", picked: [] },
    );
    expect(next).toEqual({ text: "First draft\nFix it", caret: 18, picked: [] });
  });

  test("adds the inserted picked paths to the box's, once", () => {
    const next = applyDraft(
      { text: "see @a b.ts", caret: 11, picked: ["a b.ts"] },
      { text: "Fix this problem in @src/app.ts at line 12: Broken.", mode: "fillOrAppend", picked: ["src/app.ts"] },
    );
    expect(next.picked).toEqual(["a b.ts", "src/app.ts"]);
    const again = applyDraft(next, { text: "@src/app.ts", mode: "caret", picked: ["src/app.ts"] });
    expect(again.picked).toEqual(["a b.ts", "src/app.ts"]);
  });
});

describe("editDraft", () => {
  const entry = {
    role: "user" as const,
    content: "fix @src/a b.ts in @lib with @problems and @./diff",
    mentions: [
      { path: "src/a b.ts", kind: "file" as const, status: "attached" as const, lines: 3 },
      { path: "lib", kind: "folder" as const, status: "attached" as const, lines: 2 },
      { path: "problems", kind: "problems" as const, status: "noProblems" as const },
      { path: "./diff", kind: "file" as const, status: "missing" as const },
    ],
  };

  test("fills a blank box with the text as typed, the file and folder paths picked, not the reserved mentions", () => {
    expect(applyDraft({ text: "  ", caret: 0, picked: [] }, editDraft(entry))).toEqual({
      text: entry.content,
      caret: entry.content.length,
      picked: ["src/a b.ts", "lib", "./diff"],
    });
  });

  test("follows a draft after a blank line, keeping its picked paths", () => {
    expect(applyDraft({ text: "draft @x y.ts", caret: 2, picked: ["x y.ts"] }, editDraft(entry))).toEqual({
      text: `draft @x y.ts\n\n${entry.content}`,
      caret: 15 + entry.content.length,
      picked: ["x y.ts", "src/a b.ts", "lib", "./diff"],
    });
  });
});

describe("stillReplacing", () => {
  const question: ChatEntry = { role: "user", content: "Do it", mentions: [] };
  const reply = (status: "done" | "waiting"): ChatEntry => ({ role: "assistant", reasoning: "", content: "", status });
  const state = (entries: ChatEntry[], conversationId = "c1") => ({ conversationId, entries }) as unknown as ChatState;
  const replacing = { conversationId: "c1", entries: 2 };

  test("holds for the same conversation and entries count while Edit is offered", () => {
    expect(stillReplacing(replacing, state([question, reply("done")]))).toBe(true);
  });

  test("fails for another conversation, another count, a reply in flight, or a completed summary after the message", () => {
    expect(stillReplacing(replacing, state([question, reply("done")], "c2"))).toBe(false);
    expect(stillReplacing(replacing, state([question, reply("done"), question, reply("done")]))).toBe(false);
    expect(stillReplacing(replacing, state([question, reply("waiting")]))).toBe(false);
    const summary: ChatEntry = { role: "assistant", reasoning: "", content: "S.", status: "done", summary: true };
    expect(stillReplacing({ ...replacing, entries: 3 }, state([question, reply("done"), summary]))).toBe(false);
  });
});

describe("quoteDraft", () => {
  const quoted = (box: string, selected: string) => quoteDraft({ text: box, caret: 0, picked: [] }, selected);

  test.each([
    ["an empty box", "", "a\nb", "> a\n> b\n\n"],
    ["a box holding text", "hello", "a", "hello\n\n> a\n\n"],
    ["a box ending with a line break", "hello\n", "a", "hello\n\n> a\n\n"],
    ["a box holding only whitespace", " \n\t", "a", "> a\n\n"],
    ["a box holding a first quote", "> a\n\n", "b", "> a\n\n> b\n\n"],
    ["an empty box, a blank line inside the selection", "", "a\n\nb", "> a\n>\n> b\n\n"],
    ["an empty box, a triple click's trailing blank lines", "", "a\n\n", "> a\n\n"],
  ])("%s", (_case, box, selected, expected) => {
    expect(quoted(box, selected)).toEqual({ text: expected, caret: expected.length, picked: [] });
  });

  test("a whitespace-only inner line becomes `>` alone", () => {
    expect(quoted("", "a\n  \nb").text).toBe("> a\n>\n> b\n\n");
  });

  test("keeps the picked paths", () => {
    expect(quoteDraft({ text: "see @a b.ts", caret: 3, picked: ["a b.ts"] }, "x").picked).toEqual(["a b.ts"]);
  });
});
