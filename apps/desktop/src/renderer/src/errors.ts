// Uncaught errors and unhandled rejections in the app's pages go to main, which
// logs them and records a crash report (main/crash.ts). Every page installs it,
// and passes `reportRenderError` to createRoot so render errors (caught by an
// ErrorBoundary or not) arrive with React's component stack.

import { cmd } from "./bridge.ts";

// Benign browser noise, not a bug in cmd.
const IGNORE = /ResizeObserver loop|^Script error\.?$/;

/** Error message and stack as main records them. */
function describe(err: unknown, fallback: string): { message: string; stack: string | null } {
  const e = err instanceof Error ? err : null;
  return { message: e ? `${e.name}: ${e.message}` : String(err ?? fallback), stack: e?.stack ?? null };
}

/**
 * createRoot's onCaughtError and onUncaughtError: a render error, caught by an
 * ErrorBoundary or not, with React's component stack after the error's own.
 */
export function reportRenderError(err: unknown, info: { componentStack?: string }): void {
  const { message, stack } = describe(err, "render error");
  console.error(err);
  cmd.reportError({ kind: "render", message, stack: (stack ?? message) + (info.componentStack ? `\n\nComponent stack:${info.componentStack}` : "") });
}

export function installErrorReporting(): void {
  const report = (kind: string, err: unknown, fallback: string) => {
    const { message, stack } = describe(err, fallback);
    if (IGNORE.test(message)) return;
    cmd.reportError({ kind, message, stack });
  };
  window.addEventListener("error", (ev) => report("error", ev.error, ev.message));
  window.addEventListener("unhandledrejection", (ev) => report("unhandledrejection", ev.reason, "unhandled rejection"));
}
