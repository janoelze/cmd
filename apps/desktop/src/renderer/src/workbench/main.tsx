// Entry point of the Workbench (workbench.html, dev builds only): one component
// at a time from a *.story.tsx file, in the real app's styles, icons, preload
// and core. `pnpm workbench` opens it (scripts/workbench.mjs).
import { createRoot } from "react-dom/client";
import { Symbol } from "../components/Symbol.tsx";
import "@cmd/ui/ui.css";
import "../styles.css";
import "./workbench.css";
import { cmd } from "../bridge.ts";
import { installErrorReporting, reportRenderError } from "../errors.ts";
import { ErrorBoundary, installScrollbars, installTooltips, Toaster, UIProvider } from "@cmd/ui";
import "@cmd/ui/themes/builtin";
import { bootTheme } from "@cmd/ui/themes";
import { Workbench } from "./Workbench.tsx";

installErrorReporting();
bootTheme();
installScrollbars({ always: cmd.scrollBars === "always" });
installTooltips();

document.documentElement.classList.add(navigator.platform.startsWith("Mac") ? "platform-mac" : "platform-other");
createRoot(document.getElementById("root")!, { onCaughtError: reportRenderError, onUncaughtError: reportRenderError }).render(
  <UIProvider icon={Symbol}>
    <ErrorBoundary onReload={() => location.reload()}>
      <Workbench />
    </ErrorBoundary>
    <Toaster />
  </UIProvider>,
);
