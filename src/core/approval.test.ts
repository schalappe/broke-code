import { describe, expect, test } from "bun:test";
import { autoApproveWrites, CHANGE_SCHEME, closeChangeDiffs, hasUnsavedChanges, type OpenDocument } from "./approval";

/** A URI as the editor gives it: a scheme and its string form. */
const uri = (scheme: string, path: string) => ({ scheme, toString: () => `${scheme}:${path}` });

type Tab = { label: string; proposed?: ReturnType<typeof uri> };

const tabs: Tab[] = [
  { label: "first", proposed: uri(CHANGE_SCHEME, "/1/proposed/a.ts") },
  { label: "second", proposed: uri(CHANGE_SCHEME, "/2/proposed/b.ts") },
  { label: "other diff", proposed: uri("file", "/work/a.ts") },
  { label: "editor" },
];

/** The labels of the tabs `closeChangeDiffs` closes over `tabs`, or `undefined` when it closes nothing. */
async function closed(proposed?: ReturnType<typeof uri>): Promise<string[] | undefined> {
  let closing: Tab[] | undefined;
  await closeChangeDiffs(
    tabs,
    (tab) => tab.proposed,
    async (found) => {
      closing = found;
    },
    proposed,
  );
  return closing?.map((tab) => tab.label);
}

describe("closeChangeDiffs", () => {
  test("closing a preview closes only the diff whose proposed side is its own", async () => {
    expect(await closed(uri(CHANGE_SCHEME, "/2/proposed/b.ts"))).toEqual(["second"]);
  });

  test("without a preview, closes every change diff and no other diff or tab", async () => {
    expect(await closed()).toEqual(["first", "second"]);
  });

  test("a tab without a proposed side never matches, even for its own text", async () => {
    expect(await closed(uri("file", "/work/a.ts"))).toEqual(["other diff"]);
  });

  test("closes nothing when no tab matches", async () => {
    expect(await closed(uri(CHANGE_SCHEME, "/9/proposed/gone.ts"))).toBeUndefined();
  });
});

describe("hasUnsavedChanges", () => {
  const document = (path: string, isDirty: boolean, scheme = "file"): OpenDocument => ({
    isDirty,
    uri: { scheme, fsPath: path },
  });
  /** Resolves `/link/...` to `/real/...`, as a symlinked folder would, and leaves other paths alone. */
  const resolve = async (path: string) => path.replace(/^\/link\//, "/real/");

  test("is false when no document is dirty, without resolving any path", async () => {
    const resolved: string[] = [];
    const tracking = async (path: string) => {
      resolved.push(path);
      return path;
    };
    expect(await hasUnsavedChanges([document("/real/a.ts", false)], "/real/a.ts", tracking)).toBe(false);
    expect(resolved).toEqual([]);
  });

  test("is true for a dirty file document whose resolved path is the resolved target", async () => {
    expect(await hasUnsavedChanges([document("/link/a.ts", true)], "/real/a.ts", resolve)).toBe(true);
    expect(await hasUnsavedChanges([document("/real/a.ts", true)], "/link/a.ts", resolve)).toBe(true);
  });

  test("is false for a dirty document of another file", async () => {
    expect(await hasUnsavedChanges([document("/real/b.ts", true)], "/real/a.ts", resolve)).toBe(false);
  });

  test("counts only dirty documents of the file scheme", async () => {
    const untitled = document("/real/a.ts", true, "untitled");
    const clean = document("/real/a.ts", false);
    expect(await hasUnsavedChanges([untitled, clean], "/real/a.ts", resolve)).toBe(false);
    expect(await hasUnsavedChanges([untitled, clean, document("/real/a.ts", true)], "/real/a.ts", resolve)).toBe(true);
  });
});

describe("autoApproveWrites", () => {
  test("is on only for a user setting of true", () => {
    expect(autoApproveWrites({ globalValue: true })).toBe(true);
  });

  test("stays off for a workspace value of true, no value, false, or a value that is not a boolean", () => {
    expect(autoApproveWrites({ workspaceValue: true })).toBe(false);
    expect(autoApproveWrites({ workspaceFolderValue: true })).toBe(false);
    expect(autoApproveWrites(undefined)).toBe(false);
    expect(autoApproveWrites({})).toBe(false);
    expect(autoApproveWrites({ globalValue: false })).toBe(false);
    expect(autoApproveWrites({ globalValue: "true" })).toBe(false);
  });
});
