import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatEntry, ChatState } from "../core/protocol";
import type { ProviderError } from "../core/providerError";
import type { Suggestion } from "../core/suggestions";

// [&]: `vscodeApi` calls the webview global on import -> stub it before App loads.
(globalThis as { acquireVsCodeApi?: () => { postMessage(message: unknown): void } }).acquireVsCodeApi = () => ({
  postMessage() {},
});
const { App, ConversationList, MentionMenu } = await import("./App");
const { moveHighlight } = await import("./SuggestionMenu");

type Reply = ChatEntry & { role: "assistant" };

const CONVERSATION_ID = "0b0d4c1e-8f9a-4c3b-9d2e-1a2b3c4d5e6f";
/** Conversation fields of a state with nothing saved. */
const unsaved = { conversationId: CONVERSATION_ID, conversations: [], storageProblem: undefined };

/** Panel markup for a conversation of one question and `reply`, English strings. */
function render(reply: Omit<Reply, "role">): string {
  const state: ChatState = {
    providers: ["P"],
    skipped: [],
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

describe("error actions", () => {
  /** Panel markup for a model listing that failed with `error`. */
  function failedListing(error: ProviderError): string {
    const state: ChatState = {
      providers: ["P"],
      skipped: [],
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
    const noon = Date.parse("2026-11-08T12:00:00Z");
    const html = list([
      { id: CONVERSATION_ID, title: "Newest", updatedAt: noon },
      { id: OTHER_ID, title: "Older", updatedAt: noon - 86_400_000 },
    ]);
    expect(html.indexOf("Newest")).toBeLessThan(html.indexOf("Older"));
    expect(html).toContain("Nov 8, 2026");
    expect(html).toContain("Nov 7, 2026");
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="true"[^>]*>.*Newest/);
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
});
