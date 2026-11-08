import { describe, expect, test } from "bun:test";
import { readSseData, SseEventTooLargeError } from "./sse";

function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>, maxEventLength?: number): Promise<string[]> {
  const events: string[] = [];
  for await (const data of readSseData(stream, maxEventLength)) events.push(data);
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

  test("treats a CRLF split across chunks as one line ending, not two", async () => {
    // A doubled ending would close the event early and split it in two.
    expect(await collect(streamOf(["data: one\r", "\ndata: two\r", "\n\r", "\n"]))).toEqual(["one\ntwo"]);
  });

  test("yields a last event that lacks the closing blank line", async () => {
    expect(await collect(streamOf(["data: [DONE]\n"]))).toEqual(["[DONE]"]);
  });

  test("yields a last event whose final line lacks any line ending", async () => {
    expect(await collect(streamOf(['data: {"a":1}\n\ndata: [DO', "NE]"]))).toEqual(['{"a":1}', "[DONE]"]);
  });

  test("yields a last event ending in a lone CR", async () => {
    expect(await collect(streamOf(["data: [DONE]\r"]))).toEqual(["[DONE]"]);
  });

  test("throws instead of buffering a line longer than the cap", async () => {
    const events: string[] = [];
    const reading = (async () => {
      for await (const data of readSseData(streamOf(['data: {"a":1}\n\n', "data: ", "x".repeat(40), "x".repeat(40)]), 64)) {
        events.push(data);
      }
    })();
    await expect(reading).rejects.toBeInstanceOf(SseEventTooLargeError);
    expect(events).toEqual(['{"a":1}']);
  });

  test("throws instead of accumulating an event whose data lines never close it", async () => {
    const lines = Array.from({ length: 20 }, () => `data: ${"x".repeat(10)}\n`);
    await expect(collect(streamOf(lines), 64)).rejects.toBeInstanceOf(SseEventTooLargeError);
  });
});
