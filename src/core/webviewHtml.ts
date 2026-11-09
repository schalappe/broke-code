/**
 * @module webviewHtml
 * Chat webview HTML document under strict Content Security Policy.
 */

export type WebviewHtmlInput = {
  /** `webview.cspSource`: origin of extension resources. */
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  /** Fresh random value per render. Only script carrying it runs. */
  nonce: string;
  /** BCP 47 tag of VS Code display language. */
  language: string;
};

/**
 * Render chat webview document.
 * Remote images blocked: model reply must not leak data through image URLs.
 */
export function renderWebviewHtml(input: WebviewHtmlInput): string {
  const csp = [
    "default-src 'none'",
    `img-src ${input.cspSource} data:`,
    `style-src ${input.cspSource}`,
    `font-src ${input.cspSource}`,
    `script-src 'nonce-${input.nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="${input.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${input.styleUri}">
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${input.nonce}" src="${input.scriptUri}"></script>
</body>
</html>`;
}
