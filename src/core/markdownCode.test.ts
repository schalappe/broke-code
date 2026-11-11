import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { hasTextAfter, remarkFenceClosed } from "./markdownCode";

/** Whether each code block of `source`, rendered with the plugin, is marked closed, in order. */
function marks(source: string): boolean[] {
  const html = renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkFenceClosed] }, source));
  return [...html.matchAll(/<pre><code([^>]*)>/g)].map((match) => match[1]!.includes('data-fence-closed="true"'));
}

describe("remarkFenceClosed", () => {
  test("marks a fenced block whose closing fence the parser read", () => {
    expect(marks("```\nx\n```")).toEqual([true]);
    expect(marks("```\n\n```")).toEqual([true]);
    expect(marks("```js\rx\r```")).toEqual([true]);
    expect(marks("~~~\n```\n~~~")).toEqual([true]);
    expect(marks("````\n```\n````")).toEqual([true]);
    expect(marks(">\t```\n>\tx\n>\t```")).toEqual([true]);
    expect(marks("-\t```\n\tx\n\t```")).toEqual([true]);
  });

  test("leaves unmarked an open fence, one its container ended, and an indented block", () => {
    expect(marks("```")).toEqual([false]);
    expect(marks("```\nx\n~~~")).toEqual([false]);
    expect(marks("   ```\nx\n    ```")).toEqual([false]);
    expect(marks("> ```\n> x\n\nafter")).toEqual([false]);
    expect(marks("    indented")).toEqual([false]);
  });

  test("marks each block of a message on its own", () => {
    expect(marks("```\na\n```\n\n```\nb")).toEqual([true, false]);
  });
});

describe("hasTextAfter", () => {
  test("counts text past whitespace and blockquote markers only", () => {
    expect(hasTextAfter("code\n\nafter", 4)).toBe(true);
    expect(hasTextAfter("code\n> \n> ", 4)).toBe(false);
    expect(hasTextAfter("code\n\n", 4)).toBe(false);
  });
});
