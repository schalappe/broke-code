/**
 * @module apiKey
 * Shape check of an API key typed by the user. The key travels in an HTTP `Authorization` header, which accepts
 * visible ASCII only; a key with any other character would make every request fail before it leaves the machine.
 * Also the password box that asks for a key, the same wherever it is asked.
 */
import type { Translator } from "./modelList";

const HEADER_SAFE = /^[\x21-\x7e]*$/;

/** True when `key` (already trimmed) can be sent as a bearer token. Empty = no key, accepted. */
export function isHeaderSafeKey(key: string): boolean {
  return HEADER_SAFE.test(key);
}

/** The password box asking for a provider's key: its texts, and the message shown while the value is refused. */
export type ApiKeyBox = {
  title: string;
  prompt: string;
  placeholder: string;
  validate(value: string): string | undefined;
};

/**
 * The key box of provider `name`. `new`: a provider's first key (the missing-key prompt, Add provider); `change`: Set
 * API key, which replaces or clears it. The value is trimmed before the shape check, as before storing it.
 */
export function apiKeyBox(name: string, purpose: "new" | "change", l10n: Translator): ApiKeyBox {
  return {
    title: l10n.t("API key for {0}", name),
    prompt:
      purpose === "new"
        ? l10n.t("broke-code sends this key to {0} as a bearer token.", name)
        : l10n.t("Enter a new key to set or replace it. Leave empty to clear it."),
    placeholder: l10n.t("Leave empty for a provider that needs no key, such as Ollama"),
    validate: (value) =>
      isHeaderSafeKey(value.trim())
        ? undefined
        : l10n.t("An API key can contain only visible ASCII characters, with no spaces or accents."),
  };
}
