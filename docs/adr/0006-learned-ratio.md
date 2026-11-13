---
status: accepted
---

# Each model's characters per token is learned from reported usage, starts at 4, and only goes down

Every size broke-code uses is an estimate made before a request is sent: the header's usage, the leave-out rule, the
full-context check, the summary size checks, and the commit message's diff cut. Until now the estimate divided a
request's characters by 4. Measured on the local models (gemma4 26b, Ollama 0.40.16), code and non-English text run
nearer 3.5 characters per token: a 23,612-character TypeScript file is 6,711 prompt tokens (3.52), 21,636 characters
of French JSON are 6,234 (3.47), while English prose is 4.04. A request the estimate called fitting could therefore
fill the whole context: #58 reports a provider refusing 32,769 input tokens the estimate had not seen. Since #136,
replies report their `prompt_tokens` (ADR 0001, addendum of 2026-11-13), so the real number per model is observable,
one reply late. broke-code has no tokenizer and the API does not report one.

## Decision

For each model of each provider (the provider's name and base URL and the model's name together), `ProviderSupport`
keeps one ratio of characters per token, in memory for the life of the extension host. It starts at 4. A completed
reply that reports at least 1,000 prompt tokens gives a sample: the request's characters, as the estimate counts them,
divided by `prompt_tokens`, rounded down to one decimal. The ratio becomes the smaller of itself and the sample, never
under 2. Every estimate for that model divides by it, from the next computation on, inside a running turn too.

The ratio only goes down because a high sample is not trustworthy: Ollama truncates an oversized request without an
error and reports what it kept, 16,387 tokens for 137,553 characters (8.39 per token) on a 32,768 context. Taking
that sample would make the estimate more optimistic right after an overflow, when it matters most. Prompt tokens
also include the chat template's tokens, which only lowers a sample, the safe side. The 1,000-token floor keeps tiny
requests, where the template weighs most, out.

The size functions stay pure and take the ratio as an input, computed in whole tenths (`ceil(characters * 10 / t)`,
`floor(room * t / 10)`, `t` from 20 to 40), since a floating-point division is off by one in places. `streamChat`
takes the sample, so a turn's requests, summaries, and the commit message all teach the same object the chat and the
commit message share.

## Considered options

- Take the last sample, clamped to 2–6 (the first draft of #137). Rejected: the truncated request above gives 8.39,
  clamped to 6, an estimate more optimistic than the fixed 4 right after an overflow.
- An average or a moving window of samples. Rejected: a truncated sample still pulls it up, and a single number that
  only goes down is simpler to explain and to test.
- A tokenizer per model. Rejected: the models of the internal service are not known in advance, it is a large
  dependency, and the reported usage already gives the number.
- Save the ratios across reloads or in the conversation record. Rejected: the record would change (ADR 0003's rule),
  and a ratio settles after a few replies.
- Read the ratio once per turn, like the limits. Rejected: the first long turn is where the overflow happens, and a
  ratio that only goes down never puts back a result left out, so the prompt cache of #87 stays as stable as it can.

## Consequences

- A long request on code or French no longer passes the threshold unseen once one reply of that model reported its
  usage; the header's estimate rises at that reply.
- A ratio never recovers within a session: one low sample (a prompt of mostly emoji or CJK text) keeps the estimate
  pessimistic until the window reloads, leaving results out or cutting the commit diff earlier than needed. Accepted:
  pessimistic costs context, optimistic costs a refused request.
- The first request of each model after a reload is still estimated at 4; the overflow #58 describes can still
  happen on it.
- A provider that reports no usage keeps 4, as before.
- The eval bench learns the same way with fresh ratios per run; its recorded results were measured at a fixed 4.
