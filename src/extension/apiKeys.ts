/**
 * @module apiKeys
 * Provider API keys in `SecretStorage`, keyed by provider name. Never in settings.
 * Stored empty string = explicit "no key": no prompt, no `Authorization` header.
 */
import * as vscode from "vscode";
import type { Provider } from "../core/providers";

const SECRET_PREFIX = "brokeCode.apiKey.";

export class ApiKeys {
  /** Names with prompt queued or open: avoids double prompt when settings change mid-prompt. */
  private readonly prompting = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /**
   * @returns Stored key; `""` = explicit no key; `undefined` = never set or unreadable.
   * Never rejects: read failure (e.g. keychain locked) shown as error, request goes without key.
   */
  async get(provider: string): Promise<string | undefined> {
    try {
      return await this.secrets.get(SECRET_PREFIX + provider);
    } catch (error) {
      void vscode.window.showErrorMessage(vscode.l10n.t("Could not read the API key for {0}: {1}", provider, String(error)));
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
  promptMissing(providers: Provider[]): void {
    for (const { name } of providers) {
      if (this.prompting.has(name)) continue;
      this.prompting.add(name);
      this.queue = this.queue
        .then(async () => {
          if ((await this.get(name)) !== undefined) return;
          const key = await vscode.window.showInputBox({
            title: vscode.l10n.t("API key for {0}", name),
            prompt: vscode.l10n.t("broke-code sends this key to {0} as a bearer token.", name),
            placeHolder: vscode.l10n.t("Leave empty for a provider that needs no key, such as Ollama"),
            password: true,
            ignoreFocusOut: true,
          });
          if (key !== undefined) await this.secrets.store(SECRET_PREFIX + name, key.trim());
        })
        .catch((error: unknown) => {
          void vscode.window.showErrorMessage(vscode.l10n.t("Could not save the API key for {0}: {1}", name, String(error)));
        })
        .finally(() => this.prompting.delete(name));
    }
  }

  /**
   * `broke-code: Set API key`: pick provider (unless given), then set, replace, or clear its key.
   * @param providers - Valid providers from settings.
   * @param preselected - Provider name passed by chat panel action.
   */
  async runSetCommand(providers: Provider[], preselected?: string): Promise<void> {
    if (providers.length === 0) {
      const open = vscode.l10n.t("Open settings");
      const choice = await vscode.window.showWarningMessage(vscode.l10n.t("No provider is configured."), open);
      if (choice === open) await vscode.commands.executeCommand("workbench.action.openSettings", "brokeCode.providers");
      return;
    }
    const name =
      providers.find((provider) => provider.name === preselected)?.name ??
      (await vscode.window.showQuickPick(
        providers.map((provider) => ({ label: provider.name, description: provider.baseUrl })),
        { title: vscode.l10n.t("Set API key"), placeHolder: vscode.l10n.t("Choose a provider") },
      ))?.label;
    if (!name) return;

    const key = await vscode.window.showInputBox({
      title: vscode.l10n.t("API key for {0}", name),
      prompt: vscode.l10n.t("Enter a new key to set or replace it. Leave empty to clear it."),
      placeHolder: vscode.l10n.t("Leave empty for a provider that needs no key, such as Ollama"),
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) return;
    await this.secrets.store(SECRET_PREFIX + name, key.trim());
    void vscode.window.showInformationMessage(
      key.trim() ? vscode.l10n.t("API key for {0} saved.", name) : vscode.l10n.t("API key for {0} cleared.", name),
    );
  }
}
