// Entry point of the Workbench (workbench.html, dev builds only): one component
// at a time from a *.story.tsx file, in the real app's styles, icons, preload
// and core. `pnpm workbench` opens it (scripts/workbench.mjs).
import { createRoot } from "react-dom/client";
import "@cmd/ui/ui.css";
import "../styles.css";
import "./workbench.css";
import { cmd } from "../lib/bridge.ts";
import { installErrorReporting, reportRenderError } from "../lib/errors.ts";
import { ErrorBoundary, installScrollbars, installTooltips, Toaster } from "@cmd/ui";
import "@cmd/ui/themes/builtin";
import { bootTheme } from "@cmd/ui/themes";
import { Workbench } from "./Workbench.tsx";

installErrorReporting();
bootTheme();

// Read by scripts/workbench.mjs, which waits for an edit to reach the window before a shot:
// when the page last took an update (or loaded), one on its way, and the compile error that stopped one.
const hmr = document.body.dataset;
hmr.hmrAt = String(Math.round(performance.timeOrigin));
import.meta.hot?.on("vite:beforeUpdate", () => (hmr.hmrPending = "1"));
import.meta.hot?.on("vite:afterUpdate", () => (delete hmr.hmrPending, delete hmr.hmrError, (hmr.hmrAt = String(Date.now()))));
import.meta.hot?.on("vite:error", (e: { err: { message: string } }) => (delete hmr.hmrPending, (hmr.hmrError = e.err.message)));
installScrollbars({ always: cmd.scrollBars === "always" });
installTooltips();

document.documentElement.classList.add(navigator.platform.startsWith("Mac") ? "platform-mac" : "platform-other");
// A story that breaks on purpose (the ErrorBoundary's) isn't a crash to report.
const onCaughtError: typeof reportRenderError = (err, info) => void (String(err).includes("on purpose") || reportRenderError(err, info));
createRoot(document.getElementById("root")!, { onCaughtError, onUncaughtError: reportRenderError }).render(
  <>
    <ErrorBoundary onReload={() => location.reload()}>
      <Workbench />
    </ErrorBoundary>
    <Toaster />
  </>,
);
