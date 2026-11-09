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
