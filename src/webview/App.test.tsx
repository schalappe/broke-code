import { beforeEach, describe, expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChangedFile, ChatEntry, ChatState } from "../core/protocol";
import type { ProviderError } from "../core/providerError";
import type { MentionRow } from "./composer";

// [&]: `vscodeApi` calls the webview global on import -> stub it before App loads.
/** Messages the panel posted to the host. */
const posted: unknown[] = [];
(globalThis as { acquireVsCodeApi?: () => { postMessage(message: unknown): void } }).acquireVsCodeApi = () => ({
  postMessage: (message) => posted.push(message),
});
const {
  App,
  ApprovalControls,
  ContextNotice,
  ConversationList,
  EmptyState,
  Header,
  HistoryPanel,
  MentionMenu,
  SlashMenu,
  Warnings,
} = await import("./App");
const { moveHighlight } = await import("./SuggestionMenu");
const { Root } = await import("./Root");

type Reply = ChatEntry & { role: "assistant" };

const CONVERSATION_ID = "0b0d4c1e-8f9a-4c3b-9d2e-1a2b3c4d5e6f";
/** Conversation fields of a state with nothing saved, and the Ask mode. */
const unsaved = {
  mode: "ask" as const,
  modePending: false,
  conversationId: CONVERSATION_ID,
  conversations: [],
  listFailed: undefined,
  storageProblem: undefined,
  context: { used: 0, size: 32768, known: true },
  queue: [],
  undo: { reply: undefined, ranCommand: false, running: false, outcome: undefined },
  changedFiles: [],
};

/** Panel markup for a conversation of one question and `reply`, English strings. */
function render(reply: Omit<Reply, "role">): string {
  const state: ChatState = {
    providers: ["P"],
    skipped: [],
    skillWarnings: [],
    ...unsaved,
    provider: "P",
    models: { status: "loaded", models: ["m"] },
    model: "m",
    entries: [
      { role: "user", content: "Hi", mentions: [] },
      { role: "assistant", ...reply },
    ],
  };
  return renderToStaticMarkup(<App state={state} language="en" />);
}

describe("reasoning block", () => {
  test("is absent from a reply without reasoning", () => {
    expect(render({ reasoning: "", content: "", status: "waiting" })).not.toContain("<details");
    expect(render({ reasoning: "", content: "Hello", status: "done" })).not.toContain("<details");
  });

  test("starts collapsed, labelled Thinking…, and replaces the waiting status while reasoning streams with no answer", () => {
    const html = render({ reasoning: "Plan", content: "", status: "streaming" });
    expect(html).toContain('<details class="reasoning"><summary>');
    expect(html).toContain("Thinking…");
    expect(html).not.toContain(">Reasoning<");
    expect(html).not.toContain("Waiting for the reply…");
  });

  test("is labelled Reasoning once the answer starts", () => {
    const html = render({ reasoning: "Plan", content: "Hello", status: "streaming" });
    expect(html).toContain(">Reasoning<");
    expect(html).not.toContain("Thinking…");
  });

  test("is labelled Reasoning after a reply ends with no answer, beside its Stopped mark or error", () => {
    expect(render({ reasoning: "Plan", content: "", status: "done" })).toContain(">Reasoning<");

    const stopped = render({ reasoning: "Plan", content: "", status: "stopped" });
    expect(stopped).toContain(">Reasoning<");
    expect(stopped).toContain("Stopped");

    const failed = render({
      reasoning: "Plan",
      content: "",
      status: "failed",
      error: { kind: "cutOff", provider: "P", reason: "ended" },
    });
    expect(failed).toContain(">Reasoning<");
    expect(failed).toContain("The reply from P was cut off: the stream ended before the reply was complete.");
    for (const html of [stopped, failed]) expect(html).not.toContain("Thinking…");
  });

  test("shows the reasoning as plain text and the answer as Markdown", () => {
    const html = render({ reasoning: "**plan** <b>x</b>", content: "**Answer**", status: "done" });
    expect(html).toContain("**plan** &lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("<strong>Answer</strong>");
    expect(html).not.toContain("<strong>plan</strong>");
  });
});

describe("agent turn", () => {
  /** Panel markup for one question and `entries` after it, English strings. */
  function renderTurn(entries: ChatEntry[]): string {
    const state: ChatState = {
      providers: ["P"],
      skipped: [],
      skillWarnings: [],
      ...unsaved,
      provider: "P",
      models: { status: "loaded", models: ["m"] },
      model: "m",
      entries: [{ role: "user", content: "Hi", mentions: [] }, ...entries],
    };
    return renderToStaticMarkup(<App state={state} language="en" />);
  }

  const answer = "Let me look.\n<read_file>\n<path>src/a.ts</path>\n</read_file>";
  const callReply: ChatEntry = {
    role: "assistant",
    reasoning: "",
    content: answer,
    status: "done",
    call: { name: "read_file", args: { path: "src/a.ts" }, start: 13, end: answer.length },
  };
  const step: ChatEntry = {
    role: "tool",
    name: "read_file",
    args: { path: "src/a.ts" },
    status: "ok",
    text: "@src/a.ts (file, 3 lines)\n```\nSECRET_RESULT_TEXT\n```",
  };

  test("a step row shows the tool name, its main argument, and the result's status and size", () => {
    const html = renderTurn([callReply, step, { role: "assistant", reasoning: "", content: "Done.", status: "done" }]);
    expect(html).toContain('<details class="step">');
    expect(html).toContain('<span class="step-tool">read_file</span>');
    expect(html).toContain('<span class="step-arg">src/a.ts</span>');
    expect(html).toContain("ok");
    expect(html).toContain("4 lines");
    expect(html.split('<span class="step-tool">').length - 1).toBe(1);
  });

  test("a tool step without a reply before it is still shown, once", () => {
    const html = renderTurn([step]);
    expect(html.split('<span class="step-tool">read_file</span>').length - 1).toBe(1);
    expect(html).toContain("SECRET_RESULT_TEXT");
  });

  test("shows the reply's text outside the call block as Markdown, never the call itself", () => {
    const html = renderTurn([callReply, step]);
    expect(html).toContain("<p>Let me look.</p>");
    expect(html).not.toContain("&lt;read_file&gt;");
  });

  test("keeps the step's result text in the collapsed row, hidden until expanded", () => {
    const html = renderTurn([callReply, step]);
    expect(html).not.toContain('<details class="step" open');
    const summaryEnd = html.indexOf("</summary>", html.indexOf('<details class="step">'));
    expect(html.indexOf("SECRET_RESULT_TEXT")).toBeGreaterThan(summaryEnd);
  });

  test("the main argument of a search is its pattern", () => {
    const html = renderTurn([
      {
        ...callReply,
        call: { name: "search", args: { pattern: "foo\\(", path: "src" }, start: 13, end: answer.length },
      },
      { role: "tool", name: "search", args: { pattern: "foo\\(", path: "src" }, status: "ok", text: "a:1:foo(" },
    ]);
    expect(html).toContain('<span class="step-arg">foo\\(</span>');
    expect(html).toContain("1 line");
  });

  test("the main argument of a ranged read_file is its path, then the range as the model wrote it", () => {
    const ranged = (range: Record<string, string>) =>
      renderTurn([{ ...step, args: { path: "big.log", ...range }, text: "@big.log (file, line 1 of 9)\n```\nx\n```" }]);
    expect(ranged({ start_line: "2001", end_line: "4000" })).toContain(
      '<span class="step-arg">big.log 2001-4000</span>',
    );
    expect(ranged({ start_line: "2001" })).toContain('<span class="step-arg">big.log 2001-</span>');
    expect(ranged({ end_line: "50" })).toContain('<span class="step-arg">big.log 1-50</span>');
    expect(ranged({ start_line: "2001" })).toContain("ok, 4 lines");
  });

  test("an error step says error and its size", () => {
    const html = renderTurn([callReply, { ...step, status: "error", text: "read_file: gone." }]);
    expect(html).toContain('class="step-status failed"');
    expect(html).toContain("error, 1 line");
  });

  test("a malformed step shows its message", () => {
    const html = renderTurn([
      { role: "assistant", reasoning: "", content: "<read_file>", status: "done" },
      {
        role: "tool",
        name: "read_file",
        args: {},
        status: "malformed",
        text: "The <read_file> tag never closes: end the call with </read_file>.\nA call to read_file looks like this:",
      },
    ]);
    expect(html).toContain("malformed call");
    expect(html).toContain("The &lt;read_file&gt; tag never closes: end the call with &lt;/read_file&gt;.");
  });

  test("a call still running shows its row as running, with Stop", () => {
    const html = renderTurn([{ ...callReply, status: "streaming" }]);
    expect(html).toContain('<span class="step-tool">read_file</span>');
    expect(html).toContain("running…");
    expect(html).toContain(">Stop<");
  });

  test("a call stopped while it runs shows its row as stopped with no result, then Stopped", () => {
    const html = renderTurn([{ ...callReply, status: "stopped" }]);
    expect(html).toContain('<span class="step-tool">read_file</span>');
    expect(html).toContain("stopped, no result");
    expect(html).not.toContain("not run");
    expect(html).toContain("Stopped");
  });

  test("a reply ended by an internal error says so with its message, and its call has no result", () => {
    const html = renderTurn([
      { ...callReply, status: "failed", error: { kind: "internal", message: "tool list broke" } },
    ]);
    expect(html).toContain("An unexpected internal error ended the reply.");
    expect(html).toContain("tool list broke");
    expect(html).toContain("no result");
    expect(html).not.toContain("stopped, no result");
  });

  test("a halted turn says why, after its last step", () => {
    const malformed = renderTurn([{ ...callReply, status: "halted", haltReason: "malformedCalls" }, step]);
    expect(malformed).toContain("Stopped: the model sent three malformed tool calls in a row.");
    expect(malformed.indexOf("Stopped: the model")).toBeGreaterThan(malformed.indexOf("SECRET_RESULT_TEXT"));
    const limit = renderTurn([{ ...callReply, status: "halted", haltReason: "stepLimit" }, step]);
    expect(limit).toContain("Stopped: the agent turn reached its tool step limit.");
    expect(limit).toContain(">Send<");
  });

  test("a turn halted on a full context says so and names /compact and New chat", () => {
    const html = renderTurn([
      { role: "assistant", reasoning: "", content: "", status: "halted", haltReason: "contextFull" },
    ]);
    expect(html).toContain(
      "Stopped: the conversation fills the model&#x27;s context. Summarize it with /compact, or start a new chat with New chat.",
    );
    expect(html).not.toContain("Waiting for the reply…");
  });
});

describe("summary", () => {
  const summary = (status: Reply["status"], content = "The goal is x."): ChatEntry => ({
    role: "assistant",
    reasoning: "",
    content,
    status,
    summary: true,
    ...(status === "halted" ? { haltReason: "contextFull" as const } : {}),
  });
  const panel = (entries: ChatEntry[]) =>
    renderToStaticMarkup(<App state={stateWith(true, { entries })} language="en" />);

  test("a done summary renders under its separator, and the entries before it are marked as no longer sent", () => {
    const html = panel([...hi, summary("done"), { role: "user", content: "Next", mentions: [] }]);
    expect(html).toContain(
      '<div class="unsent"><p class="unsent-note">Earlier messages are no longer sent to the model: the summary below replaces them.</p>',
    );
    expect(html).toContain('<p class="summary-separator">Conversation summarized</p>');
    expect(html.indexOf("Hello")).toBeLessThan(html.indexOf("Conversation summarized"));
    expect(html.indexOf("The goal is x.")).toBeGreaterThan(html.indexOf("Conversation summarized"));
    // [>]: The summary and what follows it are sent: outside the marked block.
    expect(html.indexOf("Conversation summarized")).toBeGreaterThan(html.indexOf("</div>", html.indexOf("Hello")));
    expect(html.match(/class="unsent"/g)).toHaveLength(1);
  });

  test("a summary in flight says so, and marks nothing yet", () => {
    const html = panel([...hi, summary("streaming", "The goal")]);
    expect(html).toContain('<p class="summary-separator">Summarizing the conversation…</p>');
    expect(html).not.toContain("unsent");
  });

  test("a failed, stopped, halted, or empty summary says the conversation was not summarized and marks nothing", () => {
    for (const entry of [
      summary("failed", ""),
      summary("stopped", "Part"),
      summary("halted", ""),
      summary("done", " "),
    ]) {
      const html = panel([...hi, entry]);
      expect(html).toContain('<p class="summary-separator">Conversation not summarized</p>');
      expect(html).not.toContain("unsent");
    }
    expect(panel([...hi, summary("halted", "")])).toContain(
      "Not summarized: the conversation does not fit the model&#x27;s context, even with its tool results left out. Start a new chat with New chat.",
    );
    expect(panel([...hi, summary("done", "")])).toContain("The model&#x27;s reply held no summary.");
  });

  test("a summary the turn ran itself, its next reply after it, says it was automatic", () => {
    const next: ChatEntry = { role: "assistant", reasoning: "", content: "Done.", status: "done" };
    const html = panel([...hi, summary("done"), next]);
    expect(html).toContain('<p class="summary-separator">Conversation summarized automatically</p>');
    expect(html.indexOf("Done.")).toBeGreaterThan(html.indexOf("The goal is x."));
    const halted: ChatEntry = { ...next, content: "", status: "halted", haltReason: "contextFull" };
    expect(panel([...hi, summary("done", ""), halted])).toContain(
      '<p class="summary-separator">Conversation not summarized</p>',
    );
  });

  test("after an automatic summary, the turn's message it quotes is marked as still sent, and only that one", () => {
    const next: ChatEntry = { role: "assistant", reasoning: "", content: "Done.", status: "done" };
    const turn: ChatEntry = { role: "user", content: "Fix it", mentions: [] };
    const html = panel([...hi, turn, summary("done"), next]);
    expect(html).toContain('<div class="unsent">');
    expect(html.match(/class="still-sent"/g)).toHaveLength(1);
    expect(html.match(/class="still-sent-note"/g)).toHaveLength(1);
    const still = html.indexOf('class="still-sent"');
    expect(html.indexOf("Fix it")).toBeGreaterThan(still);
    expect(html.indexOf("Still sent with the summary")).toBeGreaterThan(html.indexOf("Fix it"));
    // [>]: The earlier turn is not quoted: it stays outside the still-sent block, dimmed with the rest.
    expect(html.indexOf(">Hi<")).toBeGreaterThan(html.indexOf('class="unsent"'));
    expect(html.indexOf(">Hi<")).toBeLessThan(still);
    // [>]: After `/compact`, nothing before the summary is sent.
    const manual = panel([...hi, turn, summary("done"), { role: "user", content: "Next", mentions: [] }]);
    expect(manual).not.toContain("still-sent");
  });
});

describe("folded turn", () => {
  const answer = "Look.\n<read_file>\n<path>a.ts</path>\n</read_file>";
  const call: ChatEntry = {
    role: "assistant",
    reasoning: "",
    content: answer,
    status: "done",
    call: { name: "read_file", args: { path: "a.ts" }, start: 6, end: answer.length },
  };
  const ok: ChatEntry = { role: "tool", name: "read_file", args: { path: "a.ts" }, status: "ok", text: "x" };
  const failed: ChatEntry = { ...ok, status: "error", text: "read_file: gone." };
  const rejected: ChatEntry = { ...ok, status: "error", approval: "rejected", text: "The user rejected this change." };
  const final: ChatEntry = { role: "assistant", reasoning: "", content: "FINAL_ANSWER", status: "done" };
  const user: ChatEntry = { role: "user", content: "Hi", mentions: [] };

  /** The conversation section of the panel showing `entries`, as markup. */
  function conversationOf(entries: ChatEntry[]): string {
    const html = renderToStaticMarkup(<App state={stateWith(true, { entries })} language="en" />);
    const start = html.indexOf('<section class="conversation"');
    return html.slice(start, html.indexOf("</section>", start) + "</section>".length);
  }

  test("the row says the steps, the failed ones, and the rejected ones", () => {
    const html = conversationOf([user, call, ok, call, failed, call, rejected, final]);
    expect(html).toContain('<summary class="turn-fold-row">3 steps, 1 failed, 1 rejected</summary>');
  });

  test("the fold is a closed details and the final answer sits outside it, right after", () => {
    const html = conversationOf([user, call, ok, call, ok, final]);
    expect(html).toContain('<details class="turn-fold">');
    expect(html).not.toContain('<details class="turn-fold" open');
    expect(html).toContain(
      '</div></div></details><div class="message assistant"><div class="answer"><p>FINAL_ANSWER</p></div><div class="turn-actions"><button type="button" class="secondary">Retry</button></div></div>',
    );
    expect(
      html.indexOf(
        '<div class="message user">Hi</div><div class="user-actions"><button type="button" class="secondary">Edit</button></div><details class="turn-fold">',
      ),
    ).toBeGreaterThan(-1);
  });

  test("a click expands the fold, and a step row inside still toggles on its own", async () => {
    await withPanel(stateWith(true, { entries: [user, call, ok, call, ok, final] }), async ({ host }) => {
      const fold = host.querySelector<HTMLDetailsElement>("details.turn-fold");
      if (!fold) throw new Error("no fold");
      expect(fold.open).toBe(false);
      await act(async () => fold.querySelector<HTMLElement>(":scope > summary")?.click());
      expect(fold.open).toBe(true);
      const step = fold.querySelector<HTMLDetailsElement>("details.step");
      if (!step) throw new Error("no step");
      await act(async () => step.querySelector<HTMLElement>(":scope > summary")?.click());
      expect(step.open).toBe(true);
      expect(fold.open).toBe(true);
      await act(async () => step.querySelector<HTMLElement>(":scope > summary")?.click());
      expect(step.open).toBe(false);
      expect(fold.open).toBe(true);
    });
  });

  test("a step waiting for a decision is never inside a fold", async () => {
    const writeAnswer = "Writing.\n<write_file>\n<path>a.ts</path>\n<content>\nx\n</content>\n</write_file>";
    const writing: ChatEntry = {
      role: "assistant",
      reasoning: "",
      content: writeAnswer,
      status: "streaming",
      call: { name: "write_file", args: { path: "a.ts", content: "x" }, start: 9, end: writeAnswer.length },
    };
    const approval = { id: 3, kind: "write" as const, tool: "write_file", summary: "a.ts" };
    const entries = [user, call, ok, call, ok, final, user, call, ok, call, ok, writing];
    await withPanel(stateWith(true, { entries, approval }), async ({ host }) => {
      expect(host.querySelectorAll("details.turn-fold").length).toBe(1);
      const decision = host.querySelector(".decision");
      expect(decision).not.toBeNull();
      expect(decision?.closest(".turn-fold")).toBeNull();
    });
  });

  /**
   * Stubs the scroll box of the conversation `host` shows: 200px high over 1,000px of content, `scrollTop` a plain value
   * that never fires `scroll`. Returns the box, the `scrollTop` writes made after the call, and the spy standing for the
   * end marker's `scrollIntoView`.
   */
  function stubScroll(host: HTMLElement): { box: HTMLElement; writes: number[]; scrolled: ReturnType<typeof jest.fn> } {
    const box = host.querySelector<HTMLElement>("section.conversation");
    if (!box) throw new Error("no conversation");
    const writes: number[] = [];
    let scrollTop = 0;
    Object.defineProperties(box, {
      scrollTop: {
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
          writes.push(value);
        },
      },
      scrollHeight: { get: () => 1000 },
      clientHeight: { get: () => 200 },
    });
    const scrolled = jest.fn();
    Object.defineProperty(box.lastElementChild, "scrollIntoView", { value: scrolled });
    return { box, writes, scrolled };
  }

  const streaming: ChatEntry = { ...final, status: "streaming" };

  test("a turn that folds while the user is scrolled up moves nothing", async () => {
    await withPanel(stateWith(true, { entries: [user, call, ok, call, ok, streaming] }), async ({ host, show }) => {
      const { box, writes, scrolled } = stubScroll(host);
      box.scrollTop = 300;
      await act(async () => box.dispatchEvent(new Event("scroll")));
      writes.length = 0;
      scrolled.mockClear();
      await show(stateWith(true, { entries: [user, call, ok, call, ok, final] }));
      expect(host.querySelectorAll("details.turn-fold").length).toBe(1);
      expect(writes).toEqual([]);
      expect(scrolled).not.toHaveBeenCalled();
      expect(box.contains(document.activeElement)).toBe(false);
    });
  });

  // The tests above see no layout: the question row holds still only because the stylesheet turns native scroll
  // anchoring off, which the live check confirms in the real panel.
  test("the conversation turns native scroll anchoring off", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const rule = css.match(/\n\.conversation \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("overflow-anchor: none;");
  });

  test("a turn that folds while the conversation is pinned to the bottom keeps following it", async () => {
    await withPanel(stateWith(true, { entries: [user, call, ok, call, ok, streaming] }), async ({ host, show }) => {
      const { writes, scrolled } = stubScroll(host);
      await show(stateWith(true, { entries: [user, call, ok, call, ok, final] }));
      expect(host.querySelectorAll("details.turn-fold").length).toBe(1);
      expect(writes).toEqual([]);
      expect(scrolled).toHaveBeenCalledWith({ block: "end" });
    });
  });

  test("only a user message a later one follows is marked earlier", () => {
    const html = conversationOf([user, final, user, final]);
    expect(html.match(/class="message user[^"]*"/g)).toEqual(['class="message user earlier"', 'class="message user"']);
  });

  test("a turn with one step renders the same markup as before folding existed", () => {
    expect(conversationOf([user, call, ok, final])).toBe(
      '<section class="conversation"><div class="message user">Hi</div><div class="user-actions"><button type="button" class="secondary">Edit</button></div><div class="message assistant"><div class="answer"><p>Look.</p></div><details class="step"><summary class="step-row"><span class="step-tool">read_file</span><span class="step-arg">a.ts</span><span class="step-status">ok, 1 line</span></summary><pre class="step-result"><code>x</code></pre></details></div><div class="message assistant"><div class="answer"><p>FINAL_ANSWER</p></div><div class="turn-actions"><button type="button" class="secondary">Retry</button></div></div><div></div></section>',
    );
  });
});

describe("approval", () => {
  const answer = "Renaming.\n<write_file>\n<path>src/a.ts</path>\n<content>\nx\n</content>\n</write_file>";
  const writing: ChatEntry = {
    role: "assistant",
    reasoning: "",
    content: answer,
    status: "streaming",
    call: { name: "write_file", args: { path: "src/a.ts", content: "x" }, start: 10, end: answer.length },
  };
  const approval = { id: 7, kind: "write" as const, tool: "write_file", summary: "src/a.ts" };
  const turn = (entries: ChatEntry[], open = true) =>
    renderToStaticMarkup(
      <App
        state={stateWith(true, {
          entries: [{ role: "user", content: "Hi", mentions: [] }, ...entries],
          ...(open ? { approval } : {}),
        })}
        language="en"
      />,
    );

  test("an open request shows its row waiting for a decision, Accept, Reject, and a reason field, beside Stop", () => {
    const html = turn([writing]);
    expect(html).toContain("waiting for your decision");
    expect(html).toContain('<div class="answer"><p>Renaming.</p></div><div class="decision"><div class="step">');
    expect(html).not.toContain("running…");
    expect(html).toContain(">Accept<");
    expect(html).toContain(">Reject<");
    expect(html).toContain('placeholder="Reason for rejecting (optional)"');
    expect(html).toContain(">Stop<");
  });

  test("a request opening leaves focus where it was, in the message box or on a button", async () => {
    const entries: ChatEntry[] = [{ role: "user", content: "Hi", mentions: [] }, writing];
    const running = stateWith(true, { entries });
    const deciding = stateWith(true, { entries, approval });
    const focusedAfterOpening = async (pick: (panel: Panel) => HTMLElement) => {
      let kept = false;
      await withPanel(running, async (panel) => {
        const target = pick(panel);
        target.focus();
        expect(document.activeElement).toBe(target);
        await panel.show(deciding);
        expect(panel.host.querySelector(".approval-reason")).not.toBeNull();
        kept = document.activeElement === target;
      });
      return kept;
    };

    expect(await focusedAfterOpening(({ textarea }) => textarea)).toBe(true);
    expect(
      await focusedAfterOpening(({ host }) => {
        const history = [...host.querySelectorAll("button")].find((element) => element.textContent === "History");
        if (!history) throw new Error("no History button");
        return history;
      }),
    ).toBe(true);
  });

  test("without an open request, a running call shows no decision buttons", () => {
    const html = turn([writing], false);
    expect(html).toContain("running…");
    expect(html).not.toContain(">Accept<");
    expect(html).not.toContain('class="decision"');
  });

  test("the buttons belong to the reply in flight only, never to an earlier one", () => {
    const html = turn([{ ...writing, status: "stopped" }]);
    expect(html).not.toContain(">Accept<");
    expect(html).toContain("stopped, no result");
  });

  test("Accept posts the request id; Reject posts it with the reason typed, trimmed, or none when blank", () => {
    const controls = (reason: string) => ApprovalControls({ approval, reason, setReason: () => {} });
    button(controls(""), "Accept").props.onClick!();
    button(controls("  Keep the old name. "), "Reject").props.onClick!();
    button(controls("   "), "Reject").props.onClick!();
    expect(posted).toEqual([
      { type: "approve", id: 7 },
      { type: "reject", id: 7, reason: "Keep the old name." },
      { type: "reject", id: 7 },
    ]);
  });

  test("Enter in the reason field rejects with the reason; other keys and Enter while composing (IME) do not", () => {
    const field = elements(ApprovalControls({ approval, reason: " Too broad. ", setReason: () => {} })).find(
      (element) => element.type === "input",
    );
    if (!field) throw new Error("no reason field");
    const onKeyDown = field.props.onKeyDown as (event: unknown) => void;
    const prevented: string[] = [];
    const press = (key: string, isComposing = false) =>
      onKeyDown({ key, nativeEvent: { isComposing }, preventDefault: () => prevented.push(key) });

    press("a");
    press("Escape");
    press("Enter", true);
    expect(posted).toEqual([]);
    expect(prevented).toEqual([]);

    press("Enter");
    expect(posted).toEqual([{ type: "reject", id: 7, reason: "Too broad." }]);
    expect(prevented).toEqual(["Enter"]);
  });

  test("the reason typed survives opening and closing History, and Reject still carries it", async () => {
    const state = stateWith(true, { entries: [{ role: "user", content: "Hi", mentions: [] }, writing], approval });
    await withPanel(state, async ({ host, fill, click }) => {
      const field = host.querySelector<HTMLInputElement>("input.approval-reason");
      if (!field) throw new Error("no reason field");
      await fill(field, "Keep the old name.");
      await click("History");
      await click("History");

      expect(host.querySelector<HTMLInputElement>("input.approval-reason")?.value).toBe("Keep the old name.");
      await click("Reject");
      expect(posted).toEqual([{ type: "reject", id: 7, reason: "Keep the old name." }]);
    });
  });

  describe("commands", () => {
    const command = "ls -1 | wc -l\necho <done>";
    const commandAnswer = `Counting.\n<run_command>\n<command>\n${command}\n</command>\n</run_command>`;
    const running: ChatEntry = {
      role: "assistant",
      reasoning: "",
      content: commandAnswer,
      status: "streaming",
      call: { name: "run_command", args: { command }, start: 10, end: commandAnswer.length },
    };
    const commandApproval = { id: 8, kind: "command" as const, tool: "run_command", summary: command };
    const commandTurn = (entries: ChatEntry[], open?: typeof commandApproval) =>
      renderToStaticMarkup(
        <App
          state={stateWith(true, {
            entries: [{ role: "user", content: "Hi", mentions: [] }, ...entries],
            ...(open ? { approval: open } : {}),
          })}
          language="en"
        />,
      );
    const commandBlock = '<code class="step-command">ls -1 | wc -l\necho &lt;done&gt;</code>';

    test("an open request shows the whole command, line breaks kept, with Run and Reject", () => {
      const html = commandTurn([running], commandApproval);
      expect(html).toContain(commandBlock);
      expect(html).toContain("waiting for your decision");
      expect(html).toContain(">Run<");
      expect(html).toContain(">Reject<");
      expect(html).not.toContain(">Accept<");
      expect(html).toContain('placeholder="Reason for rejecting (optional)"');
    });

    test("the command controls are labelled for assistive technology; a write's keep their own label", () => {
      expect(commandTurn([running], commandApproval)).toContain(
        '<fieldset class="approval" aria-label="Run or reject this command">',
      );
      expect(turn([writing])).toContain('<fieldset class="approval" aria-label="Approve write_file on src/a.ts">');
    });

    test("pending and finished command rows carry the command class; other tools' rows do not", () => {
      const done = { ...running, status: "done" } as const;
      const ran: ChatEntry = {
        role: "tool",
        name: "run_command",
        args: { command },
        status: "ok",
        text: "exit code 0",
      };
      expect(commandTurn([running], commandApproval)).toContain('<div class="step-row command">');
      expect(commandTurn([done, ran])).toContain('<summary class="step-row command">');
      const written: ChatEntry = {
        role: "tool",
        name: "write_file",
        args: { path: "src/a.ts" },
        status: "ok",
        text: "ok",
      };
      const writeRows = turn([writing]) + turn([{ ...writing, status: "done" }, written], false);
      expect(writeRows).toContain('<div class="step-row">');
      expect(writeRows).toContain('<summary class="step-row">');
      expect(writeRows).not.toContain("step-row command");
    });

    test("a command run in another folder names it in its row", () => {
      const elsewhere = { ...running, call: { ...running.call!, args: { command, cwd: "lib/sub" } } };
      expect(commandTurn([elsewhere], commandApproval)).toContain('<span class="step-arg">in lib/sub</span>');
      expect(commandTurn([running], commandApproval)).not.toContain('class="step-arg"');
    });

    test("Run posts the request id", () => {
      button(ApprovalControls({ approval: commandApproval, reason: "", setReason: () => {} }), "Run").props.onClick!();
      expect(posted).toEqual([{ type: "approve", id: 8 }]);
    });

    test("a finished command shows the command, its exit code, and the result's size", () => {
      const step = (status: "ok" | "error", text: string): ChatEntry => ({
        role: "tool",
        name: "run_command",
        args: { command },
        status,
        text,
        approval: "accepted",
      });
      const done = { ...running, status: "done" } as const;
      const ok = commandTurn([done, step("ok", "exit code 0\nstdout:\n12\nstderr: (empty)")]);
      expect(ok).toContain(commandBlock);
      expect(ok).toContain('<span class="step-status">exit code 0, 4 lines</span>');
      const failed = commandTurn([done, step("error", "exit code 3\nstdout: (empty)\nstderr:\nno such file")]);
      expect(failed).toContain('<span class="step-status failed">exit code 3, 4 lines</span>');
      const killed = commandTurn([done, step("error", "killed by SIGKILL\nstdout: (empty)\nstderr: (empty)")]);
      expect(killed).toContain("killed by SIGKILL, 3 lines");
      const late = commandTurn([done, step("error", "stopped after 120 seconds\nstdout: (empty)\nstderr: (empty)")]);
      expect(late).toContain("stopped after 120 seconds, 3 lines");
      const refused = commandTurn([done, step("error", "run_command: src: the path is not a folder.")]);
      expect(refused).toContain("error, 1 line");
    });

    test("a rejected command says rejected", () => {
      const html = commandTurn([
        { ...running, status: "done" },
        {
          role: "tool",
          name: "run_command",
          args: { command },
          status: "error",
          text: "The user rejected this command.",
          approval: "rejected",
        },
      ]);
      expect(html).toContain(commandBlock);
      expect(html).toContain(">rejected<");
    });
  });

  test("a rejected step says so; an auto-approved one says so beside its status", () => {
    const rejected = turn(
      [
        { ...writing, status: "done" },
        {
          role: "tool",
          name: "write_file",
          args: { path: "src/a.ts", content: "x" },
          status: "error",
          text: "The user rejected this change.\nKeep it.",
          approval: "rejected",
        },
      ],
      false,
    );
    expect(rejected).toContain("rejected");
    expect(rejected).not.toContain("error, 2 lines");
    const auto = turn(
      [
        { ...writing, status: "done" },
        {
          role: "tool",
          name: "write_file",
          args: { path: "src/a.ts", content: "x" },
          status: "ok",
          text: "write_file: replaced src/a.ts.",
          approval: "auto",
        },
      ],
      false,
    );
    expect(auto).toContain("auto-approved, ok, 1 line");
  });
});

describe("error actions", () => {
  /** Panel markup for a model listing that failed with `error`. */
  function failedListing(error: ProviderError): string {
    const state: ChatState = {
      providers: ["P"],
      skipped: [],
      skillWarnings: [],
      ...unsaved,
      provider: "P",
      models: { status: "failed", error },
      model: undefined,
      entries: [],
    };
    return renderToStaticMarkup(<App state={state} language="en" />);
  }

  test("offers the provider settings for a certificate error and an unusable CA file", () => {
    const errors: ProviderError[] = [
      { kind: "certificate", provider: "P", baseUrl: "https://p/v1", code: "CERT_HAS_EXPIRED" },
      { kind: "caFileInvalid", provider: "P", path: "/x.pem", reason: "notPem", cause: "no block" },
    ];
    for (const error of errors) expect(failedListing(error)).toContain(">Open provider settings<");
  });

  test("does not offer the provider settings for an unreachable provider", () => {
    expect(
      failedListing({ kind: "unreachable", provider: "P", baseUrl: "http://p/v1", cause: "ECONNREFUSED" }),
    ).not.toContain("Open provider settings");
  });
});

describe("mentions", () => {
  /** Panel markup for one user message with `mentions` and `skill`, English strings. */
  function renderMentions(
    mentions: (ChatEntry & { role: "user" })["mentions"],
    skill?: (ChatEntry & { role: "user" })["skill"],
  ): string {
    const state: ChatState = {
      providers: ["P"],
      skipped: [],
      skillWarnings: [],
      ...unsaved,
      provider: "P",
      models: { status: "loaded", models: ["m"] },
      model: "m",
      entries: [{ role: "user", content: "look", mentions, ...(skill ? { skill } : {}) }],
    };
    return renderToStaticMarkup(<App state={state} language="en" />);
  }

  test("shows no mention list for a message without mentions", () => {
    expect(renderMentions([])).not.toContain('class="mentions"');
  });

  test("shows one chip per mention with its kind, path, and status, failed ones marked", () => {
    const html = renderMentions([
      { path: "src/a.ts", kind: "file", status: "attached", lines: 83 },
      { path: "one.ts", kind: "file", status: "attached", lines: 1 },
      { path: "src/", kind: "folder", status: "attached", lines: 12 },
      { path: "big.txt", kind: "file", status: "truncated", lines: 2000 },
      { path: "gone.txt", kind: "file", status: "missing" },
      { path: "../out.txt", kind: "file", status: "outsideWorkspace" },
      { path: "img.png", kind: "file", status: "binary" },
      { path: "huge.log", kind: "file", status: "tooLarge" },
      { path: "locked", kind: "file", status: "unreadable" },
    ]);
    const chip = (state: "chip" | "chip failed", kind: string, path: string, status: string) =>
      `<li class="${state}"><span class="kind ${kind}" aria-hidden="true"></span><span class="chip-path">@${path}</span><span class="chip-status">${status}</span></li>`;
    for (const expected of [
      chip("chip", "file", "src/a.ts", "83 lines"),
      chip("chip", "file", "one.ts", "1 line"),
      chip("chip", "folder", "src/", "12 entries"),
      chip("chip", "file", "big.txt", "truncated to 2000 lines"),
      chip("chip failed", "file", "gone.txt", "not found"),
      chip("chip failed", "file", "../out.txt", "outside the workspace"),
      chip("chip failed", "file", "img.png", "binary file, not attached"),
      chip("chip failed", "file", "huge.log", "over 1 MiB, not attached"),
      chip("chip failed", "file", "locked", "could not be read"),
    ]) {
      expect(html).toContain(expected);
    }
    expect(html.match(/<li class="chip/g)).toHaveLength(9);
  });

  test("shows a @problems chip with its kind and count, and a neutral one when there was nothing to attach", () => {
    const html = renderMentions([
      { path: "problems", kind: "problems", status: "attached", lines: 2 },
      { path: "problems", kind: "problems", status: "attached", lines: 1 },
      { path: "problems", kind: "problems", status: "truncated", lines: 2000 },
      { path: "problems", kind: "problems", status: "noProblems" },
      { path: "problems", kind: "problems", status: "unreadable" },
      { path: "gone.txt", kind: "file", status: "missing" },
    ]);
    const chip = (state: string, kind: string, path: string, status: string) =>
      `<li class="${state}"><span class="kind ${kind}" aria-hidden="true"></span><span class="chip-path">@${path}</span><span class="chip-status">${status}</span></li>`;
    for (const expected of [
      chip("chip", "problems", "problems", "2 problems"),
      chip("chip", "problems", "problems", "1 problem"),
      chip("chip", "problems", "problems", "truncated to 2000 problems"),
      chip("chip neutral", "problems", "problems", "no errors or warnings"),
      chip("chip failed", "problems", "problems", "could not be read"),
      chip("chip failed", "file", "gone.txt", "not found"),
    ]) {
      expect(html).toContain(expected);
    }
  });

  test("shows a @diff chip with its kind and line count, neutral without changes, failed without git", () => {
    const html = renderMentions([
      { path: "diff", kind: "diff", status: "attached", lines: 9 },
      { path: "diff", kind: "diff", status: "attached", lines: 1 },
      { path: "diff", kind: "diff", status: "truncated", lines: 2000 },
      { path: "diff", kind: "diff", status: "noChanges" },
      { path: "diff", kind: "diff", status: "noRepository" },
      { path: "diff", kind: "diff", status: "gitUnavailable" },
      { path: "diff", kind: "diff", status: "unreadable" },
    ]);
    const chip = (state: string, status: string) =>
      `<li class="${state}"><span class="kind diff" aria-hidden="true"></span><span class="chip-path">@diff</span><span class="chip-status">${status}</span></li>`;
    for (const expected of [
      chip("chip", "9 lines"),
      chip("chip", "1 line"),
      chip("chip", "truncated to 2000 lines"),
      chip("chip neutral", "no changes"),
      chip("chip failed", "not a git repository"),
      chip("chip failed", "git not available"),
      chip("chip failed", "could not be read"),
    ]) {
      expect(html).toContain(expected);
    }
  });

  test("shows a partial @diff chip in the error color, its line count followed by the failed folders", () => {
    const html = renderMentions([
      { path: "diff", kind: "diff", status: "attached", lines: 9, failedFolders: 1 },
      { path: "diff", kind: "diff", status: "truncated", lines: 2000, failedFolders: 2 },
    ]);
    const chip = (status: string) =>
      `<li class="chip failed"><span class="kind diff" aria-hidden="true"></span><span class="chip-path">@diff</span><span class="chip-status">${status}</span></li>`;
    expect(html).toContain(chip("9 lines, 1 folder failed"));
    expect(html).toContain(chip("truncated to 2000 lines, 2 folders failed"));
  });

  test("shows a @selection chip with its path, range, and count, failed when nothing was attached", () => {
    const html = renderMentions([
      {
        path: "selection",
        kind: "selection",
        status: "attached",
        lines: 3,
        range: { path: "src/app.ts", start: 10, end: 12 },
      },
      { path: "selection", kind: "selection", status: "attached", lines: 1, range: { path: "a.ts", start: 4, end: 4 } },
      {
        path: "selection",
        kind: "selection",
        status: "truncated",
        lines: 2000,
        range: { path: "big.ts", start: 1, end: 2003 },
      },
      { path: "selection", kind: "selection", status: "noEditor" },
      { path: "selection", kind: "selection", status: "emptySelection" },
      { path: "selection", kind: "selection", status: "outsideWorkspace" },
    ]);
    const chip = (state: string, status: string) =>
      `<li class="${state}"><span class="kind selection" aria-hidden="true"></span><span class="chip-path">@selection</span><span class="chip-status">${status}</span></li>`;
    for (const expected of [
      chip("chip", "src/app.ts 10-12, 3 lines"),
      chip("chip", "a.ts 4, 1 line"),
      chip("chip", "big.ts 1-2003, truncated to 2000 lines"),
      chip("chip failed", "no active text editor"),
      chip("chip failed", "empty selection"),
      chip("chip failed", "outside the workspace"),
    ]) {
      expect(html).toContain(expected);
    }
  });

  test("shows the skill a message loaded before its mentions, a failed load marked", () => {
    const mention = { path: "a.ts", kind: "file", status: "attached", lines: 1 } as const;
    const loaded = renderMentions([mention], { name: "grilling", status: "loaded" });
    expect(loaded).toContain(
      '<ul class="mentions" aria-label="Skill and mentions"><li class="chip"><span class="chip-path">Skill grilling</span><span class="chip-status">loaded</span></li><li class="chip"><span class="kind file"',
    );
    expect(renderMentions([], { name: "grilling", status: "failed" })).toContain(
      '<li class="chip failed"><span class="chip-path">Skill grilling</span><span class="chip-status">could not be loaded</span></li>',
    );
  });
});

describe("mention menu", () => {
  const menu = (items: MentionRow[], capped = false, highlighted = 0, failed = false) =>
    renderToStaticMarkup(
      <MentionMenu items={items} capped={capped} failed={failed} highlighted={highlighted} onPick={() => {}} />,
    );

  test("shows a file row and a folder row with their kind markers, the highlighted one selected", () => {
    const html = menu(
      [
        { path: "src/core/", kind: "folder" },
        { path: "src/core/sse.ts", kind: "file" },
      ],
      false,
      1,
    );
    expect(html).toContain('<div id="mention-menu" role="listbox" aria-label="Mentions" class="menu-list">');
    expect(html).toContain(
      '<div id="mention-menu-option-0" role="option" tabindex="-1" aria-selected="false"><span class="kind folder" aria-hidden="true"></span><span class="menu-label">@src/core/</span></div>',
    );
    expect(html).toContain(
      '<div id="mention-menu-option-1" role="option" tabindex="-1" aria-selected="true" class="highlighted"><span class="kind file" aria-hidden="true"></span><span class="menu-label">@src/core/sse.ts</span></div>',
    );
    expect(html).not.toContain("menu-notice");
  });

  test("says No match when nothing matches", () => {
    const html = menu([]);
    expect(html).toContain('<p class="menu-notice">No match</p>');
    expect(html).not.toContain('role="option"');
  });

  test("says the workspace files could not be listed, with no row to pick, instead of No match", () => {
    const html = menu([], false, 0, true);
    expect(html).toContain('<p class="menu-notice">Could not list the workspace files</p>');
    expect(html).not.toContain("No match");
    expect(html).not.toContain('role="option"');
  });

  test("shows the @problems row with its marker and description", () => {
    const html = menu([
      { path: "problems", kind: "problems" },
      { path: "problems", kind: "file" },
    ]);
    expect(html).toContain(
      '<div id="mention-menu-option-0" role="option" tabindex="-1" aria-selected="true" class="highlighted"><span class="kind problems" aria-hidden="true"></span><span class="menu-label">@problems</span><span class="menu-description">Errors and warnings of the workspace files</span></div>',
    );
    expect(html).toContain(
      '<span class="kind file" aria-hidden="true"></span><span class="menu-label">@problems</span></div>',
    );
  });

  test("shows the @diff row with its marker and description", () => {
    expect(menu([{ path: "diff", kind: "diff" }])).toContain(
      '<span class="kind diff" aria-hidden="true"></span><span class="menu-label">@diff</span><span class="menu-description">Uncommitted changes of the tracked files</span></div>',
    );
  });

  test("shows the @selection row with its marker and description", () => {
    expect(menu([{ path: "selection", kind: "selection" }])).toContain(
      '<span class="kind selection" aria-hidden="true"></span><span class="menu-label">@selection</span><span class="menu-description">Selected text of the active editor</span></div>',
    );
  });

  test("ends with the index limit when the index is capped", () => {
    const html = menu([{ path: "a.ts", kind: "file" }], true);
    expect(html).toMatch(
      /@a\.ts<\/span><\/div><\/div><p class="menu-notice">Index limited to 5,000 files<\/p><\/div>$/,
    );
    expect(html).not.toContain("No match");
  });
});

describe("slash menu", () => {
  test("shows /new, /model, and the skills, each with its description, the highlighted one selected", () => {
    const html = renderToStaticMarkup(
      <SlashMenu
        items={[
          { name: "new", description: "Start a new conversation" },
          { name: "model", description: "Choose the model" },
          { name: "grilling", description: "Grill the plan." },
          { name: "release", description: "Cut a release." },
        ]}
        failed={false}
        highlighted={2}
        onPick={() => {}}
      />,
    );
    expect(html).toContain('<div id="slash-menu" role="listbox" aria-label="Commands and skills" class="menu-list">');
    expect(html).toContain(
      '<div id="slash-menu-option-0" role="option" tabindex="-1" aria-selected="false"><span class="menu-label">/new</span><span class="menu-description">Start a new conversation</span></div>',
    );
    expect(html).toContain(
      '<span class="menu-label">/model</span><span class="menu-description">Choose the model</span>',
    );
    expect(html).toContain(
      '<div id="slash-menu-option-2" role="option" tabindex="-1" aria-selected="true" class="highlighted"><span class="menu-label">/grilling</span><span class="menu-description">Grill the plan.</span></div>',
    );
    expect(html).toContain(
      '<span class="menu-label">/release</span><span class="menu-description">Cut a release.</span>',
    );
    expect(html).not.toContain("menu-notice");
  });

  test("says No match when nothing matches, and that the skills could not be listed instead when they failed", () => {
    const menu = (failed: boolean, items = []) =>
      renderToStaticMarkup(<SlashMenu items={items} failed={failed} highlighted={0} onPick={() => {}} />);
    expect(menu(false)).toContain('<p class="menu-notice">No match</p>');
    expect(menu(true)).toContain('<p class="menu-notice">Could not list the skills</p>');
    expect(menu(true)).not.toContain("No match");
  });
});

describe("moveHighlight", () => {
  test("moves by one row and wraps at both ends", () => {
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
    expect(moveHighlight(0, 1, 0)).toBe(0);
  });
});

type Props = { children?: unknown; onClick?: () => void; [name: string]: unknown };

/** Host elements of `node` (a tree of hook-free components already called), depth first. */
function elements(node: unknown): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (typeof node !== "object" || node === null || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...elements(element.props.children)];
}

/** The button whose text is `label`. */
function button(tree: unknown, label: string): ReactElement<Props> {
  const found = elements(tree).find((element) => element.type === "button" && element.props.children === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

/** State with providers configured (or not) and `entries`. */
function stateWith(configured: boolean, overrides: Partial<ChatState> = {}): ChatState {
  return {
    providers: configured ? ["P"] : [],
    skipped: [],
    skillWarnings: [],
    ...unsaved,
    provider: configured ? "P" : undefined,
    models: configured ? { status: "loaded", models: ["m"] } : { status: "noProvider" },
    model: configured ? "m" : undefined,
    entries: [],
    ...overrides,
  };
}

const hi: ChatEntry[] = [
  { role: "user", content: "Hi", mentions: [] },
  { role: "assistant", reasoning: "", content: "Hello", status: "done" },
];

/** The mounted panel `withPanel` hands its callback, with the DOM actions a user takes. */
type Panel = {
  host: HTMLElement;
  textarea: HTMLTextAreaElement;
  /** Replace the message box text, caret at `caret` (default: its end). */
  type: (value: string, caret?: number) => Promise<void>;
  /** Key down in `field` (default: the message box), `init` adding to the key, such as `isComposing`. */
  press: (key: string, field?: HTMLElement, init?: KeyboardEventInit) => Promise<void>;
  /** A message from the host. */
  receive: (message: unknown) => Promise<void>;
  /** Render another state, as a snapshot from the host does. */
  show: (state: ChatState) => Promise<void>;
  /** Replace `field`'s value as typing does. */
  fill: (field: HTMLInputElement | HTMLTextAreaElement, value: string) => Promise<void>;
  /** Click the button labelled `label`. */
  click: (label: string) => Promise<void>;
  /** Click the open menu's row labelled `label`. */
  clickOption: (label: string) => Promise<void>;
};

/** Mount the panel's `Root`, then `state` as its `init`, over a DOM registered for the test's duration; `run` drives it, then the panel unmounts. */
async function withPanel(
  state: ChatState,
  run: (panel: Panel) => Promise<void>,
  /** Host messages dispatched in the same task as `init`, before the panel has rendered it. */
  behindInit: unknown[] = [],
): Promise<void> {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  const { act, createElement } = await import("react");
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const receive = (message: unknown) =>
      act(async () => {
        window.dispatchEvent(new MessageEvent("message", { data: message }));
      });
    // [>]: Through `Root`, as the webview runs: it posts `ready`, then renders the `init` snapshot.
    await act(async () => root.render(createElement(Root, { language: "en" })));
    await act(async () => {
      for (const data of [{ type: "init", l10n: undefined, state }, ...behindInit]) {
        window.dispatchEvent(new MessageEvent("message", { data }));
      }
    });
    posted.splice(
      posted.findIndex((message) => (message as { type: string }).type === "ready"),
      1,
    );
    const textarea = host.querySelector("textarea");
    if (!textarea) throw new Error("no message box");
    // [&]: React tracks the value property; set it through the prototype setter so the input event registers.
    const setValue = (field: HTMLInputElement | HTMLTextAreaElement, value: string) =>
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set?.call(field, value);
    await run({
      host,
      textarea,
      type: (value, caret = value.length) =>
        act(async () => {
          setValue(textarea, value);
          textarea.setSelectionRange(caret, caret);
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }),
      press: (key, field = textarea, init = {}) =>
        act(async () => {
          field.dispatchEvent(new KeyboardEvent("keydown", { ...init, key, bubbles: true, cancelable: true }));
        }),
      receive,
      show: (next) => receive({ type: "state", state: next }),
      fill: (field, value) =>
        act(async () => {
          setValue(field, value);
          field.dispatchEvent(new Event("input", { bubbles: true }));
        }),
      click: async (label) => {
        const target = [...host.querySelectorAll("button")].find((element) => element.textContent === label);
        if (!target) throw new Error(`no ${label} button`);
        await act(async () => target.click());
      },
      clickOption: async (label) => {
        const target = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(
          (row) => row.querySelector(".menu-label")?.textContent === label,
        );
        if (!target) throw new Error(`no ${label} row`);
        await act(async () => target.click());
      },
    });
    await act(async () => root.unmount());
  } finally {
    GlobalRegistrator.unregister();
  }
}

beforeEach(() => {
  posted.length = 0;
});

describe("conversation history", () => {
  const OTHER_ID = "1b0d4c1e-8f9a-4c3b-9d2e-1a2b3c4d5e6f";
  const list = (conversations: { id: string; title: string; updatedAt: number }[]) =>
    renderToStaticMarkup(
      <ConversationList
        conversations={conversations}
        currentId={CONVERSATION_ID}
        language="en"
        onOpen={() => {}}
        onDelete={() => {}}
        onDismiss={() => {}}
      />,
    );

  test("has a History toggle in the header, closed at first", () => {
    const html = render({ reasoning: "", content: "Hello", status: "done" });
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">History<");
    expect(html).not.toContain('class="history"');
  });

  test("lists each conversation in the order given with its title and date, the current one marked", () => {
    const noon = new Date(2026, 10, 8, 12).getTime();
    const html = list([
      { id: CONVERSATION_ID, title: "Newest", updatedAt: noon },
      { id: OTHER_ID, title: "Older", updatedAt: noon - 86_400_000 },
    ]);
    expect(html.indexOf("Newest")).toBeLessThan(html.indexOf("Older"));
    expect(html).toContain("Nov 8, 2026");
    expect(html).toContain("Nov 7, 2026");
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="true"[^>]*>.*Newest/);
    expect(html.match(/<li class="current">/g)).toHaveLength(1);
    expect(html).toMatch(/<li class="current"><button[^>]*aria-current="true"/);
    expect(html).toContain("<li><button");
    expect(html.match(/<button type="button" class="secondary">Delete<\/button>/g)).toHaveLength(2);
    expect(html).not.toContain("No past conversations.");
  });

  test("says when there is no past conversation", () => {
    expect(list([])).toContain("No past conversations.");
  });

  test("shows a storage problem as an alert", () => {
    const state: ChatState = {
      providers: ["P"],
      skipped: [],
      skillWarnings: [],
      ...unsaved,
      storageProblem: { kind: "deleteFailed", cause: "Error: EACCES" },
      provider: "P",
      models: { status: "loaded", models: ["m"] },
      model: "m",
      entries: [],
    };
    const html = renderToStaticMarkup(<App state={state} language="en" />);
    expect(html).toContain("Could not delete the conversation.");
    expect(html).toContain("Error: EACCES");
  });

  test("shows a listing failure and an action error at once", () => {
    const state = stateWith(true, {
      listFailed: { cause: "Error: EACCES: listing denied" },
      storageProblem: { kind: "openFailed", cause: "Error: EIO" },
    });
    const html = renderToStaticMarkup(<App state={state} language="en" />);
    expect(html).toContain("Could not list the past conversations.");
    expect(html).toContain("Error: EACCES: listing denied");
    expect(html).toContain("Could not open the conversation.");
    expect(html.match(/role="alert"/g)).toHaveLength(2);
  });
});

describe("history without a provider", () => {
  test("keeps the History toggle and the provider explanation", () => {
    const html = renderToStaticMarkup(<App state={stateWith(false)} language="en" />);
    expect(html).toContain(">History<");
    expect(html).toContain("No provider is configured.");
    expect(html).not.toContain("<select");
  });

  test("offers Add provider beside Open provider settings, and the button asks the host to add one", () => {
    const html = renderToStaticMarkup(<App state={stateWith(false)} language="en" />);
    expect(html).toContain(">Add provider</button>");
    expect(html).toContain(">Open provider settings</button>");
    button(EmptyState(), "Add provider").props.onClick!();
    expect(posted).toEqual([{ type: "addProvider" }]);
  });

  test("shows a reopened conversation read-only: no composer", () => {
    const html = renderToStaticMarkup(<App state={stateWith(false, { entries: hi })} language="en" />);
    expect(html).toContain("Hello");
    expect(html).not.toContain("<textarea");
  });
});

describe("composer", () => {
  test("shows with a provider, and without one only while a reply is in flight", () => {
    const replying: ChatEntry[] = [hi[0]!, { role: "assistant", reasoning: "", content: "", status: "waiting" }];
    expect(renderToStaticMarkup(<App state={stateWith(true)} language="en" />)).toContain("<textarea");
    expect(renderToStaticMarkup(<App state={stateWith(false)} language="en" />)).not.toContain("<textarea");
    expect(renderToStaticMarkup(<App state={stateWith(false, { entries: replying })} language="en" />)).toContain(
      "<textarea",
    );
  });
});

describe("mode selector", () => {
  const modeSelect = (host: HTMLElement) => {
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Mode"]');
    if (!select) throw new Error("no mode selector");
    return select;
  };

  test("shows the mode the state holds, Ask, Auto-edit, or Plan", async () => {
    for (const [mode, label] of [
      ["ask", "Ask"],
      ["autoEdit", "Auto-edit"],
      ["plan", "Plan"],
    ] as const) {
      await withPanel(stateWith(true, { mode }), async ({ host }) => {
        const select = modeSelect(host);
        expect(select.value).toBe(mode);
        expect(select.selectedOptions[0]?.textContent).toBe(label);
        expect([...select.options].map((option) => option.textContent)).toEqual(["Ask", "Auto-edit", "Plan"]);
      });
    }
  });

  test("posts the picked mode and keeps showing the state's mode until the host answers", async () => {
    await withPanel(stateWith(true), async ({ host, show }) => {
      const select = modeSelect(host);
      await act(async () => {
        select.value = "autoEdit";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(posted).toEqual([{ type: "setMode", mode: "autoEdit" }]);
      expect(modeSelect(host).value).toBe("ask");

      await show(stateWith(true, { mode: "autoEdit" }));
      expect(modeSelect(host).value).toBe("autoEdit");
    });
  });

  test("posts Plan when picked", async () => {
    await withPanel(stateWith(true), async ({ host }) => {
      const select = modeSelect(host);
      await act(async () => {
        select.value = "plan";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(posted).toEqual([{ type: "setMode", mode: "plan" }]);
    });
  });

  test("while a mode change is written, the selector and Send are disabled, and Enter sends nothing", async () => {
    await withPanel(stateWith(true, { modePending: true }), async ({ host, type, press }) => {
      expect(modeSelect(host).disabled).toBe(true);
      await type("Hi");
      const send = [...host.querySelectorAll("button")].find((element) => element.textContent === "Send");
      expect(send?.disabled).toBe(true);
      await press("Enter");
      await type("/new");
      await press("Enter");
      expect(posted.filter((message) => (message as { type: string }).type !== "querySkills")).toEqual([]);
    });
  });

  test("is disabled while a reply is in flight, like the pickers", () => {
    const waiting: ChatEntry[] = [hi[0]!, { role: "assistant", reasoning: "", content: "", status: "waiting" }];
    const disabled = (state: ChatState) => {
      const html = renderToStaticMarkup(<App state={state} language="en" />);
      const tag = html.match(/<select[^>]*aria-label="Mode"[^>]*>/)?.[0];
      if (!tag) throw new Error("no mode selector");
      return tag.includes('disabled=""');
    };
    expect(disabled(stateWith(true, { entries: waiting }))).toBe(true);
    expect(disabled(stateWith(true, { entries: hi }))).toBe(false);
  });

  test("sits after the message box, so Shift+Tab from it still reaches an open request's Reject first", async () => {
    const answer = "Renaming.\n<write_file>\n<path>a.ts</path>\n<content>\nx\n</content>\n</write_file>";
    const writing: ChatEntry = {
      role: "assistant",
      reasoning: "",
      content: answer,
      status: "streaming",
      call: { name: "write_file", args: { path: "a.ts", content: "x" }, start: 10, end: answer.length },
    };
    const state = stateWith(true, {
      entries: [hi[0]!, writing],
      approval: { id: 1, kind: "write", tool: "write_file", summary: "a.ts" },
    });
    await withPanel(state, async ({ host, textarea }) => {
      const focusable = [...host.querySelectorAll<HTMLElement>("button, select, textarea, input, a[href], summary")];
      const box = focusable.indexOf(textarea);
      expect(focusable[box - 1]?.textContent).toBe("Reject");
      expect(focusable.indexOf(modeSelect(host))).toBeGreaterThan(box);
    });
  });
});

describe("slash commands in the composer", () => {
  const labels = (host: HTMLElement) =>
    [...host.querySelectorAll("#slash-menu .menu-label")].map((row) => row.textContent);
  /** Ids of the skill queries posted so far. */
  const skillQueries = () =>
    posted.flatMap((message) =>
      (message as { type: string }).type === "querySkills" ? [message as { id: number }] : [],
    );
  /** Id of the last skill query posted. */
  const lastSkillQuery = () => skillQueries().at(-1)!.id;

  test("/ asks the host once for the skills, lists them after the built-ins, and narrows as the user types", async () => {
    await withPanel(stateWith(true), async ({ host, type, receive }) => {
      await type("/");
      expect(posted).toEqual([{ type: "querySkills", id: lastSkillQuery() }]);
      expect(labels(host)).toEqual(["/new", "/model", "/compact"]);
      expect(host.querySelector("#slash-menu-option-2 .menu-description")?.textContent).toBe(
        "Summarize the conversation to free context",
      );

      await receive({
        type: "skillSuggestions",
        id: lastSkillQuery(),
        items: [
          { name: "grilling", description: "Grill the plan." },
          { name: "notes", description: "Take notes." },
        ],
        failed: false,
      });
      expect(labels(host)).toEqual(["/new", "/model", "/compact", "/grilling", "/notes"]);

      await type("/gr");
      expect(labels(host)).toEqual(["/grilling"]);
      await type("/n");
      expect(labels(host)).toEqual(["/new", "/notes"]);
      expect(skillQueries()).toHaveLength(1);
    });
  });

  test("an answer to an earlier opening is dropped", async () => {
    await withPanel(stateWith(true), async ({ host, type, receive }) => {
      await type("/");
      const first = lastSkillQuery();
      await type("x");
      await type("/");
      expect(skillQueries()).toHaveLength(2);
      expect(lastSkillQuery()).not.toBe(first);
      await receive({
        type: "skillSuggestions",
        id: first,
        items: [{ name: "old", description: "Old." }],
        failed: false,
      });
      expect(labels(host)).toEqual(["/new", "/model", "/compact"]);
    });
  });

  test("a menu closed with Escape asks again when typing reopens it, and drops the earlier answer", async () => {
    await withPanel(stateWith(true), async ({ host, type, press, receive }) => {
      await type("/");
      const first = lastSkillQuery();
      await receive({
        type: "skillSuggestions",
        id: first,
        items: [{ name: "old", description: "Old." }],
        failed: false,
      });
      await press("Escape");
      await type("/n");
      expect(skillQueries()).toHaveLength(2);
      expect(labels(host)).toEqual(["/new"]);
      await receive({
        type: "skillSuggestions",
        id: first,
        items: [{ name: "nold", description: "Old." }],
        failed: false,
      });
      expect(labels(host)).toEqual(["/new"]);
      await receive({
        type: "skillSuggestions",
        id: lastSkillQuery(),
        items: [{ name: "notes", description: "Take notes." }],
        failed: false,
      });
      expect(labels(host)).toEqual(["/new", "/notes"]);
    });
  });

  test("a menu closed by blur asks again on focus, and drops the earlier answer", async () => {
    const { act } = await import("react");
    await withPanel(stateWith(true), async ({ host, textarea, type, receive }) => {
      const focusChange = (name: "focusin" | "focusout") =>
        act(async () => {
          textarea.dispatchEvent(new FocusEvent(name, { bubbles: true }));
        });
      await type("/");
      const first = lastSkillQuery();
      await focusChange("focusout");
      expect(host.querySelector("#slash-menu")).toBeNull();
      await focusChange("focusin");
      expect(skillQueries()).toHaveLength(2);
      await receive({
        type: "skillSuggestions",
        id: first,
        items: [{ name: "old", description: "Old." }],
        failed: false,
      });
      expect(labels(host)).toEqual(["/new", "/model", "/compact"]);
    });
  });

  test("when the skills cannot be listed, the menu says so and still shows the built-ins", async () => {
    await withPanel(stateWith(true), async ({ host, type, receive }) => {
      await type("/");
      await receive({ type: "skillSuggestions", id: lastSkillQuery(), items: [], failed: true });
      expect(labels(host)).toEqual(["/new", "/model", "/compact"]);
      expect(host.querySelector(".menu-notice")?.textContent).toBe("Could not list the skills");
    });
  });

  test("when one skills folder cannot be listed, the menu says so and shows the skills found elsewhere", async () => {
    await withPanel(stateWith(true), async ({ host, type, receive }) => {
      await type("/");
      await receive({
        type: "skillSuggestions",
        id: lastSkillQuery(),
        items: [{ name: "kept", description: "Kept." }],
        failed: true,
      });
      expect(labels(host)).toEqual(["/new", "/model", "/compact", "/kept"]);
      expect(host.querySelector(".menu-notice")?.textContent).toBe("Could not list the skills");
    });
  });

  test("Enter picks the highlighted row, inserting /<name> and a space without sending; Escape closes the menu", async () => {
    await withPanel(stateWith(true), async ({ host, textarea, type, press, receive }) => {
      await type("/gr");
      await receive({
        type: "skillSuggestions",
        id: lastSkillQuery(),
        items: [{ name: "grilling", description: "Grill the plan." }],
        failed: false,
      });
      await press("Enter");
      expect(textarea.value).toBe("/grilling ");
      expect(textarea.selectionStart).toBe(10);
      expect(posted).toHaveLength(1);
      expect(host.querySelector("#slash-menu")).toBeNull();

      await type("/");
      expect(skillQueries()).toHaveLength(2);
      expect(labels(host)).toEqual(["/new", "/model", "/compact"]);
      await press("Escape");
      expect(host.querySelector("#slash-menu")).toBeNull();
    });
  });

  test("a / after other text opens no menu and asks nothing", async () => {
    await withPanel(stateWith(true), async ({ host, type }) => {
      await type("see /etc");
      expect(host.querySelector("#slash-menu")).toBeNull();
      expect(posted).toEqual([]);
    });
  });

  test("sending /new posts the New chat request and empties the box", async () => {
    await withPanel(stateWith(true, { entries: hi }), async ({ textarea, type, press }) => {
      await type("/new ");
      posted.length = 0;
      await press("Enter");
      expect(posted).toEqual([{ type: "newChat" }]);
      expect(textarea.value).toBe("");
    });
  });

  test("sending /compact asks the host for a summary and empties the box", async () => {
    await withPanel(stateWith(true, { entries: hi }), async ({ textarea, type, press }) => {
      await type("/compact");
      posted.length = 0;
      await press("Enter");
      expect(posted).toEqual([{ type: "compact" }]);
      expect(textarea.value).toBe("");
    });
  });

  test("sending /model asks the host for its model list and empties the box", async () => {
    await withPanel(stateWith(true), async ({ textarea, type, press }) => {
      await type("/model ");
      posted.length = 0;
      await press("Enter");
      expect(posted).toEqual([{ type: "chooseModel" }]);
      expect(textarea.value).toBe("");
    });
  });

  test("one Enter on the highlighted /new row starts a new chat and empties the box", async () => {
    await withPanel(stateWith(true, { entries: hi }), async ({ host, textarea, type, press }) => {
      await type("/ne");
      posted.length = 0;
      await press("Enter");
      expect(posted).toEqual([{ type: "newChat" }]);
      expect(textarea.value).toBe("");
      expect(host.querySelector("#slash-menu")).toBeNull();
    });
  });

  test("Enter or Tab on the /model row and a click on the /new row run them at once", async () => {
    await withPanel(stateWith(true), async ({ textarea, type, press, clickOption }) => {
      await type("/m");
      posted.length = 0;
      await press("Enter");
      expect(posted).toEqual([{ type: "chooseModel" }]);
      expect(textarea.value).toBe("");

      await type("/");
      posted.length = 0;
      await press("ArrowDown");
      await press("Tab");
      expect(posted).toEqual([{ type: "chooseModel" }]);
      expect(textarea.value).toBe("");

      await type("/");
      posted.length = 0;
      await clickOption("/new");
      expect(posted).toEqual([{ type: "newChat" }]);
      expect(textarea.value).toBe("");
    });
  });

  test("while a reply is in flight, picking the /new row inserts /new and a space and runs nothing", async () => {
    const replying: ChatEntry[] = [hi[0]!, { role: "assistant", reasoning: "", content: "", status: "waiting" }];
    await withPanel(stateWith(true, { entries: replying }), async ({ textarea, type, press }) => {
      await type("/ne");
      posted.length = 0;
      await press("Enter");
      expect(posted).toEqual([]);
      expect(textarea.value).toBe("/new ");
    });
  });

  test("Enter on the /new row with a draft after the caret inserts /new and a space, keeps the draft, and runs nothing", async () => {
    await withPanel(stateWith(true, { entries: hi }), async ({ textarea, type, press }) => {
      await type("/ne keep this draft", "/ne".length);
      posted.length = 0;
      await press("Enter");
      expect(posted).toEqual([]);
      expect(textarea.value).toBe("/new  keep this draft");
    });
  });

  test("with no model chosen, Enter on the /new row inserts /new and a space and runs nothing", async () => {
    await withPanel(stateWith(true, { entries: hi, model: undefined }), async ({ textarea, type, press }) => {
      await type("/ne");
      posted.length = 0;
      await press("Enter");
      expect(posted).toEqual([]);
      expect(textarea.value).toBe("/new ");
    });
  });

  test("/new and /model do nothing while a reply is in flight, and words after them make an ordinary message", async () => {
    const replying: ChatEntry[] = [hi[0]!, { role: "assistant", reasoning: "", content: "", status: "waiting" }];
    await withPanel(stateWith(true, { entries: replying }), async ({ textarea, type, press }) => {
      await type("/new ");
      posted.length = 0;
      await press("Enter");
      expect(posted).toEqual([]);
      expect(textarea.value).toBe("/new ");
    });
    await withPanel(stateWith(true), async ({ type, press }) => {
      await type("/new words");
      await press("Enter");
      expect(posted.at(-1)).toEqual({ type: "send", text: "/new words", mentions: [] });
    });
  });
});

describe("composer menus", () => {
  /** Id of the last query of `type` posted. */
  const lastQuery = (type: "queryFiles" | "querySkills") =>
    (posted.filter((message) => (message as { type: string }).type === type).at(-1) as { id: number }).id;
  /** Label of the row marked selected. */
  const selected = (host: HTMLElement) =>
    host.querySelector('[role="option"][aria-selected="true"] .menu-label')?.textContent;
  const skills = {
    type: "skillSuggestions",
    items: [
      { name: "grilling", description: "Grill the plan." },
      { name: "notes", description: "Take notes." },
    ],
    failed: false,
  };

  test("the message box controls the open menu, and none while closed", async () => {
    await withPanel(stateWith(true), async ({ textarea, type, receive }) => {
      expect(textarea.hasAttribute("aria-controls")).toBe(false);
      await type("/");
      expect(textarea.getAttribute("aria-controls")).toBe("slash-menu");
      await type("@sr");
      await receive({
        type: "fileSuggestions",
        id: lastQuery("queryFiles"),
        items: [{ path: "src/a.ts", kind: "file" }],
        capped: false,
        failed: false,
      });
      expect(textarea.getAttribute("aria-controls")).toBe("mention-menu");
      await type("hi");
      expect(textarea.hasAttribute("aria-controls")).toBe(false);
    });
  });

  test("the message box points at the highlighted row, and at none without rows or menu", async () => {
    await withPanel(stateWith(true), async ({ textarea, type, press, receive }) => {
      expect(textarea.hasAttribute("aria-activedescendant")).toBe(false);
      await type("/");
      expect(textarea.getAttribute("aria-activedescendant")).toBe("slash-menu-option-0");
      await press("ArrowDown");
      expect(textarea.getAttribute("aria-activedescendant")).toBe("slash-menu-option-1");
      await receive({ ...skills, id: lastQuery("querySkills") });
      await type("/zz");
      expect(textarea.hasAttribute("aria-activedescendant")).toBe(false);
    });
  });

  test("the highlight goes back to the first row when the filter changes", async () => {
    await withPanel(stateWith(true), async ({ host, type, press, receive }) => {
      await type("/");
      await receive({ ...skills, id: lastQuery("querySkills") });
      await press("ArrowDown");
      await press("ArrowDown");
      await press("ArrowDown");
      expect(selected(host)).toBe("/grilling");
      await type("/n");
      expect(selected(host)).toBe("/new");
    });
  });

  test("a menu closed with Escape opens again on a new token once the old one is gone", async () => {
    await withPanel(stateWith(true), async ({ host, type, press }) => {
      await type("/");
      await press("Escape");
      expect(host.querySelector("#slash-menu")).toBeNull();
      await type("");
      await type("/");
      expect(host.querySelector("#slash-menu")).not.toBeNull();
    });
  });

  test("picking a path inserts @<path> and a space, and sends it as a mention", async () => {
    await withPanel(stateWith(true), async ({ textarea, type, press, receive }) => {
      await type("see @sr");
      await receive({
        type: "fileSuggestions",
        id: lastQuery("queryFiles"),
        items: [{ path: "src/a b.ts", kind: "file" }],
        capped: false,
        failed: false,
      });
      await press("Enter");
      expect(textarea.value).toBe("see @src/a b.ts ");
      await press("Enter");
      expect(posted.at(-1)).toEqual({ type: "send", text: "see @src/a b.ts ", mentions: ["src/a b.ts"] });
    });
  });
});

describe("composer @problems", () => {
  const lastFileQuery = () =>
    (posted.filter((message) => (message as { type: string }).type === "queryFiles").at(-1) as { id: number }).id;

  test("lists @problems before the files answer; picking it inserts @problems and records no path", async () => {
    await withPanel(stateWith(true), async ({ host, textarea, type, press }) => {
      await type("fix @pro");
      expect(host.querySelector('[role="option"] .menu-label')?.textContent).toBe("@problems");
      await press("Enter");
      expect(textarea.value).toBe("fix @problems ");
      await press("Enter");
      expect(posted.at(-1)).toEqual({ type: "send", text: "fix @problems ", mentions: [] });
    });
  });

  test("keeps the reserved rows, each with its description, when the files cannot be listed, saying so", async () => {
    await withPanel(stateWith(true), async ({ host, type, receive }) => {
      await type("@");
      await receive({ type: "fileSuggestions", id: lastFileQuery(), items: [], capped: false, failed: true });
      expect([...host.querySelectorAll('[role="option"] .menu-label')].map((row) => row.textContent)).toEqual([
        "@problems",
        "@diff",
        "@selection",
      ]);
      expect([...host.querySelectorAll('[role="option"] .menu-description')].map((row) => row.textContent)).toEqual([
        "Errors and warnings of the workspace files",
        "Uncommitted changes of the tracked files",
        "Selected text of the active editor",
      ]);
      expect(host.querySelector(".menu-notice")?.textContent).toBe("Could not list the workspace files");
    });
  });

  test("picking a file named problems inserts @./problems and sends that path", async () => {
    await withPanel(stateWith(true), async ({ textarea, type, press, receive }) => {
      await type("see @problems");
      await receive({
        type: "fileSuggestions",
        id: lastFileQuery(),
        items: [{ path: "problems", kind: "file" }],
        capped: false,
        failed: false,
      });
      await press("ArrowDown");
      await press("Enter");
      expect(textarea.value).toBe("see @./problems ");
      await press("Enter");
      expect(posted.at(-1)).toEqual({ type: "send", text: "see @./problems ", mentions: ["./problems"] });
    });
  });
});

describe("header actions", () => {
  test("the History toggle points at the list only while it is open", () => {
    const open = renderToStaticMarkup(
      <Header state={stateWith(true)} language="en" historyOpen={true} toggleHistory={() => {}} />,
    );
    const closed = renderToStaticMarkup(
      <Header state={stateWith(true)} language="en" historyOpen={false} toggleHistory={() => {}} />,
    );
    expect(open).toContain('aria-expanded="true" aria-controls="history"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("aria-controls");
  });

  test("New chat is disabled for an empty conversation only, with or without a provider", () => {
    const newChat = (configured: boolean, entries: ChatEntry[]) =>
      renderToStaticMarkup(
        <Header
          state={stateWith(configured, { entries })}
          language="en"
          historyOpen={false}
          toggleHistory={() => {}}
        />,
      ).match(/<button[^>]*>New chat<\/button>/)?.[0];
    for (const configured of [true, false]) {
      expect(newChat(configured, [])).toContain("disabled");
      expect(newChat(configured, hi)).not.toContain("disabled");
    }
  });

  test("New chat closes an open History and starts a new chat; a closed one stays closed", () => {
    let toggles = 0;
    const toggle = () => {
      toggles += 1;
    };
    const state = stateWith(true, { entries: hi });
    button(Header({ state, language: "en", historyOpen: true, toggleHistory: toggle }), "New chat").props.onClick!();
    expect(toggles).toBe(1);
    button(Header({ state, language: "en", historyOpen: false, toggleHistory: toggle }), "New chat").props.onClick!();
    expect(toggles).toBe(1);
    expect(posted).toEqual([{ type: "newChat" }, { type: "newChat" }]);
  });
});

describe("history panel", () => {
  const OTHER_ID = "1b0d4c1e-8f9a-4c3b-9d2e-1a2b3c4d5e6f";
  const conversations = [
    { id: CONVERSATION_ID, title: "Shown", updatedAt: 2 },
    { id: OTHER_ID, title: "Other", updatedAt: 1 },
  ];

  /** The list the panel renders, with its handlers; closing counted. */
  function panel() {
    let closed = 0;
    const list = HistoryPanel({
      state: stateWith(true, { conversations }),
      language: "en",
      close: () => {
        closed += 1;
      },
      dismiss: () => {},
    }) as ReactElement<{ onOpen(id: string): void; onDelete(id: string): void }>;
    return { list, closed: () => closed };
  }

  test("a click on another conversation closes the list and asks to open it", () => {
    const { list, closed } = panel();
    list.props.onOpen(OTHER_ID);
    expect(closed()).toBe(1);
    expect(posted).toEqual([{ type: "openConversation", id: OTHER_ID }]);
  });

  test("a click on the conversation shown still asks to open it, so it supersedes a pending open", () => {
    const { list, closed } = panel();
    list.props.onOpen(CONVERSATION_ID);
    expect(closed()).toBe(1);
    expect(posted).toEqual([{ type: "openConversation", id: CONVERSATION_ID }]);
  });

  test("Delete asks to delete that conversation", () => {
    const { list } = panel();
    list.props.onDelete(OTHER_ID);
    expect(posted).toEqual([{ type: "deleteConversation", id: OTHER_ID }]);
  });

  test("each row's buttons call back with that row's id", async () => {
    const { act } = await import("react");
    await withPanel(stateWith(true, { conversations }), async (panel) => {
      const rowButtons = (className: string) => [...panel.host.querySelectorAll<HTMLButtonElement>(className)];
      await panel.click("History");
      for (const remove of rowButtons(".history button.secondary")) await act(async () => remove.click());
      for (const index of [0, 1]) {
        if (index > 0) await panel.click("History");
        const open = rowButtons("button.history-open")[index];
        if (!open) throw new Error(`no row ${index}`);
        await act(async () => open.click());
      }
    });
    expect(posted).toEqual([
      { type: "deleteConversation", id: CONVERSATION_ID },
      { type: "deleteConversation", id: OTHER_ID },
      { type: "openConversation", id: CONVERSATION_ID },
      { type: "openConversation", id: OTHER_ID },
    ]);
  });
});

describe("history filter", () => {
  const OTHER_ID = "1b0d4c1e-8f9a-4c3b-9d2e-1a2b3c4d5e6f";
  const THIRD_ID = "2b0d4c1e-8f9a-4c3b-9d2e-1a2b3c4d5e6f";
  const conversations = [
    { id: CONVERSATION_ID, title: "Fix the parser", updatedAt: 3 },
    { id: OTHER_ID, title: "Release notes", updatedAt: 2 },
    { id: THIRD_ID, title: "Parse the logs", updatedAt: 1 },
  ];
  const saved = stateWith(true, { conversations });
  const filterField = (host: HTMLElement) =>
    host.querySelector<HTMLInputElement>('input[aria-label="Filter by title"]');
  const titles = (host: HTMLElement) => [...host.querySelectorAll(".history-title")].map((title) => title.textContent);
  const historyButton = (host: HTMLElement) =>
    [...host.querySelectorAll("button")].find((element) => element.textContent === "History");

  /** Open History over `state` and hand `run` the filter field. */
  function withHistory(state: ChatState, run: (panel: Panel, field: HTMLInputElement) => Promise<void>) {
    return withPanel(state, async (panel) => {
      await panel.click("History");
      const field = filterField(panel.host);
      if (!field) throw new Error("no filter field");
      await run(panel, field);
    });
  }

  test("shows a text field labelled Filter by title above the rows, and none without a conversation", () => {
    const list = (rows: typeof conversations) =>
      renderToStaticMarkup(
        <ConversationList
          conversations={rows}
          currentId={CONVERSATION_ID}
          language="en"
          onOpen={() => {}}
          onDelete={() => {}}
          onDismiss={() => {}}
        />,
      );
    const html = list(conversations);
    expect(html).toMatch(/<input type="text"[^>]*placeholder="Filter by title"[^>]*aria-label="Filter by title"/);
    expect(html.indexOf("Filter by title")).toBeLessThan(html.indexOf("<ul"));
    const empty = list([]);
    expect(empty).toContain("No past conversations.");
    expect(empty).not.toContain("<input");
  });

  test("opening History moves the focus into the field", async () => {
    await withHistory(saved, async (_panel, field) => {
      expect(document.activeElement).toBe(field);
    });
  });

  test("typing keeps the rows whose title holds the text, in order, and says No match when none does", async () => {
    await withHistory(saved, async (panel, field) => {
      await panel.fill(field, " PARSE ");
      expect(titles(panel.host)).toEqual(["Fix the parser", "Parse the logs"]);
      expect(panel.host.querySelector(".history li.current")?.textContent).toContain("Fix the parser");
      await panel.fill(field, "deploy");
      expect(titles(panel.host)).toEqual([]);
      expect(panel.host.querySelector(".history")?.textContent).toContain("No match");
      await panel.fill(field, "");
      expect(titles(panel.host)).toEqual(["Fix the parser", "Release notes", "Parse the logs"]);
      expect(panel.host.querySelector(".history")?.textContent).not.toContain("No match");
    });
  });

  test("Enter opens the first row listed and closes History", async () => {
    await withHistory(saved, async (panel, field) => {
      await panel.fill(field, "the logs");
      await panel.press("Enter", field);
      expect(posted).toEqual([{ type: "openConversation", id: THIRD_ID }]);
      expect(filterField(panel.host)).toBeNull();
    });
  });

  test("Enter posts nothing with no row listed or while an input method composes", async () => {
    await withHistory(saved, async (panel, field) => {
      await panel.press("Enter", field, { isComposing: true });
      await panel.fill(field, "deploy");
      await panel.press("Enter", field);
      expect(posted).toEqual([]);
      expect(filterField(panel.host)).toBe(field);
    });
  });

  test("Escape clears the field, then closes History and focuses the History button", async () => {
    await withHistory(saved, async (panel, field) => {
      await panel.fill(field, "notes");
      await panel.press("Escape", field);
      expect(field.value).toBe("");
      expect(titles(panel.host)).toHaveLength(3);
      await panel.press("Escape", field);
      expect(filterField(panel.host)).toBeNull();
      expect(document.activeElement).toBe(historyButton(panel.host) ?? null);
      expect(posted).toEqual([]);
    });
  });

  test("Delete on a filtered row deletes that row and the filter applies to the new list", async () => {
    await withHistory(saved, async (panel, field) => {
      await panel.fill(field, "parse");
      await panel.click("Delete");
      expect(posted).toEqual([{ type: "deleteConversation", id: CONVERSATION_ID }]);
      await panel.show(stateWith(true, { conversations: conversations.slice(1) }));
      expect(field.value).toBe("parse");
      expect(titles(panel.host)).toEqual(["Parse the logs"]);
    });
  });

  test("History reopens with an empty field", async () => {
    await withHistory(saved, async (panel, field) => {
      await panel.fill(field, "notes");
      await panel.click("History");
      await panel.click("History");
      expect(filterField(panel.host)?.value).toBe("");
      expect(titles(panel.host)).toHaveLength(3);
    });
  });

  /** `saved` in the middle of a reply, then with that reply done. */
  const question: ChatEntry = { role: "user", content: "Hi", mentions: [] };
  const streaming = stateWith(true, {
    conversations,
    entries: [question, { role: "assistant", reasoning: "", content: "Hel", status: "streaming" }],
  });
  const replied = stateWith(true, {
    conversations,
    entries: [question, { role: "assistant", reasoning: "", content: "Hello", status: "done" }],
  });

  test("a reply that ends while History is open leaves the focus in the filter field", async () => {
    await withPanel(streaming, async (panel) => {
      await panel.click("History");
      const field = filterField(panel.host);
      if (!field) throw new Error("no filter field");
      await panel.fill(field, "notes");
      await panel.show(replied);
      expect(document.activeElement).toBe(field);
    });
  });

  test("a reply that ends with History closed gives the focus to the message box", async () => {
    await withPanel(streaming, async (panel) => {
      historyButton(panel.host)?.focus();
      await panel.show(replied);
      expect(document.activeElement).toBe(panel.textarea);
    });
  });

  test("the listing failure shows whatever the filter", async () => {
    const failed = stateWith(true, { conversations, listFailed: { cause: "Error: EACCES" } });
    await withHistory(failed, async (panel, field) => {
      await panel.fill(field, "deploy");
      expect(panel.host.textContent).toContain("Could not list the past conversations.");
    });
  });
});

describe("drafts from the editor", () => {
  const selection = { type: "insertDraft", text: "@selection", mode: "caret", picked: [] };
  const fix = {
    type: "insertDraft",
    text: "Fix this problem in @my app.ts, at line 12: Broken.",
    mode: "fillOrAppend",
    picked: ["my app.ts,"],
  };

  test("a draft fills the message box at its caret and focuses it, without sending", async () => {
    await withPanel(stateWith(true), async ({ host, textarea, type, receive }) => {
      await type("see this", 3);
      (host.querySelector("button.secondary") as HTMLButtonElement).focus();
      await receive(selection);
      expect(textarea.value).toBe("see @selection this");
      expect(textarea.selectionStart).toBe(15);
      expect(document.activeElement).toBe(textarea);
      expect(posted.filter((message) => (message as { type: string }).type === "send")).toEqual([]);
    });
  });

  // [>]: Live in VSCodium, the workbench can focus the webview right after the draft focused the box: the frame blurs,
  // then its window regains focus with nothing focused inside it (#68).
  const workbenchRefocus = () =>
    act(async () => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.dispatchEvent(new Event("focus"));
    });

  test("a draft's box takes the focus back when the panel regains it with nothing focused", async () => {
    await withPanel(stateWith(true), async ({ textarea, receive }) => {
      await receive(selection);
      await workbenchRefocus();
      expect(document.activeElement).toBe(textarea);
    });
  });

  test("without a draft, or once the user acts in the panel, regaining the focus moves none", async () => {
    await withPanel(stateWith(true), async ({ textarea, receive }) => {
      await workbenchRefocus();
      expect(document.activeElement).not.toBe(textarea);
      await receive(selection);
      await act(async () => {
        window.dispatchEvent(new Event("pointerdown"));
      });
      await workbenchRefocus();
      expect(document.activeElement).not.toBe(textarea);
    });
  });

  test("after a draft, regaining the focus leaves a control that holds it where it is", async () => {
    await withPanel(stateWith(true), async ({ host, receive }) => {
      await receive(selection);
      const control = host.querySelector("select:not([disabled])") as HTMLSelectElement;
      control.focus();
      expect(document.activeElement).toBe(control);
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(document.activeElement).toBe(control);
    });
  });

  test("a draft posted right behind init is applied once", async () => {
    await withPanel(
      stateWith(true),
      async ({ textarea, show }) => {
        expect(textarea.value).toBe("@selection ");
        await show(stateWith(true, { entries: hi }));
        expect(textarea.value).toBe("@selection ");
      },
      [selection],
    );
  });

  test("a draft closes History and focuses the message box", async () => {
    await withPanel(stateWith(true, { entries: hi }), async ({ host, click, receive }) => {
      await click("History");
      expect(host.querySelector("#history")).not.toBeNull();
      await receive(fix);
      expect(host.querySelector("#history")).toBeNull();
      const textarea = host.querySelector("textarea");
      expect(textarea?.value).toBe(fix.text);
      expect(document.activeElement).toBe(textarea);
    });
  });

  test("sending a filled draft posts its picked path", async () => {
    await withPanel(stateWith(true), async ({ receive, press }) => {
      await receive(fix);
      await press("Enter");
      expect(posted).toEqual([{ type: "send", text: fix.text, mentions: ["my app.ts,"] }]);
    });
  });

  test("a draft that arrives while the panel has no message box is dropped", async () => {
    await withPanel(stateWith(true), async ({ host, show, receive }) => {
      await show(stateWith(false));
      await receive(selection);
      await show(stateWith(true));
      expect(host.querySelector("textarea")?.value).toBe("");
    });
  });
});

describe("context usage", () => {
  const usage = { used: 12345, size: 32768 };

  test("shows the estimate against the model's size next to the model picker", () => {
    const html = renderToStaticMarkup(
      <App state={stateWith(true, { context: { ...usage, known: true } })} language="en" />,
    );
    expect(html).toContain("12,345 / 32,768 tokens (38%)");
    expect(html.indexOf('aria-label="Model"')).toBeLessThan(html.indexOf("12,345 / 32,768 tokens"));
    expect(html.indexOf("12,345 / 32,768 tokens")).toBeLessThan(html.indexOf(">New chat<"));
    expect(html).not.toContain("Unknown context size");
  });

  test("the usage line's tooltip names the estimate only when the last reply reported no usage", () => {
    const html = renderToStaticMarkup(
      <App state={stateWith(true, { context: { ...usage, known: true } })} language="en" />,
    );
    expect(html).toContain('<span class="usage" title="Estimated size of the next request">');
  });

  test("the usage line's tooltip adds the counts the last reply reported, formatted like the line", () => {
    const context = { ...usage, known: true, reported: { prompt: 12001, completion: 345 } };
    const html = renderToStaticMarkup(<App state={stateWith(true, { context })} language="en" />);
    expect(html).toContain(
      'title="Estimated size of the next request. Last reply: 12,001 prompt tokens, 345 completion tokens"',
    );
  });

  test("a model absent from the table shows the 32k notice with its link beside the usage", () => {
    const html = renderToStaticMarkup(
      <App state={stateWith(true, { context: { ...usage, known: false } })} language="en" />,
    );
    expect(html).toContain("Unknown context size, using 32k");
    expect(html).toContain(">Set context size<");
    expect(html).toContain("12,345 / 32,768 tokens (38%)");
  });

  test("with no model selected, shows neither the usage nor the notice", () => {
    const state = stateWith(true, {
      models: { status: "loading" },
      model: undefined,
      context: { ...usage, known: false },
    });
    const html = renderToStaticMarkup(<App state={state} language="en" />);
    expect(html).not.toContain("tokens (");
    expect(html).not.toContain("Unknown context size");
  });

  test("results left out of the next request show one notice with their count", () => {
    const plural = renderToStaticMarkup(
      <App state={stateWith(true, { context: { ...usage, known: true, leftOut: 4 } })} language="en" />,
    );
    expect(plural).toContain(
      '<p class="notice" role="status">4 older tool results are left out of the request to save context.</p>',
    );
    const singular = renderToStaticMarkup(
      <App state={stateWith(true, { context: { ...usage, known: true, leftOut: 1 } })} language="en" />,
    );
    expect(singular).toContain("1 older tool result is left out of the request to save context.");
  });

  test("no notice when nothing is left out of the next request", () => {
    const html = renderToStaticMarkup(
      <App state={stateWith(true, { context: { ...usage, known: true } })} language="en" />,
    );
    expect(html).not.toContain("left out of the request");
  });

  test("the link asks the host for the selected model's context size", () => {
    button(ContextNotice({ model: "qwen3:8b" }), "Set context size").props.onClick!();
    expect(posted).toEqual([{ type: "setContextSize", model: "qwen3:8b" }]);
  });
});

describe("warnings", () => {
  test("lists each skipped skill beside the skipped providers, naming its file and the problem", () => {
    const state = stateWith(true, {
      skipped: [{ position: 2, reason: "missingName" }],
      skillWarnings: [
        { path: "~/.agents/skills/a/SKILL.md", problem: { kind: "missingDescription" } },
        { path: ".agents/skills/b/SKILL.md", problem: { kind: "nameMismatch", name: "c", directory: "b" } },
        { path: "~/.agents/skills/d/SKILL.md", problem: { kind: "outsideSkillFolder" } },
      ],
    });
    const html = renderToStaticMarkup(<App state={state} language="en" />);
    expect(html.match(/<ul class="warnings" role="status">/g)).toHaveLength(1);
    expect(html).toContain("Provider number 2 in the settings is skipped: it has no name.");
    expect(html).toContain("Skill ~/.agents/skills/a/SKILL.md is skipped: it lacks a description.");
    expect(html).toContain("Skill .agents/skills/b/SKILL.md is skipped: its name c differs from its folder b.");
    expect(html).toContain("Skill ~/.agents/skills/d/SKILL.md is skipped: it links outside its skill folder.");
  });

  test("shows skill warnings without any provider configured", () => {
    const state = stateWith(false, {
      skillWarnings: [{ path: "~/.agents/skills", problem: { kind: "folderUnreadable", cause: "EACCES" } }],
    });
    const html = renderToStaticMarkup(<App state={state} language="en" />);
    expect(html).toContain("The skills in ~/.agents/skills are skipped: the folder cannot be read (EACCES).");
  });

  test("offers Add provider under the skipped providers, and the button asks the host to add one", () => {
    const state = stateWith(true, { skipped: [{ position: 2, reason: "missingName" }] });
    const html = renderToStaticMarkup(<App state={state} language="en" />);
    expect(html).toMatch(/<\/ul>.*>Add provider<\/button>/);
    button(Warnings({ state }), "Add provider").props.onClick!();
    expect(posted).toEqual([{ type: "addProvider" }]);
  });

  test("with skipped entries and no valid provider, shows one Add provider, the empty state's", () => {
    const state = stateWith(false, { skipped: [{ position: 1, name: "P", reason: "invalidUrl" }] });
    const html = renderToStaticMarkup(<App state={state} language="en" />);
    expect(html.match(/>Add provider<\/button>/g)).toHaveLength(1);
    expect(html).toMatch(/class="empty".*>Add provider<\/button>.*<ul class="warnings"/);
  });

  test("offers no Add provider under skill warnings alone", () => {
    const state = stateWith(true, {
      skillWarnings: [{ path: "~/.agents/skills", problem: { kind: "folderUnreadable", cause: "EACCES" } }],
    });
    expect(renderToStaticMarkup(<App state={state} language="en" />)).not.toContain("Add provider");
  });

  test("shows no warning list when nothing is skipped", () => {
    expect(renderToStaticMarkup(<App state={stateWith(true)} language="en" />)).not.toContain('class="warnings"');
  });
});

describe("code blocks", () => {
  /** Panel markup for one question and `entries` after it. */
  const renderEntries = (entries: ChatEntry[]) =>
    renderToStaticMarkup(<App state={stateWith(true, { entries: [hi[0]!, ...entries] })} language="en" />);
  const reply = (content: string, status: Reply["status"] = "done", fields: Partial<Reply> = {}): ChatEntry => ({
    role: "assistant",
    reasoning: "",
    content,
    status,
    ...fields,
  });
  /** How many code blocks of the markup have controls. */
  const controlled = (html: string) => html.split('<div class="code-actions">').length - 1;
  const actionButtons = (html: string) => html.match(/<button[^>]*class="code-action"[^>]*>[^<]*<\/button>/g) ?? [];

  test("a closed block has Copy and Insert at cursor, native buttons named by their labels, before its code", () => {
    const html = renderEntries([reply("Run:\n\n```sh\nls -la\n```\n\nDone.")]);
    expect(actionButtons(html)).toEqual([
      '<button type="button" class="code-action">Copy</button>',
      '<button type="button" class="code-action">Insert at cursor</button>',
    ]);
    expect(html.indexOf('class="code-actions"')).toBeLessThan(html.indexOf("ls -la"));
  });

  test("a closed block has its controls while its reply still streams", () => {
    expect(controlled(renderEntries([reply("```\nls\n```\nmore", "streaming")]))).toBe(1);
  });

  test("a block whose fence is still open has none while its reply is in flight, and both once it stopped", () => {
    for (const status of ["waiting", "streaming"] as const) {
      expect(controlled(renderEntries([reply("Here:\n\n```ts\nconst a = 1;\n", status)]))).toBe(0);
    }
    expect(controlled(renderEntries([reply("Here:\n\n```ts\nconst a = 1;\n", "stopped")]))).toBe(1);
  });

  test("a block with an open fence gets its controls whichever way its reply ended", () => {
    for (const fields of [
      { status: "done" },
      { status: "halted", haltReason: "stepLimit" },
      { status: "failed", error: { kind: "cutOff", provider: "P", reason: "ended" } },
    ] as const) {
      expect(controlled(renderEntries([reply("```\nconst a = 1;", fields.status, fields)]))).toBe(1);
    }
  });

  test("an indented block is complete once rendered text follows it or its reply ended", () => {
    expect(controlled(renderEntries([reply("Code:\n\n    let x = 1;\n", "streaming")]))).toBe(0);
    expect(controlled(renderEntries([reply("Code:\n\n    let x = 1;\n\nAfter.", "streaming")]))).toBe(1);
    expect(controlled(renderEntries([reply("Code:\n\n    let x = 1;\n", "done")]))).toBe(1);
  });

  test("while its reply streams, a block is complete exactly when its closing fence was written", () => {
    const streaming = (content: string) => controlled(renderEntries([reply(content, "streaming")]));
    expect(streaming("```\nls\n```")).toBe(1);
    expect(streaming("```\n\n```")).toBe(1);
    expect(streaming("```js\rx\r```")).toBe(1);
    expect(streaming("```js\r\nx\r\n```")).toBe(1);
    expect(streaming("```\nx\n`````")).toBe(1);
    expect(streaming("- item\n\n  ```\n  a\n  ```")).toBe(1);
    expect(streaming("> - ```\n>   a\n>   ```")).toBe(1);
    expect(streaming("```\n\n")).toBe(0);
    expect(streaming("```\nx\n~~~")).toBe(0);
    expect(streaming("````\nx\n```")).toBe(0);
    expect(streaming("```\nx\n    ```")).toBe(0);
    expect(streaming("```\n> ```")).toBe(0);
    expect(streaming("```\nx\n``` y")).toBe(0);
  });

  test("while its reply streams, the parser decides closure inside containers, tabs, and fence indents included", () => {
    const streaming = (content: string) => controlled(renderEntries([reply(content, "streaming")]));
    expect(streaming("   ```\nx\n    ```")).toBe(0);
    expect(streaming("  ```\nx\n    ```")).toBe(0);
    expect(streaming("- > ```\n  > x\n  >     ```")).toBe(0);
    expect(streaming(">\t```\n>\tx\n>\t```")).toBe(1);
    expect(streaming("-   item\n\n    > ```\n    > x\n    > ```")).toBe(1);
    expect(streaming("-\t```\n\tx\n\t```")).toBe(1);
    expect(streaming("~~~\n```\n~~~")).toBe(1);
    expect(streaming("````\n```\n````")).toBe(1);
    expect(streaming("```")).toBe(0);
    expect(streaming("```js")).toBe(0);
  });

  test("a block open in a blockquote stays without controls while the stream ends on a container prefix", () => {
    const streaming = (content: string) => controlled(renderEntries([reply(content, "streaming")]));
    expect(streaming("> ```\n> x\n> \n> ")).toBe(0);
    expect(streaming("> ```\n> x\n> \n> y")).toBe(0);
    expect(streaming("> ```\n> x\n\nafter")).toBe(1);
  });

  test("an empty closed block streaming has its controls, disabled", () => {
    expect(actionButtons(renderEntries([reply("```\n\n```", "streaming")]))).toEqual([
      '<button type="button" class="code-action" disabled="">Copy</button>',
      '<button type="button" class="code-action" disabled="">Insert at cursor</button>',
    ]);
  });

  test("an empty block's buttons are disabled", () => {
    expect(actionButtons(renderEntries([reply("```\n```")]))).toEqual([
      '<button type="button" class="code-action" disabled="">Copy</button>',
      '<button type="button" class="code-action" disabled="">Insert at cursor</button>',
    ]);
  });

  test("the call block, a tool step's result, the reasoning, and a user message get no controls", () => {
    const content = "Look:\n<write_file>\n<path>a.md</path>\n<content>\n```\nx\n```\n</content>\n</write_file>";
    const html = renderToStaticMarkup(
      <App
        state={stateWith(true, {
          entries: [
            { role: "user", content: "```\nmine\n```", mentions: [] },
            reply(content, "done", {
              reasoning: "```\nthought\n```",
              call: {
                name: "write_file",
                args: { path: "a.md", content: "```\nx\n```" },
                start: 6,
                end: content.length,
              },
            }),
            { role: "tool", name: "write_file", args: { path: "a.md" }, status: "ok", text: "```\nresult\n```" },
            reply("Written."),
          ],
        })}
        language="en"
      />,
    );
    expect(controlled(html)).toBe(0);
  });
});

describe("code block actions", () => {
  const blockState = (content: string) =>
    stateWith(true, { entries: [hi[0]!, { role: "assistant", reasoning: "", content, status: "done" }] });

  /** Replace the webview's clipboard with one whose writes `write` answers; the texts written are recorded. */
  function fakeClipboard(write: (text: string) => Promise<void> = async () => {}) {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return write(text);
        },
      },
    });
    return written;
  }

  /** The labels of the code block buttons, in order. */
  const labels = (host: HTMLElement) =>
    [...host.querySelectorAll(".code-action")].map((element) => element.textContent);

  test("Copy writes the block's text without its final line break, says Copied, then Copy again", async () => {
    await withPanel(blockState("```js\nconst a = 1;\n\nconst b = 2;\n```"), async ({ host, click }) => {
      const written = fakeClipboard();
      jest.useFakeTimers();
      try {
        await click("Copy");
        expect(written).toEqual(["const a = 1;\n\nconst b = 2;"]);
        expect(labels(host)).toEqual(["Copied", "Insert at cursor"]);
        await act(async () => jest.advanceTimersByTime(1900));
        expect(labels(host)).toEqual(["Copied", "Insert at cursor"]);
        await act(async () => jest.advanceTimersByTime(200));
        expect(labels(host)).toEqual(["Copy", "Insert at cursor"]);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test("a second Copy before the outcome clears restarts its two seconds", async () => {
    await withPanel(blockState("```\nx\n```"), async ({ host, click }) => {
      fakeClipboard();
      jest.useFakeTimers();
      try {
        await click("Copy");
        await act(async () => jest.advanceTimersByTime(1500));
        await click("Copied");
        await act(async () => jest.advanceTimersByTime(1500));
        expect(labels(host)).toEqual(["Copied", "Insert at cursor"]);
        await act(async () => jest.advanceTimersByTime(600));
        expect(labels(host)).toEqual(["Copy", "Insert at cursor"]);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test("a block removed while Copy shows its outcome clears its pending reset", async () => {
    await withPanel(blockState("```\nx\n```"), async ({ click, show }) => {
      fakeClipboard();
      // [&]: React schedules timers of its own, so the reset is told apart by its delay and followed by its id.
      const { setTimeout: realSet, clearTimeout: realClear } = globalThis;
      const resets: unknown[] = [];
      const cleared: unknown[] = [];
      globalThis.setTimeout = ((handler: () => void, delay?: number) => {
        const id = realSet(handler, delay);
        if (delay === 2000) resets.push(id);
        return id;
      }) as typeof setTimeout;
      globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => {
        cleared.push(id);
        realClear(id);
      }) as typeof clearTimeout;
      try {
        await click("Copy");
        expect(resets).toHaveLength(1);
        expect(cleared).not.toContain(resets[0]);
        await show(blockState("No code any more."));
        expect(cleared).toContain(resets[0]);
      } finally {
        globalThis.setTimeout = realSet;
        globalThis.clearTimeout = realClear;
      }
    });
  });

  test("a rejected clipboard write says Copy failed in the button's place, then Copy again", async () => {
    await withPanel(blockState("```\nx\n```"), async ({ host, click }) => {
      fakeClipboard(async () => {
        throw new Error("denied");
      });
      jest.useFakeTimers();
      try {
        await click("Copy");
        expect(labels(host)).toEqual(["Copy failed", "Insert at cursor"]);
        await act(async () => jest.advanceTimersByTime(2100));
        expect(labels(host)).toEqual(["Copy", "Insert at cursor"]);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test("Insert at cursor posts the same text, and its label stays", async () => {
    await withPanel(blockState("```py\nprint(1)\n```"), async ({ host, click }) => {
      posted.length = 0;
      await click("Insert at cursor");
      expect(posted).toEqual([{ type: "insertCode", text: "print(1)" }]);
      expect(labels(host)).toEqual(["Copy", "Insert at cursor"]);
    });
  });

  test("a block inside a list item and a ~~~ block holding backtick fences give their exact code", async () => {
    const content = "1. Step:\n\n   ```sh\n   echo a\n     indented\n   ```\n\n~~~~md\n```js\nx\n```\n~~~~";
    await withPanel(blockState(content), async ({ host }) => {
      const insert = [...host.querySelectorAll<HTMLButtonElement>(".code-action")].filter(
        (element) => element.textContent === "Insert at cursor",
      );
      expect(insert).toHaveLength(2);
      posted.length = 0;
      for (const element of insert) await act(async () => element.click());
      expect(posted).toEqual([
        { type: "insertCode", text: "echo a\n  indented" },
        { type: "insertCode", text: "```js\nx\n```" },
      ]);
    });
  });
});

describe("queued messages", () => {
  const waiting: ChatEntry[] = [hi[0]!, { role: "assistant", reasoning: "", content: "", status: "waiting" }];
  const stopped: ChatEntry[] = [hi[0]!, { role: "assistant", reasoning: "", content: "Partial", status: "stopped" }];
  const queue = [
    { id: 4, text: "B", mentions: [] },
    { id: 5, text: "C", mentions: [] },
  ];
  /** Text of each queued row, in order. */
  const rows = (host: HTMLElement) =>
    [...host.querySelectorAll(".queue li .queued-text")].map((row) => row.textContent);
  const buttonLabels = (host: HTMLElement) => [...host.querySelectorAll("button")].map((button) => button.textContent);

  test("during a reply, Enter queues the message with its picked paths, clears the box, and keeps the focus", async () => {
    await withPanel(stateWith(true, { entries: waiting }), async ({ textarea, type, press }) => {
      textarea.focus();
      await type("next step");
      posted.length = 0;
      await press("Enter");
      expect(posted).toEqual([{ type: "queueMessage", text: "next step", mentions: [] }]);
      expect(textarea.value).toBe("");
      expect(document.activeElement).toBe(textarea);
    });
  });

  test("during a reply, Send queues the message beside Stop", async () => {
    await withPanel(stateWith(true, { entries: waiting }), async ({ host, type, click }) => {
      expect(buttonLabels(host)).toContain("Stop");
      await type("next step");
      posted.length = 0;
      await click("Send");
      expect(posted).toEqual([{ type: "queueMessage", text: "next step", mentions: [] }]);
    });
  });

  test("with 10 queued, Send leaves the text in the box and a line says the queue is full", async () => {
    const full = Array.from({ length: 10 }, (_, index) => ({ id: index, text: `m${index}`, mentions: [] }));
    await withPanel(stateWith(true, { entries: waiting, queue: full }), async ({ host, textarea, type, press }) => {
      expect(host.textContent).toContain("The queue is full: 10 messages at most.");
      await type("one more");
      posted.length = 0;
      await press("Enter");
      expect(posted).toEqual([]);
      expect(textarea.value).toBe("one more");
    });
  });

  test("shows each queued message under the message box, in order, with Edit and Remove, and no paused line during a reply", async () => {
    await withPanel(stateWith(true, { entries: waiting, queue }), async ({ host, textarea }) => {
      expect(rows(host)).toEqual(["B", "C"]);
      expect(host.querySelectorAll(".queue li button")).toHaveLength(4);
      expect(buttonLabels(host)).not.toContain("Send now");
      expect(host.textContent).not.toContain("The queue is paused.");
      const focusable = [...host.querySelectorAll<HTMLElement>("button, select, textarea, input, a[href], summary")];
      const firstQueued = focusable.findIndex((element) => element.closest(".queue"));
      expect(firstQueued).toBeGreaterThan(focusable.indexOf(textarea));
      expect(focusable[firstQueued - 1]?.textContent).toBe("Stop");
    });
  });

  test("Remove asks to remove that message", async () => {
    await withPanel(stateWith(true, { entries: waiting, queue }), async ({ host }) => {
      posted.length = 0;
      const remove = host.querySelectorAll<HTMLButtonElement>(".queue li")[1]?.querySelectorAll("button");
      await act(async () => [...(remove ?? [])].find((button) => button.textContent === "Remove")?.click());
      expect(posted).toEqual([{ type: "removeQueued", id: 5 }]);
    });
  });

  test("Edit asks the host for the message and focuses the box; its text and picked paths come back after the draft", async () => {
    const picked = [{ id: 7, text: "read @my file.ts", mentions: ["my file.ts"] }];
    await withPanel(
      stateWith(true, { entries: stopped, queue: picked }),
      async ({ host, textarea, type, press, receive }) => {
        await type("foo");
        posted.length = 0;
        // [>]: The last user message has an Edit of its own, before the queue in the DOM.
        const edit = [...host.querySelectorAll<HTMLButtonElement>(".queue button")].find(
          (b) => b.textContent === "Edit",
        );
        await act(async () => edit?.click());
        expect(posted).toEqual([{ type: "editQueued", id: 7 }]);
        expect(textarea.value).toBe("foo");
        expect(document.activeElement).toBe(textarea);
        expect(host.querySelector(".queue")).not.toBeNull();

        await receive({ type: "insertDraft", text: "read @my file.ts", mode: "paragraph", picked: ["my file.ts"] });
        expect(textarea.value).toBe("foo\n\nread @my file.ts");
        posted.length = 0;
        await press("Enter");
        expect(posted).toEqual([{ type: "send", text: "foo\n\nread @my file.ts", mentions: ["my file.ts"] }]);
      },
    );
  });

  test("after a stop, a line says the queue is paused and the first message has Send now", async () => {
    await withPanel(stateWith(true, { entries: stopped, queue }), async ({ host, click }) => {
      expect(host.textContent).toContain("The queue is paused.");
      const rowButtons = [...host.querySelectorAll(".queue li")].map((row) =>
        [...row.querySelectorAll("button")].map((button) => button.textContent),
      );
      expect(rowButtons).toEqual([
        ["Send now", "Edit", "Remove"],
        ["Edit", "Remove"],
      ]);
      posted.length = 0;
      await click("Send now");
      expect(posted).toEqual([{ type: "sendQueued", id: 4 }]);
    });
  });

  test("Send now is disabled when Send would not act", async () => {
    await withPanel(stateWith(true, { entries: stopped, queue, model: undefined }), async ({ host }) => {
      const sendNow = [...host.querySelectorAll("button")].find((button) => button.textContent === "Send now");
      expect(sendNow?.disabled).toBe(true);
    });
  });

  test("New chat posts its request only: the queued texts come back from the host, after the draft", async () => {
    await withPanel(stateWith(true, { entries: stopped, queue }), async ({ textarea, click, receive }) => {
      posted.length = 0;
      await click("New chat");
      expect(posted).toEqual([{ type: "newChat" }]);
      expect(textarea.value).toBe("");
      await receive({ type: "insertDraft", text: "B\n\nC", mode: "paragraph", picked: [] });
      expect(textarea.value).toBe("B\n\nC");
    });
    await withPanel(stateWith(true, { entries: waiting, queue }), async ({ textarea, type, click, receive }) => {
      await type("foo");
      await click("New chat");
      expect(textarea.value).toBe("foo");
      await receive({ type: "insertDraft", text: "B\n\nC", mode: "paragraph", picked: [] });
      expect(textarea.value).toBe("foo\n\nB\n\nC");
    });
  });

  test("returned texts close no History and move no focus, unlike an editor draft", async () => {
    const conversations = [{ id: CONVERSATION_ID, title: "Shown", updatedAt: 1 }];
    const state = stateWith(true, { entries: stopped, queue, conversations });
    await withPanel(state, async ({ host, textarea, click, receive }) => {
      await click("History");
      const filter = host.querySelector<HTMLInputElement>(".history input");
      expect(filter).not.toBeNull();
      expect(document.activeElement).toBe(filter);
      await receive({ type: "insertDraft", text: "B", mode: "paragraph", picked: [] });
      expect(host.querySelector(".history")).not.toBeNull();
      expect(document.activeElement).toBe(filter);
      expect(textarea.value).toBe("B");
    });
  });

  test("a returned text waits while there is no message box and lands when it comes back; an editor draft is dropped", async () => {
    await withPanel(stateWith(true, { entries: stopped }), async ({ host, show, receive }) => {
      await show(stateWith(false, { entries: stopped }));
      expect(host.querySelector("textarea")).toBeNull();
      await receive({ type: "insertDraft", text: "unsent B", mode: "paragraph", picked: [] });
      await receive({ type: "insertDraft", text: "from the editor", mode: "fillOrAppend", picked: [] });
      await show(stateWith(true, { entries: stopped }));
      expect(host.querySelector("textarea")?.value).toBe("unsent B");
    });
  });

  test("Send is secondary beside Stop during a reply, and primary otherwise", async () => {
    const sendClass = (state: ChatState) =>
      renderToStaticMarkup(<App state={state} language="en" />).match(/<button[^>]*>Send<\/button>/)?.[0];
    expect(sendClass(stateWith(true, { entries: waiting }))).toContain('class="secondary"');
    expect(sendClass(stateWith(true, { entries: hi }))).not.toContain("class=");
  });

  test("with an approval open and a queue, Shift+Tab from the message box still reaches Reject first", async () => {
    const answer = "Renaming.\n<write_file>\n<path>a.ts</path>\n<content>\nx\n</content>\n</write_file>";
    const writing: ChatEntry = {
      role: "assistant",
      reasoning: "",
      content: answer,
      status: "streaming",
      call: { name: "write_file", args: { path: "a.ts", content: "x" }, start: 10, end: answer.length },
    };
    const state = stateWith(true, {
      entries: [hi[0]!, writing],
      approval: { id: 1, kind: "write", tool: "write_file", summary: "a.ts" },
      queue,
    });
    await withPanel(state, async ({ host, textarea }) => {
      const focusable = [...host.querySelectorAll<HTMLElement>("button, select, textarea, input, a[href], summary")];
      const box = focusable.indexOf(textarea);
      expect(focusable[box - 1]?.textContent).toBe("Reject");
      expect(focusable.findIndex((element) => element.closest(".queue"))).toBeGreaterThan(box);
    });
  });
});

describe("undo changes", () => {
  const writeAnswer = "Writing.\n<write_file>\n<path>a.ts</path>\n<content>\nx\n</content>\n</write_file>";
  /** A turn that wrote `a.ts` and answered "Done.", then a turn answered "Other.". */
  const turns: ChatEntry[] = [
    { role: "user", content: "Write it", mentions: [] },
    {
      role: "assistant",
      reasoning: "",
      content: writeAnswer,
      status: "done",
      call: { name: "write_file", args: { path: "a.ts", content: "x" }, start: 9, end: writeAnswer.length },
    },
    {
      role: "tool",
      name: "write_file",
      args: { path: "a.ts", content: "x" },
      status: "ok",
      text: "ok",
      approval: "auto",
    },
    { role: "assistant", reasoning: "", content: "Done.", status: "done" },
    { role: "user", content: "Anything else?", mentions: [] },
    { role: "assistant", reasoning: "", content: "Other.", status: "done" },
  ];
  const idle = { reply: undefined, ranCommand: false, running: false, outcome: undefined };
  const html = (undo: ChatState["undo"], entries: ChatEntry[] = turns) =>
    renderToStaticMarkup(<App state={stateWith(true, { entries, undo })} language="en" />);
  const count = (text: string, part: string) => text.split(part).length - 1;

  test("shows the button only under the reply the state names", () => {
    expect(html(idle)).not.toContain("Undo changes");
    const shown = html({ ...idle, reply: 3 });
    expect(count(shown, ">Undo changes</button>")).toBe(1);
    const at = shown.indexOf("Undo changes");
    expect(at).toBeGreaterThan(shown.indexOf("Done."));
    expect(at).toBeLessThan(shown.indexOf("Other."));
    expect(shown).not.toContain("not undone");
  });

  test("never shows the button while a reply is in flight", () => {
    const streaming: ChatEntry[] = [
      ...turns.slice(0, 5),
      { role: "assistant", reasoning: "", content: "Oth", status: "streaming" },
    ];
    expect(html({ ...idle, reply: 3 }, streaming)).not.toContain("Undo changes");
  });

  test("shows the button outside the fold of a turn of several steps, and under a summary that ended its turn", () => {
    const step = turns[2]!;
    const folded: ChatEntry[] = [...turns.slice(0, 3), turns[1]!, step, turns[3]!];
    const shown = html({ ...idle, reply: 5 }, folded);
    expect(shown).toContain('<details class="turn-fold"');
    expect(shown.indexOf("Undo changes")).toBeGreaterThan(shown.indexOf("</details>"));

    const summary: ChatEntry = { role: "assistant", reasoning: "", content: "", status: "stopped", summary: true };
    expect(html({ ...idle, reply: 3 }, [...turns.slice(0, 3), summary])).toContain(">Undo changes</button>");
  });

  test("says commands are not listed or undone when the turn ran one", () => {
    expect(html({ ...idle, reply: 3, ranCommand: true })).toContain("Commands this turn ran are not listed or undone.");
  });

  test("words the outcome three ways, naming each file under the reply it undid", () => {
    const outcome = (files: NonNullable<ChatState["undo"]["outcome"]>["files"], reply?: number, under = 3) =>
      html({ ...idle, reply, outcome: { reply: under, files } });

    const all = outcome([
      { path: "a.ts", status: "restored" },
      { path: "b.ts", status: "removed" },
    ]);
    expect(all).toContain("Changes undone.");
    expect(all).toContain('<code class="undo-path">a.ts</code>: restored');
    expect(all).toContain('<code class="undo-path">b.ts</code>: removed, since this turn created it');
    expect(all).toContain('<div class="undo-outcome" role="status">');
    expect(all.indexOf("Changes undone.")).toBeGreaterThan(all.indexOf("Done."));
    expect(all.indexOf("Changes undone.")).toBeLessThan(all.indexOf("Other."));
    const later = outcome([{ path: "a.ts", status: "restored" }], undefined, 5);
    expect(count(later, "Changes undone.")).toBe(1);
    expect(later.indexOf("Changes undone.")).toBeGreaterThan(later.indexOf("Other."));

    const some = outcome(
      [
        { path: "a.ts", status: "restored" },
        { path: "b.ts", status: "skipped", reason: "changed" },
      ],
      3,
    );
    expect(some).toContain("Some changes were not undone. Undo changes again to retry the files skipped.");
    expect(some).toContain('<code class="undo-path">b.ts</code>: skipped, it changed since this turn wrote it');
    expect(some).not.toContain("Changes undone.");
    expect(some).toContain('<div class="undo-outcome skipped" role="status">');

    const none = outcome(
      [
        { path: "a.ts", status: "skipped", reason: "unsaved" },
        { path: "b.ts", status: "skipped", reason: "failed", cause: "EACCES" },
      ],
      3,
    );
    expect(none).toContain("No change was undone. Undo changes again to retry the files skipped.");
    expect(none).toContain('<div class="undo-outcome skipped" role="status">');
    expect(none).toContain('<code class="undo-path">a.ts</code>: skipped, it has unsaved changes in an editor');
    expect(none).toContain('<code class="undo-path">b.ts</code>: skipped, it could not be restored (EACCES)');
  });

  test("an undone step's row says undone, its line count unchanged", () => {
    const undone: ChatEntry[] = turns.map((entry) => (entry.role === "tool" ? { ...entry, undone: true } : entry));
    expect(html(idle, undone)).toContain('<span class="step-status">undone, auto-approved, ok, 1 line</span>');
    expect(html(idle)).not.toContain("undone, ");
  });

  test("inside a folded turn, the undone row shows once the fold is opened", async () => {
    const step = { ...(turns[2] as ChatEntry & { role: "tool" }), undone: true as const };
    const folded: ChatEntry[] = [turns[0]!, turns[1]!, step, turns[1]!, turns[2]!, turns[3]!];
    await withPanel(stateWith(true, { entries: folded }), async ({ host }) => {
      const fold = host.querySelector<HTMLDetailsElement>("details.turn-fold");
      if (!fold) throw new Error("no fold");
      expect(fold.querySelector(":scope > summary")?.textContent).toBe("2 steps");
      await act(async () => fold.querySelector<HTMLElement>(":scope > summary")?.click());
      expect(fold.open).toBe(true);
      const rows = [...fold.querySelectorAll(".step-status")].map((row) => row.textContent);
      expect(rows).toEqual(["undone, auto-approved, ok, 1 line", "auto-approved, ok, 1 line"]);
    });
  });

  test("an undo that failed shows an error block with its cause, the files undone before it, and the button", () => {
    const failed = html({
      ...idle,
      reply: 3,
      outcome: { reply: 3, files: [{ path: "a.ts", status: "restored" }], error: "editor check broke" },
    });
    expect(failed).toContain('<div class="undo-outcome failed" role="alert">');
    expect(failed).toContain("Undo changes failed unexpectedly. Undo changes again to retry the files not yet undone.");
    expect(failed).toContain("editor check broke");
    expect(failed).toContain('<code class="undo-path">a.ts</code>: restored');
    expect(failed).not.toContain("Changes undone.");
    expect(failed.indexOf("editor check broke")).toBeLessThan(failed.indexOf(">Undo changes</button>"));
  });

  test("Undo changes posts its request", async () => {
    await withPanel(stateWith(true, { entries: turns, undo: { ...idle, reply: 3 } }), async ({ click }) => {
      await click("Undo changes");
      expect(posted).toEqual([{ type: "undoChanges" }]);
    });
  });

  test("while an undo runs, its button and Send are disabled, and Enter sends nothing", async () => {
    const running = stateWith(true, { entries: turns, undo: { ...idle, reply: 3, running: true } });
    await withPanel(running, async ({ host, type, press }) => {
      const buttons = [...host.querySelectorAll("button")];
      expect(buttons.find((element) => element.textContent === "Undoing changes…")?.disabled).toBe(true);
      await type("Hi");
      expect(buttons.find((element) => element.textContent === "Send")?.disabled).toBe(true);
      await press("Enter");
      expect(posted).toEqual([]);
    });
  });
});

describe("changed files", () => {
  const answer = "Writing.\n<write_file>\n<path>a.ts</path>\n<content>\nx\n</content>\n</write_file>";
  /** A turn that wrote files and answered "Done.", then a turn answered "Other.". */
  const turns: ChatEntry[] = [
    { role: "user", content: "Write it", mentions: [] },
    {
      role: "assistant",
      reasoning: "",
      content: answer,
      status: "done",
      call: { name: "write_file", args: { path: "a.ts", content: "x" }, start: 9, end: answer.length },
    },
    { role: "tool", name: "write_file", args: { path: "a.ts", content: "x" }, status: "ok", text: "ok" },
    { role: "assistant", reasoning: "", content: "Done.", status: "done" },
    { role: "user", content: "Anything else?", mentions: [] },
    { role: "assistant", reasoning: "", content: "Other.", status: "done" },
  ];
  const rows: ChangedFile[] = [
    { path: "src/a.ts", kind: "edited", added: 2, removed: 1 },
    { path: "b.ts", kind: "created", added: 2, removed: 0 },
  ];
  const idle = { reply: undefined, ranCommand: false, running: false, outcome: undefined };
  const html = (undo: ChatState["undo"], changedFiles: ChangedFile[], entries: ChatEntry[] = turns) =>
    renderToStaticMarkup(<App state={stateWith(true, { entries, undo, changedFiles })} language="en" />);

  test("lists each file under the reply the state names, before the undo's outcome and the actions row", () => {
    const outcome = { reply: 3, files: [{ path: "c.ts", status: "skipped" as const, reason: "changed" as const }] };
    const shown = html({ ...idle, reply: 3, outcome }, rows);
    expect(shown.split(">Changed files<").length - 1).toBe(1);
    const at = shown.indexOf(">Changed files<");
    expect(at).toBeGreaterThan(shown.indexOf("Done."));
    expect(at).toBeLessThan(shown.indexOf('class="undo-outcome'));
    expect(shown.indexOf('class="undo-outcome')).toBeLessThan(shown.indexOf(">Undo changes</button>"));
    expect(shown.indexOf(">Undo changes</button>")).toBeLessThan(shown.indexOf("Other."));
    expect(shown).toContain('<code class="changed-path">src/a.ts</code>');
    expect(shown).toContain('<code class="changed-path">b.ts</code>');
    expect(shown.indexOf("src/a.ts")).toBeLessThan(shown.indexOf(">b.ts<"));
    expect(shown).toContain(">edited<");
    expect(shown).toContain(">created<");
    expect(shown).toContain(">+2 −1<");
    expect(shown).toContain(">+2 −0<");
  });

  test("shows no list without rows, without a reply named, or while a reply is in flight", () => {
    expect(html({ ...idle, reply: 3 }, [])).not.toContain("Changed files");
    expect(html(idle, rows)).not.toContain("Changed files");
    const streaming: ChatEntry[] = [
      ...turns.slice(0, 5),
      { role: "assistant", reasoning: "", content: "Oth", status: "streaming" },
    ];
    expect(html({ ...idle, reply: 3 }, rows, streaming)).not.toContain("Changed files");
  });

  test("one hint covers the list and the button when the turn ran a command", () => {
    const shown = html({ ...idle, reply: 3, ranCommand: true }, rows);
    expect(shown).toContain("Commands this turn ran are not listed or undone.");
    expect(shown).not.toContain("are not undone.");
  });

  test("a row is a button that posts its path", async () => {
    await withPanel(
      stateWith(true, { entries: turns, undo: { ...idle, reply: 3 }, changedFiles: rows }),
      async ({ host }) => {
        const row = [...host.querySelectorAll<HTMLButtonElement>("button.changed-file")];
        expect(row.map((element) => element.textContent)).toEqual(["src/a.tsedited+2 −1", "b.tscreated+2 −0"]);
        await act(async () => row[1]?.click());
        expect(posted).toEqual([{ type: "openChangeDiff", path: "b.ts" }]);
      },
    );
  });
});

describe("retry and continue", () => {
  const question: ChatEntry = { role: "user", content: "Do it", mentions: [] };
  const reply = (status: Reply["status"], extra: Partial<Reply> = {}): ChatEntry => ({
    role: "assistant",
    reasoning: "",
    content: `Reply ${status}.`,
    status,
    ...extra,
  });
  const readStep: ChatEntry = { role: "tool", name: "read_file", args: { path: "a.ts" }, status: "ok", text: "x" };
  const html = (entries: ChatEntry[], overrides: Partial<ChatState> = {}) =>
    renderToStaticMarkup(<App state={stateWith(true, { entries, ...overrides })} language="en" />);
  const count = (text: string, part: string) => text.split(part).length - 1;
  const RETRY = ">Retry</button>";
  const CONTINUE = ">Continue</button>";

  test("Retry shows once, under the last turn's last reply, for every end status", () => {
    const earlier: ChatEntry[] = [{ role: "user", content: "First", mentions: [] }, reply("done")];
    for (const status of ["done", "failed", "stopped"] as const) {
      const shown = html([...earlier, question, reply(status)]);
      expect(count(shown, RETRY)).toBe(1);
      expect(shown.indexOf(RETRY)).toBeGreaterThan(shown.indexOf(`Reply ${status}.`));
    }
  });

  test("neither shows while a reply is in flight", () => {
    for (const status of ["waiting", "streaming"] as const) {
      const shown = html([question, reply(status)]);
      expect(shown).not.toContain(RETRY);
      expect(shown).not.toContain(CONTINUE);
    }
  });

  test("Continue shows only after Stop, a step-limit halt, or a malformed-calls halt", () => {
    expect(html([question, reply("stopped")])).toContain(CONTINUE);
    for (const haltReason of ["stepLimit", "malformedCalls"] as const) {
      const shown = html([question, reply("halted", { haltReason }), readStep]);
      expect(count(shown, CONTINUE)).toBe(1);
      expect(shown).toContain(RETRY);
    }
    expect(html([question, reply("halted", { haltReason: "contextFull" })])).not.toContain(CONTINUE);
    expect(html([question, reply("done")])).not.toContain(CONTINUE);
    expect(html([question, reply("failed")])).not.toContain(CONTINUE);
  });

  test("neither shows when a completed /compact summary follows the last user entry", () => {
    const shown = html([question, reply("stopped"), reply("done", { summary: true, content: "Summary." })]);
    expect(shown).not.toContain(RETRY);
    expect(shown).not.toContain(CONTINUE);
  });

  test("both are disabled when Send would not act; the order is Retry, Continue, Undo changes", () => {
    const entries = [question, reply("stopped")];
    const disabled = (shown: string) => shown.includes('disabled="">Retry<') && shown.includes('disabled="">Continue<');
    expect(disabled(html(entries))).toBe(false);
    expect(disabled(html(entries, { modePending: true }))).toBe(true);
    expect(disabled(html(entries, { model: undefined }))).toBe(true);
    const undo = { reply: 1, ranCommand: false, running: true, outcome: undefined };
    const shown = html(entries, { undo });
    expect(disabled(shown)).toBe(true);
    expect(shown.indexOf(RETRY.slice(1))).toBeLessThan(shown.indexOf(CONTINUE.slice(1)));
    expect(shown.indexOf(CONTINUE.slice(1))).toBeLessThan(shown.indexOf("Undoing changes…"));
  });

  const wrote: ChatEntry[] = [
    question,
    reply("done", { content: "Writing." }),
    { role: "tool", name: "write_file", args: { path: "a.ts" }, status: "ok", text: "ok", approval: "auto" },
    reply("done"),
  ];

  test("Retry posts at once when the turn left nothing on disk; Continue posts with the conversation and entries count", async () => {
    await withPanel(stateWith(true, { entries: [question, reply("stopped")] }), async ({ click }) => {
      await click("Retry");
      await click("Continue");
      expect(posted).toEqual([
        { type: "retry", shown: { conversationId: CONVERSATION_ID, entries: 2 } },
        { type: "continueTurn", shown: { conversationId: CONVERSATION_ID, entries: 2 } },
      ]);
    });
  });

  const ran: ChatEntry[] = [
    question,
    reply("done"),
    { role: "tool", name: "run_command", args: { command: "ls" }, status: "ok", text: "x", approval: "accepted" },
    reply("done"),
  ];
  const undoOffered: [ChatEntry[], Partial<ChatState>] = [
    [question, reply("done")],
    { undo: { reply: 1, ranCommand: false, running: false, outcome: undefined } },
  ];

  for (const [name, entries, overrides] of [
    ["a write that applied", wrote, {}],
    ["a command the user ran", ran, {}],
    ["Undo changes offered for the turn", ...undoOffered],
  ] as const) {
    test(`with ${name}, the first click asks; the second posts; Cancel restores the button`, async () => {
      await withPanel(stateWith(true, { entries: [...entries], ...overrides }), async ({ host, click }) => {
        const retry = [...host.querySelectorAll("button")].find((element) => element.textContent === "Retry")!;
        retry.focus();
        await click("Retry");
        expect(posted).toEqual([]);
        expect(host.textContent).toContain("Retry does not revert the files this turn wrote or the commands it ran.");
        expect(retry.textContent).toBe("Retry anyway");
        expect(document.activeElement).toBe(retry);
        await click("Cancel");
        expect(retry.textContent).toBe("Retry");
        expect(host.textContent).not.toContain("does not revert");
        expect(document.activeElement).toBe(retry);
        await click("Retry");
        await click("Retry anyway");
        expect(posted).toEqual([
          { type: "retry", shown: { conversationId: CONVERSATION_ID, entries: entries.length } },
        ]);
      });
    });
  }

  test("a change of the entries drops the confirmation", async () => {
    await withPanel(stateWith(true, { entries: wrote }), async ({ host, click, show }) => {
      await click("Retry");
      expect(host.textContent).toContain("Retry anyway");
      await show(
        stateWith(true, { entries: [...wrote, { role: "user", content: "More", mentions: [] }, reply("done")] }),
      );
      expect(host.textContent).not.toContain("Retry anyway");
      expect(host.textContent).not.toContain("does not revert");
    });
  });

  test("the reply a Retry starts at a removed reply's index opens with its reasoning collapsed", async () => {
    const old = reply("done", { reasoning: "Old thinking" });
    await withPanel(stateWith(true, { entries: [question, old] }), async ({ host, show }) => {
      const reasoning = () => host.querySelector<HTMLDetailsElement>("details.reasoning");
      await act(async () => reasoning()?.querySelector<HTMLElement>(":scope > summary")?.click());
      expect(reasoning()?.open).toBe(true);
      await show(stateWith(true, { entries: [question, reply("waiting", { content: "" })] }));
      await show(stateWith(true, { entries: [question, reply("streaming", { content: "", reasoning: "New" })] }));
      expect(reasoning()?.textContent).toContain("New");
      expect(reasoning()?.open).toBe(false);
    });
  });

  test("a change of the turn's entries that keeps their count drops the confirmation; an unrelated post keeps it", async () => {
    const both: ChatEntry[] = [
      ...wrote,
      { role: "tool", name: "run_command", args: { command: "ls" }, status: "ok", text: "x", approval: "accepted" },
      reply("done"),
    ];
    await withPanel(stateWith(true, { entries: both }), async ({ host, click, show }) => {
      await click("Retry");
      await show(stateWith(true, { entries: structuredClone(both), context: { used: 9, size: 32768, known: true } }));
      expect(host.textContent).toContain("Retry anyway");
      const undone = both.map((entry) =>
        entry.role === "tool" && entry.name === "write_file" ? { ...entry, undone: true as const } : entry,
      );
      await show(stateWith(true, { entries: undone }));
      expect(host.textContent).toContain("Retry");
      expect(host.textContent).not.toContain("Retry anyway");
      expect(host.textContent).not.toContain("does not revert");
    });
  });

  test("an undone write asks nothing", async () => {
    const undone = wrote.map((entry) => (entry.role === "tool" ? { ...entry, undone: true as const } : entry));
    await withPanel(stateWith(true, { entries: undone }), async ({ click }) => {
      await click("Retry");
      expect(posted).toEqual([{ type: "retry", shown: { conversationId: CONVERSATION_ID, entries: 4 } }]);
    });
  });
});

describe("edit the last message", () => {
  const first: ChatEntry = { role: "user", content: "First", mentions: [] };
  const firstReply: ChatEntry = { role: "assistant", reasoning: "", content: "One.", status: "done" };
  const question: ChatEntry = {
    role: "user",
    content: "Fix @src/a b.ts and @problems",
    mentions: [
      { path: "src/a b.ts", kind: "file", status: "attached", lines: 1 },
      { path: "problems", kind: "problems", status: "noProblems" },
    ],
  };
  const reply = (status: Reply["status"], extra: Partial<Reply> = {}): ChatEntry => ({
    role: "assistant",
    reasoning: "",
    content: `Reply ${status}.`,
    status,
    ...extra,
  });
  const entries = [first, firstReply, question, reply("done")];
  const html = (shown: ChatEntry[], overrides: Partial<ChatState> = {}) =>
    renderToStaticMarkup(<App state={stateWith(true, { entries: shown, ...overrides })} language="en" />);
  const EDIT = ">Edit</button>";
  const LINE = "Sending replaces this message and its replies.";
  const WARNING = "It does not revert the files this turn wrote or the commands it ran.";

  test("Edit shows once, on the last user message, before its reply", () => {
    const shown = html(entries);
    expect(shown.split(EDIT)).toHaveLength(2);
    expect(shown.indexOf(EDIT)).toBeGreaterThan(shown.indexOf("Fix @src/a b.ts"));
    expect(shown.indexOf(EDIT)).toBeLessThan(shown.indexOf("Reply done."));
  });

  test("Edit never shows during a reply, nor when a completed /compact summary follows the last user message", () => {
    for (const status of ["waiting", "streaming"] as const) {
      expect(html([first, firstReply, question, reply(status)])).not.toContain(EDIT);
    }
    expect(html([...entries, reply("done", { summary: true, content: "Summary." })])).not.toContain(EDIT);
  });

  test("Edit is disabled when Send would not act", () => {
    expect(html(entries)).not.toContain('disabled="">Edit<');
    expect(html(entries, { modePending: true })).toContain('disabled="">Edit<');
    expect(html(entries, { model: undefined })).toContain('disabled="">Edit<');
  });

  test("a click posts nothing, fills and focuses the box, and marks the last turn with the line and Cancel", async () => {
    await withPanel(stateWith(true, { entries }), async ({ host, textarea, click }) => {
      await click("Edit");
      // [>]: The caret ends on `@problems`: the mention lookup may run, but its menu stays closed.
      expect(posted.filter((message) => (message as { type: string }).type !== "queryFiles")).toEqual([]);
      expect(host.querySelector('[role="listbox"]')).toBeNull();
      expect(textarea.value).toBe("Fix @src/a b.ts and @problems");
      expect(document.activeElement).toBe(textarea);
      const group = host.querySelector(".replacing")!;
      expect(group.textContent).toContain(LINE);
      expect(group.textContent).not.toContain(WARNING);
      expect(group.textContent).toContain("Fix @src/a b.ts");
      expect(group.textContent).toContain("Reply done.");
      expect(group.textContent).not.toContain("One.");
      expect(group.querySelector("button")?.textContent).toBe("Cancel");
      expect(host.textContent).not.toContain("Edit");
    });
  });

  test("the line carries the warning when a removed step applied a write", async () => {
    const wrote: ChatEntry[] = [
      question,
      reply("done", { content: "Writing." }),
      { role: "tool", name: "write_file", args: { path: "a.ts" }, status: "ok", text: "ok", approval: "auto" },
      reply("done"),
    ];
    await withPanel(stateWith(true, { entries: wrote }), async ({ host, click }) => {
      await click("Edit");
      expect(host.querySelector(".replacing")!.textContent).toContain(WARNING);
    });
  });

  test("Cancel removes the mark, posts nothing, keeps the box's text, and gives the focus back to Edit", async () => {
    await withPanel(stateWith(true, { entries }), async ({ host, textarea, click }) => {
      await click("Edit");
      await click("Cancel");
      expect(posted.filter((message) => (message as { type: string }).type !== "queryFiles")).toEqual([]);
      expect(host.querySelector(".replacing")).toBeNull();
      expect(textarea.value).toBe("Fix @src/a b.ts and @problems");
      expect(document.activeElement?.textContent).toBe("Edit");
    });
  });

  test("Send then posts the send with the conversation and entries count it replaces, the file paths picked", async () => {
    await withPanel(stateWith(true, { entries }), async ({ textarea, click, type }) => {
      await type("draft");
      await click("Edit");
      expect(textarea.value).toBe("draft\n\nFix @src/a b.ts and @problems");
      posted.length = 0;
      await click("Send");
      expect(posted).toEqual([
        {
          type: "send",
          text: "draft\n\nFix @src/a b.ts and @problems",
          mentions: ["src/a b.ts"],
          replaces: { conversationId: CONVERSATION_ID, entries: 4 },
        },
      ]);
    });
  });

  test("another conversation, another entries count, or a reply starting ends the replacing state", async () => {
    const others: [string, Partial<ChatState>][] = [
      ["conversation", { entries, conversationId: "other" }],
      ["count", { entries: [...entries, { role: "user", content: "More", mentions: [] }, reply("done")] }],
      ["reply", { entries: [first, firstReply, question, reply("waiting")] }],
    ];
    for (const [name, overrides] of others) {
      await withPanel(stateWith(true, { entries }), async ({ host, click, show }) => {
        await click("Edit");
        await show(stateWith(true, overrides));
        await show(stateWith(true, { entries, conversationId: stateWith(true).conversationId }));
        expect({ name, marked: host.querySelector(".replacing") !== null }).toEqual({ name, marked: false });
        posted.length = 0;
        await click("Send");
        expect(posted).toEqual([{ type: "send", text: "Fix @src/a b.ts and @problems", mentions: ["src/a b.ts"] }]);
      });
    }
  });
});

describe("recall earlier messages", () => {
  const user = (
    content: string,
    mentions: ChatEntry & { role: "user" } extends { mentions: infer M } ? M : never = [],
  ) => ({ role: "user", content, mentions }) as ChatEntry;
  const answer: ChatEntry = { role: "assistant", reasoning: "", content: "Done.", status: "done" };
  const entries = [user("First\nline"), answer, user("Second"), answer];
  /** Key down in the message box, returning the event so a test sees whether the panel consumed it. */
  const keyDown = async (textarea: HTMLTextAreaElement, key: string) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => {
      textarea.dispatchEvent(event);
    });
    return event;
  };
  /** ArrowUp is not consumed: the event keeps its default and the box keeps its text. */
  const expectDefault = async (textarea: HTMLTextAreaElement) => {
    const before = textarea.value;
    const event = await keyDown(textarea, "ArrowUp");
    expect({ prevented: event.defaultPrevented, text: textarea.value }).toEqual({ prevented: false, text: before });
  };

  test("ArrowUp in an empty box fills it with the newest message, the caret at the end, and posts nothing", async () => {
    await withPanel(stateWith(true, { entries }), async ({ textarea }) => {
      const event = await keyDown(textarea, "ArrowUp");
      expect(event.defaultPrevented).toBe(true);
      expect(textarea.value).toBe("Second");
      expect(textarea.selectionStart).toBe("Second".length);
      expect(textarea.selectionEnd).toBe("Second".length);
      expect(posted).toEqual([]);
    });
  });

  test("a recalled text ending in /<name> or @<path> opens no menu, and the next ArrowUp goes older", async () => {
    // [>]: `@pro` names the reserved `@problems` row, which shows without a host answer; mentions not read yet.
    const shown = [user("Oldest"), answer, user("check @pro"), answer, user("/grilling"), answer];
    await withPanel(stateWith(true, { entries: shown }), async ({ host, textarea }) => {
      await keyDown(textarea, "ArrowUp");
      expect(textarea.value).toBe("/grilling");
      expect(host.querySelector('[role="listbox"]')).toBeNull();
      await keyDown(textarea, "ArrowUp");
      expect(textarea.value).toBe("check @pro");
      expect(host.querySelector('[role="listbox"]')).toBeNull();
      await keyDown(textarea, "ArrowUp");
      expect(textarea.value).toBe("Oldest");
      const queries = posted.filter((message) => (message as { type: string }).type === "queryFiles");
      expect(queries.length).toBeLessThanOrEqual(1);
      expect(posted.filter((message) => (message as { type: string }).type !== "queryFiles")).toEqual([]);
    });
  });

  test("another conversation shown, and coming back, leaves the text and ends the recall", async () => {
    await withPanel(stateWith(true, { entries }), async ({ textarea, show }) => {
      await keyDown(textarea, "ArrowUp");
      await show(stateWith(true, { entries, conversationId: "other" }));
      expect(textarea.value).toBe("Second");
      await expectDefault(textarea);
      await show(stateWith(true, { entries }));
      expect(textarea.value).toBe("Second");
      await expectDefault(textarea);
    });
  });

  test("after a recalled message is sent, the same text typed by hand does not recall", async () => {
    await withPanel(stateWith(true, { entries }), async ({ textarea, click, show, type }) => {
      await keyDown(textarea, "ArrowUp");
      await click("Send");
      expect(posted).toEqual([{ type: "send", text: "Second", mentions: [] }]);
      expect(textarea.value).toBe("");
      await show(stateWith(true, { entries: [...entries, user("Second"), answer] }));
      await type("Second");
      await expectDefault(textarea);
    });
  });

  test("after the box is erased by hand and Edit puts the same message back, ArrowUp does not recall", async () => {
    await withPanel(stateWith(true, { entries }), async ({ textarea, click, type }) => {
      await keyDown(textarea, "ArrowUp");
      await type("");
      await click("Edit");
      expect(textarea.value).toBe("Second");
      await expectDefault(textarea);
    });
  });
});
