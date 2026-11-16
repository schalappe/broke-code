/**
 * @module approval
 * The approval seam between a tool run and the user: what a tool asks (`ApprovalRequest`), what it gets back
 * (`Decision`), and the rejection text the model reads. The chat controller answers the request (see
 * `ToolContext.requestApproval`); a tool never reads the mode setting itself. Also the decisions of a write's
 * editor side, which the extension glue feeds with VS Code's tabs, documents, and settings: which change diffs to
 * close, whether an editor holds unsaved changes to the target, and which mode the setting holds.
 */
import type { LineCounts } from "./lineDiff";

/**
 * What the user sees while deciding, such as a diff editor. `show`: brings it back, opened again if the user closed it,
 * while the request is open. `close`: closes it once the request ends, whatever the decision.
 */
export type Preview = { show(): PromiseLike<void>; close(): PromiseLike<void> };

/**
 * One approval request. `kind`: `write` for a change to a workspace file, which Auto-edit and Full access accept
 * without asking; `command` for a command to run, which waits for the user except in Full access. `tool`: the tool asking.
 * `summary`: what it acts on, as the chat shows it, such as the path a write changes. `lines`: the lines a write adds
 * and removes, as "Changed files" counts them. `preview`: opens what the user reviews; it is not opened when the
 * request is accepted without asking, and a preview that fails to open fails the request.
 */
export type ApprovalRequest = {
  kind: "write" | "command";
  tool: string;
  summary: string;
  lines?: LineCounts;
  preview?: () => Promise<Preview>;
};

/**
 * The answer to an approval request. `accept`: by the user or the mode the setting holds; `sandbox`, set only on a command Full
 * access accepted without asking, which must then run in the sandbox. `reject`: by the user, with the reason typed, if
 * any. `deny`: Full access refused a command that starts like `entry` of the denied commands, without asking; never
 * given for a write. `cancel`: Stop, navigation, or deactivation ended the request; the tool must not act.
 */
export type Decision =
  | { kind: "accept"; sandbox?: true }
  | { kind: "reject"; reason?: string }
  | { kind: "deny"; entry: string }
  | { kind: "cancel" };

/**
 * The text of a rejected call's `error` result: a fixed first line naming what was rejected (`subject`: a write's
 * change, or a command), then the user's reason on its own line.
 */
export function rejectionText(reason?: string, subject: "change" | "command" = "change"): string {
  const first = `The user rejected this ${subject}.`;
  return reason === undefined ? first : `${first}\n${reason}`;
}

/** The text of a denied call's `error` result: what matched, that nothing ran, and how the model may go on. */
export function denialText(entry: string): string {
  return `This command matches "${entry}", which the user's denied commands forbid in Full access mode. Nothing ran. Do it another way, or ask the user to run it themselves.`;
}

/** The URI scheme of both sides of a change diff, served from memory by the extension's content provider. */
export const CHANGE_SCHEME = "broke-code-change";

/** A URI as the editor gives it; `toString` is its full form, equal for the same URI. */
export type EditorUri = { readonly scheme: string; toString(): string };

/**
 * Close the change diffs among `tabs`: the one whose proposed side is `proposed` (a preview closing), or every change
 * diff when `proposed` is absent (deactivation). `proposedSide`: a tab's proposed side, `undefined` for a tab that is
 * not a text diff. `close` is called once with the tabs found, and not at all when none is.
 */
export async function closeChangeDiffs<Tab>(
  tabs: readonly Tab[],
  proposedSide: (tab: Tab) => EditorUri | undefined,
  close: (tabs: Tab[]) => PromiseLike<unknown>,
  proposed?: EditorUri,
): Promise<void> {
  const matches =
    proposed === undefined
      ? (uri: EditorUri) => uri.scheme === CHANGE_SCHEME
      : (uri: EditorUri) => uri.toString() === proposed.toString();
  const found = tabs.filter((tab) => {
    const side = proposedSide(tab);
    return side !== undefined && matches(side);
  });
  if (found.length > 0) await close(found);
}

/** A document open in the editor, as VS Code's `TextDocument` gives it. */
export type OpenDocument = {
  readonly isDirty: boolean;
  readonly uri: { readonly scheme: string; readonly fsPath: string };
};

/**
 * Whether one of `documents` holds unsaved changes to the file at `target`, which a write would race. Only dirty
 * documents of scheme `file` count. Paths compare once `resolve`d (symlinks and letter case), which must not reject;
 * no path is resolved when no document is dirty.
 */
export async function hasUnsavedChanges(
  documents: readonly OpenDocument[],
  target: string,
  resolve: (path: string) => Promise<string>,
): Promise<boolean> {
  const dirty = documents.filter((document) => document.isDirty && document.uri.scheme === "file");
  if (dirty.length === 0) return false;
  const file = await resolve(target);
  for (const document of dirty) {
    if ((await resolve(document.uri.fsPath)) === file) return true;
  }
  return false;
}

/** A setting's values by scope, as VS Code's `WorkspaceConfiguration.inspect` gives them. */
export type InspectedSetting = { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown };

/**
 * The values of `brokeCode.mode`: `ask` waits for a click on every write and command, `autoEdit` accepts
 * writes at once, `fullAccess` also runs commands at once, in the sandbox, unless denied.
 */
export const SETTING_MODES = ["ask", "autoEdit", "fullAccess"] as const;
export type SettingMode = (typeof SETTING_MODES)[number];

/**
 * The mode `brokeCode.mode` holds, from what `inspect` gives for it: `ask` unless the user value is
 * another mode. [!]: User settings only, like the providers: a repository must not turn approval off, so only a user
 * (`globalValue`) value counts. The manifest's `application` scope already makes VS Code ignore a workspace value;
 * reading `globalValue` keeps that explicit here.
 */
export function settingMode(inspected: InspectedSetting | undefined): SettingMode {
  const value = inspected?.globalValue;
  return SETTING_MODES.find((mode) => mode === value) ?? "ask";
}
