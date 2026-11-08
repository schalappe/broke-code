import { describe, expect, test } from "bun:test";
import { readSseData } from "./sse";

function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const events: string[] = [];
  for await (const data of readSseData(stream)) events.push(data);
  return events;
}

describe("readSseData", () => {
  test("yields the data of each event, including [DONE]", async () => {
    expect(await collect(streamOf(['data: {"a":1}\n\n', 'data: {"a":2}\n\n', "data: [DONE]\n\n"]))).toEqual([
      '{"a":1}',
      '{"a":2}',
      "[DONE]",
    ]);
  });

  test("reassembles an event split across chunk boundaries", async () => {
    expect(await collect(streamOf(["da", 'ta: {"con', 'tent":"x"}', "\n", "\ndata: [DO", "NE]\n\n"]))).toEqual([
      '{"content":"x"}',
      "[DONE]",
    ]);
  });

  test("reassembles a multi-byte character split across chunks", async () => {
    const bytes = new TextEncoder().encode("data: é\n\n");
    expect(await collect(streamOf([bytes.slice(0, 7), bytes.slice(7)]))).toEqual(["é"]);
  });

  test("handles CRLF line endings and joins multi-line data with newlines", async () => {
    expect(await collect(streamOf(["data: one\r\ndata: two\r\n\r\n"]))).toEqual(["one\ntwo"]);
  });

  test("ignores comments and other fields, and accepts data without a space", async () => {
    expect(await collect(streamOf([": keep-alive\n\n", "event: message\nid: 3\ndata:x\n\n"]))).toEqual(["x"]);
  });

  test("yields a last event that lacks the closing blank line", async () => {
    expect(await collect(streamOf(["data: [DONE]\n"]))).toEqual(["[DONE]"]);
  });
});
