/**
 * @module limits
 * Turn limits from the user settings (`brokeCode.maxToolSteps`, `brokeCode.contextSizes`), the command timeout
 * (`brokeCode.commandTimeoutSeconds`), and the context budget: the estimate of a request's size in tokens and the
 * context-full threshold. No `node:` or `vscode` import.
 */

/** The limits an agent turn runs under: its tool step limit and the context size of each model in the table. */
export type TurnLimits = { maxToolSteps: number; contextSizes: ReadonlyMap<string, number> };

/** A model's context size in tokens; `known` is false when the model is absent from the table and 32,768 is used. */
export type ContextSize = { size: number; known: boolean };

/** Tool steps per agent turn, calls and malformed calls alike, while `brokeCode.maxToolSteps` is unset or invalid. */
export const DEFAULT_MAX_TOOL_STEPS = 50;
/** Context size of a model absent from `brokeCode.contextSizes`. */
export const DEFAULT_CONTEXT_SIZE = 32_768;

/**
 * Parse the raw setting values. Never throws. A step limit that is not an integer of at least 1 gives 50; a table that
 * is not a plain object is empty, and each entry that is not a positive integer is left out (VS Code already flags a
 * schema mismatch in settings.json).
 */
export function parseLimits(raw: { maxToolSteps: unknown; contextSizes: unknown }): TurnLimits {
  const steps = raw.maxToolSteps;
  const maxToolSteps = isPositiveInteger(steps) ? steps : DEFAULT_MAX_TOOL_STEPS;
  const contextSizes = new Map<string, number>();
  const table = raw.contextSizes;
  if (isPlainObject(table)) {
    for (const [model, size] of Object.entries(table)) {
      if (isPositiveInteger(size)) contextSizes.set(model, size);
    }
  }
  return { maxToolSteps, contextSizes };
}

/** Seconds a command runs before it is stopped, while `brokeCode.commandTimeoutSeconds` is unset or invalid. */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
/** The longest timeout in seconds: a Node timer fires at once past 2^31 - 1 milliseconds, about 24.8 days. */
const MAX_COMMAND_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

/**
 * Parse the raw `brokeCode.commandTimeoutSeconds` value. Never throws. A value that is not an integer of at least 1
 * gives 120; a longer one than a timer can wait is capped, so the timeout still holds.
 */
export function parseCommandTimeout(raw: unknown): number {
  return isPositiveInteger(raw) ? Math.min(raw, MAX_COMMAND_TIMEOUT_SECONDS) : DEFAULT_COMMAND_TIMEOUT_SECONDS;
}

/** Context size of `model` under `limits`; no model gets the default, unknown. */
export function contextOf(limits: TurnLimits, model: string | undefined): ContextSize {
  const size = model === undefined ? undefined : limits.contextSizes.get(model);
  return size === undefined ? { size: DEFAULT_CONTEXT_SIZE, known: false } : { size, known: true };
}

/**
 * Estimated tokens of a request made of `messages`: the characters (UTF-16 code units) of their contents divided by 4,
 * rounded up. A decision, not a tokenizer: no provider reports usage without `stream_options`.
 */
export function estimateTokens(messages: readonly { content: string }[]): number {
  const characters = messages.reduce((total, message) => total + message.content.length, 0);
  return Math.ceil(characters / 4);
}

/** True when an estimate of `used` tokens leaves less than one eighth of `size` for the reply. */
export function fillsContext(used: number, size: number): boolean {
  return used > Math.floor((size * 7) / 8);
}

/** A context size typed in the input box: digits only, spaces around them trimmed, at least 1; else `undefined`. */
export function parseContextSizeInput(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const size = Number(trimmed);
  return isPositiveInteger(size) ? size : undefined;
}

/**
 * The user's `brokeCode.contextSizes` value with `model` set to `size`, its other entries kept. A value that is not a
 * plain object is replaced, since `parseLimits` reads it as empty anyway.
 */
export function withContextSize(current: unknown, model: string, size: number): Record<string, unknown> {
  return { ...(isPlainObject(current) ? current : {}), [model]: size };
}

/** A JSON-like object: its prototype is `Object.prototype` or none, so no class instance or array passes. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
