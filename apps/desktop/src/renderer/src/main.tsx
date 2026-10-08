// Boot timeline marks (boot:*) are read by the boot benchmark; see also main/index.ts and store.ts.
performance.mark("boot:renderer-script");
import { createRoot } from "react-dom/client";
import { Symbol } from "./components/Symbol.tsx";
import "@xterm/xterm/css/xterm.css";
import "@cmd/ui/ui.css";
import "./styles.css";
import "./windows/builtin.tsx"; // built-in window views (browser, files, text)
import { App } from "./App.tsx";
import { TOPBAR_HEIGHT } from "../../shared/chrome.ts";
import { cmd } from "./bridge.ts";
import { installErrorReporting } from "./errors.ts";
import { installDrops } from "./drops.ts";
import { installScrollbars, installTooltips, UIProvider } from "@cmd/ui";
import "@cmd/ui/themes/builtin";
import { bootTheme } from "@cmd/ui/themes";

installErrorReporting();
bootTheme();
installScrollbars({ always: cmd.scrollBars === "always" });
installTooltips();
installDrops();

// macOS draws the traffic lights over the page; elsewhere the platform's frame sits above it.
document.documentElement.classList.add(navigator.platform.startsWith("Mac") ? "platform-mac" : "platform-other");
// macOS: the top bar is as tall as main centres the traffic lights for (shared/chrome.ts).
if (navigator.platform.startsWith("Mac")) document.documentElement.style.setProperty("--topbar-h", `${TOPBAR_HEIGHT}px`);
createRoot(document.getElementById("root")!).render(
  // Kit controls draw their icons as native SF Symbols.
  <UIProvider icon={Symbol}>
    <App />
  </UIProvider>,
);

// Views that load on first use (editor, Markdown) are fetched once startup is
// done, so opening the first one is still instant.
setTimeout(() => {
  void import("./components/TextView.tsx");
  void import("./windows/markdown-view.tsx");
  void import("./windows/json-view.tsx");
}, 2000);
