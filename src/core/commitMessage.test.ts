import { describe, expect, test } from "bun:test";
import type { ChatOutcome, ProviderAccess, StreamChatOptions } from "./client";
import {
  CommitMessageGenerator,
  type CommitMessagePorts,
  type CommitRepository,
  type CommitSelection,
  cleanCommitMessage,
  composeCommitRequest,
  type RepositoryLookup,
} from "./commitMessage";
import { estimateTokens } from "./limits";
import type { ErrorText } from "./providerError";

/** A file's section of a `git diff --cached`, `lines` added lines of 39 characters each, plus their line breaks. */
function fileDiff(name: string, lines: number): string {
  const header = `diff --git a/${name} b/${name}\nindex 1111111..2222222 100644\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1,${lines} @@\n`;
  return header + `+${"x".repeat(38)}\n`.repeat(lines);
}

describe("composeCommitRequest", () => {
  test("sends a system prompt asking for an English Conventional Commits message, then the diff, and no tool", () => {
    const diff = fileDiff("src/a.ts", 3);
    const request = composeCommitRequest(diff, 32_768);
    if (request.kind !== "ok") throw new Error(request.kind);
    const [system, user] = request.messages;
    expect(request.messages).toHaveLength(2);
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("Conventional Commits");
    expect(system?.content).toContain("English");
    expect(system?.content).toContain("72 characters");
    expect(system?.content).toContain("why");
    expect(system?.content).not.toContain("<tool_result");
    expect(system?.content).not.toContain("read_file");
    expect(user).toEqual({ role: "user", content: diff });
    expect(request.partial).toBe(false);
  });

  test("never lets the request's estimate pass 28,672 tokens for a context of 32,768", () => {
    for (const lines of [2_900, 2_930, 2_950, 3_000, 10_000]) {
      const request = composeCommitRequest(fileDiff("a.ts", 1) + fileDiff("big.ts", lines), 32_768);
      if (request.kind !== "ok") throw new Error(request.kind);
      expect(estimateTokens(request.messages)).toBeLessThanOrEqual(28_672);
      const characters = request.messages.reduce((total, message) => total + message.content.length, 0);
      expect(characters).toBeLessThanOrEqual(114_688);
    }
  });

  test("keeps whole files in order while they fit, cuts between files, and flags the request partial", () => {
    const first = fileDiff("first.ts", 1_000);
    const second = fileDiff("second.ts", 1_000);
    const third = fileDiff("third.ts", 1_000);
    const request = composeCommitRequest(first + second + third, 32_768);
    if (request.kind !== "ok") throw new Error(request.kind);
    const sent = request.messages[1]?.content ?? "";
    expect(sent.startsWith(first + second)).toBe(true);
    expect(sent).not.toContain("third.ts");
    expect(sent).toContain("cut");
    expect(request.partial).toBe(true);
  });

  test("cuts a single file that alone exceeds the room, and flags the request partial", () => {
    const big = fileDiff("big.ts", 5_000);
    const request = composeCommitRequest(big, 32_768);
    if (request.kind !== "ok") throw new Error(request.kind);
    const sent = request.messages[1]?.content ?? "";
    const kept = sent.slice(0, sent.indexOf("\n\n["));
    expect(big.startsWith(kept)).toBe(true);
    expect(kept.length).toBeGreaterThan(100_000);
    expect(request.partial).toBe(true);
    expect(estimateTokens(request.messages)).toBeLessThanOrEqual(28_672);
  });

  test("never splits a character written as two UTF-16 units when it cuts inside a line", () => {
    // [>]: Two line starts of opposite parity, so one of them puts the room inside a pair.
    for (const lead of ["+", "+ "]) {
      const request = composeCommitRequest(`diff --git a/e b/e\n${lead}${"😀".repeat(70_000)}\n`, 32_768);
      if (request.kind !== "ok") throw new Error(request.kind);
      const sent = request.messages[1]?.content ?? "";
      expect(sent).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(sent.length).toBeGreaterThan(100_000);
      expect(request.partial).toBe(true);
    }
  });

  test("refuses a context too small to hold the prompt and any of the diff", () => {
    expect(composeCommitRequest(fileDiff("a.ts", 1), 100)).toEqual({ kind: "contextTooSmall" });
  });
});

describe("cleanCommitMessage", () => {
  test("keeps a plain message, trimmed", () => {
    expect(cleanCommitMessage("\n  feat: add x\n\nBecause y.\n  ")).toBe("feat: add x\n\nBecause y.");
  });

  test("unwraps a code fence around the whole reply, with or without a language", () => {
    expect(cleanCommitMessage("```\nfix: a\n```")).toBe("fix: a");
    expect(cleanCommitMessage("Staged: one file.\n</think>\n\nfix: a")).toBe("fix: a");
    expect(cleanCommitMessage("```text\nfix: a\n\nWhy.\n```\n")).toBe("fix: a\n\nWhy.");
    expect(cleanCommitMessage("~~~git\nfix: a\n~~~")).toBe("fix: a");
    expect(cleanCommitMessage("```text\n```\nfix: a\n```\n```")).toBe("fix: a");
    expect(cleanCommitMessage("~~~text\n~~~\nfix: a\n~~~\n~~~")).toBe("fix: a");
  });

  test("keeps a fence that wraps only part of the reply", () => {
    expect(cleanCommitMessage("fix: a\n\n```\ncode\n```")).toBe("fix: a\n\n```\ncode\n```");
  });

  test("unwraps quotes around the whole reply", () => {
    expect(cleanCommitMessage('"fix: a"')).toBe("fix: a");
    expect(cleanCommitMessage("'fix: a'")).toBe("fix: a");
    expect(cleanCommitMessage("“fix: a”")).toBe("fix: a");
    expect(cleanCommitMessage("`fix: a`")).toBe("fix: a");
  });

  test("keeps quotes that do not wrap the whole reply", () => {
    expect(cleanCommitMessage('fix: quote "x"')).toBe('fix: quote "x"');
    expect(cleanCommitMessage('fix: "a" and "b"')).toBe('fix: "a" and "b"');
  });

  test("unwraps quotes around the whole reply whatever the interior holds", () => {
    expect(cleanCommitMessage('"fix: handle the "cancel" action"')).toBe('fix: handle the "cancel" action');
    expect(cleanCommitMessage("'fix: don't discard staged changes'")).toBe("fix: don't discard staged changes");
  });

  test("unwraps nested wrappers until none is left", () => {
    expect(cleanCommitMessage('"```text\nfix: handle cancel\n```"')).toBe("fix: handle cancel");
    expect(cleanCommitMessage("\"```\n'fix: a'\n```\"")).toBe("fix: a");
  });

  test("drops <think> text anywhere, an unclosed one to the end", () => {
    expect(cleanCommitMessage("<think>hmm</think>\nfix: a")).toBe("fix: a");
    expect(cleanCommitMessage("fix: a\n<think>more\nthought</think>")).toBe("fix: a");
    expect(cleanCommitMessage("fix: a\n<think>never closed")).toBe("fix: a");
    expect(cleanCommitMessage("<think>x</think>```\nfix: a\n```")).toBe("fix: a");
  });

  test("gives undefined for a reply with no message once cleaned", () => {
    expect(cleanCommitMessage("")).toBeUndefined();
    expect(cleanCommitMessage("  \n ")).toBeUndefined();
    expect(cleanCommitMessage("<think>only</think>")).toBeUndefined();
    expect(cleanCommitMessage("```\n\n```")).toBeUndefined();
    expect(cleanCommitMessage('""')).toBeUndefined();
  });
});

describe("CommitMessageGenerator", () => {
  const english = { t: (message: string, ...args: (string | number | boolean)[]) => format(message, args) };
  const access: ProviderAccess = {
    provider: { name: "Ollama", baseUrl: "http://localhost:11434/v1" },
    apiKey: undefined,
  };
  const diff = fileDiff("src/a.ts", 2);

  /** A repository whose input box starts with `box`; `writes` records every write. */
  function fakeRepository(box = "", staged = diff) {
    const repository = {
      root: "/work/app",
      name: "app",
      box,
      writes: [] as string[],
      readInputBox: () => repository.box,
      writeInputBox: (message: string) => {
        repository.writes.push(message);
        repository.box = message;
      },
      stagedDiff: async () => staged,
    };
    return repository;
  }

  /**
   * Ports that record what the flow did. `reply` answers each request: the outcome, after pushing its `content`, or a
   * promise the test settles. `confirm` answers the replace question; `cancel` aborts the progress notification.
   */
  function fakePorts(options: {
    reply?: (request: StreamChatOptions) => Promise<ChatOutcome>;
    confirm?: boolean | Promise<boolean> | (() => Promise<boolean>);
    selection?: CommitSelection | undefined;
  }) {
    const calls = {
      requests: [] as StreamChatOptions[],
      errors: [] as ErrorText[],
      warnings: [] as string[],
      questions: 0,
      progress: 0,
      cancel: () => {},
    };
    const selection = "selection" in options ? options.selection : { access, model: "qwen", contextSize: 32_768 };
    const ports: CommitMessagePorts = {
      selection: async () => selection,
      stream: (_access, request) => {
        calls.requests.push(request);
        return options.reply ? options.reply(request) : answer("feat: add a")(request);
      },
      confirmReplace: async () => {
        calls.questions++;
        const { confirm } = options;
        return typeof confirm === "function" ? confirm() : (confirm ?? true);
      },
      withProgress: (task) => {
        calls.progress++;
        const cancel = new AbortController();
        calls.cancel = () => cancel.abort();
        return task(cancel.signal);
      },
      showError: (text) => calls.errors.push(text),
      showWarning: (message) => calls.warnings.push(message),
    };
    return { ports, calls };
  }

  function answer(content: string, reasoning = "") {
    return async (request: StreamChatOptions): Promise<ChatOutcome> => {
      if (reasoning) request.onReasoning(reasoning);
      request.onContent(content);
      return { status: "done" };
    };
  }

  /** A reply that waits until the request's signal aborts, then ends `stopped`, as `streamChat` does. */
  function untilAborted(request: StreamChatOptions): Promise<ChatOutcome> {
    return new Promise((resolve) => {
      request.signal.addEventListener("abort", () => resolve({ status: "stopped" }), { once: true });
    });
  }

  const found = (repository: CommitRepository) => async (): Promise<RepositoryLookup> => ({
    kind: "found",
    repository,
  });

  test("writes the cleaned reply, without its reasoning, to the input box once, from the diff and the selected model", async () => {
    const repository = fakeRepository();
    const { ports, calls } = fakePorts({ reply: answer("```\nfeat: add a\n```", "thinking") });
    await new CommitMessageGenerator(ports, english).run(found(repository));
    expect(repository.writes).toEqual(["feat: add a"]);
    expect(calls.requests).toHaveLength(1);
    expect(calls.requests[0]?.model).toBe("qwen");
    expect(calls.requests[0]?.messages[1]?.content).toBe(diff);
    expect(calls.progress).toBe(1);
    expect(calls.questions).toBe(0);
    expect(calls.errors).toEqual([]);
    expect(calls.warnings).toEqual([]);
  });

  test("says the message covers only part of the changes when the diff was cut", async () => {
    const repository = fakeRepository("", fileDiff("big.ts", 5_000));
    const { ports, calls } = fakePorts({});
    await new CommitMessageGenerator(ports, english).run(found(repository));
    expect(repository.writes).toEqual(["feat: add a"]);
    expect(calls.warnings).toEqual([
      "The commit message covers only part of the staged changes: the diff did not fit the model's context.",
    ]);
  });

  test("says why when nothing is staged, and sends nothing", async () => {
    const repository = fakeRepository("", "");
    const { ports, calls } = fakePorts({});
    await new CommitMessageGenerator(ports, english).run(found(repository));
    expect(calls.errors).toEqual([{ message: "Nothing is staged in app. Stage the changes to describe first." }]);
    expect(calls.requests).toEqual([]);
    expect(repository.writes).toEqual([]);
  });

  test("says why when no repository is found or the Git extension cannot be used, and sends nothing", async () => {
    const cases: [RepositoryLookup["kind"], string][] = [
      ["noRepository", "No git repository is open in this window."],
      ["gitUnavailable", "The Git extension is not available. Check that the built-in Git extension is enabled."],
      [
        "gitDisabled",
        "The Git extension is disabled: git is turned off in the settings (git.enabled), or git was not found.",
      ],
    ];
    for (const [kind, message] of cases) {
      const { ports, calls } = fakePorts({});
      await new CommitMessageGenerator(ports, english).run(async () => ({ kind }) as RepositoryLookup);
      expect(calls.errors).toEqual([{ message }]);
      expect(calls.requests).toEqual([]);
    }
  });

  test("does nothing when the repository pick is dismissed", async () => {
    const { ports, calls } = fakePorts({});
    await new CommitMessageGenerator(ports, english).run(async () => ({ kind: "dismissed" }));
    expect(calls.errors).toEqual([]);
    expect(calls.requests).toEqual([]);
  });

  test("says to choose a provider and a model when none is chosen, and leaves the box untouched", async () => {
    const repository = fakeRepository();
    const { ports, calls } = fakePorts({ selection: undefined });
    await new CommitMessageGenerator(ports, english).run(found(repository));
    expect(calls.errors).toEqual([{ message: "Choose a provider and a model in the broke-code chat first." }]);
    expect(calls.requests).toEqual([]);
    expect(repository.writes).toEqual([]);
  });

  test("shows a provider error with the chat's wording, and leaves the box untouched", async () => {
    const repository = fakeRepository("draft");
    const { ports, calls } = fakePorts({
      reply: async () => ({
        status: "failed",
        error: { kind: "rejected", provider: "Ollama", status: 404, detail: "model 'qwen' not found" },
      }),
    });
    await new CommitMessageGenerator(ports, english).run(found(repository));
    expect(calls.errors).toEqual([
      { message: "Ollama rejected the request (HTTP 404).", detail: "model 'qwen' not found" },
    ]);
    expect(repository.box).toBe("draft");
    expect(repository.writes).toEqual([]);
  });

  test("says the reply held no message when nothing is left once cleaned", async () => {
    const repository = fakeRepository();
    const { ports, calls } = fakePorts({ reply: answer("```\n\n```") });
    await new CommitMessageGenerator(ports, english).run(found(repository));
    expect(calls.errors).toEqual([{ message: "The model's reply held no commit message." }]);
    expect(repository.writes).toEqual([]);
  });

  test("says the context is too small when the prompt alone fills it", async () => {
    const repository = fakeRepository();
    const { ports, calls } = fakePorts({ selection: { access, model: "tiny", contextSize: 100 } });
    await new CommitMessageGenerator(ports, english).run(found(repository));
    expect(calls.errors).toEqual([
      {
        message:
          "The context size of tiny is too small for a commit message request. Set a larger one in brokeCode.contextSizes.",
      },
    ]);
    expect(calls.requests).toEqual([]);
  });

  test("asks before replacing text in the box, and replaces it on Accept", async () => {
    const repository = fakeRepository("wip");
    const { ports, calls } = fakePorts({ confirm: true });
    await new CommitMessageGenerator(ports, english).run(found(repository));
    expect(calls.questions).toBe(1);
    expect(repository.writes).toEqual(["feat: add a"]);
  });

  test("a refusal to replace sends no request and leaves the box untouched", async () => {
    const repository = fakeRepository("wip");
    const { ports, calls } = fakePorts({ confirm: false });
    await new CommitMessageGenerator(ports, english).run(found(repository));
    expect(calls.questions).toBe(1);
    expect(calls.requests).toEqual([]);
    expect(calls.progress).toBe(0);
    expect(repository.writes).toEqual([]);
  });

  /** A reply that waits for `release`, letting the test type in the box meanwhile, then answers `feat: add a`. */
  function heldReply() {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const reply = async (request: StreamChatOptions): Promise<ChatOutcome> => {
      await held;
      return answer("feat: add a")(request);
    };
    return { reply, release };
  }

  test("asks again when the box changed during the run; a refusal keeps the user's text", async () => {
    const repository = fakeRepository();
    const { reply, release } = heldReply();
    const { ports, calls } = fakePorts({ reply, confirm: false });
    const run = new CommitMessageGenerator(ports, english).run(found(repository));
    await waitFor(() => calls.requests.length === 1);
    repository.box = "typed meanwhile";
    release();
    await run;
    expect(calls.questions).toBe(1);
    expect(repository.box).toBe("typed meanwhile");
    expect(repository.writes).toEqual([]);
    expect(calls.errors).toEqual([]);
  });

  test("asks again when the box changed during the run; acceptance writes the message once", async () => {
    const repository = fakeRepository("wip");
    const { reply, release } = heldReply();
    const { ports, calls } = fakePorts({ reply, confirm: true });
    const run = new CommitMessageGenerator(ports, english).run(found(repository));
    await waitFor(() => calls.requests.length === 1);
    repository.box = "wip, edited";
    release();
    await run;
    expect(calls.questions).toBe(2);
    expect(repository.writes).toEqual(["feat: add a"]);
  });

  test("an unchanged box is not asked about a second time", async () => {
    const repository = fakeRepository("wip");
    const { ports, calls } = fakePorts({ confirm: true });
    await new CommitMessageGenerator(ports, english).run(found(repository));
    expect(calls.questions).toBe(1);
    expect(repository.writes).toEqual(["feat: add a"]);
  });

  test("cancel or deactivation while the second question is open writes nothing", async () => {
    for (const stop of ["cancel", "dispose"] as const) {
      const repository = fakeRepository();
      const { reply, release } = heldReply();
      let accept: (value: boolean) => void = () => {};
      const { ports, calls } = fakePorts({ reply, confirm: () => new Promise((resolve) => (accept = resolve)) });
      const generator = new CommitMessageGenerator(ports, english);
      const run = generator.run(found(repository));
      await waitFor(() => calls.requests.length === 1);
      repository.box = "typed meanwhile";
      release();
      await waitFor(() => calls.questions === 1);
      if (stop === "cancel") calls.cancel();
      else generator.dispose();
      accept(true);
      await run;
      expect(repository.writes).toEqual([]);
      expect(repository.box).toBe("typed meanwhile");
    }
  });

  test("a box holding only whitespace is replaced without asking", async () => {
    const repository = fakeRepository("  \n");
    const { ports, calls } = fakePorts({});
    await new CommitMessageGenerator(ports, english).run(found(repository));
    expect(calls.questions).toBe(0);
    expect(repository.writes).toEqual(["feat: add a"]);
  });

  test("cancel aborts the request and leaves the box untouched, with no message", async () => {
    const repository = fakeRepository("draft");
    const { ports, calls } = fakePorts({ reply: untilAborted });
    const run = new CommitMessageGenerator(ports, english).run(found(repository));
    await waitFor(() => calls.requests.length === 1);
    calls.cancel();
    await run;
    expect(calls.requests[0]?.signal.aborted).toBe(true);
    expect(repository.writes).toEqual([]);
    expect(calls.errors).toEqual([]);
  });

  test("a second run on the same repository while one is in flight is refused; another repository runs", async () => {
    const repository = fakeRepository();
    const other = { ...fakeRepository(), root: "/work/lib", name: "lib" };
    const { ports, calls } = fakePorts({ reply: untilAborted });
    const generator = new CommitMessageGenerator(ports, english);
    const first = generator.run(found(repository));
    await waitFor(() => calls.requests.length === 1);
    await generator.run(found(repository));
    expect(calls.errors).toEqual([{ message: "A commit message is already being generated for app." }]);
    expect(calls.requests).toHaveLength(1);
    const second = generator.run(found(other));
    await waitFor(() => calls.requests.length === 2);
    generator.dispose();
    await Promise.all([first, second]);
  });

  test("a repository is free again once its run ended", async () => {
    const repository = fakeRepository();
    const { ports, calls } = fakePorts({});
    const generator = new CommitMessageGenerator(ports, english);
    await generator.run(found(repository));
    await generator.run(found(repository));
    expect(calls.requests).toHaveLength(2);
    expect(calls.errors).toEqual([]);
  });

  test("deactivation aborts a run in flight and writes nothing", async () => {
    const repository = fakeRepository();
    const { ports, calls } = fakePorts({ reply: untilAborted });
    const generator = new CommitMessageGenerator(ports, english);
    const run = generator.run(found(repository));
    await waitFor(() => calls.requests.length === 1);
    generator.dispose();
    await run;
    expect(calls.requests[0]?.signal.aborted).toBe(true);
    expect(repository.writes).toEqual([]);
    expect(calls.errors).toEqual([]);
  });

  test("deactivation while the replace question is open sends nothing once it is answered", async () => {
    const repository = fakeRepository("wip");
    let accept: (value: boolean) => void = () => {};
    const { ports, calls } = fakePorts({ confirm: new Promise((resolve) => (accept = resolve)) });
    const generator = new CommitMessageGenerator(ports, english);
    const run = generator.run(found(repository));
    await waitFor(() => calls.questions === 1);
    generator.dispose();
    accept(true);
    await run;
    expect(calls.requests).toEqual([]);
    expect(repository.writes).toEqual([]);
  });

  test("a run started after deactivation does nothing", async () => {
    const repository = fakeRepository();
    const { ports, calls } = fakePorts({});
    const generator = new CommitMessageGenerator(ports, english);
    generator.dispose();
    await generator.run(found(repository));
    expect(calls.requests).toEqual([]);
    expect(repository.writes).toEqual([]);
  });

  test("a staged diff that cannot be read says so, and sends nothing", async () => {
    const repository = { ...fakeRepository(), stagedDiff: async () => Promise.reject(new Error("git failed")) };
    const { ports, calls } = fakePorts({});
    await new CommitMessageGenerator(ports, english).run(found(repository));
    expect(calls.errors).toEqual([
      { message: "The staged changes of app could not be read.", detail: "Error: git failed" },
    ]);
    expect(calls.requests).toEqual([]);
  });

  test("cancel or deactivation while the staged diff is read ends quietly, even when the read then fails", async () => {
    for (const stop of ["cancel", "dispose"] as const) {
      let fail: (error: Error) => void = () => {};
      const reading = new Promise<string>((_, reject) => (fail = reject));
      const repository = { ...fakeRepository(), stagedDiff: () => reading };
      const { ports, calls } = fakePorts({});
      const generator = new CommitMessageGenerator(ports, english);
      const run = generator.run(found(repository));
      await waitFor(() => calls.progress === 1);
      if (stop === "cancel") calls.cancel();
      else generator.dispose();
      fail(new Error("git failed"));
      await run;
      expect(calls.errors).toEqual([]);
      expect(calls.requests).toEqual([]);
      expect(repository.writes).toEqual([]);
    }
  });

  test("an unexpected failure is shown, never rejected, and frees the repository", async () => {
    const repository = fakeRepository();
    const { ports, calls } = fakePorts({});
    ports.selection = async () => Promise.reject(new Error("boom"));
    const generator = new CommitMessageGenerator(ports, english);
    await generator.run(found(repository));
    expect(calls.errors).toEqual([{ message: "Could not generate the commit message.", detail: "Error: boom" }]);
    ports.selection = async () => ({ access, model: "qwen", contextSize: 32_768 });
    await generator.run(found(repository));
    expect(repository.writes).toEqual(["feat: add a"]);
  });
});

/** `message` with each `{n}` replaced by `args[n]`, as `l10n.t` does for English. */
function format(message: string, args: (string | number | boolean)[]): string {
  return message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)]));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let tries = 0; !condition(); tries++) {
    if (tries > 1000) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
