import { beforeEach, describe, expect, jest, test } from "bun:test";
import { act, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatEntry, ChatState } from "../core/protocol";
import type { ProviderError } from "../core/providerError";
import type { Suggestion } from "../core/suggestions";

// [&]: `vscodeApi` calls the webview global on import -> stub it before App loads.
/** Messages the panel posted to the host. */
const posted: unknown[] = [];
(globalThis as { acquireVsCodeApi?: () => { postMessage(message: unknown): void } }).acquireVsCodeApi = () => ({
  postMessage: (message) => posted.push(message),
});
const { App, ApprovalControls, ContextNotice, ConversationList, Header, HistoryPanel, MentionMenu, SlashMenu } =
  await import("./App");
const { moveHighlight } = await import("./SuggestionMenu");

type Reply = ChatEntry & { role: "assistant" };

const CONVERSATION_ID = "0b0d4c1e-8f9a-4c3b-9d2e-1a2b3c4d5e6f";
/** Conversation fields of a state with nothing saved. */
const unsaved = {
  conversationId: CONVERSATION_ID,
  conversations: [],
  listFailed: undefined,
  storageProblem: undefined,
  context: { used: 0, size: 32768, known: true },
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

  test("a turn halted on a full context says so and names New chat", () => {
    const html = renderTurn([
      { role: "assistant", reasoning: "", content: "", status: "halted", haltReason: "contextFull" },
    ]);
    expect(html).toContain("Stopped: the conversation fills the model&#x27;s context. Start a new chat with New chat.");
    expect(html).not.toContain("Waiting for the reply…");
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
  const menu = (items: Suggestion[], capped = false, highlighted = 0, failed = false) =>
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
    expect(html).toContain('<div id="mention-menu" role="listbox" aria-label="Files and folders" class="menu-list">');
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

/** Mount `App` over a DOM registered for the test's duration; `run` drives it, then the panel unmounts. */
async function withPanel(state: ChatState, run: (panel: Panel) => Promise<void>): Promise<void> {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  const { act, createElement } = await import("react");
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(App, { state, language: "en" })));
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
      receive: (message) =>
        act(async () => {
          window.dispatchEvent(new MessageEvent("message", { data: message }));
        }),
      show: (next) => act(async () => root.render(createElement(App, { state: next, language: "en" }))),
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
      expect(labels(host)).toEqual(["/new", "/model"]);

      await receive({
        type: "skillSuggestions",
        id: lastSkillQuery(),
        items: [
          { name: "grilling", description: "Grill the plan." },
          { name: "notes", description: "Take notes." },
        ],
        failed: false,
      });
      expect(labels(host)).toEqual(["/new", "/model", "/grilling", "/notes"]);

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
      expect(labels(host)).toEqual(["/new", "/model"]);
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
      expect(labels(host)).toEqual(["/new", "/model"]);
    });
  });

  test("when the skills cannot be listed, the menu says so and still shows the built-ins", async () => {
    await withPanel(stateWith(true), async ({ host, type, receive }) => {
      await type("/");
      await receive({ type: "skillSuggestions", id: lastSkillQuery(), items: [], failed: true });
      expect(labels(host)).toEqual(["/new", "/model"]);
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
      expect(labels(host)).toEqual(["/new", "/model", "/kept"]);
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
      expect(labels(host)).toEqual(["/new", "/model"]);
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
