/**
 * @module quickFix
 * The quick fix "Fix with broke-code": which diagnostics it is offered on, and the draft it puts in the message box.
 * The host's code action provider and its command both go through `fixDraft`, so the rule holds for every caller.
 */
import { type Diagnostic, oneLine, workspacePath } from "./problems";
import type { DraftInsert } from "./protocol";
import { pickedPath } from "./reservedMentions";
import type { WorkspaceRoot } from "./workspaceFiles";

const SEVERITIES: readonly Diagnostic["severity"][] = ["error", "warning", "information", "hint"];

/**
 * The draft that asks the model to fix `diagnostic`: `Fix this problem in @<path> at line <n>: <message>`, filled in
 * the box or appended to its draft, the path picked, so one with spaces or trailing punctuation is one mention. The
 * path is as the file index writes it, `./<name>` for a file named like a reserved mention; the line is 1-based; the
 * message is on one line, as `@problems` writes it. `undefined`, so no action, for information and hints, and for a
 * document that is not a `file` inside `roots`.
 */
export function fixDraft(roots: readonly WorkspaceRoot[], diagnostic: Diagnostic): DraftInsert | undefined {
  if (diagnostic.severity !== "error" && diagnostic.severity !== "warning") return undefined;
  const inside = diagnostic.scheme === "file" ? workspacePath(roots, diagnostic.path) : undefined;
  if (inside === undefined) return undefined;
  const path = pickedPath(inside);
  return {
    text: `Fix this problem in @${path} at line ${diagnostic.line + 1}: ${oneLine(diagnostic.message)}`,
    mode: "fillOrAppend",
    picked: [path],
  };
}

/**
 * The `Diagnostic` record a command argument holds, its known fields only; `undefined` for any other shape. The
 * quick fix's command is public: any extension can run it with any argument.
 */
export function parseDiagnostic(raw: unknown): Diagnostic | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { scheme, path, line, character, severity, message, source } = raw as Record<string, unknown>;
  if (typeof scheme !== "string" || typeof path !== "string" || typeof message !== "string") return undefined;
  if (!isPosition(line) || !isPosition(character)) return undefined;
  const known = SEVERITIES.find((name) => name === severity);
  if (known === undefined || (source !== undefined && typeof source !== "string")) return undefined;
  const diagnostic = { scheme, path, line, character, severity: known, message };
  return source === undefined ? diagnostic : { ...diagnostic, source };
}

function isPosition(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
