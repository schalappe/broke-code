import { describe, expect, test } from "bun:test";
import { renderWebviewHtml } from "./webviewHtml";

const input = {
  cspSource: "https://webview.test",
  scriptUri: "https://webview.test/dist/webview/main.js",
  styleUri: "https://webview.test/dist/webview/main.css",
  nonce: "abc123",
  language: "fr",
};

function contentSecurityPolicy(html: string): string {
  const match = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/);
  if (!match?.[1]) throw new Error("no CSP meta tag");
  return match[1];
}

describe("renderWebviewHtml", () => {
  test("allows scripts only with the nonce and blocks everything else by default", () => {
    const csp = contentSecurityPolicy(renderWebviewHtml(input));
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-abc123'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  test("blocks remote images so a reply cannot leak data through an image URL", () => {
    const csp = contentSecurityPolicy(renderWebviewHtml(input));
    expect(csp).toMatch(/img-src https:\/\/webview\.test data:;/);
  });

  test("loads the bundle script with the nonce and the stylesheet from the extension", () => {
    const html = renderWebviewHtml(input);
    expect(html).toContain('<script type="module" nonce="abc123" src="https://webview.test/dist/webview/main.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="https://webview.test/dist/webview/main.css">');
    expect(html).toContain('<html lang="fr">');
  });
});
