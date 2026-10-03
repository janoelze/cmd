// Uncaught errors and unhandled rejections in the app's pages go to main, which
// logs them and records a crash report (main/crash.ts). Both pages install it.

import { cmd } from "./bridge.ts";

// Benign browser noise, not a bug in cmd.
const IGNORE = /ResizeObserver loop|^Script error\.?$/;

export function installErrorReporting(): void {
  const report = (kind: string, err: unknown, fallback: string) => {
    const e = err instanceof Error ? err : null;
    const message = e ? `${e.name}: ${e.message}` : String(err ?? fallback);
    if (IGNORE.test(message)) return;
    cmd.reportError({ kind, message, stack: e?.stack ?? null });
  };
  window.addEventListener("error", (ev) => report("error", ev.error, ev.message));
  window.addEventListener("unhandledrejection", (ev) => report("unhandledrejection", ev.reason, "unhandled rejection"));
}
