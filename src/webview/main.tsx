/**
 * @module main
 * Webview entry: renders `Root` into `#root`.
 */
import { createRoot } from "react-dom/client";
import { Root } from "./Root";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<Root language={document.documentElement.lang} />);
