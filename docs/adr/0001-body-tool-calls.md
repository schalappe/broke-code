---
status: accepted
---

# Tool calls travel in the reply text as XML tags, never as native tool calls

broke-code targets an internal LLM service that serves Gemma, GLM, and Qwen through an OpenAI-compatible API.
That service rejects the `tools` request field. Agent extensions that rely on native tool calls fail against
it. Roo Code and Kilo Code removed their text-based protocol in late 2025.

broke-code therefore lists the tools in the prompt. The model writes each call in its reply as XML tags. Each
tool is one outer tag, each argument is one child tag, and argument values are raw text. The harness parses that
text. It never sends `tools` to any provider, not even to Ollama, which would accept it. With one protocol,
there is one code path to test, and the harness behaves the same on every provider.

## Considered options

- **JSON inside a fenced block.** Rejected. Open models often mis-escape quotes and newlines inside JSON
  strings, and file writes then break.
- **Continue-style fenced block (`TOOL_NAME:` / `BEGIN_ARG:` / `END_ARG`).** Rejected. Models have seen this
  format less often in training, and Continue reports that small models echo its keywords as plain text.
- **Native tool calls where the provider supports them, with a text fallback.** Rejected. Two protocols double
  the code paths and the test matrix. Roo Code cited the same cost when it dropped its XML protocol.

## Consequences

- The parsing rules (one call per reply, calls inside code fences ignored, malformed calls returned to the
  model as errors) are starting values. The local eval against Ollama decides changes to them, not intuition.
- File content inside a tag is raw text. The parser must cope with content that itself contains angle
  brackets or code fences.
- Tool results go back to the model as `user` messages that wrap the result in a
  `<tool_result tool="<name>" status="ok|error">` tag. The OpenAI `tool` role needs a `tool_call_id`, so it
  needs native tool calling. The assistant message before the result is the reply verbatim, call included.

## Amendment (2026-11-09): where a call ends

The first parser ended a call at the first `</tool_name>` in the reply, so a `write_file` whose content held that
text was cut, sometimes silently. A call now ends at the `</tool_name>` that follows its last argument value. A
value ends at the first `</argument>` that closes no `<argument>` opened inside the value and is followed by nothing
but whitespace and then another argument tag of the tool or the call's closing tag; an inner `<argument>` …
`</argument>` pair is kept, so content can hold a whole example call. When the tags never balance, the value ends at
the first `</argument>` so followed, pairs ignored; failing that, at the last `</argument>` before the next
`</tool_name>`. File content can therefore hold the call's own tags, other tools' tags, and code fences. The pairing
has a cost: content holding an unpaired `<argument>` runs on into the text after the call when that text holds
`</argument>` then `</tool_name>`. It is kept: the pairing protects content holding a whole example call, and the
failing case needs prose after the call that itself holds those closing tags.
This changes one of the starting values above ahead of its eval evidence, because the old rule could not write such
files at all; the write scenario of the eval (#38) is the evidence that confirms or reverses it.

## Evidence (2026-11-09): the write eval

The `create` scenario of the eval (#38) asks for a new file whose text holds double quotes, backslashes,
`<content>...</content>`, `</write_file>`, and a fenced code block. On revision 0d6ebb7, 10 runs per model:

| Model                   | `read` | `edit` | `create` |
| ----------------------- | ------ | ------ | -------- |
| `qwen3.8:27b`           | 10/10  | 10/10  | 1/10     |
| `gemma4:26b-a4b-it-qat` | 9/10   | 10/10  | 7/10     |

The rule of the amendment above holds: in all 20 `create` runs the parser read one `write_file` call, and the file
held the requested text exactly, every quote, backslash, tag, and fence included, up to its trailing line breaks. No
call was cut and no other file changed. Every one of the 12 misses is the same: one or two extra empty lines at the
end of the file. Two causes, both read from the dump:

- The leading and trailing line breaks are dropped only together. A value that starts on the `<content>` line and
  ends on a line of its own keeps its last line break, and `write_file` then adds one: 5 misses (`gemma4` 3,
  `qwen3.8` 2) come from this alone.
- `qwen3.8` writes an empty line between the closing fence and `</content>`: 7 misses, 6 of them with the first
  cause too.

The scenario is therefore under the 9/10 bar on both models. The `edit` scenario, an `edit_file` rename, passed all
20 runs. Changing the line-break rule is a parser decision, left to the maintainer.
