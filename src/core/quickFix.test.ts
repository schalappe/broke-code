import { describe, expect, test } from "bun:test";
import type { Diagnostic } from "./problems";
import { fixDraft, parseDiagnostic } from "./quickFix";
import type { WorkspaceRoot } from "./workspaceFiles";

const root: WorkspaceRoot = { name: "app", path: "/w/app" };

const typeError: Diagnostic = {
  scheme: "file",
  path: "/w/app/src/app.ts",
  line: 11,
  character: 4,
  severity: "error",
  message: "Type 'string' is not assignable to type 'number'.",
  source: "ts",
};

describe("fixDraft", () => {
  test("asks to fix the problem at its 1-based line, the file picked", () => {
    expect(fixDraft([root], typeError)).toEqual({
      text: "Fix this problem in @src/app.ts at line 12: Type 'string' is not assignable to type 'number'.",
      mode: "fillOrAppend",
      picked: ["src/app.ts"],
    });
  });

  test("offers a warning too", () => {
    expect(fixDraft([root], { ...typeError, severity: "warning" })?.text).toStartWith(
      "Fix this problem in @src/app.ts",
    );
  });

  test("names a file called like a reserved mention ./<name>", () => {
    const draft = fixDraft([root], { ...typeError, path: "/w/app/problems", line: 0 });
    expect(draft?.text).toStartWith("Fix this problem in @./problems at line 1: ");
    expect(draft?.picked).toEqual(["./problems"]);
  });

  test("leads the path with its folder name in a multi-root workspace", () => {
    const draft = fixDraft([root, { name: "lib", path: "/w/lib" }], { ...typeError, path: "/w/lib/a b.ts" });
    expect(draft?.text).toStartWith("Fix this problem in @lib/a b.ts at line 12: ");
    expect(draft?.picked).toEqual(["lib/a b.ts"]);
  });

  test("writes each line break of the message as a space", () => {
    const draft = fixDraft([root], { ...typeError, message: "First.\nSecond.\r\nThird.\rFourth." });
    expect(draft?.text).toEndWith("at line 12: First. Second. Third. Fourth.");
  });

  test("gives no draft for information, hints, another scheme, or a file outside the workspace", () => {
    expect(fixDraft([root], { ...typeError, severity: "information" })).toBeUndefined();
    expect(fixDraft([root], { ...typeError, severity: "hint" })).toBeUndefined();
    expect(fixDraft([root], { ...typeError, scheme: "untitled" })).toBeUndefined();
    expect(fixDraft([root], { ...typeError, path: "/w/other/app.ts" })).toBeUndefined();
    expect(fixDraft([], typeError)).toBeUndefined();
  });
});

describe("parseDiagnostic", () => {
  test("accepts the record the code action carries", () => {
    expect(parseDiagnostic(typeError)).toEqual(typeError);
    const { source: _, ...withoutSource } = typeError;
    expect(parseDiagnostic(withoutSource)).toEqual(withoutSource);
  });

  test("refuses any other shape, since any extension can run the command", () => {
    for (const raw of [
      undefined,
      null,
      "src/app.ts",
      { ...typeError, scheme: 1 },
      { ...typeError, path: undefined },
      { ...typeError, line: -1 },
      { ...typeError, line: 1.5 },
      { ...typeError, character: "4" },
      { ...typeError, severity: "fatal" },
      { ...typeError, message: undefined },
      { ...typeError, source: 2 },
    ]) {
      expect(parseDiagnostic(raw)).toBeUndefined();
    }
  });
});
