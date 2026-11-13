import { describe, expect, test } from "bun:test";
import * as l10n from "@vscode/l10n";
import french from "../../l10n/bundle.l10n.fr.json";
import type { ChatEntry, ChatState, SkillProblem } from "../core/protocol";
import {
  describeAnnouncement,
  describeContextTitle,
  describeContextUsage,
  describeFold,
  describeHalt,
  describeProviderError,
  describeSkillWarning,
  describeStorageProblem,
  describeToolStep,
  describeUndoFailure,
  describeUndoneFile,
  describeUndoOutcome,
  formatConversationDate,
  mainArgument,
} from "./text";
import { type FoldCounts, foldTurns, STEP_KINDS, type StepKind } from "./turns";

describe("describeProviderError", () => {
  test("names the model list, not a reply, when the list download is cut off", () => {
    const text = describeProviderError({
      kind: "cutOff",
      provider: "Ollama",
      reason: "listDropped",
      cause: "socket closed",
    });
    expect(text).toEqual({
      message: "The model list from Ollama was cut off: the connection dropped.",
      detail: "socket closed",
    });
  });

  test("says a rejected request's body could not be read, with the cause", () => {
    const text = describeProviderError({
      kind: "rejected",
      provider: "Ollama",
      status: 500,
      detail: "",
      bodyReadError: "socket closed",
    });
    expect(text).toEqual({
      message: "Ollama rejected the request (HTTP 500).",
      detail: "The response body could not be read: socket closed",
    });
  });

  test("shows a rejected request's body detail when it was read", () => {
    const text = describeProviderError({
      kind: "rejected",
      provider: "Ollama",
      status: 404,
      detail: "model 'nope' not found",
    });
    expect(text).toEqual({ message: "Ollama rejected the request (HTTP 404).", detail: "model 'nope' not found" });
  });

  test("names the provider and the failure of an untrusted certificate, and points to the CA file setting", () => {
    const text = describeProviderError({
      kind: "certificate",
      provider: "Corp",
      baseUrl: "https://llm.corp/v1",
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
    expect(text).toEqual({
      message:
        "Corp presented a certificate that is not trusted (DEPTH_ZERO_SELF_SIGNED_CERT). If it uses a corporate or self-signed certificate, set its CA file in the provider settings.",
      detail: "https://llm.corp/v1",
    });
  });

  test("names the path of an unusable CA file, with the reason in the detail", () => {
    expect(
      describeProviderError({
        kind: "caFileInvalid",
        provider: "Corp",
        path: "/x.pem",
        reason: "unreadable",
        cause: "ENOENT",
      }),
    ).toEqual({
      message: "The CA file of Corp could not be read: /x.pem",
      detail: "ENOENT",
    });
    expect(
      describeProviderError({
        kind: "caFileInvalid",
        provider: "Corp",
        path: "/x.pem",
        reason: "notPem",
        cause: "no block",
      }),
    ).toEqual({
      message: "The CA file of Corp is not a PEM certificate: /x.pem",
      detail: "no block",
    });
    expect(
      describeProviderError({ kind: "caFileInvalid", provider: "Corp", path: "x.pem", reason: "relative" }),
    ).toEqual({
      message: "The CA file of Corp must be an absolute path or start with ~/: x.pem",
    });
  });

  test("names an unsupported compression instead of a wrong base URL, in listing and chat alike", () => {
    expect(describeProviderError({ kind: "invalidResponse", provider: "Corp", detail: "", encoding: "zstd" })).toEqual({
      message: "Corp answered with a compression that broke-code cannot read (Content-Encoding: zstd).",
    });
  });
});

describe("formatConversationDate", () => {
  const noon = new Date(2026, 10, 8, 12).getTime();

  test("writes the date in the display language", () => {
    expect(formatConversationDate(noon, "en")).toContain("Nov 8, 2026");
    expect(formatConversationDate(noon, "fr")).toContain("8 nov. 2026");
  });

  test("falls back to the runtime's language for a tag it cannot use", () => {
    expect(formatConversationDate(noon, "not a tag!")).toContain("2026");
  });
});

describe("describeStorageProblem", () => {
  test("says what failed, with the runtime cause as detail", () => {
    expect(describeStorageProblem({ kind: "saveFailed", cause: "Error: ENOSPC" })).toEqual({
      message: "Could not save the conversation.",
      detail: "Error: ENOSPC",
    });
  });

  test("says a conversation to open is gone, with no detail", () => {
    expect(describeStorageProblem({ kind: "notFound" })).toEqual({
      message: "This conversation is missing or unreadable; it was removed from the list.",
    });
  });
});

describe("describeContextUsage", () => {
  test("writes the estimate, the size, and the share used, in the display language", () => {
    expect(describeContextUsage({ used: 12345, size: 32768, known: true }, "en")).toBe("12,345 / 32,768 tokens (38%)");
    expect(describeContextUsage({ used: 12345, size: 32768, known: true }, "fr")).toBe(
      "12\u202f345 / 32\u202f768 tokens (38\u00a0%)",
    );
  });

  test("falls back to the runtime's language for a tag it cannot use", () => {
    expect(describeContextUsage({ used: 0, size: 1000, known: false }, "not a tag!")).toContain("0%");
  });
});

describe("describeContextTitle", () => {
  test("names the estimate, then the reported counts in the display language when there are any", () => {
    expect(describeContextTitle({ used: 1, size: 2, known: true }, "en")).toBe("Estimated size of the next request");
    const reported = { used: 1, size: 2, known: true, reported: { prompt: 12001, completion: 345 } };
    expect(describeContextTitle(reported, "fr")).toBe(
      "Estimated size of the next request. Last reply: 12\u202f001 prompt tokens, 345 completion tokens",
    );
  });
});

describe("describeSkillWarning", () => {
  test("names the file and each problem", () => {
    const path = "app/.agents/skills/x/SKILL.md";
    const text = (problem: SkillProblem) => describeSkillWarning({ path, problem });
    const prefix = `Skill ${path} is skipped: `;
    expect(text({ kind: "noFrontmatter" })).toBe(`${prefix}it has no frontmatter between --- lines.`);
    expect(text({ kind: "missingName" })).toBe(`${prefix}it lacks a name.`);
    expect(text({ kind: "nameTooLong" })).toBe(`${prefix}its name is longer than 64 characters.`);
    expect(text({ kind: "invalidName" })).toBe(
      `${prefix}its name is not lowercase letters, digits, and single hyphens, with no hyphen at either end.`,
    );
    expect(text({ kind: "nameMismatch", name: "y", directory: "x" })).toBe(
      `${prefix}its name y differs from its folder x.`,
    );
    expect(text({ kind: "unparsableField", field: "description" })).toBe(
      `${prefix}its description cannot be read; write it as plain, quoted, or > or | block text.`,
    );
    expect(text({ kind: "missingDescription" })).toBe(`${prefix}it lacks a description.`);
    expect(text({ kind: "descriptionTooLong" })).toBe(`${prefix}its description is longer than 1024 characters.`);
    expect(text({ kind: "tooLarge" })).toBe(`${prefix}the file is over 1 MiB.`);
    expect(text({ kind: "binary" })).toBe(`${prefix}the file is not text.`);
    expect(text({ kind: "outsideWorkspace" })).toBe(`${prefix}it links outside the workspace.`);
    expect(text({ kind: "unreadable", cause: "EACCES" })).toBe(`${prefix}the file cannot be read (EACCES).`);
  });

  test("names the skills folder whose entries past the cap are skipped", () => {
    expect(describeSkillWarning({ path: ".agents/skills", problem: { kind: "tooManyEntries", entries: 5000 } })).toBe(
      "Some skills in .agents/skills are skipped: the folder holds 5000 entries, and only the first 200 by name are read.",
    );
  });
});

describe("describeFold", () => {
  const user: ChatEntry = { role: "user", content: "Hi", mentions: [] };
  const reply: ChatEntry = { role: "assistant", reasoning: "", content: "Done.", status: "done" };
  const step = (name: string, args: Record<string, string> = {}, extra: Partial<ChatEntry & { role: "tool" }> = {}) =>
    ({ role: "tool", name, args, status: "ok", text: "x", ...extra }) as ChatEntry;
  const read = (path: string) => step("read_file", { path });
  const list = (path: string) => step("list_files", { path });
  const search = () => step("search", { pattern: "x" });
  const skill = () => step("load_skill", { name: "s" });
  const edit = (path: string, extra: Partial<ChatEntry & { role: "tool" }> = {}) => step("edit_file", { path }, extra);
  const command = (extra: Partial<ChatEntry & { role: "tool" }> = {}) => step("run_command", { command: "ls" }, extra);
  const malformed = () => step("read_file", {}, { status: "malformed", text: "Malformed." });

  /** The row of the fold of one ended turn holding `steps`. */
  function rowOf(...steps: ChatEntry[]): string {
    const part = foldTurns([user, ...steps, reply]).find((each) => each.kind === "fold");
    if (part?.kind !== "fold") throw new Error("no fold");
    return describeFold(part.counts);
  }

  /** Counts with `steps` steps of one kind, each its own path, and the failed and rejected ones. */
  function countsOf(kind: StepKind | "other", steps: number, failed = 0, rejected = 0): FoldCounts {
    const kinds = Object.fromEntries(STEP_KINDS.map((each) => [each, { shown: 0, steps: 0 }])) as FoldCounts["kinds"];
    if (kind !== "other") kinds[kind] = { shown: steps, steps };
    return { steps, failed, rejected, kinds, otherSteps: kind === "other" ? steps : 0 };
  }

  const table = () => ({
    first: rowOf(read("a.ts"), read("b.ts"), read("c.ts"), edit("x.ts"), edit("x.ts"), command()),
    sixth: rowOf(
      read("a.ts"),
      list("src"),
      search(),
      skill(),
      malformed(),
      malformed(),
      malformed(),
      step("write_file", {}, { status: "error", text: "Plan mode." }),
    ),
  });

  test("words each row of the contract's table", () => {
    expect(table().first).toBe("Read 3 files, edited 1 file, ran 1 command");
    const bigLog = read("big.log");
    expect(rowOf(bigLog, bigLog, bigLog, bigLog, command())).toBe("Read 1 file, ran 1 command");
    expect(
      rowOf(
        read("a.ts"),
        read("b.ts"),
        list("."),
        search(),
        search(),
        search(),
        search(),
        skill(),
        edit("x.ts"),
        edit("x.ts"),
        edit("y.ts"),
      ),
    ).toBe("Read 2 files, searched 4 times, edited 2 files, 2 other steps");
    expect(rowOf(read("a.ts"), list("."), search(), skill(), edit("a.ts"), command())).toBe(
      "Read 1 file, edited 1 file, ran 1 command, 3 other steps",
    );
    const fiveEdits = Array.from({ length: 5 }, () => edit("a.ts"));
    expect(rowOf(read("a.ts"), read("b.ts"), list("."), list("src"), search(), search(), ...fiveEdits, command())).toBe(
      "Read 2 files, edited 1 file, ran 1 command, 4 other steps",
    );
    expect(table().sixth).toBe("Read 1 file, listed 1 folder, searched 1 time, 5 other steps, 4 failed");
    expect(rowOf(list("."), command({ status: "error", approval: "rejected" }))).toBe(
      "Listed 1 folder, ran 1 command, 1 rejected",
    );
    expect(rowOf(malformed(), malformed())).toBe("2 steps, 2 failed");
    expect(rowOf(step("write_file", { path: "a.ts" }, { undone: true }), step("write_file", { path: "a.ts" }))).toBe(
      "Edited 1 file",
    );
  });

  test("counts an ask_user step among the other steps", () => {
    const ask = step("ask_user", { question: "Which file?" }, { text: "The user answered: a.ts" });
    expect(rowOf(read("a.ts"), ask)).toBe("Read 1 file, 1 other step");
    expect(rowOf(ask, ask)).toBe("2 steps");
  });

  test("words each kind in the singular and the plural", () => {
    const rows: [StepKind | "other", string, string][] = [
      ["read", "Read 1 file", "Read 2 files"],
      ["listed", "Listed 1 folder", "Listed 2 folders"],
      ["searched", "Searched 1 time", "Searched 2 times"],
      ["loaded", "Loaded 1 skill", "Loaded 2 skills"],
      ["edited", "Edited 1 file", "Edited 2 files"],
      ["ran", "Ran 1 command", "Ran 2 commands"],
    ];
    for (const [kind, one, two] of rows) {
      expect(describeFold(countsOf(kind, 1))).toBe(one);
      expect(describeFold(countsOf(kind, 2))).toBe(two);
    }
    const oneOther = countsOf("read", 1);
    oneOther.otherSteps = 1;
    oneOther.steps = 2;
    expect(describeFold(oneOther)).toBe("Read 1 file, 1 other step");
    expect(describeFold(countsOf("other", 3))).toBe("3 steps");
  });

  test("adds the failed and the rejected ones when there are any", () => {
    expect(describeFold(countsOf("ran", 3, 1))).toBe("Ran 3 commands, 1 failed");
    expect(describeFold(countsOf("ran", 3, 2, 1))).toBe("Ran 3 commands, 2 failed, 1 rejected");
    expect(describeFold(countsOf("ran", 4, 0, 1))).toBe("Ran 4 commands, 1 rejected");
    expect(describeFold(countsOf("ran", 5, 0, 2))).toBe("Ran 5 commands, 2 rejected");
  });

  test("reads in French with the French bundle loaded", () => {
    l10n.config({ contents: french });
    try {
      expect(table().first).toBe("3 fichiers lus, 1 fichier modifié, 1 commande exécutée");
      expect(table().sixth).toBe("1 fichier lu, 1 dossier listé, 1 recherche, 5 autres étapes, 4 échecs");
      expect(describeFold(countsOf("other", 2, 0, 2))).toBe("2 étapes, 2 refus");
    } finally {
      l10n.config({ contents: {} });
    }
  });
});

describe("describeHalt", () => {
  test("a summary halted on a full context says it was not summarized, without naming /compact", () => {
    expect(describeHalt("contextFull", true)).toBe(
      "Not summarized: the conversation does not fit the model's context, even with its tool results left out. Start a new chat with New chat.",
    );
  });

  test("an agent turn halted on a full context names /compact and New chat", () => {
    expect(describeHalt("contextFull")).toBe(
      "Stopped: the conversation fills the model's context. Summarize it with /compact, or start a new chat with New chat.",
    );
  });

  test("a summary keeps the turn's wording for any other reason", () => {
    expect(describeHalt("stepLimit", true)).toBe("Stopped: the agent turn reached its tool step limit.");
  });
});

describe("describeUndoOutcome", () => {
  test("tells all restored, some skipped, and nothing restored apart", () => {
    expect(
      describeUndoOutcome([
        { path: "a", status: "restored" },
        { path: "b", status: "removed" },
      ]),
    ).toBe("Changes undone.");
    expect(
      describeUndoOutcome([
        { path: "a", status: "removed" },
        { path: "b", status: "skipped", reason: "symlink" },
      ]),
    ).toBe("Some changes were not undone. Undo changes again to retry the files skipped.");
    expect(describeUndoOutcome([{ path: "b", status: "skipped", reason: "outsideWorkspace" }])).toBe(
      "No change was undone. Undo changes again to retry the files skipped.",
    );
  });
});

describe("describeUndoFailure", () => {
  test("says the undo failed and how to retry, with the error as detail", () => {
    expect(describeUndoFailure("editor check broke")).toEqual({
      message: "Undo changes failed unexpectedly. Undo changes again to retry the files not yet undone.",
      detail: "editor check broke",
    });
  });
});

describe("describeToolStep", () => {
  const step = { role: "tool", name: "edit_file", args: { path: "a.ts" }, status: "ok", text: "done\n" } as const;

  test("an undone step says so first, its approval and line count unchanged", () => {
    expect(describeToolStep({ ...step, undone: true })).toBe("undone, ok, 1 line");
    expect(describeToolStep({ ...step, approval: "auto", undone: true })).toBe("undone, auto-approved, ok, 1 line");
    expect(describeToolStep({ ...step, approval: "accepted", undone: true })).toBe("undone, ok, 1 line");
    expect(describeToolStep({ ...step, approval: "auto" })).toBe("auto-approved, ok, 1 line");
  });
});

describe("mainArgument", () => {
  test("an ask_user row shows the first line of its question, whichever argument the model wrote first", () => {
    const question = "  Which load do you mean?  \nBoth files define one.";
    expect(mainArgument("ask_user", { options: "a.ts\nb.ts", question })).toBe("Which load do you mean?");
    expect(mainArgument("ask_user", { question, options: "a.ts\nb.ts" })).toBe("Which load do you mean?");
    expect(mainArgument("ask_user", { question: "\n\nWhich file?" })).toBe("Which file?");
  });

  test("an ask_user row without a question shows no argument, never its options", () => {
    expect(mainArgument("ask_user", { options: "a.ts\nb.ts" })).toBeUndefined();
    expect(mainArgument("ask_user", { question: "  \n ", options: "a.ts" })).toBeUndefined();
  });

  test("another tool shows its pattern, else its path, else the first value given", () => {
    expect(mainArgument("search", { path: "src", pattern: "load" })).toBe("load");
    expect(mainArgument("list_files", { path: "src" })).toBe("src");
    expect(mainArgument("load_skill", { name: "review" })).toBe("review");
  });
});

describe("describeUndoneFile", () => {
  /** The parts as one string, each path in backticks, to read the sentence at a glance. */
  const flat = (file: Parameters<typeof describeUndoneFile>[0]) =>
    describeUndoneFile(file)
      .map((part) => ("path" in part ? `\`${part.path}\`` : part.text))
      .join("");

  test("names the file and what happened to it, with the reason it was skipped", () => {
    expect(flat({ path: "a.ts", status: "restored" })).toBe("`a.ts`: restored");
    expect(flat({ path: "a.ts", status: "removed" })).toBe("`a.ts`: removed, since this turn created it");
    expect(flat({ path: "a.ts", status: "skipped", reason: "changed" })).toBe(
      "`a.ts`: skipped, it changed since this turn wrote it",
    );
    expect(flat({ path: "a.ts", status: "skipped", reason: "unsaved" })).toBe(
      "`a.ts`: skipped, it has unsaved changes in an editor",
    );
    expect(flat({ path: "a.ts", status: "skipped", reason: "symlink" })).toBe(
      "`a.ts`: skipped, it is now a symbolic link",
    );
    expect(flat({ path: "a.ts", status: "skipped", reason: "outsideWorkspace" })).toBe(
      "`a.ts`: skipped, it is no longer inside the workspace folders",
    );
    expect(flat({ path: "a.ts", status: "skipped", reason: "failed", cause: "ENOSPC" })).toBe(
      "`a.ts`: skipped, it could not be restored (ENOSPC)",
    );
  });

  test("gives each path a part of its own, apart from the prose", () => {
    expect(describeUndoneFile({ path: "src/a b.ts", status: "restored" })).toEqual([
      { path: "src/a b.ts" },
      { text: ": restored" },
    ]);
  });

  test("adds the temporary file left behind, as a path of its own", () => {
    const leftover = { name: ".a.ts.broke-code-1.tmp", cause: "EPERM" };
    expect(describeUndoneFile({ path: "a.ts", status: "restored", leftover })).toEqual([
      { path: "a.ts" },
      { text: ": restored; its temporary file " },
      { path: ".a.ts.broke-code-1.tmp" },
      { text: " could not be removed (EPERM)" },
    ]);
  });
});

describe("describeAnnouncement", () => {
  const ask: ChatEntry = { role: "user", content: "Fix it", mentions: [] };
  const reply = (status: Extract<ChatEntry, { role: "assistant" }>["status"], extra = {}): ChatEntry => ({
    role: "assistant",
    reasoning: "",
    content: "Done",
    status,
    ...extra,
  });
  const state = (entries: ChatEntry[], extra: Partial<ChatState> = {}): ChatState =>
    ({ conversationId: "c", entries, ...extra }) as ChatState;

  test("names the call that waits for a decision, once per request", () => {
    const before = state([ask, reply("streaming")]);
    const command = state([ask, reply("streaming")], {
      approval: { id: 1, kind: "command", tool: "run_command", summary: "bun test" },
    });
    expect(describeAnnouncement(before, command)).toBe("Waiting for your decision: run bun test");
    expect(describeAnnouncement(command, { ...command })).toBeUndefined();
    const write = state([ask, reply("streaming")], {
      approval: { id: 2, kind: "write", tool: "edit_file", summary: "src/a.ts" },
    });
    expect(describeAnnouncement(command, write)).toBe("Waiting for your decision: edit_file on src/a.ts");
  });

  test("reads the agent's question", () => {
    const asked = state([ask, reply("streaming")], { question: { id: 3, question: "Which file?", options: [] } });
    expect(describeAnnouncement(state([ask, reply("streaming")]), asked)).toBe("The agent asks: Which file?");
  });

  describe("a call, through the states the controller publishes", () => {
    const run = { name: "run_command", args: { command: "bun test" }, start: 0, end: 4 };
    const approval = { id: 1, kind: "command" as const, tool: "run_command", summary: "bun test" };
    const step: ChatEntry = { role: "tool", name: "run_command", args: run.args, status: "ok", text: "ok" };
    const flight = state([ask, reply("streaming")]);
    /** The call shown, not running: a command asks before it runs. */
    const shown = state([ask, reply("streaming", { call: run })], { callRunning: false });
    const deciding = state([ask, reply("streaming", { call: run })], { approval, callRunning: false });
    /** The step and the next reply, which land in one update. */
    const stepped = state([ask, reply("done", { call: run }), step, reply("waiting")], { callRunning: false });
    /** Announcements of each state after the one before it. */
    const heard = (states: ChatState[]) =>
      states.slice(1).map((next, index) => describeAnnouncement(states[index]!, next));

    test("a call that never asks is named as it shows, once", () => {
      const read = { name: "read_file", args: { path: "src/a.ts" }, start: 0, end: 4 };
      const reading = state([ask, reply("streaming", { call: read })], { callRunning: true });
      expect(heard([flight, reading, { ...reading }])).toEqual(["Running read_file on src/a.ts", undefined]);
    });

    test("a command is named once Run is accepted, never before its request opens", () => {
      const running = state([ask, reply("streaming", { call: run })], { callRunning: true });
      expect(heard([flight, shown, deciding, running, stepped])).toEqual([
        undefined,
        "Waiting for your decision: run bun test",
        "Running bun test",
        undefined,
      ]);
    });

    test("a rejected command is never named as running", () => {
      expect(heard([flight, shown, deciding, shown, stepped])).toEqual([
        undefined,
        "Waiting for your decision: run bun test",
        undefined,
        undefined,
      ]);
    });

    test("Stop on an open request says Stopped, never Running", () => {
      const stopped = state([ask, reply("stopped", { call: run })], { callRunning: false });
      expect(heard([flight, shown, deciding, shown, stopped])).toEqual([
        undefined,
        "Waiting for your decision: run bun test",
        undefined,
        "Stopped",
      ]);
    });

    test("an answered question is never named as running", () => {
      const asking = { name: "ask_user", args: { question: "Which file?" }, start: 0, end: 4 };
      const question = { id: 2, question: "Which file?", options: [] };
      const asked = state([ask, reply("streaming", { call: asking })], { callRunning: false });
      const open = state([ask, reply("streaming", { call: asking })], { question, callRunning: false });
      expect(heard([flight, asked, open, asked])).toEqual([undefined, "The agent asks: Which file?", undefined]);
    });
  });

  test("says how the reply in flight ended", () => {
    const flight = state([ask, reply("streaming")]);
    expect(describeAnnouncement(flight, state([ask, reply("done")]))).toBe("Reply finished.");
    expect(describeAnnouncement(flight, state([ask, reply("stopped")]))).toBe("Stopped");
    expect(describeAnnouncement(flight, state([ask, reply("halted", { haltReason: "stepLimit" })]))).toBe(
      describeHalt("stepLimit"),
    );
  });

  test("stays quiet on a failure, a reply ending on a call, another conversation, or nothing new", () => {
    const flight = state([ask, reply("streaming")]);
    expect(describeAnnouncement(flight, state([ask, reply("failed")]))).toBeUndefined();
    const call = { name: "read_file", args: { path: "a" }, start: 0, end: 4 };
    expect(describeAnnouncement(flight, state([ask, reply("done", { call })]))).toBeUndefined();
    expect(describeAnnouncement(flight, { ...state([ask, reply("done")]), conversationId: "d" })).toBeUndefined();
    const ended = state([ask, reply("done")]);
    expect(describeAnnouncement(ended, { ...ended })).toBeUndefined();
  });

  test("is worded in French with the French bundle", () => {
    l10n.config({ contents: french });
    try {
      const flight = state([ask, reply("streaming")]);
      expect(describeAnnouncement(flight, state([ask, reply("done")]))).toBe("Réponse terminée.");
    } finally {
      l10n.config({ contents: {} });
    }
  });
});
