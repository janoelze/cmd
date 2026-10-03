import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./windows/builtin.tsx"; // built-in window views (browser, files, text)
import { App } from "./App.tsx";
import { installScrollbars } from "./scrollbars.ts";

installScrollbars();

createRoot(document.getElementById("root")!).render(<App />);
