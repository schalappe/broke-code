import { describe, expect, test } from "bun:test";
import { GENERIC_CALL_SHAPE, type ParsedReply, parseToolCall, replyCut, type ToolSpec } from "./toolCalls";

const TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    description: "Read a file.",
    args: [
      { name: "path", required: true, oneLine: true, description: "The file to read." },
      { name: "start_line", required: false, description: "The first line to read." },
    ],
  },
  {
    name: "write_file",
    description: "Write a file.",
    args: [
      { name: "path", required: true, description: "The file to write." },
      { name: "content", required: true, description: "The whole new content." },
    ],
  },
];

describe("parseToolCall", () => {
  test("returns the tool name and the raw values of a valid call with two arguments", () => {
    const answer = "I will write it.\n<write_file>\n<path>a.txt</path>\n<content>hello</content>\n</write_file>";
    expect(parseToolCall(answer, TOOLS)).toEqual({
      kind: "call",
      name: "write_file",
      args: { path: "a.txt", content: "hello" },
      start: 17,
      end: answer.length,
    });
  });

  test("returns no call for a reply without a tag", () => {
    expect(parseToolCall("The answer is 42.", TOOLS)).toEqual({ kind: "none" });
  });

  test("returns a malformed reply for an empty answer, whitespace only included", () => {
    const empty: ParsedReply = {
      kind: "malformed",
      message: "Your reply was empty. Call a tool, or write your answer to the user.",
      start: 0,
      end: 0,
    };
    expect(parseToolCall("", TOOLS)).toEqual(empty);
    expect(parseToolCall(" \n\t\r\n", TOOLS)).toEqual(empty);
  });

  test("returns no call for a call inside a fenced block", () => {
    const answer = "Call it like this:\n```\n<read_file>\n<path>a.txt</path>\n</read_file>\n```\nDone.";
    expect(parseToolCall(answer, TOOLS)).toEqual({ kind: "none" });
  });

  test("returns no call for a call inside an inline code span", () => {
    expect(parseToolCall("Write `<read_file><path>a</path></read_file>`.", TOOLS)).toEqual({ kind: "none" });
    expect(parseToolCall("Write ``\n<read_file><path>a</path></read_file>\n`` to read.", TOOLS)).toEqual({
      kind: "none",
    });
  });

  test("parses a call after a fenced block between two lone backticks, which form no span", () => {
    const call = "<read_file>\n<path>a.txt</path>\n</read_file>";
    const answer = `A \` here.\n~~~\nx\n~~~\n${call}\nand \` there.`;
    expect(parseToolCall(answer, TOOLS)).toMatchObject({ kind: "call", name: "read_file", args: { path: "a.txt" } });
  });

  test("returns the first of two calls and ignores the second, with no error", () => {
    const first = "<read_file>\n<path>a.txt</path>\n</read_file>";
    const answer = `${first}\n<read_file>\n<path>b.txt</path>\n</read_file>`;
    expect(parseToolCall(answer, TOOLS)).toEqual({
      kind: "call",
      name: "read_file",
      args: { path: "a.txt" },
      start: 0,
      end: first.length,
    });
  });

  test("ignores everything after the first call, even a malformed block", () => {
    const first = "<read_file>\n<path>a.txt</path>\n</read_file>";
    expect(parseToolCall(`${first}\n<nope>\n</nope>`, TOOLS)).toMatchObject({ kind: "call", end: first.length });
  });

  test("drops every leading and trailing line break of a one-line argument, even on one side only", () => {
    for (const path of ["a.txt\n", "\na.txt", "\r\n\na.txt\n\r\n", "\na.txt\n"]) {
      const answer = `<read_file>\n<path>${path}</path>\n</read_file>`;
      expect(parseToolCall(answer, TOOLS)).toMatchObject({ kind: "call", args: { path: "a.txt" } });
    }
  });

  test("keeps a one-sided line break of an argument that may span lines", () => {
    const answer = "<write_file>\n<path>a.txt</path>\n<content>hello\n</content>\n</write_file>";
    expect(parseToolCall(answer, TOOLS)).toMatchObject({ kind: "call", args: { content: "hello\n" } });
  });

  test("reads a call after a fenced block that quotes one", () => {
    const answer = "```\n<read_file>\n<path>a</path>\n</read_file>\n```\n<read_file>\n<path>b</path>\n</read_file>";
    expect(parseToolCall(answer, TOOLS)).toMatchObject({
      kind: "call",
      args: { path: "b" },
      start: answer.lastIndexOf("<read_file>"),
    });
  });

  test("treats a tag that does not start a line as plain text", () => {
    expect(parseToolCall("Use <b>bold</b> and <div>x</div>.", TOOLS)).toEqual({ kind: "none" });
    expect(parseToolCall("Run: <read_file><path>a</path></read_file>", TOOLS)).toEqual({ kind: "none" });
  });

  test("reads an outer tag indented with spaces or tabs as starting a line, with start at its <", () => {
    const answer = "Reading.\n  <read_file>\n  <path>a</path>\n  </read_file>";
    expect(parseToolCall(answer, TOOLS)).toEqual({
      kind: "call",
      name: "read_file",
      args: { path: "a" },
      start: answer.indexOf("<read_file>"),
      end: answer.length,
    });
    expect(parseToolCall("\t<read_file><path>b</path></read_file>", TOOLS)).toMatchObject({ kind: "call", start: 1 });
    expect(parseToolCall(" \t <read_file><path>c</path></read_file>", TOOLS)).toMatchObject({ start: 3 });
  });

  test("treats a tag whose name is not snake_case, or that has attributes, as plain text", () => {
    expect(parseToolCall("<Read_File><path>a</path></Read_File>", TOOLS)).toEqual({ kind: "none" });
    expect(parseToolCall("<read-file><path>a</path></read-file>", TOOLS)).toEqual({ kind: "none" });
    expect(parseToolCall('<read_file id="1"><path>a</path></read_file>', TOOLS)).toEqual({ kind: "none" });
  });

  test("treats a line-start tag of an unknown name that never closes as plain text, and keeps scanning", () => {
    expect(parseToolCall("<br>\nSee below.", TOOLS)).toEqual({ kind: "none" });
    const answer = "<p>\nReading it.\n<read_file>\n<path>a</path>\n</read_file>";
    expect(parseToolCall(answer, TOOLS)).toMatchObject({ kind: "call", start: answer.indexOf("<read_file>") });
  });

  test("stays fast on many line-start unknown tags that never close, before a call", () => {
    const answer = `${"<p>\n".repeat(262144)}<read_file>\n<path>a</path>\n</read_file>`;
    const started = performance.now();
    expect(parseToolCall(answer, TOOLS)).toMatchObject({ kind: "call", args: { path: "a" } });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("stays fast on many line-start unknown tags of distinct names that never close, before a call", () => {
    const tags = Array.from({ length: 40000 }, (_, index) => `<p${index}>\n`).join("");
    const answer = `${tags}<read_file>\n<path>a</path>\n</read_file>`;
    expect(answer.length).toBeGreaterThan(340000);
    const started = performance.now();
    expect(parseToolCall(answer, TOOLS)).toMatchObject({ kind: "call", args: { path: "a" } });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("stays fast on one long line full of tags, before a call", () => {
    const answer = `${"x<a>".repeat(240000)}\n<read_file>\n<path>a</path>\n</read_file>`;
    const started = performance.now();
    expect(parseToolCall(answer, TOOLS)).toMatchObject({ kind: "call", args: { path: "a" } });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("stays fast on many inline code spans, before a call", () => {
    const answer = `${"a `x` ".repeat(64000)}\n<read_file>\n<path>a</path>\n</read_file>`;
    const started = performance.now();
    expect(parseToolCall(answer, TOOLS)).toMatchObject({ kind: "call", args: { path: "a" } });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("reports a known tool as never closing when its only closing tags come before it", () => {
    const answer = "</read_file>\n<read_file>\n<path>a</path>";
    const parsed = parseToolCall(answer, TOOLS);
    expect(parsed).toMatchObject({ kind: "malformed", start: answer.indexOf("<read_file>"), end: answer.length });
    expect(malformedMessage(answer)).toContain("The <read_file> tag never closes");
  });

  test("closes the outer tag at its first closing tag after it, not at one before it", () => {
    const answer = "Text </read_file> first.\n<read_file>\n<path>a</path>\n</read_file>\n</read_file>";
    expect(parseToolCall(answer, TOOLS)).toMatchObject({
      kind: "call",
      args: { path: "a" },
      start: answer.indexOf("<read_file>"),
      end: answer.indexOf("</read_file>\n</read_file>") + "</read_file>".length,
    });
  });
});

/** The message of a malformed result, failing the test on any other kind. */
function malformedMessage(answer: string): string {
  const parsed = parseToolCall(answer, TOOLS);
  if (parsed.kind !== "malformed") throw new Error(`expected malformed, got ${JSON.stringify(parsed)}`);
  return parsed.message;
}

const READ_FILE_SHAPE = "<read_file>\n<path>…</path>\n<start_line>…</start_line>\n</read_file>";

describe("parseToolCall on a malformed call", () => {
  test("reports an outer tag that never closes, naming it, up to the end of the answer", () => {
    const answer = "Reading.\n<read_file>\n<path>a.txt</path>\n";
    expect(parseToolCall(answer, TOOLS)).toMatchObject({ kind: "malformed", start: 9, end: answer.length });
    const message = malformedMessage(answer);
    expect(message).toContain("<read_file>");
    expect(message).toContain("never closes");
    expect(message).toContain(READ_FILE_SHAPE);
  });

  test("reports an unknown snake_case tool at a line start, listing the known tools", () => {
    const answer = "<delete_file>\n<path>a</path>\n</delete_file>\nThen more.";
    expect(parseToolCall(answer, TOOLS)).toMatchObject({ kind: "malformed", start: 0, end: answer.indexOf("\nThen") });
    const message = malformedMessage(answer);
    expect(message).toContain("<delete_file>");
    expect(message).toContain("read_file, write_file");
    expect(message).toContain(GENERIC_CALL_SHAPE);
  });

  test("reports a closed HTML-looking block at a line start as an unknown tool", () => {
    expect(malformedMessage("<div>\nhello\n</div>")).toContain("<div>");
  });

  test("reports a missing required argument, naming it", () => {
    const message = malformedMessage("<write_file>\n<path>a.txt</path>\n</write_file>");
    expect(message).toContain("missing the required argument <content>.");
    expect(message).toContain("<write_file>\n<path>…</path>\n<content>…</content>\n</write_file>");
  });

  test("names every missing required argument", () => {
    const message = malformedMessage("<write_file>\n</write_file>");
    expect(message).toContain("missing the required arguments <path>, <content>.");
  });

  test("accepts a call without its optional arguments", () => {
    expect(parseToolCall("<read_file>\n<path>a</path>\n</read_file>", TOOLS)).toMatchObject({
      kind: "call",
      args: { path: "a" },
    });
  });

  test("reports an argument unknown to the tool, naming it", () => {
    const message = malformedMessage("<read_file>\n<path>a</path>\n<encoding>utf8</encoding>\n</read_file>");
    expect(message).toContain("<encoding>");
    expect(message).toContain(READ_FILE_SHAPE);
  });

  test("reports text other than whitespace and argument tags inside the outer tag, quoting it", () => {
    const message = malformedMessage("<read_file>\nthe file is <path>a</path>\n</read_file>");
    expect(message).toContain("the file is");
    expect(message).toContain(READ_FILE_SHAPE);
    expect(malformedMessage("<read_file>\n<path>a</path>\ntrailing words\n</read_file>")).toContain("trailing words");
    expect(malformedMessage("<read_file>\n<Path>a</Path>\n</read_file>")).toContain("<Path>");
  });

  test("quotes at most 40 characters of the unexpected text, marking a cut with …", () => {
    const forty = "a".repeat(40);
    expect(malformedMessage(`<read_file>\n${forty}\n</read_file>`)).toContain(`"${forty}"`);
    expect(malformedMessage(`<read_file>\n${forty}bcd\n</read_file>`)).toContain(`"${forty}…"`);
  });

  test("reports an argument tag that never closes, naming it", () => {
    const message = malformedMessage("<read_file>\n<path>a.txt\n</read_file>");
    expect(message).toContain("<path>");
    expect(message).toContain("never closes");
  });

  test("reports an argument read a second time, naming it and the tool", () => {
    const message = malformedMessage("<read_file>\n<path>a</path>\n<path>b\n</read_file>");
    expect(message).toContain("<path> appears twice in <read_file>.");
    expect(message).toContain(READ_FILE_SHAPE);
    const interleaved = "<read_file>\n<path>a</path>\n<start_line>1</start_line>\n<path>b\n</read_file>";
    expect(malformedMessage(interleaved)).toContain("<path> appears twice in <read_file>.");
  });

  test("reports an argument written twice with both values closed", () => {
    const twice = "<read_file>\n<path>a</path>\n<path>b</path>\n</read_file>";
    expect(malformedMessage(twice)).toContain("<path> appears twice in <read_file>.");
    const interleaved = "<read_file>\n<path>a</path><start_line>1</start_line><path>b</path>\n</read_file>";
    expect(malformedMessage(interleaved)).toContain("<path> appears twice in <read_file>.");
  });

  test("reports the first problem: an unclosed outer tag before an unknown argument", () => {
    const message = malformedMessage("<read_file>\n<encoding>x</encoding>\n");
    expect(message).toContain("never closes");
    expect(message).not.toContain("<encoding>");
  });

  test("reports the first problem: unexpected text before a missing argument", () => {
    expect(malformedMessage("<write_file>\nhello\n</write_file>")).toContain("hello");
  });

  test("covers the whole block with start and end", () => {
    const block = "<read_file>\n<nope>x</nope>\n</read_file>";
    const answer = `Let me look.\n${block}\nok`;
    expect(parseToolCall(answer, TOOLS)).toMatchObject({ kind: "malformed", start: 13, end: 13 + block.length });
  });
});

/** The argument values of a call, failing the test on any other kind. */
function callArgs(answer: string): Record<string, string> {
  const parsed = parseToolCall(answer, TOOLS);
  if (parsed.kind !== "call") throw new Error(`expected a call, got ${JSON.stringify(parsed)}`);
  return parsed.args;
}

describe("parseToolCall argument values", () => {
  test("keep angle brackets, another tool's tags, and a fenced code block byte for byte", () => {
    const content = [
      "if (a < b && c > d) {}",
      "<read_file>",
      "<start_line>3</start_line>",
      "</read_file>",
      "```ts",
      "const x = `<content>`;",
      "```",
      "</content> inside the value",
      "  indented line\t",
    ].join("\n");
    const answer = `<write_file>\n<path>a.md</path>\n<content>\n${content}\n</content>\n</write_file>`;
    expect(callArgs(answer)).toEqual({ path: "a.md", content });
  });

  test("keep a value on the same line as its tags untouched, spaces included", () => {
    expect(callArgs("<read_file>\n<path>  a b.txt </path>\n</read_file>").path).toBe("  a b.txt ");
  });

  test("drop one leading and one trailing line break when the value sits on its own lines", () => {
    const answer = "<write_file>\n<path>a</path>\n<content>\n\n  two\n\n</content>\n</write_file>";
    expect(callArgs(answer).content).toBe("\n  two\n");
  });

  test("drop CRLF line breaks the same way", () => {
    const answer = "<write_file>\r\n<path>a</path>\r\n<content>\r\nline\r\n</content>\r\n</write_file>";
    expect(callArgs(answer)).toEqual({ path: "a", content: "line" });
  });

  test("keep a value untouched when only one side has a line break", () => {
    expect(callArgs("<write_file>\n<path>a</path>\n<content>\nline</content>\n</write_file>").content).toBe("\nline");
    expect(callArgs("<write_file>\n<path>a</path>\n<content>line\n</content>\n</write_file>").content).toBe("line\n");
  });

  test("read a value that is one line break, or nothing, as empty", () => {
    expect(callArgs("<write_file>\n<path>a</path>\n<content>\n</content>\n</write_file>").content).toBe("");
    expect(callArgs("<write_file>\n<path>a</path>\n<content>\r\n</content>\n</write_file>").content).toBe("");
    expect(callArgs("<write_file>\n<path>a</path>\n<content></content>\n</write_file>").content).toBe("");
  });

  test("end at the last closing tag before the outer close, so an earlier one stays in the value", () => {
    const answer = "<write_file>\n<path>a</path>\n<content>x</content>y</content>\n</write_file>";
    expect(callArgs(answer).content).toBe("x</content>y");
  });

  test("hold the tags of an earlier argument, which ends at its first closing tag before another argument", () => {
    const content = "<read_file>\n<path>x</path>\n</read_file>";
    const answer = `<write_file>\n<path>a.md</path>\n<content>\n${content}\n</content>\n</write_file>`;
    expect(callArgs(answer)).toEqual({ path: "a.md", content });
    const nested = "<path>x</path>\n<content>y</content>";
    expect(callArgs(`<write_file>\n<path>a.md</path>\n<content>\n${nested}\n</content>\n</write_file>`)).toEqual({
      path: "a.md",
      content: nested,
    });
  });

  test("hold their own tags in pairs, even followed by another argument's opening tag", () => {
    const content = "<content>x</content>\n<path>icon.svg</path>";
    const answer = `<write_file>\n<path>a.xml</path>\n<content>\n${content}\n</content>\n</write_file>`;
    expect(callArgs(answer)).toEqual({ path: "a.xml", content });
    const repeated = "<content>x</content>\n<content>y</content>";
    const twice = `<write_file>\n<path>a.xml</path>\n<content>\n${repeated}\n</content>\n</write_file>`;
    expect(callArgs(twice)).toEqual({ path: "a.xml", content: repeated });
  });

  test("hold their own opening tag without its pair, ending at the last closing tag", () => {
    const content = 'const tag = "<content>";';
    const answer = `<write_file>\n<content>\n${content}\n</content>\n<path>a.ts</path>\n</write_file>`;
    expect(callArgs(answer)).toEqual({ path: "a.ts", content });
  });

  test("stay fast on a body with many nested opening and closing tags", () => {
    const content = `${"<content>".repeat(100000)}x${"</content>\n<path>p</path>".repeat(100000)}`;
    const answer = `<write_file>\n<path>a</path>\n<content>${content}</content>\n</write_file>`;
    const started = performance.now();
    expect(callArgs(answer).content).toBe(content);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("stay fast on a body with many repeated closing tags that never parses", () => {
    const body = `<path>${"x</path>y".repeat(200000)}</path>\n`;
    const started = performance.now();
    expect(malformedMessage(`<read_file>\n${body}stray text\n</read_file>`)).toContain("stray text");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("round-trip quotes, backslashes, angle brackets, a code fence, and the call's own closing tags byte for byte", () => {
    const content = [
      `const quoted = "say \\"hi\\"" + 'it\\'s' + \`\${a}\`;`,
      "const path = 'C:\\\\Users\\\\me\\n';",
      "if (a < b && c > d) {}",
      "```ts",
      "const tag = `</write_file>`;",
      "```",
      "</write_file>",
      "</content>",
      "</content> then </write_file> on one line",
      "",
    ].join("\n");
    const answer = `Writing it.\n<write_file>\n<path>a.md</path>\n<content>\n${content}\n</content>\n</write_file>`;
    expect(parseToolCall(answer, TOOLS)).toEqual({
      kind: "call",
      name: "write_file",
      args: { path: "a.md", content },
      start: "Writing it.\n".length,
      end: answer.length,
    });
  });

  test("end the call at the closing tag after its last value, not at an earlier one inside a value", () => {
    const content = "before\n</write_file>\nafter";
    const call = `<write_file>\n<path>a</path>\n<content>\n${content}\n</content>\n</write_file>`;
    const answer = `${call}\nDone.\n</write_file>`;
    expect(parseToolCall(answer, TOOLS)).toMatchObject({ kind: "call", args: { content }, end: call.length });
  });

  test("end a value at the first closing tag followed by the call's closing tag, ignoring text after the call", () => {
    const call = "<write_file>\n<path>a</path>\n<content>x</content>\n</write_file>";
    const answer = `${call}\nThen y</content>\n</write_file>`;
    expect(parseToolCall(answer, TOOLS)).toMatchObject({ kind: "call", args: { content: "x" }, end: call.length });
  });

  test("end a value holding an unpaired opening tag and the call's closing tag at the close before the next argument", () => {
    const content = 'const tag = "<content>"; // </write_file>';
    const answer = `<write_file>\n<content>\n${content}\n</content>\n<path>a.ts</path>\n</write_file>`;
    expect(callArgs(answer)).toEqual({ path: "a.ts", content });
  });

  test("report an argument that never closes even when the call's closing tag stands in its value", () => {
    const answer = "<write_file>\n<path>a</path>\n<content>\nhello\n</write_file>\n";
    expect(parseToolCall(answer, TOOLS)).toMatchObject({ kind: "malformed", start: 0, end: answer.length - 1 });
    expect(malformedMessage(answer)).toContain(
      "The <content> argument tag never closes: end its value with </content>.",
    );
  });

  test("report text after the last value that is neither an argument nor the call's closing tag", () => {
    const answer = "<write_file>\n<path>a</path>\n<content>x</content>\nstray words\n</write_file>";
    expect(malformedMessage(answer)).toContain('Unexpected text inside <write_file>: "stray words".');
  });
});

test.each(["toolCalls.ts", "systemPrompt.ts"])("%s imports nothing from vscode or node:", async (file) => {
  const source = await Bun.file(`${import.meta.dir}/${file}`).text();
  const specifiers = [...source.matchAll(/(?:from|import)\s+"([^"]+)"/g)].map((match) => match[1]);
  expect(specifiers.length).toBeGreaterThan(0);
  expect(specifiers.filter((specifier) => specifier === "vscode" || specifier!.startsWith("node:"))).toEqual([]);
});

describe("replyCut", () => {
  const call = "<read_file>\n<path>a.txt</path>\n</read_file>";
  const result = '<tool_result tool="read_file" status="ok">';

  test("cuts at the end of the call a tool result written by the model follows", () => {
    expect(replyCut(`${call}\n${result}\nfine\n`, TOOLS, 0)).toEqual({
      cut: call.length,
      scanned: call.length + 1,
    });
  });

  test("does not cut on a result opening before any call, and moves the scan past it", () => {
    const answer = `${result}\nfine\n</tool_result>\nI will read it.`;
    expect(replyCut(answer, TOOLS, 0)).toEqual({ scanned: answer.length - "<tool_result".length + 1 });
  });

  test("does not cut on a result opening inside a write_file value still streaming", () => {
    const answer = `<write_file>\n<path>doc.md</path>\n<content>\nResults look like ${result}`;
    expect(replyCut(answer, TOOLS, 0).cut).toBeUndefined();
  });

  test("finds an opening split across deltas by scanning its first characters again", () => {
    const first = replyCut(`${call}\n<tool_`, TOOLS, 0);
    expect(first.cut).toBeUndefined();
    expect(replyCut(`${call}\n${result}`, TOOLS, first.scanned).cut).toBe(call.length);
  });

  test("cuts at the end of a call another call follows, so a repeating model stops at once", () => {
    expect(replyCut(`${call}\n${call}\n${call}`, TOOLS, 0).cut).toBe(call.length);
  });

  test("cuts after a wrapped call another wrapper follows", () => {
    const wrapped = `<tool_call>\n${call}\n</tool_call>`;
    expect(replyCut(`${wrapped}\n<tool_call>\n${call}`, TOOLS, 0).cut).toBe(wrapped.length);
  });

  test("does not cut on a call opening inside a write_file value still streaming", () => {
    const answer = `<write_file>\n<path>doc.md</path>\n<content>\nExample:\n${call}\n<read_file>\n`;
    expect(replyCut(answer, TOOLS, 0).cut).toBeUndefined();
  });

  test("does not cut on a call opening in the middle of a line", () => {
    expect(replyCut(`${call}\nthen <read_file> again`, TOOLS, 0).cut).toBeUndefined();
  });
});

describe("parseToolCall: wrappers and forged results (ADR 0001, 2026-11-12)", () => {
  const call = "<read_file>\n<path>a.txt</path>\n</read_file>";
  const result = '<tool_result tool="read_file" status="ok">\nall good\n</tool_result>';

  test.each(["tool_call", "tool_code"])("reads a call wrapped in <%s>, the block spanning the wrapper", (wrapper) => {
    const answer = `I will read it.\n<${wrapper}>\n${call}\n</${wrapper}>\nthen more`;
    const start = "I will read it.\n".length;
    expect(parseToolCall(answer, TOOLS)).toEqual({
      kind: "call",
      name: "read_file",
      args: { path: "a.txt" },
      start,
      end: start + `<${wrapper}>\n${call}\n</${wrapper}>`.length,
    });
  });

  test("reads a wrapped call written on one line, and one whose wrapper never closes", () => {
    const oneLine = "<tool_call><read_file><path>a.txt</path></read_file></tool_call>";
    expect(parseToolCall(oneLine, TOOLS)).toMatchObject({ kind: "call", args: { path: "a.txt" }, end: oneLine.length });
    const open = `<tool_code>\n${call}\nand then`;
    expect(parseToolCall(open, TOOLS)).toMatchObject({ kind: "call", end: `<tool_code>\n${call}`.length });
  });

  test("reports a wrapped call that is malformed with the tool's own message", () => {
    const parsed = parseToolCall("<tool_call>\n<read_file>\n<file>a.txt</file>\n</read_file>\n</tool_call>", TOOLS);
    expect(parsed).toMatchObject({ kind: "malformed", start: 0 });
    expect((parsed as { message: string }).message).toStartWith("<read_file> has no argument <file>.");
  });

  test("keeps a wrapper around an unknown tool, or around nothing, a wrapper the model is told is not a tool", () => {
    for (const answer of [
      "<tool_call>\n<fetch_url>\n<url>x</url>\n</fetch_url>\n</tool_call>",
      "<tool_call>\nhi\n</tool_call>",
    ]) {
      const parsed = parseToolCall(answer, TOOLS);
      expect(parsed).toMatchObject({ kind: "malformed", start: 0 });
      expect((parsed as { message: string }).message).toStartWith("<tool_call> is not a known tool.");
    }
  });

  test("ignores a wrapper inside a code fence", () => {
    expect(parseToolCall(`Like this:\n\`\`\`\n<tool_call>\n${call}\n</tool_call>\n\`\`\``, TOOLS)).toEqual({
      kind: "none",
    });
  });

  test("refuses a tool result the model wrote before its call, from where the result opens", () => {
    const answer = `Loaded.\n${result}\n\n${call}`;
    expect(parseToolCall(answer, TOOLS)).toMatchObject({ kind: "malformed", forged: true, start: "Loaded.\n".length });
  });

  test("refuses an answer built on a tool result the model wrote, with no call", () => {
    const parsed = parseToolCall(`${result}\nThe code is 42.`, TOOLS);
    expect(parsed).toMatchObject({ kind: "malformed", forged: true, start: 0 });
    expect((parsed as { message: string }).message).toStartWith("Your reply holds a tool result you wrote yourself");
  });

  test("reads no forged result in code, in the middle of a line, or after the call", () => {
    expect(parseToolCall(`\`\`\`\n${result}\n\`\`\`\n${call}`, TOOLS)).toMatchObject({ kind: "call" });
    expect(parseToolCall(`Results open with <tool_result tool="x">.\n${call}`, TOOLS)).toMatchObject({ kind: "call" });
    expect(parseToolCall(`${call}\n${result}`, TOOLS)).toMatchObject({ kind: "call", end: call.length });
    expect(parseToolCall("A <tool_results> table.", TOOLS)).toEqual({ kind: "none" });
    expect(parseToolCall("<tool_results>\nnone\n", TOOLS)).toEqual({ kind: "none" });
  });
});
