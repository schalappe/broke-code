/**
 * @module providerSupport
 * What the extension has learned about each model of each provider, in memory for the life of the extension host.
 * One instance is shared by the chat and the commit message, so a request of either teaches the other. A model is
 * keyed by the provider's name and base URL and the model's name together: an edited base URL under the same name is
 * another provider, and behind a proxy two models of one provider may reach servers that differ.
 */
import { DEFAULT_RATIO, MIN_RATIO } from "./limits";
import type { Provider } from "./providers";

/** Fewest prompt tokens a reply must report to give a sample: below, the chat template's tokens weigh too much. */
export const MIN_SAMPLE_TOKENS = 1000;

/**
 * Whether a model takes the request field asking for usage (`stream_options`). `unknown` at the start; `accepts` once
 * a request carrying the field got a started stream, for good; `refuses` once a request sent again without it, after a
 * 400 or 422, got a started stream while the model was still `unknown`.
 */
export type UsageFieldSupport = "unknown" | "accepts" | "refuses";

/**
 * What is known of one model. `ratioTenths`: its characters per token times 10, an integer from 20 to 40, so the
 * estimates computed from it are exact (see `estimateTokens`).
 */
type ModelRecord = { usageField: UsageFieldSupport; ratioTenths: number };

export class ProviderSupport {
  private readonly models = new Map<string, ModelRecord>();

  usageField(provider: Provider, model: string): UsageFieldSupport {
    return this.models.get(keyOf(provider, model))?.usageField ?? "unknown";
  }

  /** A request carrying the field got a started stream: proof the field is taken, which nothing undoes. */
  usageFieldAccepted(provider: Provider, model: string): void {
    this.record(provider, model).usageField = "accepts";
  }

  /**
   * A request sent again without the field, after a 400 or 422, got a started stream. Only an `unknown` model becomes
   * `refuses`: one that accepted the field meanwhile (another request in flight) keeps that proof.
   */
  usageFieldRefused(provider: Provider, model: string): void {
    const record = this.record(provider, model);
    if (record.usageField === "unknown") record.usageField = "refuses";
  }

  /** The characters per token of `model`'s estimates: 4 until a reply taught a lower one. */
  ratio(provider: Provider, model: string): number {
    return (this.models.get(keyOf(provider, model))?.ratioTenths ?? DEFAULT_RATIO * 10) / 10;
  }

  /**
   * A completed request of `characters` (what the estimate counts: the UTF-16 lengths of its messages' contents) whose
   * reply reported `promptTokens`. From `MIN_SAMPLE_TOKENS` tokens, its sample (the characters per token rounded down
   * to one decimal) lowers the ratio to it, never under 2. The ratio never goes back up: a server that truncates an
   * oversized request without an error reports too few tokens, a high sample, which must not make the estimate more
   * optimistic (ADR 0006). True when the ratio went down.
   */
  learnRatio(provider: Provider, model: string, characters: number, promptTokens: number): boolean {
    if (promptTokens < MIN_SAMPLE_TOKENS) return false;
    const sample = Math.max(MIN_RATIO * 10, Math.floor((characters * 10) / promptTokens));
    const record = this.record(provider, model);
    if (sample >= record.ratioTenths) return false;
    record.ratioTenths = sample;
    return true;
  }

  private record(provider: Provider, model: string): ModelRecord {
    const key = keyOf(provider, model);
    let record = this.models.get(key);
    if (record === undefined) {
      record = { usageField: "unknown", ratioTenths: DEFAULT_RATIO * 10 };
      this.models.set(key, record);
    }
    return record;
  }
}

/** One string per (name, base URL, model); JSON keeps a separator inside a name from making two keys collide. */
function keyOf(provider: Provider, model: string): string {
  return JSON.stringify([provider.name, provider.baseUrl, model]);
}
