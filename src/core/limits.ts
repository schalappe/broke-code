/**
 * @module limits
 * Turn limits from the user settings (`brokeCode.maxToolSteps`, `brokeCode.contextSizes`) and the context budget: the
 * estimate of a request's size in tokens and the context-full threshold. No `node:` or `vscode` import.
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
  if (typeof table === "object" && table !== null && !Array.isArray(table)) {
    for (const [model, size] of Object.entries(table)) {
      if (isPositiveInteger(size)) contextSizes.set(model, size);
    }
  }
  return { maxToolSteps, contextSizes };
}

/** Context size of `model` under `limits`; no model gets the default, unknown. */
export function contextOf(limits: TurnLimits, model: string | undefined): ContextSize {
  const size = model === undefined ? undefined : limits.contextSizes.get(model);
  return size === undefined ? { size: DEFAULT_CONTEXT_SIZE, known: false } : { size, known: true };
}

/**
 * Estimated tokens of a request whose messages hold `contents`: their characters (UTF-16 code units) divided by 4,
 * rounded up. A decision, not a tokenizer: no provider reports usage without `stream_options`.
 */
export function estimateTokens(contents: readonly string[]): number {
  const characters = contents.reduce((total, content) => total + content.length, 0);
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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
