/**
 * @module contextSizes
 * The turn limits from the user settings, and the chat's "Set context size" action, which saves a model's size to
 * `brokeCode.contextSizes`.
 */
import * as vscode from "vscode";
import { parseContextSizeInput, parseLimits, type TurnLimits } from "../core/limits";

/** Settings whose change updates the limits. */
export const LIMIT_SETTINGS = ["brokeCode.maxToolSteps", "brokeCode.contextSizes"] as const;

/**
 * `brokeCode.maxToolSteps` and `brokeCode.contextSizes` from the user settings. [!]: User settings only, like the
 * providers: the manifest's `application` scope already makes VS Code ignore a workspace value; reading `globalValue`
 * keeps that explicit here.
 */
export function readLimits(): TurnLimits {
  const config = vscode.workspace.getConfiguration("brokeCode");
  return parseLimits({
    maxToolSteps: config.inspect<unknown>("maxToolSteps")?.globalValue,
    contextSizes: config.inspect<unknown>("contextSizes")?.globalValue,
  });
}

/**
 * Ask for `model`'s context size in tokens and save it to the user's `brokeCode.contextSizes`, keeping its other
 * entries. Escape saves nothing. A failed write is logged and shown. The settings change then updates the chat.
 */
export async function askContextSize(model: string): Promise<void> {
  const text = await vscode.window.showInputBox({
    title: vscode.l10n.t("Context size of {0}", model),
    prompt: vscode.l10n.t("Tokens the model accepts in one request, prompt and reply together."),
    placeHolder: vscode.l10n.t("For example 131072"),
    ignoreFocusOut: true,
    validateInput: (value) =>
      parseContextSizeInput(value) === undefined
        ? vscode.l10n.t("Enter a whole number of tokens, at least 1.")
        : undefined,
  });
  const size = text === undefined ? undefined : parseContextSizeInput(text);
  if (size === undefined) return;

  const config = vscode.workspace.getConfiguration("brokeCode");
  // [>]: Merged into the user value, never the effective one, so no other scope's entry is copied into it.
  const current = config.inspect<unknown>("contextSizes")?.globalValue;
  const table = isPlainObject(current) ? current : {};
  try {
    await config.update("contextSizes", { ...table, [model]: size }, vscode.ConfigurationTarget.Global);
  } catch (error) {
    console.error("broke-code: could not save a context size", model, error);
    void vscode.window.showErrorMessage(
      vscode.l10n.t("Could not save the context size of {0}: {1}", model, String(error)),
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
