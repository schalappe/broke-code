/**
 * @module vllmFixture
 * Test fixture: SSE events shaped like the internal vLLM service sends them (0.28 glm-latest, 0.30 qwen-latest,
 * 0.30 gemma-4-31b-it, observed live). Reasoning fragments carry `reasoning_content` and no `content` key; deltas
 * carry `provider_specific_fields`; usage arrives last, with `choices: []`. No model sends `<think>`.
 */

/** One `chat.completion.chunk` event. */
export function vllmEvent(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const chunk = {
    id: "chatcmpl-vllm-1",
    object: "chat.completion.chunk",
    created: 1_762_560_000,
    model: "qwen-latest",
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** Final usage event: no choices, `completion_tokens_details` vLLM adds. */
export function vllmUsage(reasoningTokens: number): string {
  const chunk = {
    id: "chatcmpl-vllm-1",
    object: "chat.completion.chunk",
    created: 1_762_560_000,
    model: "qwen-latest",
    choices: [],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 20 + reasoningTokens,
      total_tokens: 32 + reasoningTokens,
      completion_tokens_details: { reasoning_tokens: reasoningTokens },
    },
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** First event of every vLLM reply, before any reasoning or answer. */
export const vllmOpening = vllmEvent({ role: "assistant", content: "" });

/** Reply of a reasoning model (glm-latest, qwen-latest), after `vllmOpening`. */
export const vllmReasoningRest = [
  vllmEvent({ reasoning_content: "The user greets me.", provider_specific_fields: {} }),
  vllmEvent({ reasoning_content: " Reply politely.", provider_specific_fields: {} }),
  vllmEvent({ content: "Hello!", provider_specific_fields: {} }),
  vllmEvent({ content: " How can I help?", provider_specific_fields: {} }),
  vllmEvent({}, "stop"),
  vllmUsage(12),
  "data: [DONE]\n\n",
];

/** Reply of a model that does not reason (gemma-4-31b-it): `content` directly, zero reasoning tokens. */
export const vllmPlainStream = [
  vllmOpening,
  vllmEvent({ content: "Hello!", provider_specific_fields: {} }),
  vllmEvent({ content: " How can I help?", provider_specific_fields: {} }),
  vllmEvent({}, "stop"),
  vllmUsage(0),
  "data: [DONE]\n\n",
];
