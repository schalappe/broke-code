import { describe, expect, test } from "bun:test";
import { type DiffReader, type FolderDiff, readDiff } from "./diff";
import { formatMention } from "./mentions";
import type { WorkspaceRoot } from "./workspaceFiles";

const app: WorkspaceRoot = { name: "app", path: "/w/app" };
const lib: WorkspaceRoot = { name: "lib", path: "/w/lib" };

const PATCH = [
  "diff --git a/f.txt b/f.txt",
  "index de98044..2493845 100644",
  "--- a/f.txt",
  "+++ b/f.txt",
  "@@ -1,3 +1,3 @@",
  "-a",
  "+A",
  " b",
  "-c",
  "",
].join("\n");

/** A port answering `folders` for whatever roots it is asked about. */
const port = (...folders: FolderDiff[]): DiffReader => ({ read: async () => ({ kind: "read", folders }) });

describe("readDiff", () => {
  test("attaches one folder's diff under a header counting its lines, in a fence", async () => {
    const mention = await readDiff([app], port({ kind: "diff", text: PATCH }));
    expect(mention).toMatchObject({ path: "diff", kind: "diff", status: "attached", lines: 9 });
    expect(formatMention(mention)).toBe(`@diff (diff, 9 lines)\n\`\`\`\n${PATCH}\`\`\``);
  });

  test("counts one line in the singular", async () => {
    expect(formatMention(await readDiff([app], port({ kind: "diff", text: "+x\n" })))).toBe(
      "@diff (diff, 1 line)\n```\n+x\n```",
    );
  });

  test("leads each folder's diff with its name in a multi-root workspace, leaving out folders with nothing", async () => {
    const other: WorkspaceRoot = { name: "docs", path: "/w/docs" };
    const mention = await readDiff(
      [app, other, lib],
      port({ kind: "diff", text: "+a\n" }, { kind: "diff", text: "" }, { kind: "diff", text: "+b\n" }),
    );
    expect(mention.content).toBe("# app\n+a\n# lib\n+b\n");
    expect(mention.lines).toBe(4);
  });

  test("attaches as soon as one folder has a diff, a folder without a repository left out", async () => {
    const mention = await readDiff([app, lib], port({ kind: "noRepository" }, { kind: "diff", text: "+b\n" }));
    expect(mention).toMatchObject({ status: "attached", content: "# lib\n+b\n" });
  });

  test("attaches nothing when no tracked file differs from HEAD, saying so, as noChanges", async () => {
    const mention = await readDiff([app, lib], port({ kind: "diff", text: "" }, { kind: "noRepository" }));
    expect(mention).toEqual({ path: "diff", kind: "diff", status: "noChanges", content: "", omitted: 0 });
    expect(formatMention(mention)).toBe("@diff (diff, noChanges)\nNot attached: no tracked file differs from HEAD.");
  });

  test("reports noRepository when no workspace folder is in a git repository", async () => {
    const mention = await readDiff([app, lib], port({ kind: "noRepository" }, { kind: "noRepository" }));
    expect(mention).toMatchObject({ status: "noRepository" });
    expect(formatMention(mention)).toBe(
      "@diff (diff, noRepository)\nNot attached: no workspace folder is a git repository.",
    );
  });

  test("reports noRepository without a workspace folder", async () => {
    expect(await readDiff([], port())).toMatchObject({ status: "noRepository" });
  });

  test("reports gitUnavailable when the Git extension is missing or disabled", async () => {
    const mention = await readDiff([app], { read: async () => ({ kind: "gitUnavailable" }) });
    expect(mention).toMatchObject({ status: "gitUnavailable" });
    expect(formatMention(mention)).toBe("@diff (diff, gitUnavailable)\nNot attached: git is not available in VS Code.");
  });

  test("reports a folder whose diff fails unreadable with its cause when no folder has a diff", async () => {
    const mention = await readDiff([app], port({ kind: "failed", cause: "fatal: bad revision 'HEAD'" }));
    expect(mention).toMatchObject({ status: "unreadable", cause: "fatal: bad revision 'HEAD'" });
    expect(formatMention(mention)).toBe(
      "@diff (diff, unreadable)\nNot attached: the diff could not be read (fatal: bad revision 'HEAD').",
    );
    const none = await readDiff([app, lib], port({ kind: "diff", text: "" }, { kind: "failed", cause: "boom" }));
    expect(none).toMatchObject({ status: "unreadable", cause: "lib: boom" });
  });

  test("attaches the readable diffs beside a failed folder, one line per failed folder below the block", async () => {
    const docs: WorkspaceRoot = { name: "docs", path: "/w/docs" };
    const mention = await readDiff(
      [app, docs, lib],
      port({ kind: "diff", text: "+a\n" }, { kind: "failed", cause: "boom" }, { kind: "failed", cause: "bad HEAD" }),
    );
    expect(mention).toMatchObject({ status: "attached", lines: 2, content: "# app\n+a\n", failedFolders: 2 });
    expect(formatMention(mention)).toBe(
      [
        "@diff (diff, 2 lines)",
        "```",
        "# app",
        "+a",
        "```",
        "Not attached for docs: the diff could not be read (boom).",
        "Not attached for lib: the diff could not be read (bad HEAD).",
      ].join("\n"),
    );
  });

  test("puts the failed folders' lines after the truncation notice of a cut diff", async () => {
    const text = Array.from({ length: 2001 }, (_, line) => `+line ${line + 1}\n`).join("");
    const mention = await readDiff([app, lib], port({ kind: "diff", text }, { kind: "failed", cause: "boom" }));
    expect(mention).toMatchObject({ status: "truncated", failedFolders: 1 });
    expect(
      formatMention(mention).endsWith(
        "```\n[truncated: 2 more lines not shown]\nNot attached for lib: the diff could not be read (boom).",
      ),
    ).toBe(true);
  });

  test("reports a failing port unreadable with its cause", async () => {
    const mention = await readDiff([app], {
      read: async () => {
        throw new Error("no git");
      },
    });
    expect(mention).toMatchObject({ status: "unreadable", cause: "no git" });
  });

  test("cuts over 2,000 lines with the truncation notice", async () => {
    const text = Array.from({ length: 2003 }, (_, line) => `+line ${line + 1}\n`).join("");
    const mention = await readDiff([app], port({ kind: "diff", text }));
    expect(mention).toMatchObject({ status: "truncated", lines: 2000, omitted: 3 });
    const block = formatMention(mention);
    expect(block.startsWith("@diff (diff, 2000 lines, truncated)\n```\n+line 1\n")).toBe(true);
    expect(block.endsWith("+line 2000\n```\n[truncated: 3 more lines not shown]")).toBe(true);
  });

  test("cuts over 1 MiB between characters, never refused, the cut line counted as not shown", async () => {
    // Each line holds about 96,000 bytes: ten fit in 1 MiB, the eleventh is cut between two characters.
    const text = `${Array.from({ length: 12 }, () => `+${"€".repeat(32_000)}`).join("\n")}\n`;
    const mention = await readDiff([app], port({ kind: "diff", text }));
    expect(mention).toMatchObject({ status: "truncated", lines: 10, omitted: 2 });
    expect(Buffer.byteLength(mention.content)).toBeLessThanOrEqual(1024 * 1024);
    expect(mention.content.endsWith("€")).toBe(true);
  });
});
