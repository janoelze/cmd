// Entry point of the Task Manager window (tasks.html): its own small bundle,
// like the Settings window's.
import { createRoot } from "react-dom/client";
import { Symbol } from "../components/Symbol.tsx";
import "@cmd/ui/ui.css";
import "../styles.css";
import "./tasks.css";
import { cmd } from "../bridge.ts";
import { installErrorReporting } from "../errors.ts";
import { installScrollbars, installTooltips, UIProvider } from "@cmd/ui";
import "@cmd/ui/themes/builtin";
import { bootTheme } from "@cmd/ui/themes";
import { TaskManager } from "./TaskManager.tsx";

installErrorReporting();
bootTheme();
installScrollbars({ always: cmd.scrollBars === "always" });
installTooltips();

// The menu bar sends the edit commands it can't do natively (main/menu.ts); ⌘W closes in main.
cmd.onCommand((id) => {
  if (id === "edit.copy") cmd.editNative("copy");
  else if (id === "edit.selectAll") cmd.editNative("selectAll");
});

document.documentElement.classList.add(navigator.platform.startsWith("Mac") ? "platform-mac" : "platform-other");
createRoot(document.getElementById("root")!).render(
  // Kit controls draw their icons as native SF Symbols.
  <UIProvider icon={Symbol}>
    <TaskManager />
  </UIProvider>,
);
