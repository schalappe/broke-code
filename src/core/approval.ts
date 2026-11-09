/**
 * @module approval
 * The approval seam between a tool run and the user: what a tool asks (`ApprovalRequest`), what it gets back
 * (`Decision`), and the rejection text the model reads. The chat controller answers the request (see
 * `ToolContext.requestApproval`); a tool never reads the auto-approve setting itself.
 */

/** What the user sees while deciding, such as a diff editor; closed once the request ends, whatever the decision. */
export type Preview = { close(): PromiseLike<void> };

/**
 * One approval request. `kind`: `write` for a change to a workspace file, which the auto-approve setting may accept
 * without asking; `command` for a command to run, which always waits for the user. `tool`: the tool asking.
 * `summary`: what it acts on, as the chat shows it, such as the path a write changes. `preview`: opens what the user
 * reviews; it is not opened when the request is accepted without asking, and a preview that fails to open fails the
 * request.
 */
export type ApprovalRequest = {
  kind: "write" | "command";
  tool: string;
  summary: string;
  preview?: () => Promise<Preview>;
};

/**
 * The answer to an approval request. `accept`: by the user or the auto-approve setting. `reject`: by the user, with
 * the reason typed, if any. `cancel`: Stop, navigation, or deactivation ended the request; the tool must not act.
 */
export type Decision = { kind: "accept" } | { kind: "reject"; reason?: string } | { kind: "cancel" };

/** The text of a rejected call's `error` result: a fixed first line, then the user's reason on its own line. */
export function rejectionText(reason?: string): string {
  const first = "The user rejected this change.";
  return reason === undefined ? first : `${first}\n${reason}`;
}
