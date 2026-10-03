// Entry point of the Settings window (settings.html): its own small bundle, so
// it doesn't load the app or subscribe to every pane.
import { createRoot } from "react-dom/client";
import "../styles.css";
import "./settings.css";
import { cmd } from "../bridge.ts";
import { installScrollbars } from "../scrollbars.ts";
import "../themes/builtin.ts";
import { bootTheme } from "../themes/registry.ts";
import { SettingsWindow } from "./SettingsWindow.tsx";

bootTheme();
installScrollbars();

// The menu bar sends the edit commands it can't do natively (main/menu.ts); ⌘W closes in main.
cmd.onCommand((id) => {
  if (id === "edit.copy") document.execCommand("copy");
  else if (id === "edit.selectAll") document.execCommand("selectAll");
});

createRoot(document.getElementById("root")!).render(<SettingsWindow />);
