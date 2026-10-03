// Boot timeline marks (boot:*) are read by the boot benchmark; see also main/index.ts and store.ts.
performance.mark("boot:renderer-script");
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./windows/builtin.tsx"; // built-in window views (browser, files, text)
import { App } from "./App.tsx";
import { installScrollbars } from "./scrollbars.ts";
import "./themes/builtin.ts";
import { bootTheme } from "./themes/registry.ts";

bootTheme();
installScrollbars();

createRoot(document.getElementById("root")!).render(<App />);

// Views that load on first use (editor, Markdown) are fetched once startup is
// done, so opening the first one is still instant.
setTimeout(() => {
  void import("./components/TextView.tsx");
  void import("./windows/markdown-view.tsx");
}, 2000);
