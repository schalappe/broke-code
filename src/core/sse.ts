/**
 * @module sse
 * Server-sent events reader: byte stream -> `data` payload per event.
 */

/**
 * Yield `data` of each event in order. Multi-line data joined with `\n`.
 * Lenient at end of stream: pending event without closing blank line still yielded.
 * @param stream - Response body. Read errors propagate to caller.
 */
export async function* readSseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  let dataLines: string[] = [];

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
      return;
    }
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
    // Comments (`:`) and other fields (`event`, `id`, `retry`) unused.
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of takeLines(false)) yield* dispatch(line);
    }
    buffer += decoder.decode();
    for (const line of takeLines(true)) yield* dispatch(line);
    if (buffer !== "") yield* dispatch(buffer);
    yield* dispatch("");
  } finally {
    reader.releaseLock();
  }
}
