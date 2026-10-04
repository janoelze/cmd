// The app's own processes for the Task Manager: Electron's main process, GPU,
// utility processes and each renderer, named after the window or page it draws.

import { app, BrowserWindow, webContents } from "electron";

export interface AppProcess {
  pid: number;
  /** "Browser" (main), "GPU", "Tab" (a renderer), "Utility"… (Electron's ProcessMetric.type). */
  type: string;
  name: string;
  /** Percent of one core since the previous call. */
  cpu: number;
  /** Working set in bytes. */
  memory: number;
}

/** What a renderer draws: an app window (by title), a utility window, or a browser window's page. */
function rendererName(pid: number): string | null {
  const names = webContents
    .getAllWebContents()
    .filter((wc) => !wc.isDestroyed() && wc.getOSProcessId() === pid)
    .map((wc) => {
      const win = BrowserWindow.fromWebContents(wc);
      if (wc.getType() === "webview") {
        const url = wc.getURL();
        return `Page: ${/^https?:/.test(url) ? new URL(url).host : wc.getTitle() || url}`;
      }
      return `Window: ${win?.getTitle() || wc.getTitle() || "cmd"}`;
    });
  return names.length ? [...new Set(names)].join(", ") : null;
}

export function appMetrics(): AppProcess[] {
  return app.getAppMetrics().map((m) => ({
    pid: m.pid,
    type: m.type,
    name:
      m.type === "Browser" ? "App (main process)" : m.type === "Tab" ? (rendererName(m.pid) ?? "Renderer") : m.type === "GPU" ? "GPU" : m.name || m.serviceName || m.type,
    cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10,
    memory: m.memory.workingSetSize * 1024,
  }));
}
