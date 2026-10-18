// Boot timeline marks (boot:*) are read by the boot benchmark; see also main/app.ts and store.ts.
performance.mark("boot:renderer-script");
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "@cmd/ui/ui.css";
import "./styles.css";
import "./windows/builtin.tsx"; // built-in window views (browser, files, text)
import "./shell/commands/index.ts"; // the app's commands
import "./lib/presence.ts"; // focus time stops while cmd is in the background (docs/49)
import { App } from "./shell/App.tsx";
import { TOPBAR_HEIGHT } from "../../shared/chrome.ts";
import { cmd } from "./lib/bridge.ts";
import { installErrorReporting, reportRenderError } from "./lib/errors.ts";
import { installDrops } from "./lib/drops.ts";
import { ErrorBoundary, installScrollbars, installTooltips } from "@cmd/ui";
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
createRoot(document.getElementById("root")!, { onCaughtError: reportRenderError, onUncaughtError: reportRenderError }).render(
  // A window that breaks shows its own fallback (WindowContent); this one is for the rest of the shell.
  <ErrorBoundary text="Your terminals keep running." onReload={() => location.reload()}>
    <App />
  </ErrorBoundary>,
);

// Views that load on first use (editor, Markdown) are fetched once startup is
// done, so opening the first one is still instant.
setTimeout(() => {
  void import("./windows/text/TextView.tsx");
  void import("./windows/markdown/markdown-view.tsx");
  void import("./windows/json/json-view.tsx");
}, 2000);
