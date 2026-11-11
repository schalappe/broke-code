/**
 * @module addProvider
 * "broke-code: Add provider" over the editor's Quick Pick and input boxes, the user settings, and `SecretStorage`; the
 * flow itself is `addProvider` in the core.
 */
import * as vscode from "vscode";
import { addProvider } from "../core/addProvider";
import type { ApiKeys } from "./apiKeys";

/**
 * Run the flow as a key dialog (see `ApiKeys.runDialog`): the automatic missing-key prompt that the settings write
 * triggers then finds the new key already stored. Never rejects: an unexpected failure is logged and shown.
 * @param readSetting - The user value of `brokeCode.providers`.
 * @param select - Apply the settings and select the provider named, as the header's pick does.
 */
export function runAddProvider(apiKeys: ApiKeys, readSetting: () => unknown, select: (name: string) => void) {
  return apiKeys.runDialog(async () => {
    try {
      await addProvider(
        {
          pick: async (items, placeHolder) =>
            vscode.window.showQuickPick(items, { title: vscode.l10n.t("Add provider"), placeHolder }),
          input: async (box) =>
            vscode.window.showInputBox({
              title: box.title,
              prompt: box.prompt,
              placeHolder: box.placeholder,
              password: box.password,
              ignoreFocusOut: true,
              validateInput: box.validate,
            }),
          readSetting,
          // [!]: The user value only (`Global`): a workspace value is ignored for providers, by the `application` scope.
          writeSetting: async (value) => {
            await vscode.workspace
              .getConfiguration("brokeCode")
              .update("providers", value, vscode.ConfigurationTarget.Global);
          },
          storeKey: (name, key) => apiKeys.store(name, key),
          deleteKey: (name) => apiKeys.delete(name),
          select,
          showError: (message) => void vscode.window.showErrorMessage(message),
        },
        vscode.l10n,
      );
    } catch (error) {
      console.error("broke-code: could not add a provider", error);
      void vscode.window.showErrorMessage(vscode.l10n.t("Could not add the provider: {0}", String(error)));
    }
  });
}
