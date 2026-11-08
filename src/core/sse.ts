/**
 * @module sse
 * Server-sent events reader: byte stream -> `data` payload per event.
 */

/** Default cap on one event (pending line plus its data), in UTF-16 code units. Real chunks stay far below it. */
export const SSE_EVENT_MAX_LENGTH = 1024 * 1024;

/** Thrown by `readSseData` when one line or event exceeds its cap; the stream is not read further. */
export class SseEventTooLargeError extends Error {
  constructor(maxLength: number) {
    super(`server-sent event longer than ${maxLength} characters`);
  }
}

/**
 * Yield `data` of each event in order. Multi-line data joined with `\n`.
 * Lenient at end of stream: pending event without closing blank line still yielded.
 * @param stream - Response body. Read errors propagate to caller.
 * @param maxEventLength - Cap on a pending line and on an event's data, so a stream with no line or event end
 *   cannot grow memory without bound. Over it -> `SseEventTooLargeError`.
 */
export async function* readSseData(
  stream: ReadableStream<Uint8Array>,
  maxEventLength = SSE_EVENT_MAX_LENGTH,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  let dataLines: string[] = [];
  let dataLength = 0;

  function* takeLines(atEnd: boolean): Generator<string> {
    for (;;) {
      const end = buffer.search(/[\r\n]/);
      if (end === -1) return;
      // [>]: Lone trailing CR may be first half of CRLF split across chunks.
      if (buffer[end] === "\r" && end === buffer.length - 1 && !atEnd) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(buffer.startsWith("\r\n", end) ? end + 2 : end + 1);
      yield line;
    }
  }

  function* dispatch(line: string): Generator<string> {
    if (line === "") {
      if (dataLines.length > 0) yield dataLines.join("\n");
      dataLines = [];
      dataLength = 0;
      return;
    }
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      const data = value.startsWith(" ") ? value.slice(1) : value;
      dataLength += data.length + 1;
      if (dataLength > maxEventLength) throw new SseEventTooLargeError(maxEventLength);
      dataLines.push(data);
    }
    // Comments (`:`) and other fields (`event`, `id`, `retry`) unused.
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of takeLines(false)) yield* dispatch(line);
      if (buffer.length > maxEventLength) throw new SseEventTooLargeError(maxEventLength);
    }
    buffer += decoder.decode();
    for (const line of takeLines(true)) yield* dispatch(line);
    if (buffer !== "") yield* dispatch(buffer);
    yield* dispatch("");
  } finally {
    reader.releaseLock();
  }
}
