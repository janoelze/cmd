// Self-update from GitHub releases (electron-updater reads latest-mac.yml from
// the latest non-prerelease). Packaged builds only. The `updates.mode` setting:
// auto downloads in the background and installs when the app quits, notify only
// says a version is out, off never checks. "Check for Updates…" always checks.
// Quitting the app leaves the core and its terminals running; after the update
// the app offers to restart a core started from the old version (index.ts).

import { app, dialog, Notification } from "electron";
import electronUpdater from "electron-updater";
import type { Settings } from "@cmd/protocol";
import { connect, formatLine, formatValue, LogFile } from "@cmd/protocol/node";

const { autoUpdater } = electronUpdater;

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 30 * 60_000;

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
/** Version found but not downloaded (notify mode). */
let available: string | null = null;
let downloading: { version: string; percent: number } | null = null;

export interface UpdateStatus {
  mode: Settings["updates.mode"];
  /** A check is running. */
  checking: boolean;
  /** Found but not downloaded (notify mode). */
  available: string | null;
  /** Download in progress; percent reaches 100 before macOS finishes preparing it. */
  downloading: { version: string; percent: number } | null;
  /** Epoch ms of the last finished check. */
  lastCheck: number | null;
  /** Downloaded, installs on quit. */
  ready: string | null;
  lastError: string | null;
}

export const updateStatus = (): UpdateStatus => ({
  mode,
  checking: busy && !downloading,
  available,
  downloading,
  lastCheck,
  ready,
  lastError,
});

/** logDir()/update.log, electron-updater's own messages included. */
let updateLog: LogFile | null = null;
function log(...args: unknown[]): void {
  (updateLog ??= new LogFile("update")).write(formatLine("info", "update", args.map(formatValue).join(" "), []));
}

function notify(body: string, onClick: () => void): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: "cmd update", body });
  n.on("click", onClick);
  n.show();
}

function download(version: string): void {
  downloading = { version, percent: 0 };
  void autoUpdater.downloadUpdate().catch(() => {});
}

/** Restart into the downloaded version. */
export function installUpdate(): void {
  if (ready) install();
}

function install(): void {
  log("installing", ready);
  // Windows close before before-quit; workspaces.ts saves them on before-quit-for-update. The core keeps running.
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
export function checkForUpdates(devBuild: boolean): void {
  if (devBuild) {
    void dialog.showMessageBox({ type: "info", message: "Development builds don't update themselves", detail: "Install a release for updates." });
    return;
  }
  if (ready) return void askToRestart(ready);
  manual = true;
  check();
}

/** Mirror updates.mode from the core's settings; reconnects like the core connection in workspaces.ts. */
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
    if (mode === "auto" || manual) return download(info.version);
    busy = false;
    available = info.version;
    if (announced === info.version) return;
    announced = info.version;
    notify(`cmd ${info.version} is available. Click to install it.`, () => {
      manual = true;
      busy = true;
      download(info.version);
    });
  });
  autoUpdater.on("download-progress", (p) => {
    if (downloading) downloading.percent = Math.min(100, p.percent);
  });
  autoUpdater.on("update-not-available", () => {
    (lastCheck = Date.now()), (lastError = null);
    busy = false;
    available = null;
    if (manual) void dialog.showMessageBox({ type: "info", message: "cmd is up to date", detail: `Version ${app.getVersion()} is the newest.` });
    manual = false;
  });
  autoUpdater.on("update-downloaded", (info) => {
    busy = false;
    (downloading = null), (available = null);
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
    downloading = null;
    log("error", err?.message ?? err);
    (lastCheck = Date.now()), (lastError = err?.message ?? String(err));
    if (manual) dialog.showErrorBox("cmd could not update", err?.message ?? String(err));
    manual = false;
  });

  followSettings(socketPath);
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
}
