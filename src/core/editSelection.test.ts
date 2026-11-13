import { describe, expect, test } from "bun:test";
import type { ChatModel, ChatOutcome, ProviderAccess, StreamChatOptions } from "./client";
import {
  cleanEditReply,
  composeEditRequest,
  EARLIER_NOT_SHOWN,
  EDIT_SELECTION_COMMAND,
  type EditCommand,
  type EditDocument,
  type EditedSelection,
  type EditorState,
  editInstruction,
  LATER_NOT_SHOWN,
  type LiveDocument,
  requestPath,
  SelectionEditor,
  type SelectionEditPorts,
} from "./editSelection";
import { charactersOf } from "./limits";
import { describeProviderError, type ErrorText, type ProviderError } from "./providerError";
import { ProviderSupport } from "./providerSupport";

/** `count` lines `line 000` to `line <count - 1>`, each padded to 39 characters, so 40 with its line break. */
function numberedLines(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line ${String(index).padStart(3, "0")}`.padEnd(39, "."));
}

/** A `file` document of `lines` joined by `eol`, ending with a line break, the lines `from` to `to` selected whole. */
function documentOf(lines: string[], from: number, to: number, eol: "\n" | "\r\n" = "\n"): EditDocument {
  const text = lines.map((line) => line + eol).join("");
  const offset = (line: number) => lines.slice(0, line).reduce((total, each) => total + each.length + eol.length, 0);
  return {
    uri: "file:///work/app/src/a.ts",
    name: "a.ts",
    path: "src/a.ts",
    languageId: "typescript",
    eol,
    text,
    start: offset(from),
    end: offset(to + 1),
  };
}

const total = (messages: { content: string }[]) => charactersOf(messages);

describe("composeEditRequest", () => {
  test("asks for the rewritten selection only, then labels the file, the context, the selection, and the instruction", () => {
    const lines = ["import x from 'x';", "", "function add(a, b) {", "  return a + b;", "}", "", "export { add };"];
    const request = composeEditRequest(documentOf(lines, 2, 4), "Rename add to sum", 32_768, 4);
    if (request.kind !== "ok") throw new Error(request.kind);
    const [system, user] = request.messages;
    expect(request.messages).toHaveLength(2);
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("rewritten selection only");
    expect(system?.content).toContain("code fence");
    expect(system?.content).toContain("explanation");
    expect(user?.role).toBe("user");
    expect(user?.content).toBe(
      [
        "File: src/a.ts",
        "Language: typescript",
        "",
        "Lines before the selection, read-only context, never part of the answer:",
        "<before>",
        "import x from 'x';",
        "",
        "</before>",
        "",
        "The selection to rewrite:",
        "<selection>",
        "function add(a, b) {\n  return a + b;\n}",
        "</selection>",
        "",
        "Lines after the selection, read-only context, never part of the answer:",
        "<after>",
        "",
        "export { add };",
        "</after>",
        "",
        "Instruction:",
        "Rename add to sum",
      ].join("\n"),
    );
  });

  test("sends the lines around a selection that starts and ends inside a line, and the selection with LF line breaks", () => {
    const text = "const a = 1;\r\nconst total = sum(a,\r\n  b);\r\nexport { total };\r\n";
    const start = text.indexOf("sum(");
    const end = text.indexOf(";", start);
    const document: EditDocument = { ...documentOf([], 0, -1, "\r\n"), text, start, end };
    const request = composeEditRequest(document, "Inline it", 32_768, 4);
    if (request.kind !== "ok") throw new Error(request.kind);
    const user = request.messages[1]?.content ?? "";
    expect(user).toContain("<before>\nconst a = 1;\nconst total = \n</before>");
    expect(user).toContain("<selection>\nsum(a,\n  b)\n</selection>");
    expect(user).toContain("<after>\n;\nexport { total };\n</after>");
    expect(user).not.toContain("\r");
  });

  test("at 3,500 characters, a selection in the middle of a long file cuts both sides and leaves less than one line", () => {
    const lines = numberedLines(400);
    const request = composeEditRequest(documentOf(lines, 200, 202), "Make it faster", 1_000, 4);
    if (request.kind !== "ok") throw new Error(request.kind);
    const sent = total(request.messages);
    expect(sent).toBeLessThanOrEqual(3_500);
    expect(3_500 - sent).toBeLessThan(40);
    const user = request.messages[1]?.content ?? "";
    expect(user).toContain(`<before>\n${EARLIER_NOT_SHOWN}\n`);
    expect(user).toContain(`\n${LATER_NOT_SHOWN}\n</after>`);
    expect(user).toContain(lines[199]!);
    expect(user).toContain(lines[203]!);
    expect(user).not.toContain(lines[0]!);
    expect(user).not.toContain(lines[399]!);
  });

  test("near the top of the file, sends every line before with no notice and gives the unused room to the lines after", () => {
    const lines = numberedLines(400);
    const request = composeEditRequest(documentOf(lines, 2, 2), "Make it faster", 1_000, 4);
    if (request.kind !== "ok") throw new Error(request.kind);
    const user = request.messages[1]?.content ?? "";
    expect(user).toContain(`<before>\n${lines[0]}\n${lines[1]}\n</before>`);
    expect(user).not.toContain(EARLIER_NOT_SHOWN);
    expect(user).toContain(LATER_NOT_SHOWN);
    // [>]: Without the pooling, the room the lines before left unused would stay unused: far more than one line.
    expect(total(request.messages)).toBeLessThanOrEqual(3_500);
    expect(3_500 - total(request.messages)).toBeLessThan(40 + EARLIER_NOT_SHOWN.length + 1);
  });

  test("refuses a fixed part of 3,501 characters, and sends one of 3,500 with no context line", () => {
    const lines = numberedLines(20);
    // [>]: The whole document selected reaches both ends: the request is then the fixed part without its two notices.
    const whole = composeEditRequest(documentOf(lines.slice(5, 15), 0, 9), "x", 1_000, 4);
    if (whole.kind !== "ok") throw new Error(whole.kind);
    const notices = EARLIER_NOT_SHOWN.length + 1 + LATER_NOT_SHOWN.length + 1;
    const fixedWithOneCharacter = total(whole.messages) + notices;
    const middle = documentOf(lines, 5, 14);
    const instructionFor = (fixed: number) => "x".repeat(fixed - fixedWithOneCharacter + 1);

    expect(composeEditRequest(middle, instructionFor(3_501), 1_000, 4)).toEqual({ kind: "tooLarge" });

    const fits = composeEditRequest(middle, instructionFor(3_500), 1_000, 4);
    if (fits.kind !== "ok") throw new Error(fits.kind);
    expect(total(fits.messages)).toBe(3_500);
    const user = fits.messages[1]?.content ?? "";
    expect(user).toContain(`<before>\n${EARLIER_NOT_SHOWN}\n</before>`);
    expect(user).toContain(`<after>\n${LATER_NOT_SHOWN}\n</after>`);
  });
});

describe("cleanEditReply", () => {
  /** A whole-line selection of a TypeScript document with LF line breaks, ending with one. */
  const lines: EditedSelection = { selection: "  a();\n  b();\n", startsInsideLine: false, eol: "\n", markdown: false };

  test("drops a leading think block and late reasoning, and keeps <think> inside the code", () => {
    expect(cleanEditReply("<think>\nhow?\n</think>\n  c();", lines)).toBe("  c();\n");
    expect(cleanEditReply("The user wants c.\n</think>\n\n  c();", lines)).toBe("  c();\n");
    expect(cleanEditReply('  const tag = "<think>";\n  const end = "</think>";', lines)).toBe(
      '  const tag = "<think>";\n  const end = "</think>";\n',
    );
  });

  test("unwraps a fence around the whole reply", () => {
    expect(cleanEditReply("```ts\n  c();\n  d();\n```", lines)).toBe("  c();\n  d();\n");
    expect(cleanEditReply("\n\n```\n  c();\n```\n\n", lines)).toBe("  c();\n");
  });

  test("takes the one fenced block after prose, or before prose", () => {
    expect(cleanEditReply("Here is the code:\n```ts\n  c();\n```", lines)).toBe("  c();\n");
    expect(cleanEditReply("```ts\n  c();\n```\nI renamed b to c.", lines)).toBe("  c();\n");
  });

  test("takes the whole text for a fence in the middle of the code, two fenced blocks, or an unclosed fence", () => {
    const flush: EditedSelection = {
      selection: "def f():\n    pass\n",
      startsInsideLine: false,
      eol: "\n",
      markdown: false,
    };
    const example = 'def f():\n    """Call it so:\n\n```python\nf()\n```\n    """\n    return 1';
    expect(cleanEditReply(example, flush)).toBe(`${example}\n`);
    const two = "```python\nf()\n```\nand\n```python\ng()\n```";
    expect(cleanEditReply(two, flush)).toBe(`${two}\n`);
    const unclosed = "```python\nf()";
    expect(cleanEditReply(unclosed, flush)).toBe(`${unclosed}\n`);
  });

  test("unwraps nothing in a Markdown document", () => {
    const markdown: EditedSelection = { selection: "Some text.\n", startsInsideLine: false, eol: "\n", markdown: true };
    expect(cleanEditReply("```sh\nbun test\n```", markdown)).toBe("```sh\nbun test\n```\n");
  });

  test("re-bases a reply indented by 2 spaces on a selection indented by one tab", () => {
    const tabbed: EditedSelection = {
      selection: "\tif (a) {\n\t\tb();\n\t}",
      startsInsideLine: false,
      eol: "\n",
      markdown: false,
    };
    expect(cleanEditReply("  if (a) {\n    c();\n  }", tabbed)).toBe("\tif (a) {\n\t  c();\n\t}");
  });

  test("leaves the first line as it is when the selection starts inside a line, and re-bases the others", () => {
    const inside: EditedSelection = {
      selection: "add(\n\ta,\n\tb)",
      startsInsideLine: true,
      eol: "\n",
      markdown: false,
    };
    expect(cleanEditReply("sum(\n  a,\n  b,\n  c)", inside)).toBe("sum(\n\ta,\n\tb,\n\tc)");
  });

  test("uses the document's CRLF line breaks", () => {
    const crlf: EditedSelection = {
      selection: "  a();\r\n  b();\r\n",
      startsInsideLine: false,
      eol: "\r\n",
      markdown: false,
    };
    expect(cleanEditReply("  c();\r\n  d();", crlf)).toBe("  c();\r\n  d();\r\n");
    expect(cleanEditReply("  c();\n  d();\n", crlf)).toBe("  c();\r\n  d();\r\n");
  });

  test("ends with a line break exactly when the selection did", () => {
    const open: EditedSelection = { selection: "  a();", startsInsideLine: false, eol: "\n", markdown: false };
    expect(cleanEditReply("  c();\n\n", open)).toBe("  c();");
    expect(cleanEditReply("  c();", lines)).toBe("  c();\n");
  });

  test("gives undefined when nothing is left", () => {
    expect(cleanEditReply("", lines)).toBeUndefined();
    expect(cleanEditReply(" \n\t\n", lines)).toBeUndefined();
    expect(cleanEditReply("<think>only</think>", lines)).toBeUndefined();
    expect(cleanEditReply("```ts\n\n```", lines)).toBeUndefined();
  });
});

describe("requestPath", () => {
  const roots = [
    { name: "app", path: "/work/app" },
    { name: "lib", path: "/work/lib" },
  ];

  test("names a file by its path relative to its workspace folder, its name outside one, and untitled", () => {
    expect(requestPath("file", "/work/app/src/a.ts", roots)).toBe("src/a.ts");
    expect(requestPath("file", "/work/lib/b.ts", roots)).toBe("b.ts");
    expect(requestPath("file", "/elsewhere/c.ts", roots)).toBe("c.ts");
    expect(requestPath("untitled", "Untitled-1", roots)).toBe("untitled");
  });
});

describe("SelectionEditor", () => {
  const english = { t: (message: string, ...args: (string | number | boolean)[]) => format(message, args) };
  const access: ProviderAccess = {
    provider: { name: "Ollama", baseUrl: "http://localhost:11434/v1" },
    apiKey: undefined,
  };
  const original = "function add(a, b) {\n  return a + b;\n}\n";
  const sent = "  return a + b;\n";

  /** A `file` document holding `original`, its second line selected. */
  function fileDocument(uri = "file:///work/app/a.ts"): EditDocument {
    return {
      uri,
      name: "a.ts",
      path: "a.ts",
      languageId: "typescript",
      eol: "\n",
      text: original,
      start: original.indexOf(sent),
      end: original.indexOf(sent) + sent.length,
    };
  }

  const state =
    (document = fileDocument(), more: Partial<EditorState> = {}) =>
    async (): Promise<EditorState> => ({
      scheme: "file",
      writable: true,
      document,
      ...more,
    });
  const say = (instruction: string | undefined) => async () => instruction;

  /** A document whose text the test changes; `edits` records each replace, `applied` is VS Code's answer. */
  function liveDocument(text = original, applied = true) {
    const live = {
      text,
      edits: [] as { start: number; end: number; text: string }[],
    };
    const port: LiveDocument = {
      text: () => live.text,
      replace: async (start, end, replacement) => {
        live.edits.push({ start, end, text: replacement });
        if (applied) live.text = live.text.slice(0, start) + replacement + live.text.slice(end);
        return applied;
      },
    };
    return { live, port };
  }

  /**
   * Ports that record what the flow did. `reply` answers each request; `documents` gives the live document by URI
   * (absent: gone).
   */
  function fakePorts(
    options: {
      reply?: (request: StreamChatOptions) => Promise<ChatOutcome>;
      chatModel?: ChatModel | undefined;
      documents?: Map<string, LiveDocument>;
    } = {},
  ) {
    const calls = {
      requests: [] as StreamChatOptions[],
      errors: [] as ErrorText[],
      diffs: [] as { id: string; document: EditDocument; proposed: string }[],
      closed: [] as string[],
      closedAll: 0,
      progress: 0,
      cancel: () => {},
    };
    const chatModel = "chatModel" in options ? options.chatModel : { access, model: "qwen", contextSize: 32_768 };
    const ports: SelectionEditPorts = {
      chatModel: async () => chatModel,
      stream: (_access, request) => {
        calls.requests.push(request);
        return options.reply ? options.reply(request) : answer("  return a - b;")(request);
      },
      providerSupport: new ProviderSupport(),
      withProgress: (task) => {
        calls.progress++;
        const cancel = new AbortController();
        calls.cancel = () => cancel.abort();
        return task(cancel.signal);
      },
      showDiff: async (document, proposed) => {
        const id = `diff-${calls.diffs.length + 1}`;
        calls.diffs.push({ id, document, proposed });
        return id;
      },
      closeDiff: async (id) => {
        calls.closed.push(id);
      },
      closeAllDiffs: async () => {
        calls.closedAll++;
      },
      openDocument: async (document) => options.documents?.get(document.uri),
      showError: (text) => calls.errors.push(text),
    };
    return { ports, calls };
  }

  function answer(content: string) {
    return async (request: StreamChatOptions): Promise<ChatOutcome> => {
      request.onContent(content);
      return { status: "done" };
    };
  }

  function untilAborted(request: StreamChatOptions): Promise<ChatOutcome> {
    return new Promise((resolve) => {
      request.signal.addEventListener("abort", () => resolve({ status: "stopped" }), { once: true });
    });
  }

  test("sends one request with the chat's model, then shows the document beside its edited text", async () => {
    const { ports, calls } = fakePorts();
    await new SelectionEditor(ports, english).run(state(), say("Subtract"));
    expect(calls.requests).toHaveLength(1);
    expect(calls.requests[0]?.model).toBe("qwen");
    expect(calls.requests[0]?.messages[1]?.content).toContain("Instruction:\nSubtract");
    expect(calls.progress).toBe(1);
    expect(calls.diffs).toHaveLength(1);
    expect(calls.diffs[0]?.document.text).toBe(original);
    expect(calls.diffs[0]?.proposed).toBe("function add(a, b) {\n  return a - b;\n}\n");
    expect(calls.errors).toEqual([]);
  });

  test("Accept with the range unchanged applies one edit and closes the diff", async () => {
    const { live, port } = liveDocument();
    const { ports, calls } = fakePorts({ documents: new Map([["file:///work/app/a.ts", port]]) });
    const editor = new SelectionEditor(ports, english);
    await editor.run(state(), say("Subtract"));
    await editor.accept("diff-1");
    expect(live.edits).toEqual([{ start: 21, end: 37, text: "  return a - b;\n" }]);
    expect(live.text).toBe("function add(a, b) {\n  return a - b;\n}\n");
    expect(calls.closed).toEqual(["diff-1"]);
    expect(calls.errors).toEqual([]);
  });

  test("Accept edits nothing when the text changed, the selection moved, or the document is gone", async () => {
    const changed = liveDocument(original.replace("a + b", "a + b + 1"));
    const moved = liveDocument(`// sum\n${original}`);
    const cases: Map<string, LiveDocument>[] = [
      new Map([["file:///work/app/a.ts", changed.port]]),
      new Map([["file:///work/app/a.ts", moved.port]]),
      new Map(),
    ];
    for (const documents of cases) {
      const { ports, calls } = fakePorts({ documents });
      const editor = new SelectionEditor(ports, english);
      await editor.run(state(), say("Subtract"));
      await editor.accept("diff-1");
      expect(calls.errors).toEqual([{ message: "The text changed since the request. Nothing was edited." }]);
      expect(calls.closed).toEqual(["diff-1"]);
    }
    expect(changed.live.edits).toEqual([]);
    expect(moved.live.edits).toEqual([]);
  });

  test("says so when VS Code reports the edit was not applied", async () => {
    const { live, port } = liveDocument(original, false);
    const { ports, calls } = fakePorts({ documents: new Map([["file:///work/app/a.ts", port]]) });
    const editor = new SelectionEditor(ports, english);
    await editor.run(state(), say("Subtract"));
    await editor.accept("diff-1");
    expect(live.edits).toHaveLength(1);
    expect(calls.errors).toEqual([{ message: "The document could not be edited." }]);
    expect(calls.closed).toEqual(["diff-1"]);
  });

  test("refuses an empty selection, another scheme, and a read-only file before anything is sent", async () => {
    const empty = { ...fileDocument(), end: fileDocument().start };
    const cases: [() => Promise<EditorState | undefined>, string][] = [
      [async () => undefined, "Select the code to edit first."],
      [state(empty), "Select the code to edit first."],
      [
        state(fileDocument(), { scheme: "output" }),
        "broke-code can edit a selection only in a writable file or an untitled document.",
      ],
      [
        state(fileDocument(), { writable: false }),
        "broke-code can edit a selection only in a writable file or an untitled document.",
      ],
    ];
    for (const [lookup, message] of cases) {
      const { ports, calls } = fakePorts();
      let asked = 0;
      await new SelectionEditor(ports, english).run(lookup, async () => {
        asked++;
        return "Subtract";
      });
      expect(calls.errors).toEqual([{ message }]);
      expect(calls.requests).toEqual([]);
      expect(asked).toBe(0);
    }
  });

  test("an untitled document can be edited", async () => {
    const { ports, calls } = fakePorts();
    await new SelectionEditor(ports, english).run(
      state(fileDocument("untitled:Untitled-1"), { scheme: "untitled" }),
      say("x"),
    );
    expect(calls.requests).toHaveLength(1);
  });

  test("no provider or model, or a selection that does not fit, sends nothing", async () => {
    const none = fakePorts({ chatModel: undefined });
    await new SelectionEditor(none.ports, english).run(state(), say("Subtract"));
    expect(none.calls.errors).toEqual([{ message: "Choose a provider and a model in the broke-code chat first." }]);
    expect(none.calls.requests).toEqual([]);

    const tiny = fakePorts({ chatModel: { access, model: "qwen", contextSize: 100 } });
    await new SelectionEditor(tiny.ports, english).run(state(), say("Subtract"));
    expect(tiny.calls.errors).toEqual([{ message: "The selection does not fit the model's context." }]);
    expect(tiny.calls.requests).toEqual([]);
  });

  test("an Escape or an empty instruction sends nothing, and a new run on that document may start", async () => {
    const { ports, calls } = fakePorts();
    const editor = new SelectionEditor(ports, english);
    await editor.run(state(), say(undefined));
    await editor.run(state(), say("  "));
    expect(calls.requests).toEqual([]);
    expect(calls.errors).toEqual([]);
    await editor.run(state(), say("Subtract"));
    expect(calls.requests).toHaveLength(1);
  });

  test("Reject and a closed tab edit nothing and end the run", async () => {
    const { live, port } = liveDocument();
    const { ports, calls } = fakePorts({ documents: new Map([["file:///work/app/a.ts", port]]) });
    const editor = new SelectionEditor(ports, english);
    await editor.run(state(), say("Subtract"));
    await editor.reject("diff-1");
    expect(calls.closed).toEqual(["diff-1"]);
    await editor.run(state(), say("Subtract"));
    editor.diffClosed("diff-2");
    await editor.run(state(), say("Subtract"));
    expect(calls.diffs).toHaveLength(3);
    // [>]: A later Accept on a settled diff finds no run: it only closes the tab.
    await editor.accept("diff-2");
    expect(live.edits).toEqual([]);
    expect(calls.errors).toEqual([]);
  });

  test("Accept or Reject on a diff with no run closes it and does nothing else", async () => {
    const { live, port } = liveDocument();
    const { ports, calls } = fakePorts({ documents: new Map([["file:///work/app/a.ts", port]]) });
    const editor = new SelectionEditor(ports, english);
    await editor.accept("left-by-a-crash");
    await editor.reject("left-by-a-crash-too");
    expect(calls.closed).toEqual(["left-by-a-crash", "left-by-a-crash-too"]);
    expect(live.edits).toEqual([]);
    expect(calls.errors).toEqual([]);
  });

  test("Cancel shows no diff, and a provider error shows the chat's wording and no diff", async () => {
    const cancelled = fakePorts({ reply: untilAborted });
    const editor = new SelectionEditor(cancelled.ports, english);
    const running = editor.run(state(), say("Subtract"));
    await Bun.sleep(0);
    cancelled.calls.cancel();
    await running;
    expect(cancelled.calls.diffs).toEqual([]);
    expect(cancelled.calls.errors).toEqual([]);

    const error: ProviderError = { kind: "cutOff", provider: "Ollama", reason: "ended" };
    const failed = fakePorts({ reply: async () => ({ status: "failed", error }) });
    await new SelectionEditor(failed.ports, english).run(state(), say("Subtract"));
    expect(failed.calls.diffs).toEqual([]);
    expect(failed.calls.errors).toEqual([describeProviderError(error, english)]);
  });

  test("an empty reply shows its notification and no diff", async () => {
    const { ports, calls } = fakePorts({ reply: answer("```ts\n```") });
    await new SelectionEditor(ports, english).run(state(), say("Subtract"));
    expect(calls.errors).toEqual([{ message: "The model returned no code." }]);
    expect(calls.diffs).toEqual([]);
  });

  test("a second run on the same document is refused while a run on another document starts", async () => {
    const { ports, calls } = fakePorts({ reply: untilAborted });
    const editor = new SelectionEditor(ports, english);
    const first = editor.run(state(), say("Subtract"));
    await Bun.sleep(0);
    await editor.run(state(), say("Again"));
    expect(calls.errors).toEqual([{ message: "An edit is already in progress for a.ts." }]);
    const other = editor.run(state(fileDocument("file:///work/app/b.ts")), say("Other"));
    await Bun.sleep(0);
    expect(calls.requests).toHaveLength(2);
    editor.dispose();
    await Promise.all([first, other]);
  });

  test("a document stays taken while its diff is open", async () => {
    const { ports, calls } = fakePorts();
    const editor = new SelectionEditor(ports, english);
    await editor.run(state(), say("Subtract"));
    await editor.run(state(), say("Again"));
    expect(calls.errors).toEqual([{ message: "An edit is already in progress for a.ts." }]);
    expect(calls.requests).toHaveLength(1);
  });

  test("dispose aborts the requests in flight and closes the diffs; later runs do nothing", async () => {
    const { ports, calls } = fakePorts({ reply: untilAborted });
    const editor = new SelectionEditor(ports, english);
    const running = editor.run(state(), say("Subtract"));
    await Bun.sleep(0);
    editor.dispose();
    await running;
    expect(calls.diffs).toEqual([]);
    expect(calls.closedAll).toBe(1);
    await editor.run(state(), say("Subtract"));
    expect(calls.requests).toHaveLength(1);
  });

  test("each preset sends its exact instruction and never asks for one", async () => {
    const presets: [EditCommand, string][] = [
      [
        "broke-code.refactorSelection",
        "Refactor this code to make it simpler and easier to read. Keep its behavior and its public names unchanged.",
      ],
      [
        "broke-code.documentSelection",
        "Add documentation comments to this code, in the documentation style of its language. Change nothing else.",
      ],
      [
        "broke-code.typeSelection",
        "Add explicit type annotations to this code where the language allows them. Change nothing else.",
      ],
    ];
    for (const [command, instruction] of presets) {
      const { ports, calls } = fakePorts();
      let asked = 0;
      const ask = async () => {
        asked++;
        return "typed";
      };
      await new SelectionEditor(ports, english).run(state(), editInstruction(command, ask));
      expect(asked).toBe(0);
      expect(calls.requests).toHaveLength(1);
      expect(calls.requests[0]?.messages[1]?.content).toEndWith(`Instruction:\n${instruction}`);
      expect(calls.diffs).toHaveLength(1);
    }
  });

  test("Edit selection asks for its instruction", async () => {
    const { ports, calls } = fakePorts();
    await new SelectionEditor(ports, english).run(state(), editInstruction(EDIT_SELECTION_COMMAND, say("Subtract")));
    expect(calls.requests[0]?.messages[1]?.content).toEndWith("Instruction:\nSubtract");
  });

  test("a preset and Edit selection on the same document refuse each other", async () => {
    const { ports, calls } = fakePorts({ reply: untilAborted });
    const editor = new SelectionEditor(ports, english);
    const preset = editor.run(state(), editInstruction("broke-code.typeSelection", say(undefined)));
    await Bun.sleep(0);
    await editor.run(state(), editInstruction(EDIT_SELECTION_COMMAND, say("Subtract")));
    await editor.run(state(), editInstruction("broke-code.refactorSelection", say(undefined)));
    expect(calls.errors).toEqual([
      { message: "An edit is already in progress for a.ts." },
      { message: "An edit is already in progress for a.ts." },
    ]);
    expect(calls.requests).toHaveLength(1);
    editor.dispose();
    await preset;

    const { ports: second, calls: secondCalls } = fakePorts({ reply: untilAborted });
    const other = new SelectionEditor(second, english);
    const asked = other.run(state(), editInstruction(EDIT_SELECTION_COMMAND, say("Subtract")));
    await Bun.sleep(0);
    await other.run(state(), editInstruction("broke-code.documentSelection", say(undefined)));
    expect(secondCalls.errors).toEqual([{ message: "An edit is already in progress for a.ts." }]);
    expect(secondCalls.requests).toHaveLength(1);
    other.dispose();
    await asked;
  });

  test("a diff that opens after dispose is closed at once", async () => {
    const { ports, calls } = fakePorts();
    const editor = new SelectionEditor(ports, english);
    const show = ports.showDiff;
    ports.showDiff = async (document, proposed) => {
      editor.dispose();
      return show(document, proposed);
    };
    await editor.run(state(), say("Subtract"));
    expect(calls.closed).toEqual(["diff-1"]);
  });
});

function format(message: string, args: (string | number | boolean)[]): string {
  return message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)]));
}
