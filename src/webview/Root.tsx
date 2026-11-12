/**
 * @module Root
 * The panel's root: posts `ready`, then renders each state snapshot from the host. The l10n bundle is applied from
 * `init` before the first render (`@vscode/l10n` must be configured before `t()`). Drafts from the editor's entry
 * points are received here, not in the composer: one may arrive right behind `init`, before the composer is mounted.
 */
import * as l10n from "@vscode/l10n";
import { useCallback, useEffect, useState } from "react";
import { type ChatState, chatStateOf, type DraftInsert, type HostMessage } from "../core/protocol";
import { App } from "./App";
import { post } from "./vscodeApi";

/** `language`: BCP 47 tag of the VS Code display language, for dates. */
export function Root({ language }: { language: string }) {
  const [state, setState] = useState<ChatState>();
  /** Drafts received and not yet applied, in arrival order; each is applied once, then taken. */
  const [drafts, setDrafts] = useState<DraftInsert[]>([]);
  const takeDrafts = useCallback((count: number) => setDrafts((queued) => queued.slice(count)), []);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      if (message.type === "init" && message.l10n) l10n.config({ contents: message.l10n });
      if (message.type === "insertDraft") {
        const { text, mode, picked } = message;
        setDrafts((queued) => [...queued, { text, mode, picked }]);
        return;
      }
      // [>]: File and skill suggestions carry no state; the composer listens for them itself.
      const next = chatStateOf(message);
      if (next) setState(next);
    };
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return state ? <App state={state} language={language} drafts={drafts} takeDrafts={takeDrafts} /> : null;
}
