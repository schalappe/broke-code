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
