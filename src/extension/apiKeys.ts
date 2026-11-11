/**
 * @module apiKeys
 * Provider API keys in `SecretStorage`, keyed by provider name. Never in settings.
 * Stored empty string = explicit "no key": no prompt, no `Authorization` header.
 * Every key dialog (automatic prompt, `broke-code: Set API key`) runs through one queue -> boxes never overlap.
 */
import * as vscode from "vscode";
import { isHeaderSafeKey } from "../core/apiKey";
import type { Provider } from "../core/providers";
import { SerialQueue } from "../core/serialQueue";

const SECRET_PREFIX = "brokeCode.apiKey.";

export class ApiKeys {
  private readonly dialogs = new SerialQueue();
  /** Names with automatic prompt queued or open: avoids double prompt when settings change mid-prompt. */
  private readonly prompting = new Set<string>();

  /** @param readProviders - Current valid providers; read when each dialog starts, not when queued. */
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly readProviders: () => Provider[],
  ) {}

  /**
   * @returns Stored key; `""` = explicit no key; `undefined` = never set or unreadable.
   * Never rejects: read failure (e.g. keychain locked) shown as error, request goes without key.
   */
  async get(provider: string): Promise<string | undefined> {
    try {
      return await this.secrets.get(SECRET_PREFIX + provider);
    } catch (error) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("Could not read the API key for {0}: {1}", provider, String(error)),
      );
      return undefined;
    }
  }

  /** Fire `listener` with provider name whenever its key changes, from any window. */
  onDidChange(listener: (provider: string) => void): vscode.Disposable {
    return this.secrets.onDidChange((event) => {
      if (event.key.startsWith(SECRET_PREFIX)) listener(event.key.slice(SECRET_PREFIX.length));
    });
  }

  /**
   * Ask key of each provider with no stored entry, one box at a time.
   * Escape stores nothing -> asked again on next activation or settings change.
   */
  promptMissing(): void {
    for (const { name } of this.readProviders()) {
      if (this.prompting.has(name)) continue;
      this.prompting.add(name);
      void this.dialogs
        .run(async () => {
          const stillConfigured = this.readProviders().some((provider) => provider.name === name);
          if (!stillConfigured || (await this.get(name)) !== undefined) return;
          await this.askAndStore(name, vscode.l10n.t("broke-code sends this key to {0} as a bearer token.", name));
        })
        .catch((error: unknown) => {
          void vscode.window.showErrorMessage(
            vscode.l10n.t("Could not save the API key for {0}: {1}", name, String(error)),
          );
        })
        .finally(() => this.prompting.delete(name));
    }
  }

  /**
   * Run `task` as a key dialog: it waits for the open one, and the automatic prompts queued meanwhile wait for it, so
   * none opens over it or asks for a key it is about to store.
   */
  runDialog<T>(task: () => Promise<T>): Promise<T> {
    return this.dialogs.run(task);
  }

  /** Store `key` for `provider`; `""` = no key. Rejects on failure, for the caller to show. */
  async store(provider: string, key: string): Promise<void> {
    await this.secrets.store(SECRET_PREFIX + provider, key);
  }

  /** Delete the stored entry of `provider`, so it counts as never set. Rejects on failure, for the caller to show. */
  async delete(provider: string): Promise<void> {
    await this.secrets.delete(SECRET_PREFIX + provider);
  }

  /**
   * `broke-code: Set API key`: pick provider (unless given), then set, replace, or clear its key.
   * Waits behind any open key dialog.
   * @param preselected - Provider name passed by chat panel action.
   */
  runSetCommand(preselected?: string): Promise<void> {
    return this.dialogs.run(async () => {
      const providers = this.readProviders();
      if (providers.length === 0) {
        const open = vscode.l10n.t("Open settings");
        const choice = await vscode.window.showWarningMessage(vscode.l10n.t("No provider is configured."), open);
        if (choice === open)
          await vscode.commands.executeCommand("workbench.action.openSettings", "brokeCode.providers");
        return;
      }
      const name =
        providers.find((provider) => provider.name === preselected)?.name ??
        (
          await vscode.window.showQuickPick(
            providers.map((provider) => ({ label: provider.name, description: provider.baseUrl })),
            { title: vscode.l10n.t("Set API key"), placeHolder: vscode.l10n.t("Choose a provider") },
          )
        )?.label;
      if (!name) return;

      const outcome = await this.askAndStore(
        name,
        vscode.l10n.t("Enter a new key to set or replace it. Leave empty to clear it."),
      );
      if (outcome === "stored")
        void vscode.window.showInformationMessage(vscode.l10n.t("API key for {0} saved.", name));
      if (outcome === "cleared")
        void vscode.window.showInformationMessage(vscode.l10n.t("API key for {0} cleared.", name));
    });
  }

  /** Password box for `name`; empty submit stores `""` (no key), Escape stores nothing. Save failure shown. */
  private async askAndStore(name: string, prompt: string): Promise<"stored" | "cleared" | "cancelled" | "failed"> {
    const key = await vscode.window.showInputBox({
      title: vscode.l10n.t("API key for {0}", name),
      prompt,
      placeHolder: vscode.l10n.t("Leave empty for a provider that needs no key, such as Ollama"),
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        isHeaderSafeKey(value.trim())
          ? undefined
          : vscode.l10n.t("An API key can contain only visible ASCII characters, with no spaces or accents."),
    });
    if (key === undefined) return "cancelled";
    try {
      await this.store(name, key.trim());
    } catch (error) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("Could not save the API key for {0}: {1}", name, String(error)),
      );
      return "failed";
    }
    return key.trim() ? "stored" : "cleared";
  }
}
