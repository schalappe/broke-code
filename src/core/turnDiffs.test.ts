import { describe, expect, spyOn, test } from "bun:test";
import { CHANGE_SCHEME } from "./approval";
import { BEFORE_TURN_SCHEME, closeTurnDiffs, TurnDiffs } from "./turnDiffs";

/** A URI as the editor gives it: a scheme and its string form. */
const uri = (scheme: string, path: string) => ({ scheme, toString: () => `${scheme}:${path}` });

type Tab = { label: string; original?: ReturnType<typeof uri> };

const tabs: Tab[] = [
  { label: "a", original: uri(BEFORE_TURN_SCHEME, "/1/a.ts") },
  { label: "b", original: uri(BEFORE_TURN_SCHEME, "/2/b.ts") },
  { label: "approval", original: uri(CHANGE_SCHEME, "/3/planned/a.ts") },
  { label: "git diff", original: uri("git", "/work/a.ts") },
  { label: "editor" },
];

/** The labels of the tabs `closeTurnDiffs` closes over `tabs`, or `undefined` when it closes nothing. */
async function closed(originals?: ReturnType<typeof uri>[]): Promise<string[] | undefined> {
  let closing: Tab[] | undefined;
  await closeTurnDiffs(
    tabs,
    (tab) => tab.original,
    async (found) => {
      closing = found;
    },
    originals,
  );
  return closing?.map((tab) => tab.label);
}

describe("closeTurnDiffs", () => {
  test("closes only the diffs whose left side is one of the given ones", async () => {
    expect(await closed([uri(BEFORE_TURN_SCHEME, "/2/b.ts")])).toEqual(["b"]);
  });

  test("without given sides, closes every changed file's diff and no approval diff or other tab", async () => {
    expect(await closed()).toEqual(["a", "b"]);
  });

  test("closes nothing when no tab matches", async () => {
    expect(await closed([uri(BEFORE_TURN_SCHEME, "/9/gone.ts")])).toBeUndefined();
    expect(await closed([])).toBeUndefined();
  });
});

describe("TurnDiffs", () => {
  type Side = ReturnType<typeof uri>;
  /** A promise settled from outside. */
  function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  /**
   * Turn diffs over a fake editor: `tabs` holds each diff open, its left side and right file; `files` the paths on
   * disk. `checks` and `opens`, when set, hold the existence check and the diff's open until settled from the test.
   */
  function editor() {
    const tabs: { original: Side; realPath: string; title: string }[] = [];
    const files = new Set<string>();
    const errors: string[] = [];
    let made = 0;
    const gates: { check?: Promise<void>; open?: Promise<void> } = {};
    const diffs = new TurnDiffs<Side>(
      {
        isFile: async (path) => {
          await gates.check;
          return files.has(path);
        },
        side: (name) => uri(BEFORE_TURN_SCHEME, `/${++made}/${name}`),
        openDiff: async (original, realPath, title) => {
          await gates.open;
          tabs.push({ original, realPath, title });
        },
        closeDiffs: (originals) =>
          closeTurnDiffs(
            [...tabs],
            (tab) => tab.original,
            async (found) => {
              for (const tab of found) tabs.splice(tabs.indexOf(tab), 1);
            },
            originals,
          ),
        showError: (message) => void errors.push(message),
      },
      { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, at: string) => String(args[Number(at)])) },
    );
    return { diffs, tabs, files, errors, gates };
  }

  const held = { path: "src/a.ts", realPath: "/work/src/a.ts", original: "before\n" };

  test("opens the file's diff, its left side serving the text before the turn, the right side the real file", async () => {
    const { diffs, tabs, files, errors } = editor();
    files.add(held.realPath);
    await diffs.open(held);
    expect(tabs).toEqual([
      { original: tabs[0]!.original, realPath: "/work/src/a.ts", title: "src/a.ts (changes of this turn)" },
    ]);
    expect(tabs[0]!.original.scheme).toBe(BEFORE_TURN_SCHEME);
    expect(diffs.text(tabs[0]!.original)).toBe("before\n");
    expect(errors).toEqual([]);
  });

  test("a created file's left side is empty", async () => {
    const { diffs, tabs, files } = editor();
    files.add(held.realPath);
    await diffs.open({ ...held, original: undefined });
    expect(diffs.text(tabs[0]!.original)).toBe("");
  });

  test("a file no longer on disk opens no diff and says so", async () => {
    const { diffs, tabs, errors } = editor();
    await diffs.open(held);
    expect(tabs).toEqual([]);
    expect(errors).toEqual(["Could not open the changes of src/a.ts: the file no longer exists."]);
  });

  test("a diff that fails to open is shown as an error", async () => {
    const { diffs, tabs, files, errors, gates } = editor();
    files.add(held.realPath);
    gates.open = Promise.reject(new Error("no diff editor"));
    gates.open.catch(() => {});
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await diffs.open(held);
    } finally {
      logged.mockRestore();
    }
    expect(tabs).toEqual([]);
    expect(errors).toEqual(["Could not open the changes of src/a.ts: Error: no diff editor"]);
  });

  test("a second open with the same text reuses its left side; after a close, or with another text, a new one", async () => {
    const { diffs, tabs, files } = editor();
    files.add(held.realPath);
    await diffs.open(held);
    await diffs.open(held);
    expect(tabs[1]!.original.toString()).toBe(tabs[0]!.original.toString());

    diffs.close([held.realPath]);
    await Bun.sleep(0);
    expect(tabs).toEqual([]);
    await diffs.open(held);
    await diffs.open({ ...held, original: "other\n" });
    await Bun.sleep(0);
    // [>]: The first reopen got a new side; the other text replaced it, and its tab closed.
    expect(tabs.map((tab) => tab.original.toString())).toEqual(["broke-code-before-turn:/3/a.ts"]);
    expect(diffs.text(tabs[0]!.original)).toBe("other\n");
  });

  test("close closes only the diffs of the files named, by their left side, and drops their text", async () => {
    const { diffs, tabs, files } = editor();
    const other = { path: "b.ts", realPath: "/work/b.ts", original: "b\n" };
    files.add(held.realPath);
    files.add(other.realPath);
    await diffs.open(held);
    await diffs.open(other);
    const gone = tabs[0]!.original;
    diffs.close([held.realPath]);
    await Bun.sleep(0);
    expect(tabs.map((tab) => tab.realPath)).toEqual(["/work/b.ts"]);
    expect(diffs.text(gone)).toBe("");
  });

  test("close with nothing open closes nothing", async () => {
    const { diffs, tabs, files } = editor();
    files.add(held.realPath);
    await diffs.open(held);
    diffs.close(["/work/never-opened.ts"]);
    diffs.close([]);
    await Bun.sleep(0);
    expect(tabs).toHaveLength(1);
  });

  test("a close during the existence check cancels the open: no diff, no error", async () => {
    const { diffs, tabs, files, errors, gates } = editor();
    files.add(held.realPath);
    const check = deferred<void>();
    gates.check = check.promise;
    const opening = diffs.open(held);
    diffs.close([held.realPath]);
    check.resolve();
    await opening;
    await Bun.sleep(0);
    expect(tabs).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a close while the diff opens closes the tab it opened once it is open", async () => {
    const { diffs, tabs, files, gates } = editor();
    files.add(held.realPath);
    const shown = deferred<void>();
    gates.open = shown.promise;
    const opening = diffs.open(held);
    await Bun.sleep(0);
    diffs.close([held.realPath]);
    shown.resolve();
    await opening;
    await Bun.sleep(0);
    expect(tabs).toEqual([]);
  });

  test("an open after the close is not cancelled by it", async () => {
    const { diffs, tabs, files } = editor();
    files.add(held.realPath);
    diffs.close([held.realPath]);
    await diffs.open(held);
    expect(tabs).toHaveLength(1);
  });

  test("dispose closes every changed file's diff and drops every text", async () => {
    const { diffs, tabs, files } = editor();
    files.add(held.realPath);
    await diffs.open(held);
    const side = tabs[0]!.original;
    diffs.dispose();
    await Bun.sleep(0);
    expect(tabs).toEqual([]);
    expect(diffs.text(side)).toBe("");
  });

  test("dispose during the existence check cancels the open: no diff, no error", async () => {
    const { diffs, tabs, files, errors, gates } = editor();
    files.add(held.realPath);
    const check = deferred<void>();
    gates.check = check.promise;
    const opening = diffs.open(held);
    diffs.dispose();
    check.resolve();
    await opening;
    await Bun.sleep(0);
    expect(tabs).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("dispose while the diff opens closes the tab it opened once it is open", async () => {
    const { diffs, tabs, files, gates } = editor();
    files.add(held.realPath);
    const shown = deferred<void>();
    gates.open = shown.promise;
    const opening = diffs.open(held);
    await Bun.sleep(0);
    diffs.dispose();
    shown.resolve();
    await opening;
    await Bun.sleep(0);
    expect(tabs).toEqual([]);
  });
});
