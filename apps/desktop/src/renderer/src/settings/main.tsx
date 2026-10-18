// Entry point of the Settings window (settings.html): its own small bundle, so
// it doesn't load the app or subscribe to every pane.
import { createRoot } from "react-dom/client";
import "@cmd/ui/ui.css";
import "../styles.css";
import { cmd } from "../lib/bridge.ts";
import { installErrorReporting, reportRenderError } from "../lib/errors.ts";
import { ErrorBoundary, installScrollbars, installTooltips } from "@cmd/ui";
import "@cmd/ui/themes/builtin";
import { bootTheme } from "@cmd/ui/themes";
import { SettingsWindow } from "./SettingsWindow.tsx";

installErrorReporting();
bootTheme();
installScrollbars({ always: cmd.scrollBars === "always" });
installTooltips();

// The menu bar sends the edit commands it can't do natively (main/menu.ts); ⌘W closes in main.
cmd.onCommand((id) => {
  if (id === "edit.copy") cmd.editNative("copy");
  else if (id === "edit.selectAll") cmd.editNative("selectAll");
});

// macOS draws the traffic lights over the page; elsewhere the platform's frame sits above it.
document.documentElement.classList.add(navigator.platform.startsWith("Mac") ? "platform-mac" : "platform-other");
createRoot(document.getElementById("root")!, { onCaughtError: reportRenderError, onUncaughtError: reportRenderError }).render(
  <ErrorBoundary onReload={() => location.reload()}>
    <SettingsWindow />
  </ErrorBoundary>,
);
