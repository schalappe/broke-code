/**
 * @module addProvider
 * "broke-code: Add provider": a guided flow that appends a provider to the user's `brokeCode.providers` and stores its
 * API key, over ports the host fills with the Quick Pick, input boxes, the settings, and `SecretStorage`. Nothing is
 * contacted: the Ollama preset is offered without probing its port.
 */
import { isHeaderSafeKey } from "./apiKey";
import type { Translator } from "./modelList";
import { appendProvider, type CandidateReading, parseProviders, readCandidate, type SkipReason } from "./providers";

/** The local Ollama preset, added with the empty key (no key). */
export const OLLAMA_PRESET = { name: "ollama", baseUrl: "http://localhost:11434/v1" } as const;

/** `ollama`: the local Ollama preset; `other`: another OpenAI-compatible service, asked in input boxes. */
export type ProviderChoice = "ollama" | "other";

/** A row of the first Quick Pick. Not `kind`, which a Quick Pick item reads as its separator flag. */
export type ProviderChoiceItem = { choice: ProviderChoice; label: string; detail?: string };

/** An input box. `validate`: the message shown under the box while the value is refused, `undefined` when accepted. */
export type ProviderInput = {
  title: string;
  prompt: string;
  placeholder: string;
  password: boolean;
  validate(value: string): string | undefined;
};

/**
 * What `addProvider` needs from the host. `pick` and `input` settle with `undefined` on Escape. `readSetting`: the
 * user value of `brokeCode.providers`, never another scope's. `select`: apply the new settings and select `name`, as
 * picking it in the header does.
 */
export type AddProviderPorts = {
  pick(items: ProviderChoiceItem[], placeholder: string): Promise<ProviderChoiceItem | undefined>;
  input(box: ProviderInput): Promise<string | undefined>;
  readSetting(): unknown;
  writeSetting(value: unknown[]): Promise<void>;
  storeKey(name: string, key: string): Promise<void>;
  deleteKey(name: string): Promise<void>;
  select(name: string): void;
  showError(message: string): void;
};

/** `added`: key stored and setting written. `selected`: the preset's provider existed. `failed`: shown to the user. */
export type AddProviderOutcome = "added" | "selected" | "cancelled" | "failed";

// [>]: Stands in for the base URL while the name box validates, so only the name can be refused.
const VALID_URL = "http://localhost/v1";

/**
 * Run the flow: pick the Ollama preset or another service; for another, ask its name, base URL, and key, each box
 * validated by the settings parser's rule (`readCandidate`) or the key shape check. On completion the key is stored
 * first (`""` for no key), then the entry is appended to the user setting, base URL normalized; a failed settings
 * write deletes that key, so a failure leaves none. Escape at any step changes nothing. Port failures other than these
 * writes reject, for the host to show.
 */
export async function addProvider(ports: AddProviderPorts, l10n: Translator): Promise<AddProviderOutcome> {
  const items: ProviderChoiceItem[] = [
    { choice: "ollama", label: l10n.t("Ollama on this machine"), detail: OLLAMA_PRESET.baseUrl },
    { choice: "other", label: l10n.t("Other OpenAI-compatible service") },
  ];
  const choice = (await ports.pick(items, l10n.t("Choose the provider to add")))?.choice;
  if (choice === undefined) return "cancelled";

  if (choice === "ollama") {
    const existing = parseProviders(ports.readSetting()).providers.some((p) => p.name === OLLAMA_PRESET.name);
    if (existing) {
      ports.select(OLLAMA_PRESET.name);
      return "selected";
    }
    return save({ name: OLLAMA_PRESET.name, baseUrl: OLLAMA_PRESET.baseUrl, key: "" }, ports, l10n);
  }

  const refusal = (reading: CandidateReading) => ("reason" in reading ? reasonText(reading.reason, l10n) : undefined);
  const title = l10n.t("Add provider");
  const name = await ports.input({
    title,
    prompt: l10n.t("The provider's name, shown in the chat."),
    placeholder: l10n.t("For example Lab"),
    password: false,
    validate: (value) => refusal(readCandidate(ports.readSetting(), { name: value, baseUrl: VALID_URL })),
  });
  if (name === undefined) return "cancelled";
  const baseUrl = await ports.input({
    title,
    prompt: l10n.t("The base URL of its OpenAI-compatible API, version path included."),
    placeholder: "https://llm.example.com/v1",
    password: false,
    validate: (value) => refusal(readCandidate(ports.readSetting(), { name, baseUrl: value })),
  });
  if (baseUrl === undefined) return "cancelled";
  const key = await ports.input({
    title: l10n.t("API key for {0}", name.trim()),
    prompt: l10n.t("broke-code sends this key to {0} as a bearer token.", name.trim()),
    placeholder: l10n.t("Leave empty for a provider that needs no key, such as Ollama"),
    password: true,
    validate: (value) => (isHeaderSafeKey(value.trim()) ? undefined : keyShapeText(l10n)),
  });
  if (key === undefined) return "cancelled";
  return save({ name, baseUrl, key: key.trim() }, ports, l10n);
}

/** Store the key, then append the entry; read against the setting as it is now, since it may have changed meanwhile. */
async function save(
  typed: { name: string; baseUrl: string; key: string },
  ports: AddProviderPorts,
  l10n: Translator,
): Promise<AddProviderOutcome> {
  const current = ports.readSetting();
  const reading = readCandidate(current, { name: typed.name, baseUrl: typed.baseUrl });
  if ("reason" in reading) {
    ports.showError(l10n.t("Could not add the provider {0}: {1}", typed.name.trim(), reasonText(reading.reason, l10n)));
    return "failed";
  }
  if (!isHeaderSafeKey(typed.key)) {
    ports.showError(l10n.t("Could not add the provider {0}: {1}", reading.provider.name, keyShapeText(l10n)));
    return "failed";
  }
  const { name, baseUrl } = reading.provider;

  // [!]: Key first: keys outlive their provider, so a setting written first would send a removed provider's leftover
  // key under this name to the new URL at the first model listing.
  try {
    await ports.storeKey(name, typed.key);
  } catch (error) {
    ports.showError(l10n.t("Could not save the API key for {0}: {1}", name, String(error)));
    return "failed";
  }
  try {
    await ports.writeSetting(appendProvider(current, { name, baseUrl }));
  } catch (error) {
    console.error("broke-code: could not add a provider", name, error);
    ports.showError(l10n.t("Could not add the provider {0}: {1}", name, String(error)));
    await deleteKey(name, ports, l10n);
    return "failed";
  }
  ports.select(name);
  return "added";
}

async function deleteKey(name: string, ports: AddProviderPorts, l10n: Translator): Promise<void> {
  try {
    await ports.deleteKey(name);
  } catch (error) {
    console.error("broke-code: could not delete the key of a provider not added", name, error);
    ports.showError(l10n.t("Could not delete the API key for {0}: {1}", name, String(error)));
  }
}

/** The input box's own short message for each reason the parser skips an entry. */
function reasonText(reason: SkipReason, l10n: Translator): string {
  switch (reason) {
    case "missingName":
      return l10n.t("Enter a name.");
    case "duplicateName":
      return l10n.t("Another provider already uses this name.");
    case "invalidUrl":
      return l10n.t("Enter an http or https URL.");
  }
}

function keyShapeText(l10n: Translator): string {
  return l10n.t("An API key can contain only visible ASCII characters, with no spaces or accents.");
}
