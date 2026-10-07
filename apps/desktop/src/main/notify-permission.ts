// Whether macOS lets cmd show notifications (Settings → Notifications), asking
// it to, and its settings page for cmd. macOS answers for the app that asks, so
// the check runs here in main, through a small addon (native/notifications.m,
// built by postinstall). Without the addon (another OS, a failed build) the
// answer is null and Settings doesn't show the row.

import { shell } from "electron";
import path from "node:path";
import { logger } from "@cmd/protocol/node";

const log = logger("notify-permission");

/** What the addon reports (UNNotificationSettings). */
interface Raw {
  authorization: "notDetermined" | "denied" | "authorized" | "provisional";
  alerts: boolean;
  style: "none" | "banner" | "alert";
  bundleId: string;
}

/**
 * on: banners or alerts show. ask: macOS hasn't asked yet. quiet: allowed, but
 * only into Notification Center (style None, or provisional). off: blocked.
 */
export type NotifyAccess = "on" | "ask" | "quiet" | "off";
export interface NotifyPermission {
  access: NotifyAccess;
  bundleId: string;
}

export function accessOf(r: Pick<Raw, "authorization" | "alerts" | "style">): NotifyAccess {
  if (r.authorization === "notDetermined") return "ask";
  if (r.authorization === "denied") return "off";
  if (r.authorization === "provisional" || !r.alerts || r.style === "none") return "quiet";
  return "on";
}

interface Addon {
  status(cb: (json: string) => void): void;
  request(cb: (json: string) => void): void;
}
let addon: Addon | null | undefined;
function load(repoRoot: string): Addon | null {
  if (addon !== undefined) return addon;
  addon = null;
  if (process.platform !== "darwin") return addon;
  try {
    const m = { exports: {} as Addon };
    process.dlopen(m, path.join(repoRoot, "apps/desktop/native/build/notifications.node"));
    addon = m.exports;
  } catch (err) {
    log.warn("no notifications addon", { error: (err as Error).message });
  }
  return addon;
}

function call(repoRoot: string, fn: "status" | "request"): Promise<NotifyPermission | null> {
  const a = load(repoRoot);
  if (!a) return Promise.resolve(null);
  return new Promise((resolve) => {
    a[fn]((json) => {
      try {
        const r = JSON.parse(json) as Raw;
        if (fn === "request") log.info("asked macOS", r);
        resolve({ access: accessOf(r), bundleId: r.bundleId });
      } catch {
        resolve(null);
      }
    });
  });
}

export const notifyPermission = (repoRoot: string) => call(repoRoot, "status");
/** Shows macOS's "Allow notifications?" prompt if it hasn't been answered, then the status. */
export const requestNotifyPermission = (repoRoot: string) => call(repoRoot, "request");

/** System Settings → Notifications, at cmd's page (macOS 13+; older ones open the Notifications pane). */
export function openNotifySettings(bundleId: string): void {
  void shell.openExternal(`x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${encodeURIComponent(bundleId)}`).catch((err: Error) => {
    log.warn("could not open System Settings at cmd", { bundleId, error: err.message });
    return shell.openExternal("x-apple.systempreferences:com.apple.preference.notifications");
  });
}
