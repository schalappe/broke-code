import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatEntry, ChatState } from "../core/protocol";
import type { ProviderError } from "../core/providerError";

// [&]: `vscodeApi` calls the webview global on import -> stub it before App loads.
(globalThis as { acquireVsCodeApi?: () => { postMessage(message: unknown): void } }).acquireVsCodeApi = () => ({
  postMessage() {},
});
const { App } = await import("./App");

type Reply = ChatEntry & { role: "assistant" };

/** Panel markup for a conversation of one question and `reply`, English strings. */
function render(reply: Omit<Reply, "role">): string {
  const state: ChatState = {
    providers: ["P"],
    skipped: [],
    provider: "P",
    models: { status: "loaded", models: ["m"] },
    model: "m",
    entries: [
      { role: "user", content: "Hi", mentions: [] },
      { role: "assistant", ...reply },
    ],
  };
  return renderToStaticMarkup(<App state={state} />);
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
      provider: "P",
      models: { status: "failed", error },
      model: undefined,
      entries: [],
    };
    return renderToStaticMarkup(<App state={state} />);
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
      provider: "P",
      models: { status: "loaded", models: ["m"] },
      model: "m",
      entries: [{ role: "user", content: "look", mentions }],
    };
    return renderToStaticMarkup(<App state={state} />);
  }

  test("shows no mention list for a message without mentions", () => {
    expect(renderMentions([])).not.toContain('class="mentions"');
  });

  test("lists each mention under the message as a plain label with its status", () => {
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
    for (const label of [
      "@src/a.ts · 83 lines",
      "@one.ts · 1 line",
      "@src/ · 12 entries",
      "@big.txt · truncated to 2000 lines",
      "@gone.txt · not found",
      "@../out.txt · outside the workspace",
      "@img.png · binary file, not attached",
      "@huge.log · over 1 MiB, not attached",
      "@locked · could not be read",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('<li class="failed">@gone.txt · not found</li>');
    expect(html).toContain("<li>@src/a.ts · 83 lines</li>");
  });
});
