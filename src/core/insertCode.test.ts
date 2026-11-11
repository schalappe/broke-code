import { describe, expect, test } from "bun:test";
import { type InsertEditor, insertCode } from "./insertCode";

const french = { t: (message: string, ...args: (string | number | boolean)[]) => `fr:${message}${args.join(",")}` };

/** A selection of the fake editor: `[start, end)` offsets into its text, in document order. */
type Range = { start: number; end: number };

/**
 * An editor over `text` with `selections`. `refuse`: its edits resolve `false`, as a version mismatch does. `ignore`:
 * its edits resolve `true` and change nothing, as VS Code's do on a read-only document. Each applied `edit` call is one
 * undo stop and one version, so `edits` counts them; the replacements of one edit apply together.
 */
function fakeEditor(
  text: string,
  selections: Range[],
  options: { refuse?: boolean; ignore?: boolean; fail?: Error } = {},
) {
  const document = { text, edits: 0 };
  const editor: InsertEditor<Range> = {
    selections,
    document: {
      get version() {
        return document.edits + 1;
      },
      getText: (range) => document.text.slice(range.start, range.end),
    },
    edit: async (callback) => {
      const replacements: { range: Range; value: string }[] = [];
      callback({ replace: (range, value) => replacements.push({ range, value }) });
      if (options.fail) throw options.fail;
      if (options.refuse) return false;
      if (options.ignore) return true;
      document.edits++;
      for (const { range, value } of [...replacements].sort((a, b) => b.range.start - a.range.start)) {
        document.text = document.text.slice(0, range.start) + value + document.text.slice(range.end);
      }
      return true;
    },
  };
  return { editor, document };
}

function recordingErrors() {
  const errors: string[] = [];
  return { errors, showError: (message: string) => errors.push(message) };
}

describe("insertCode", () => {
  test("replaces every selection with the text in one edit, inserting at an empty one", async () => {
    const { editor, document } = fakeEditor("one two three", [
      { start: 0, end: 3 },
      { start: 8, end: 13 },
      { start: 4, end: 4 },
    ]);
    const { errors, showError } = recordingErrors();
    expect(await insertCode("X", { activeEditor: () => editor, showError }, french)).toBe("done");
    expect(document.text).toBe("X Xtwo X");
    expect(document.edits).toBe(1);
    expect(errors).toEqual([]);
  });

  test("without an active text editor, says so and changes nothing", async () => {
    const { errors, showError } = recordingErrors();
    expect(await insertCode("X", { activeEditor: () => undefined, showError }, french)).toBe("noEditor");
    expect(errors).toEqual(["fr:No text editor is active: open a file to insert the code."]);
  });

  test("an edit the editor refuses says so and changes nothing", async () => {
    const { editor, document } = fakeEditor("read only", [{ start: 0, end: 4 }], { refuse: true });
    const { errors, showError } = recordingErrors();
    expect(await insertCode("X", { activeEditor: () => editor, showError }, french)).toBe("refused");
    expect(document.text).toBe("read only");
    expect(document.edits).toBe(0);
    expect(errors).toEqual(["fr:The editor refused the edit; its document may be read-only."]);
  });

  test("an edit the editor accepts but leaves unapplied, as on a read-only document, says so", async () => {
    const { editor, document } = fakeEditor("read only", [{ start: 0, end: 4 }], { ignore: true });
    const { errors, showError } = recordingErrors();
    expect(await insertCode("X", { activeEditor: () => editor, showError }, french)).toBe("refused");
    expect(document.text).toBe("read only");
    expect(errors).toEqual(["fr:The editor refused the edit; its document may be read-only."]);
  });

  test("an unapplied edit where every selection already holds the text is done, and shows nothing", async () => {
    const { editor } = fakeEditor(
      "X and X",
      [
        { start: 0, end: 1 },
        { start: 6, end: 7 },
      ],
      { ignore: true },
    );
    const { errors, showError } = recordingErrors();
    expect(await insertCode("X", { activeEditor: () => editor, showError }, french)).toBe("done");
    expect(errors).toEqual([]);
  });

  test("an unapplied edit where only some selections hold the text is refused", async () => {
    const { editor } = fakeEditor(
      "X and Y",
      [
        { start: 0, end: 1 },
        { start: 6, end: 7 },
      ],
      { ignore: true },
    );
    const { errors, showError } = recordingErrors();
    expect(await insertCode("X", { activeEditor: () => editor, showError }, french)).toBe("refused");
    expect(errors).toHaveLength(1);
  });

  test("an edit that throws is shown with its cause, never as a refusal", async () => {
    const { editor, document } = fakeEditor("text", [{ start: 0, end: 0 }], { fail: new Error("closed editor") });
    const { errors, showError } = recordingErrors();
    expect(await insertCode("X", { activeEditor: () => editor, showError }, french)).toBe("failed");
    expect(document.text).toBe("text");
    expect(errors).toEqual(["fr:Could not insert the code: {0}Error: closed editor"]);
  });
});
