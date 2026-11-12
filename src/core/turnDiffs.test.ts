import { describe, expect, test } from "bun:test";
import { CHANGE_SCHEME } from "./approval";
import { BEFORE_TURN_SCHEME, closeTurnDiffs } from "./turnDiffs";

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
