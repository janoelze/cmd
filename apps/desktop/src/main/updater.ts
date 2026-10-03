// Self-update from GitHub releases (electron-updater reads latest-mac.yml from
// the latest non-prerelease). Packaged builds only. The `updates.mode` setting:
// auto downloads in the background and installs when the app quits, notify only
// says a version is out, off never checks. "Check for Updates…" always checks.
// Quitting the app leaves the core and its terminals running; after the update
// the app offers to restart a core started from the old version (index.ts).

import { app, dialog, Notification } from "electron";
import electronUpdater from "electron-updater";
import fs from "node:fs";
import path from "node:path";
import type { Settings } from "@cmd/protocol";
import { cmdHome, connect } from "@cmd/protocol/node";

const { autoUpdater } = electronUpdater;

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 4 * 60 * 60_000;

let mode: Settings["updates.mode"] = "auto";
/** A check the person asked for: answer it with a dialog, whatever the outcome. */
let manual = false;
let busy = false;
/** Version downloaded and waiting to be installed on quit. */
let ready: string | null = null;
/** Version a notification was shown for, so each one is announced once. */
let announced: string | null = null;
let lastCheck: number | null = null;
let lastError: string | null = null;

export interface UpdateStatus {
  mode: Settings["updates.mode"];
  /** Epoch ms of the last finished check. */
  lastCheck: number | null;
  /** Downloaded, installs on quit. */
  ready: string | null;
  lastError: string | null;
}

export const updateStatus = (): UpdateStatus => ({ mode, lastCheck, ready, lastError });

function log(...args: unknown[]): void {
  try {
    fs.appendFileSync(path.join(cmdHome(), "update.log"), `${new Date().toISOString()} ${args.map(String).join(" ")}\n`);
  } catch {}
}

function notify(body: string, onClick: () => void): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: "cmd update", body });
  n.on("click", onClick);
  n.show();
}

function install(): void {
  log("installing", ready);
  // Windows close normally (Spaces are saved); the core keeps running.
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
}

async function askToRestart(version: string): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: "info",
    message: `cmd ${version} is ready`,
    detail: "Restart cmd to finish updating, or it installs the next time you quit. Terminals keep running.",
    buttons: ["Restart Now", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) install();
}

function check(): void {
  if (busy || (!manual && (mode === "off" || ready))) return;
  busy = true;
  // Failures arrive as "error"; null means the updater is inactive (no app-update.yml).
  autoUpdater.checkForUpdates().then(
    (r) => void (r || (busy = manual = false)),
    () => {},
  );
}

/** Menu bar / palette: check now and report the result. */
export function checkForUpdates(): void {
  if (!app.isPackaged) {
    void dialog.showMessageBox({ type: "info", message: "Updates only work in the packaged app" });
    return;
  }
  if (ready) return void askToRestart(ready);
  manual = true;
  check();
}

/** Mirror updates.mode from the core's settings; reconnects like the core connection in spaces.ts. */
function followSettings(socketPath: string): void {
  const attach = async () => {
    try {
      const conn = await connect(socketPath);
      conn.client.onEvent((e) => {
        if (e.type === "settings.updated") mode = e.snapshot.settings["updates.mode"];
      });
      await conn.client.call("events.subscribe", { types: ["settings.updated"] });
      mode = (await conn.client.call("settings.get", {})).settings["updates.mode"];
      conn.closed.then(() => setTimeout(attach, 1000));
    } catch {
      setTimeout(attach, 1000);
    }
  };
  void attach();
}

export function startUpdater(socketPath: string): void {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = false; // decided per mode below
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };

  autoUpdater.on("update-available", (info) => {
    (lastCheck = Date.now()), (lastError = null);
    if (mode === "auto" || manual) {
      void autoUpdater.downloadUpdate().catch(() => {});
      return;
    }
    busy = false;
    if (announced === info.version) return;
    announced = info.version;
    notify(`cmd ${info.version} is available. Click to install it.`, () => {
      manual = true;
      busy = true;
      void autoUpdater.downloadUpdate().catch(() => {});
    });
  });
  autoUpdater.on("update-not-available", () => {
    (lastCheck = Date.now()), (lastError = null);
    busy = false;
    if (manual) void dialog.showMessageBox({ type: "info", message: "cmd is up to date", detail: `Version ${app.getVersion()} is the newest.` });
    manual = false;
  });
  autoUpdater.on("update-downloaded", (info) => {
    busy = false;
    ready = info.version;
    if (manual) void askToRestart(info.version);
    else if (announced !== info.version) {
      announced = info.version;
      notify(`cmd ${info.version} installs when you quit cmd. Click to restart now.`, install);
    }
    manual = false;
  });
  autoUpdater.on("error", (err) => {
    busy = false;
    log("error", err?.message ?? err);
    (lastCheck = Date.now()), (lastError = err?.message ?? String(err));
    if (manual) dialog.showErrorBox("cmd could not update", err?.message ?? String(err));
    manual = false;
  });

  followSettings(socketPath);
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
}
