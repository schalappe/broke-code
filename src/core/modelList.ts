/**
 * @module modelList
 * The model list outside the header's select: why it is empty, its rows, and the `/model` pick the host relays to the
 * editor's Quick Pick. Imports nothing from `vscode` or `node:`, since the webview loads it.
 */
import type { ChatState, ModelsState } from "./protocol";

/**
 * A translator of English message keys: `vscode.l10n` in the host, `@vscode/l10n` in the webview. Callers name it
 * `l10n` so the localization test, which reads the literal key of each `t` call on `l10n`, finds the keys used here.
 */
export type Translator = { t(message: string, ...args: (string | number | boolean)[]): string };

/**
 * Why the model list `models` is empty, as a label translated by `l10n`, for the header's select and the `/model`
 * Quick Pick. Without a provider, `withoutProvider` decides: `blank` (the header's select stays empty) or `noModels`
 * (the Quick Pick's placeholder says "No models").
 */
export function emptyModelsLabel(models: ModelsState, l10n: Translator, withoutProvider: "blank" | "noModels"): string {
  switch (models.status) {
    case "loading":
      return l10n.t("Loading models…");
    case "failed":
      return l10n.t("Models unavailable");
    case "noProvider":
      if (withoutProvider === "blank") return "";
      return l10n.t("No models");
    case "loaded":
      return l10n.t("No models");
  }
}

/** A row of the model list `/model` opens. `current`: the model selected now. */
export type ModelChoice = { model: string; current: boolean };

/** Rows of the model list `/model` opens: the listed models in listing order, as the header's select; none until listed. */
export function modelChoices(state: Pick<ChatState, "models" | "model">): ModelChoice[] {
  if (state.models.status !== "loaded") return [];
  return state.models.models.map((model) => ({ model, current: model === state.model }));
}

/** A row of the `/model` pick as the editor shows it: the model's name, and `current` for the model selected now. */
export type ModelPickItem = { label: string; description?: string };

/**
 * What `chooseModel` needs from the host. `pick`: shows `items` under `placeholder` and settles with the picked row, or
 * `undefined` when dismissed (the Quick Pick). `selectModel`: what the header's select change does. `showError`: shows
 * a failure to the user.
 */
export type ModelPickPorts = {
  pick(items: ModelPickItem[], placeholder: string): Promise<ModelPickItem | undefined>;
  selectModel(model: string): void;
  showError(message: string): void;
};

/**
 * The `/model` pick: the selected provider's listed models, the current one described as such. Before the models are
 * listed, it opens empty and its placeholder says why, as the header's select does. A pick selects that model;
 * dismissing it changes nothing. A failure is logged and shown, never rejected, since the webview's message started it.
 */
export async function chooseModel(
  state: Pick<ChatState, "models" | "model">,
  ports: ModelPickPorts,
  l10n: Translator,
): Promise<void> {
  const items = modelChoices(state).map((choice): ModelPickItem => {
    if (!choice.current) return { label: choice.model };
    return { label: choice.model, description: l10n.t("current") };
  });
  const placeholder = items.length > 0 ? l10n.t("Choose the model") : emptyModelsLabel(state.models, l10n, "noModels");
  try {
    const picked = await ports.pick(items, placeholder);
    if (picked) ports.selectModel(picked.label);
  } catch (error) {
    console.error("broke-code: could not open the model list", error);
    ports.showError(l10n.t("Could not open the model list: {0}", String(error)));
  }
}
