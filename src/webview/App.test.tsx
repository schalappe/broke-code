import { beforeEach, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
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
const { App, ApprovalControls, ContextNotice, ConversationList, Header, HistoryPanel, MentionMenu } = await import(
  "./App"
);
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
  const approval = { id: 7, tool: "write_file", summary: "src/a.ts" };
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
    expect(html).not.toContain("running…");
    expect(html).toContain(">Accept<");
    expect(html).toContain(">Reject<");
    expect(html).toContain('placeholder="Reason for rejecting (optional)"');
    expect(html).toContain(">Stop<");
  });

  test("without an open request, a running call shows no decision buttons", () => {
    const html = turn([writing], false);
    expect(html).toContain("running…");
    expect(html).not.toContain(">Accept<");
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
  /** Panel markup for one user message with `mentions`, English strings. */
  function renderMentions(mentions: (ChatEntry & { role: "user" })["mentions"]): string {
    const state: ChatState = {
      providers: ["P"],
      skipped: [],
      skillWarnings: [],
      ...unsaved,
      provider: "P",
      models: { status: "loaded", models: ["m"] },
      model: "m",
      entries: [{ role: "user", content: "look", mentions }],
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

  test("each row's buttons call back with that row's id", () => {
    const opened: string[] = [];
    const deleted: string[] = [];
    const tree = ConversationList({
      conversations,
      currentId: CONVERSATION_ID,
      language: "en",
      onOpen: (id) => opened.push(id),
      onDelete: (id) => deleted.push(id),
    });
    const buttons = elements(tree).filter((element) => element.type === "button");
    for (const element of buttons) element.props.onClick!();
    expect(opened).toEqual([CONVERSATION_ID, OTHER_ID]);
    expect(deleted).toEqual([CONVERSATION_ID, OTHER_ID]);
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
      ],
    });
    const html = renderToStaticMarkup(<App state={state} language="en" />);
    expect(html.match(/<ul class="warnings" role="status">/g)).toHaveLength(1);
    expect(html).toContain("Provider number 2 in the settings is skipped: it has no name.");
    expect(html).toContain("Skill ~/.agents/skills/a/SKILL.md is skipped: it lacks a description.");
    expect(html).toContain("Skill .agents/skills/b/SKILL.md is skipped: its name c differs from its folder b.");
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
