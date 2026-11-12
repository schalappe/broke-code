/**
 * @module providerSupport
 * What the extension has learned about each model of each provider, in memory for the life of the extension host.
 * One instance is shared by the chat and the commit message, so a request of either teaches the other. A model is
 * keyed by the provider's name and base URL and the model's name together: an edited base URL under the same name is
 * another provider, and behind a proxy two models of one provider may reach servers that differ.
 */
import type { Provider } from "./providers";

/**
 * Whether a model takes the request field asking for usage (`stream_options`). `unknown` at the start; `accepts` once
 * a request carrying the field got a started stream, for good; `refuses` once a request sent again without it, after a
 * 400 or 422, got a started stream while the model was still `unknown`.
 */
export type UsageFieldSupport = "unknown" | "accepts" | "refuses";

/** What is known of one model. One record per model, so later knowledge sits beside the usage field. */
type ModelRecord = { usageField: UsageFieldSupport };

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

  private record(provider: Provider, model: string): ModelRecord {
    const key = keyOf(provider, model);
    let record = this.models.get(key);
    if (record === undefined) {
      record = { usageField: "unknown" };
      this.models.set(key, record);
    }
    return record;
  }
}

/** One string per (name, base URL, model); JSON keeps a separator inside a name from making two keys collide. */
function keyOf(provider: Provider, model: string): string {
  return JSON.stringify([provider.name, provider.baseUrl, model]);
}
