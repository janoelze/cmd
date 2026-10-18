// Self-update from GitHub releases (electron-updater reads latest-mac.yml from
// the latest non-prerelease). Packaged builds only. The `updates.mode` setting:
// auto downloads in the background and installs when the app quits, notify only
// says a version is out, off never checks. "Check for Updates…" always checks.
// Quitting the app leaves the core and its terminals running; after the update
// the app offers to restart a core started from the old version (app.ts).
//
// A bad release must not spread or stick (update-policy.ts): checks go on after a version
// is downloaded, and a newer one replaces it; Restart Now checks once more first; versions
// on the blocklist are never downloaded; and a version whose app can't load at all still
// looks for its fix (rescue, from index.ts).
//
// On macOS a download is two steps: electron-updater fetches the zip ("update-downloaded"),
// then Squirrel.Mac prepares it from a local proxy (Electron's own autoUpdater fires
// "update-downloaded"), and only then does it install on quit. `ready` is the second.

import { app, autoUpdater as squirrel, dialog, Notification, powerMonitor } from "electron";
import electronUpdater, { type UpdateInfo } from "electron-updater";
import type { Settings } from "@cmd/protocol";
import { connect, formatLine, formatValue, LogFile } from "@cmd/protocol/node";
import { BLOCKLIST_URL, onFound, parseBlocklist } from "./update-policy.ts";

const { autoUpdater } = electronUpdater;

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 15 * 60_000;
/** After waking from sleep: the network may need a moment. */
const RESUME_CHECK_MS = 10_000;
/** How long Restart Now waits on its last check before restarting into what it has. */
const RESTART_CHECK_MS = 8_000;

let mode: Settings["updates.mode"] = "auto";
/** A check the person asked for: answer it with a dialog, whatever the outcome. */
let manual = false;
let busy = false;
/** Version downloaded and prepared: installs on quit. */
let ready: string | null = null;
/** Version downloaded, which macOS is still preparing (it becomes `ready`). */
let staging: string | null = null;
/** Version a notification was shown for, so each one is announced once. */
let announced: string | null = null;
let lastCheck: number | null = null;
let lastError: string | null = null;
/** Version found but not downloaded (notify mode). */
let available: string | null = null;
let downloading: { version: string; percent: number } | null = null;
/** Restart Now was chosen: restart once its last check (and any newer download) settles. */
let restarting = false;
/** Pulled versions and why (update-policy.ts), as of the last check. */
let blocked = new Map<string, string>();

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

/** Restart Now: one more check first, so a newer release (the fix for this one) wins. */
function install(): void {
  if (restarting) return;
  restarting = true;
  log("restart asked; checking once more first", ready);
  check(true);
  setTimeout(() => {
    if (restarting && !downloading && !staging) restartNow();
  }, RESTART_CHECK_MS);
}

/** The last check before a restart came back: restart, unless a newer version is on its way. */
function settled(): void {
  if (restarting && ready && !downloading && !staging) restartNow();
}

function restartNow(): void {
  if (!ready) return void (restarting = false);
  restarting = false;
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

/** The blocklist as of now; on failure, the last one read (a check never waits on it for long). */
async function readBlocklist(): Promise<void> {
  try {
    const res = await fetch(BLOCKLIST_URL, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (res.ok) blocked = parseBlocklist(await res.text());
  } catch (err) {
    log("blocklist unavailable", (err as Error)?.message ?? err);
  }
}

/** `force`: whatever the mode (Restart Now's last check). */
function check(force = false): void {
  if (busy || (!manual && !force && mode === "off")) return;
  busy = true;
  void readBlocklist().then(() =>
    // Failures arrive as "error"; null means the updater is inactive (no app-update.yml).
    autoUpdater.checkForUpdates().then(
      (r) => void (r || ((busy = manual = false), settled())),
      () => {},
    ),
  );
}

/** Menu bar / palette: check now and report the result. */
export function checkForUpdates(devBuild: boolean): void {
  if (devBuild) {
    void dialog.showMessageBox({ type: "info", message: "Development builds don't update themselves", detail: "Install a release for updates." });
    return;
  }
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

/** Versions on the blocklist aren't updates; electron-updater's own test (the macOS version) still applies. */
function skipBlocked(): void {
  const builtin = autoUpdater.isUpdateSupported;
  autoUpdater.isUpdateSupported = async (info: UpdateInfo) => {
    const why = blocked.get(info.version);
    if (why === undefined) return builtin(info);
    log("skipping", info.version, "(blocked)", why);
    return false;
  };
}

/** The download is prepared and installs on quit. */
function prepared(version: string): void {
  (staging = null), (downloading = null);
  ready = version;
  log("ready", version);
  if (restarting) return settled();
  if (manual) void askToRestart(version);
  else if (announced !== version) {
    announced = version;
    notify(`cmd ${version} installs when you quit cmd. Click to restart now.`, install);
  }
  manual = false;
}

export function startUpdater(socketPath: string): void {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = false; // decided per mode below
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  skipBlocked();

  autoUpdater.on("update-available", (info) => {
    (lastCheck = Date.now()), (lastError = null);
    if (onFound(info.version, downloading?.version ?? staging ?? ready) === "keep") {
      // What there is is the newest: a download under way, or one waiting for a restart.
      busy = false;
      if (manual && ready && !downloading && !staging) void askToRestart(ready);
      manual = false;
      return settled();
    }
    if (ready) log("newer than the downloaded", ready, ":", info.version);
    if (mode === "auto" || manual || restarting) return download(info.version);
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
    if (manual) {
      if (ready) void askToRestart(ready);
      else void dialog.showMessageBox({ type: "info", message: "cmd is up to date", detail: `Version ${app.getVersion()} is the newest.` });
    }
    manual = false;
    settled();
  });
  autoUpdater.on("update-downloaded", (info) => {
    busy = false;
    available = null;
    if (downloading) downloading.percent = 100;
    // macOS prepares it next (squirrel's own event below); elsewhere it is ready now.
    if (process.platform === "darwin") staging = info.version;
    else prepared(info.version);
  });
  if (process.platform === "darwin")
    squirrel.on("update-downloaded", () => {
      if (staging) prepared(staging);
    });
  autoUpdater.on("error", (err) => {
    busy = false;
    (downloading = null), (staging = null);
    log("error", err?.message ?? err);
    (lastCheck = Date.now()), (lastError = err?.message ?? String(err));
    if (manual) dialog.showErrorBox("cmd could not update", err?.message ?? String(err));
    manual = false;
    // Offline is no reason not to restart into what is already downloaded.
    settled();
  });

  followSettings(socketPath);
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
  powerMonitor.on("resume", () => setTimeout(check, RESUME_CHECK_MS));
}

/**
 * The app didn't load (index.ts), so nothing else runs: no window, no core connection, no
 * settings. Look for a newer version, which is likely its fix, and install it, whatever
 * `updates.mode` says; otherwise say what happened and where to get cmd.
 */
export async function rescue(err: unknown): Promise<void> {
  const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
  await app.whenReady();
  const giveUp = (detail: string) => {
    dialog.showErrorBox("cmd couldn't start", `${detail}\n\n${error}`);
    app.exit(1);
  };
  if (!app.isPackaged) return giveUp("The app failed to load.");
  log("the app failed to load; looking for a fix", error);
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  await readBlocklist();
  skipBlocked();
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result?.isUpdateAvailable) return giveUp("No newer version is out yet. Download the latest cmd from github.com/janoelze/cmd/releases.");
    const version = result.updateInfo.version;
    notify(`cmd couldn't start. Installing ${version}, which may fix it…`, () => {});
    const prepared = process.platform === "darwin" ? new Promise((resolve) => squirrel.once("update-downloaded", resolve)) : Promise.resolve();
    await autoUpdater.downloadUpdate();
    await prepared;
    log("rescue: installing", version);
    autoUpdater.quitAndInstall(false, true);
  } catch (e) {
    giveUp(`Looking for a fixed version failed (${(e as Error)?.message ?? e}). Download the latest cmd from github.com/janoelze/cmd/releases.`);
  }
}
