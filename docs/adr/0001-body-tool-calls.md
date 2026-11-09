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

## Amendment (2026-11-09): trailing line breaks of written content

Decided by the maintainer (schalappe) on 2026-11-09, on the evidence of the write eval (#38).

The `create` scenario of the eval asks for a new file whose text holds double quotes, backslashes,
`<content>...</content>`, `</write_file>`, and a fenced code block. On revision 0d6ebb7, 10 runs per model:

| Model                   | `read` | `edit` | `create` |
| ----------------------- | ------ | ------ | -------- |
| `qwen3.8:27b`           | 10/10  | 10/10  | 1/10     |
| `gemma4:26b-a4b-it-qat` | 9/10   | 10/10  | 7/10     |

The rule of the amendment above holds: in all 20 `create` runs the parser read one `write_file` call, and the file
held the requested text exactly, every quote, backslash, tag, and fence included, up to its trailing line breaks. No
call was cut and no other file changed. Every one of the 12 misses is the same: one or two extra empty lines at the
end of the file. Two causes, both read from the dump:

- The parser drops the leading and trailing line breaks of a value only together. A value that starts on the
  `<content>` line and ends on a line of its own keeps its last line break, and `write_file` then added one: 5
  misses (`gemma4` 3, `qwen3.8` 2) come from this alone.
- `qwen3.8` writes an empty line between the closing fence and `</content>`: 7 misses, 6 of them with the first
  cause too.

**Decision.** `write_file` drops every trailing line break of its content, `\n` or `\r\n`, then ends the file
with exactly one, of the kind its last line break is. Content made only of line breaks, or empty, writes an empty
file. The parser's rule (one leading and one trailing line break, both or neither) stays as it is: it is the
`write_file` contract, not the parser, that decides how a file ends.

**Cost, accepted.** `write_file` cannot create a file that ends with an empty line; `edit_file` still can.

**Considered.** Dropping one trailing line break whatever the leading one does would have fixed the 5 misses of the
first cause only, leaving `qwen3.8` at 3/10 on the same replies.

**Result.** On revision 6224b01, with the rule above, 10 runs per model:

| Model                   | `read` | `edit` | `create` |
| ----------------------- | ------ | ------ | -------- |
| `qwen3.8:27b`           | 10/10  | 9/10   | 10/10    |
| `gemma4:26b-a4b-it-qat` | 10/10  | 6/10   | 10/10    |

`create` now passes all 20 runs, which confirms the parser rule of the amendment above and this one. `edit` is under
the bar on `gemma4`. Its 4 misses, and the one of `qwen3.8`, are not about writes: the reply holds reasoning but no
text, so the turn ends `done` before any edit and the file stays as it was. The same reply was 1 miss in 60 runs on
0d6ebb7 (`gemma4` `read`) and is 5 in 60 here; between the two, the prompt changed only in the `write_file`
description, so whether that wording or chance moved it is not known yet.

## Amendment (2026-11-09): an empty reply is no final answer

Decided by the maintainer (schalappe) on 2026-11-09, on the evidence of the write eval (#38).

Until now a reply without a call was the final answer, an empty one included. The models sometimes reason, then
stop with no text: the turn ended `done` with nothing done. The eval dumps show it as the only cause of the `edit`
misses once the line breaks were fixed:

| Revision                 | Runs              | Empty final replies |
| ------------------------ | ----------------- | ------------------- |
| 0d6ebb7                  | 60, both models   | 1 (`gemma4` `read`) |
| 6224b01                  | 60, both models   | 5 (`gemma4` 4 `edit`, `qwen3.8` 1 `edit`) |
| ea0c75c (`gemma4` rerun) | 30, `gemma4` only | 6 (`edit` 5, `read` 1) |

**Decision.** A reply whose answer is empty once trimmed (reasoning excluded, so no call either) is handled like a
malformed call: a tool step with status `malformed` and the message "Your reply was empty. Call a tool, or write your
answer to the user.", sent back as `<tool_result tool="unknown" status="error">`. The loop asks again, and the step
counts toward the three malformed calls in a row and the step limit. A reply with text and no call stays the final
answer. The empty assistant message goes back in the history before its step, as `content: ""`, which the
OpenAI-compatible contract accepts, so user and assistant messages keep alternating as Gemma's chat template requires.

**Result.** On revision c96f1e7, 10 runs per model:

| Model                   | `read` | `edit` | `create` |
| ----------------------- | ------ | ------ | -------- |
| `qwen3.8:27b`           | 10/10  | 10/10  | 10/10    |
| `gemma4:26b-a4b-it-qat` | 10/10  | 8/10   | 10/10    |

`gemma4` sent empty replies in 4 runs; 2 recovered and passed (`read` 9, `edit` 3). `edit` stays one run under the bar:
run 1 made the right edit after two empty replies, then a `search` for other references took the sixth and last step
of the bench's limit before its answer (`stepLimit`); run 8 never called `edit_file`, wrote in its reasoning that the
rename was done, and sent three empty replies in a row (`malformed`).

**Bench step limit.** Decided by the maintainer (schalappe) on 2026-11-09: the eval's step limit goes from 6 to 10,
since an edit takes list, read, edit, and sometimes search, and empty replies now count as steps; on c96f1e7, `gemma4`
`edit` run 1 halted at the limit after a correct edit. The 9/10 bar and the product default of 50 are unchanged.

**Result with the limit at 10.** On revision b1049a2, 10 runs per model:

| Model                   | `read` | `edit` | `create` |
| ----------------------- | ------ | ------ | -------- |
| `qwen3.8:27b`           | 10/10  | 10/10  | 10/10    |
| `gemma4:26b-a4b-it-qat` | 10/10  | 10/10  | 10/10    |

Every model met the bar. One reply was empty (`gemma4` `edit` run 5, its `edit_file` call written in its reasoning);
sent back, the model called `edit_file` and passed. The same run took 18 minutes, one reply's reasoning running on for
about 98,000 characters. `qwen3.8` twice wrote the placeholder `<tool_name>` of the format example as a call
(`read` runs 1 and 5); each got the unknown-tool message, recovered, and passed.
