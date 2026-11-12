/**
 * @module providers
 * Parse `brokeCode.providers` setting into usable providers plus skipped entries with reasons.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export type Provider = {
  name: string;
  /** OpenAI-compatible API root, no trailing slash. Routes appended: `/models`, `/chat/completions`. */
  baseUrl: string;
  /**
   * PEM file of extra CAs trusted for this provider only, `~/` expanded. Kept as written otherwise: a relative path
   * is reported when the provider is used, like an unreadable file, so it never skips the provider.
   */
  caFile?: string;
};

export type SkipReason = "missingName" | "invalidUrl" | "duplicateName";

export type SkippedProvider = {
  /** 1-based index in setting array. */
  position: number;
  name?: string;
  reason: SkipReason;
};

export type ParsedProviders = {
  providers: Provider[];
  skipped: SkippedProvider[];
};

/**
 * Parse raw setting value. Never throws.
 * First entry of a name wins; later duplicates skipped.
 * @param raw - Value of `brokeCode.providers`. Non-array -> no providers, non-string `caFile` -> no CA file
 *   (VS Code already flags schema mismatch in settings.json).
 */
export function parseProviders(raw: unknown): ParsedProviders {
  const result: ParsedProviders = { providers: [], skipped: [] };
  if (!Array.isArray(raw)) return result;

  const seen = new Set<string>();
  raw.forEach((entry: unknown, index) => {
    const position = index + 1;
    const name = readString(entry, "name")?.trim();
    if (!name) {
      result.skipped.push({ position, reason: "missingName" });
      return;
    }
    const baseUrl = normalizeBaseUrl(readString(entry, "baseUrl"));
    if (!baseUrl) {
      result.skipped.push({ position, name, reason: "invalidUrl" });
      return;
    }
    if (seen.has(name)) {
      result.skipped.push({ position, name, reason: "duplicateName" });
      return;
    }
    seen.add(name);
    const caFile = expandHome(readString(entry, "caFile")?.trim());
    result.providers.push(caFile ? { name, baseUrl, caFile } : { name, baseUrl });
  });
  return result;
}

/** A new entry as the parser reads it after the current entries: the provider it yields, or why it is skipped. */
export type CandidateReading = { provider: Provider } | { reason: SkipReason };

/**
 * How `parseProviders` reads `entry` appended to the setting value `raw`. The one rule of what may be added: a form
 * that validates a new provider with it accepts exactly what the settings would.
 */
export function readCandidate(raw: unknown, entry: unknown): CandidateReading {
  const entries = appendProvider(raw, entry);
  const { providers, skipped } = parseProviders(entries);
  const refusal = skipped.find((skip) => skip.position === entries.length);
  if (refusal) return { reason: refusal.reason };
  // [>]: Not skipped, so the entry is the last provider the parser yields.
  return { provider: providers.at(-1) as Provider };
}

/**
 * The setting value `raw` with `entry` appended. Existing entries, skipped ones included, keep their order and every
 * field; a value that is not an array (no providers to the parser) becomes the one-entry array.
 */
export function appendProvider(raw: unknown, entry: unknown): unknown[] {
  return [...(Array.isArray(raw) ? raw : []), entry];
}

function readString(entry: unknown, key: string): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const value = (entry as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (!value || !URL.canParse(value.trim())) return undefined;
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return value.trim().replace(/\/+$/, "");
}

/** `~/x` -> `<home>/x`. Other forms (`~user/x`, relative, absolute) unchanged. */
function expandHome(path: string | undefined): string | undefined {
  if (path === "~") return homedir();
  return path?.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
