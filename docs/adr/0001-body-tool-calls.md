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

**Note (2026-11-12, #110).** The empty assistant message kept the roles alternating after a malformed step only.
Other shapes still sent two `user` messages in a row: a message typed after a turn halted on a tool step (`stepLimit`,
`malformedCalls`), and a message after a reply left out of the history (failed or stopped before any text, or halted on
a full context). Decided by the maintainer (schalappe) on 2026-11-12: one rule for every history sent, a turn's
request and the summary request alike. A `user` message that would follow another `user` message joins it after a
blank line, its text unchanged and in order, so a request never holds two `user` messages in a row. A request without
such a pair is byte-identical. A left-out tool result is replaced inside its `<tool_result>` wrapper only, so the text
joined to it stays whole, and the size estimate counts the request as sent. Live, on local Ollama, `gemma4` and
`qwen3.8` accepted two `user` messages in a row and answered the joined shape correctly; a server applying Gemma's
chat template as published refuses the pair, and the employer's service was not checked.

## Amendment (2026-11-10): text after the call, and one-line arguments

Decided by the maintainer (schalappe) on 2026-11-10, on live evidence: the first runs on the employer's service, with
`gemma-4-31b-it`, `qwen-latest`, and `glm-latest`, none of them measured by the eval.

- `gemma-4-31b-it` went on after its call: in one reply it wrote seven more `edit_file` calls, each followed by a
  `<tool_result tool="edit_file" status="ok">` it wrote itself. Only the first call ran, yet the chat showed the
  others as done, and the history sent them back, so the model read its invented results as true.
- `qwen-latest` got ripgrep's `the literal "\n" is not allowed in a regex` for patterns that hold no line break: a
  value ending with a line break but not starting with one keeps it under the rule "both or neither".

**Decision.**

- A reply's answer ends at its call: the text after the call block is dropped before the call runs, so the chat and
  the history never hold it. One call per reply stays the rule; nothing after the call was ever run.
- While a reply streams, a tool result opening (`<tool_result`) the model writes after a complete call ends the reply
  there: the request is cancelled, and the reply ends `done`, as if the provider had stopped. An opening with no
  complete call before it, such as one inside a `write_file` value still streaming, stops nothing.
- An argument that cannot hold a line break (each `path`, `cwd`, the `search` pattern, and the `load_skill` name)
  loses every leading and trailing line break, whatever the other side holds. The other arguments keep the "both or
  neither" rule.

**Cost, accepted.** A `write_file` value that holds an example call followed by a tool result opening, while its
tags do not balance yet, ends the reply at that example: the diff shows the cut file before anything is written.

**Open.** These models also wrap calls in `<tool_call>` (Gemma) or write `<parameter>` tags (Qwen's native format,
garbled), and `glm-latest` ends with a plan and no call. Changing the parser for those waits for an eval run against
the employer's service.

## Amendment (2026-11-12): wrapped calls, results forged before the call, repeated calls

Decided by the maintainer (schalappe) on 2026-11-12, on eval evidence (#58): the bench against `gemma-4-31b-it` served
by vLLM 0.28 on a rented A100 (`google/gemma-4-31B-it`, BF16, `--max-model-len 32768`), the closest public setup to
the employer's service. It passed `skill` 6/10 and `command` 9/10, every other scenario 10/10, while the local Ollama
`gemma4:26b-a4b-it-qat` passes everything.

- Gemma wrapped calls in `<tool_code>` or `<tool_call>`, the live observation of 2026-11-10 reproduced: every failed
  run started that way, and 8 of the 63 passing runs did too before recovering after the malformed-call message.
- After that message, Gemma wrote a `<tool_result tool="load_skill">` itself, with an invented folder, before a
  `read_file` of that folder. The 2026-11-10 cut only acts on a result written after a complete call, so the call ran
  on the invented path; 3 of the 4 `skill` failures held such a result.
- One `command` run repeated the same wrapped call for 24 minutes (78,168 characters), until the next request
  overflowed the context.

**Decision.**

- A wrapper tag, `<tool_call>` or `<tool_code>`, starting a line outside code, whose content starts with a known tool's
  call, is that call. The block spans the wrapper when its closing tag follows the call; the closing tag is optional.
  A wrapper around anything else is still "not a known tool". Accepting the native habit costs one rule; refusing it
  costs a request and, as measured, sends the model off course.
- A tool result opening the model writes (never itself a call-shaped block, even as a bare `<tool_result>`) before the
  reply's first call-shaped block, or in a reply with no call, makes the reply malformed: it is cut where the result
  opens, so the invented result never reaches the chat or the history, and the model is told that only the extension
  writes results.
- While a reply streams, the opening tag of another call (a known tool or a wrapper, starting a line) after a complete
  call ends the reply there, as a forged result already does. One call runs per reply, so nothing after the first call
  was ever used.

**Cost, accepted.** A final answer that quotes a raw `<tool_result …>` opening at a line start, outside code, is
refused once. A `write_file` value holding an unfenced example call, after a complete-looking call whose tags already
balance, ends the reply there, as for a forged result (2026-11-10).

**Verified (2026-11-12).** With these rules, `gemma-4-31b-it` on vLLM passed 70 of 70 runs in 6 min 32 s; 26 wrapped
replies in 17 runs were read as calls, and no reply forged a result. The local Ollama bench stayed at 140 of 140
(`qwen3.8:27b` and `gemma4:26b-a4b-it-qat`, 58 min 23 s). Gemma on vLLM still wrote the placeholder `<tool_name>` of the
generic call shape 12 times, each time recovering after the malformed-call message.

**Open.** Qwen's garbled `<parameter>` form and GLM's reply ending mid-call wait for their own measurement; GLM on a
rented GPU is out of budget.

## Amendment (2026-11-12): reasoning that closes with a bare `</think>`

Decided by the maintainer (schalappe) on 2026-11-12, on eval evidence (#58): `qwen-latest` is Qwen 3.8, 27B, FP8
(the employer's announcement), measured as `Qwen/Qwen3.8-27B-FP8` on vLLM 0.28 without a reasoning parser, with the
rules of the amendment above. It passed `create` 4/10: each of its 216 replies reasoned as content, with no `<think>`
and a bare `</think>` line, since its chat template opens `<think>` in the prompt; in the 6 failures the reasoning
quoted the file with unbalanced fences, so the real `write_file` after `</think>` read as code and the reply as a final
answer.

**Decision.** A reply with no reasoning yet whose content holds a bare `</think>` line (alone on its line, no `<think>`
before it) reasoned as content: once that line streams in, the text before it moves to the reasoning and the answer
starts after it, so the parser and the history never see it. The commit message drops it the same way. Whether the
employer's service runs a reasoning parser is unknown; with one, no such line reaches the content and nothing changes.

**Cost, accepted.** Until the line arrives the reasoning shows as answer text, and the stream cut of the amendment
above scans it: measured, none of the 214 replies holding such reasoning had a call tag or a result opening before
`</think>`. An answer holding a bare `</think>` line loses the text before it.

**Verified (2026-11-12).** `qwen-latest` on vLLM then passed `create` 10/10; `read`, `skill`, `slash`, and `hidden` 10/10,
`edit` 9/10 (one run closed `edit_file` with `</tool_name>` three times), and `command` 8/10: in two runs it walked
`logs/` with `list_files` until the step limit instead of running a command, the behavior seen live (#9). On 48 GB vLLM
needs `--max-num-seqs 16` for this hybrid model (Mamba cache blocks).

**Closed (2026-11-12).** The measurement of #58 ends here. With one sentence added to the system prompt's `run_command`
rule (one command covers a whole folder tree, #120), `qwen-latest` on vLLM passed 70 of 70 runs, `gemma-4-31b-it` 69 of
70 (one `edit` run wrote an invented `<tool_read_file>` tag three times), and the local Ollama bench 140 of 140. No
failed run on vLLM was traced to Qwen's garbled `<parameter>` form seen live on 2026-11-10, so it gets no parser rule.
`glm-latest` stays unmeasured, a rented GPU for it being out of budget (maintainer decision): its reply ending mid-call
gets no rule either, and the rule above stands: no parser change without eval evidence.

## Addendum (2026-11-12): `read_file` takes a line range

Decided by the maintainer (schalappe) on 2026-11-12 (#100). `read_file` gets two optional `oneLine` arguments,
`start_line` and `end_line`, so the model can read past a file's first 2,000 lines. The call format is unchanged: they
are ordinary named arguments in the body of the call, and the parser needs no new rule. A cut read without a range now
gets the header `lines 1-2000 of T` and the notice `[truncated: N more lines not shown; read on with start_line 2001]`:
the first read of a long file never has a range, so the notice is where the model learns it can read on. The bench's
`range` scenario measures that the model follows it; the bench rejects its commands, since `tail -n 1` found the
answer without the notice in 2 of 10 `gemma4` runs. Mentions and the other tools keep their wording.

## Addendum (2026-11-13): the request asks for usage

Decided by the maintainer (schalappe) on 2026-11-12 (#136, part of #105). Every chat completion request carries one
optional field, `stream_options: { include_usage: true }`, so the provider reports the reply's token counts; the
header's tooltip shows them beside the estimate. The body still never carries `tools`, and the call format is
unchanged. A model of a provider that answers a request with the field by HTTP 400 or 422, before it has once taken the
field, gets the same request once more without it, and is then sent none until a request with the field gets a started
stream. The refusal is read from the status alone, not the error's wording: nobody has observed how the internal
service words one, and a detector on the wording could fail every request there. Measured live on Ollama 0.40.16: with
the field the stream ends with a usage chunk, without it none comes. vLLM's `StreamOptions` takes the field; the
internal service's own answer to it is unknown.

**Cost, accepted.** A provider that answers 400 for another reason (a request over its context) gets the request twice
until one of its streams has started with the field; the second answer is the one shown.
