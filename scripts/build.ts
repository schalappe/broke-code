/**
 * @module build
 * Bundle extension host (CommonJS, Node, `vscode` external) and webview (browser) into `dist/`.
 */
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

const builds = [
  Bun.build({
    entrypoints: ["src/extension/extension.ts"],
    outdir: "dist",
    target: "node",
    format: "cjs",
    external: ["vscode"],
    sourcemap: "linked",
  }),
  Bun.build({
    entrypoints: ["src/webview/main.tsx"],
    outdir: "dist/webview",
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "linked",
    // [&]: React reads process.env.NODE_ENV; browser has no `process`.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  }),
];

let failed = false;
for (const result of await Promise.all(builds)) {
  for (const log of result.logs) console.error(log);
  if (!result.success) failed = true;
  for (const output of result.outputs) console.log(output.path);
}
if (failed) process.exit(1);
