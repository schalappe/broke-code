/**
 * @module main
 * Webview entry: posts `ready`, then renders each state snapshot from host. File suggestions go to the composer.
 * L10n bundle applied from `init` before first render (`@vscode/l10n` must be configured before `t()`).
 */
import * as l10n from "@vscode/l10n";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ChatState, HostMessage } from "../core/protocol";
import { App } from "./App";
import { post } from "./vscodeApi";
import "./styles.css";

function Root() {
  const [state, setState] = useState<ChatState>();

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      // [>]: File suggestions go to the composer, which listens for them itself.
      if (message.type === "fileSuggestions") return;
      if (message.type === "init" && message.l10n) l10n.config({ contents: message.l10n });
      setState(message.state);
    };
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return state ? <App state={state} /> : null;
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<Root />);
