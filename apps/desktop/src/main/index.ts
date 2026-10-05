// Electron main: makes sure a core is running, then opens the window.
// The core is a separate, detached process so terminals survive UI reloads and restarts.

// Boot timeline marks (boot:*), read by the boot benchmark; the renderer adds its own.
performance.mark("boot:main-script");
import "./background.ts";
import { servePreviews } from "./preview.ts";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, net as electronNet, Notification, protocol, session, shell, webContents, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { SETTINGS_TEMPLATE, SYSTEM_SOUNDS, mediaOrigin, widgetCsp } from "@cmd/protocol";
import { cmdHome, connect, coreSocketPath, enterInstance, initLog, isOwnCore, installCrashHandlers, ipcPath, logDir, logger, sourceBuildId } from "@cmd/protocol/node";
import type { ContextItem, MenuState } from "../shared/commands.ts";
import { applyMenuState, buildMenu, commandSender } from "./menu.ts";
import { lucideSymbol, type SymbolImage } from "@cmd/ui/lucide";
import { appMetrics } from "./metrics.ts";
import { savedAppearance, setAppearance, type Appearance } from "./appearance.ts";
import { setDockIcon, startDockIcon } from "./dock-icon.ts";
import { SpaceWindows, type Bounds } from "./spaces.ts";
import { crashStatus, followCrashReports, record as recordCrash, startCrashReporting } from "./crash.ts";
import { feedbackStatus, sendFeedback, startFeedback, type FeedbackRequest } from "./feedback.ts";
import { claimWhatsNew } from "./whats-new.ts";
import { claimOnboarding, recordOnboarding } from "./onboarding.ts";
import { ensureKeybindingsFile, loadKeybindings, resetKeybindings, watchKeybindings, writeKeybinding, type KeybindingsSnapshot } from "./keybindings.ts";

// Loaded after launch: the updater isn't needed to show the first window.
const updater = () => import("./updater.ts");
/** Configures the updater once (packaged builds); deferred at launch, or first when asked to check. */
let updaterStarted: Promise<void> | null = null;
const startUpdater = () => (updaterStarted ??= devBuild ? Promise.resolve() : updater().then((u) => u.startUpdater(socketPath)));
const checkForUpdates = () => void startUpdater().then(() => updater()).then((u) => u.checkForUpdates(devBuild));

/**
 * Development builds (pnpm dev, and pnpm dist, which packages as "cmd dev") sit
 * next to the installed app: a red icon, their own name, and their own core,
 * state and logs (the "dev" instance, see protocol/instance.ts), so they never
 * attach to (and offer to restart) the core your real terminals run in, even
 * when started from one of them. Settings and keybindings stay shared. $CMD_HOME
 * relocates either instance.
 */
const devBuild = !app.isPackaged || app.getName() === "cmd dev";
/** Signs usage stats batches (core/usage.ts); baked in at build time, release builds only. */
declare const __USAGE_KEY__: string;
const USAGE_KEY = typeof __USAGE_KEY__ === "string" && !devBuild ? __USAGE_KEY__ : "";
if (devBuild) app.setName("cmd dev");
enterInstance(devBuild ? "dev" : "release");

// Logs: main.log, renderer.log and (from the core) core.log in logDir(), see
// protocol/log.ts. The core learns the app's version from this and its instance
// from $CMD_INSTANCE.
process.env.CMD_APP_VERSION = app.getVersion();
initLog("main", { level: devBuild ? "debug" : "info" });
const log = logger("main");
const rendererLog = logger("renderer");
installCrashHandlers("main", { exitOnException: false, context: () => crashContext() });
startCrashReporting({ devBuild, context: () => crashContext() });
startFeedback(devBuild);
log.info(`${app.getName()} ${app.getVersion()} starting`, { pid: process.pid, electron: process.versions.electron, platform: `${process.platform} ${os.release()} ${process.arch}`, home: cmdHome() });

let keybindings: KeybindingsSnapshot = loadKeybindings();
// While the Settings window records a shortcut the menu has none, so the keys
// reach it instead of running commands.
let recordingShortcut = false;
let refreshMenu = (): void => {};

if (process.env.CMD_NO_SANDBOX) app.commandLine.appendSwitch("no-sandbox");
// Tests: render as on a Retina display regardless of the actual screen.
if (process.env.CMD_FORCE_SCALE) app.commandLine.appendSwitch("force-device-scale-factor", process.env.CMD_FORCE_SCALE);

// cmd-file://local/?path=<abs path> — read-only access to local images/media for the app's own
// pages (Markdown windows show relative images). Registered on the default
// session only; browser windows use their own session and can't reach it.
// cmd-widget://frame/ — the page every Magic widget runs in (docs/12-magic-widgets.md):
// the kit and the `cmd` runtime, under a CSP header that allows only inline code
// and no network. The renderer posts the widget, theme and data into it. Frames
// are sandboxed (no allow-same-origin), so each is an opaque origin.
// cmd-widget://frame/<token> — the same page whose CSP also lets media (audio,
// video, images) load from origins the person allowed for that window. Tokens
// come from the renderer's "widget-frame" call and can't be guessed, so a widget
// can't navigate itself to a page with a looser CSP.
protocol.registerSchemesAsPrivileged([
  { scheme: "cmd-file", privileges: { secure: true, supportFetchAPI: true, stream: true } },
  { scheme: "cmd-widget", privileges: { standard: true, secure: true } },
]);
const CMD_FILE_TYPES = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|mp4|webm|mov|mp3|m4a|wav)$/i;

const here = import.meta.dirname; // apps/desktop/out/main
// Packaged builds ship the core's source tree in Resources/runtime (see
// scripts/stage-runtime.mjs) and run it with Electron's own Node.
const repoRoot = app.isPackaged ? path.join(process.resourcesPath, "runtime") : path.resolve(here, "../../../..");
const socketPath = coreSocketPath();
/** What crash reports from the app say about it (the core adds its own build). */
let appBuild = "";
function crashContext(): Record<string, string> {
  try {
    appBuild ||= sourceBuildId(repoRoot);
  } catch {}
  return { build: appBuild };
}
// Chromium's profile (browser-window cookies, caches) lives in the state dir, so
// $CMD_HOME isolates it too. By default it would be Application Support/<app name>,
// which for "cmd" is the core's own state dir. Dev builds used to be named
// "@cmd/desktop": move that profile over once (as before dev builds had their own state).
const uiData = path.join(cmdHome(), "ui");
const legacyUiData = path.join(app.getPath("appData"), "@cmd", "desktop");
if (!process.env.CMD_HOME && !devBuild && !fs.existsSync(uiData) && fs.existsSync(legacyUiData)) {
  try {
    fs.mkdirSync(cmdHome(), { recursive: true });
    fs.renameSync(legacyUiData, uiData);
  } catch {}
}
// Before Electron creates it: an existing dir means an existing user (whats-new.ts, onboarding.ts).
const hadUiData = fs.existsSync(uiData);
app.setPath("userData", uiData);

// Packaged builds carry their icon in the bundle (.icns / .ico); dev runs use the PNG.
const devIcon = app.isPackaged ? undefined : path.join(here, "../../build/dev/icon.png");
// The themed Dock icons (dock-icon.ts); dev builds keep their red one.
const dockIcons = app.isPackaged ? path.join(process.resourcesPath, "dock-icons") : path.join(here, "../../build/themes");

function canConnect(): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.createConnection(ipcPath(socketPath));
    c.once("connect", () => (c.destroy(), resolve(true)));
    c.once("error", () => resolve(false));
  });
}

/**
 * Whether the core that answered is this instance's. Only ours may be stopped:
 * a socket shared by mistake must never let a dev build restart the installed
 * app's core.
 */
function ownCore(hello: { pid: number; stateDir?: string }): boolean {
  if (isOwnCore(hello)) return true;
  log.error(`core ${hello.pid} on ${socketPath} belongs to ${hello.stateDir ?? "another instance"}, not ${cmdHome()}; leaving it alone`);
  return false;
}

/**
 * A core outlives the app on purpose, so after pulling or editing core code (or
 * an update) an old core may still be serving. Restart it: its terminals keep
 * running in the PTY host, and the new core takes them over.
 */
async function checkCoreBuild(): Promise<void> {
  const conn = await connect(socketPath);
  try {
    const hello = await conn.client.call("core.hello", {});
    if (!ownCore(hello)) return;
    const current = sourceBuildId(repoRoot);
    if (hello.build === current) return;
    log.info(`core ${hello.pid} runs build ${hello.build}, this app ships ${current}: restarting it`);
    conn.close(); // the core closes only once its clients are gone
    await stopCore(hello.pid);
  } catch {
    // An unresponsive or very old core: leave it, the UI shows the error.
  } finally {
    conn.close();
  }
}

/**
 * Packaged: the core runs from a copy of the bundle's runtime, one per build in
 * $CMD_HOME/runtime. An update replaces the bundle while the old core keeps
 * running; from its own copy it never loads the new version's files (search
 * worker, shell integration). The newest few copies are kept, and the one the
 * PTY host runs from (it can outlive many cores, and starts every new shell).
 */
function coreRoot(): string {
  if (!app.isPackaged) return repoRoot;
  const base = path.join(cmdHome(), "runtime");
  const dir = path.join(base, sourceBuildId(repoRoot));
  try {
    if (!fs.existsSync(dir)) {
      const tmp = `${dir}.tmp-${process.pid}`;
      fs.cpSync(repoRoot, tmp, { recursive: true, verbatimSymlinks: true });
      fs.renameSync(tmp, dir);
    }
    const now = new Date();
    fs.utimesSync(dir, now, now);
    const hostRoot = ptyHostRoot();
    const old = fs
      .readdirSync(base)
      .map((name) => ({ name, mtime: fs.statSync(path.join(base, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(3)
      .filter((o) => path.join(base, o.name) !== hostRoot);
    for (const o of old) fs.rmSync(path.join(base, o.name), { recursive: true, force: true });
    return dir;
  } catch {
    return repoRoot;
  }
}

/** The code folder of the running PTY host (written by packages/core/src/terminals/host-main.ts). */
function ptyHostRoot(): string | null {
  try {
    process.kill(Number(fs.readFileSync(path.join(cmdHome(), "ptyhost.pid"), "utf8")), 0);
    return fs.readFileSync(path.join(cmdHome(), "ptyhost.root"), "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Run an edit command natively: in the focused <webview> guest (a browser
 * window's page, its own WebContents) when the page names one, else in the
 * page's focused frame (inputs, text windows, Magic widgets' iframes).
 * document.execCommand in the app's page reaches neither guests nor iframes.
 */
function editNative(sender: WebContents, op: string, guestId?: number): void {
  const guest = guestId ? webContents.fromId(guestId) : undefined;
  const wc = guest?.hostWebContents === sender ? guest : sender;
  if (op === "copy") wc.copy();
  else if (op === "selectAll") wc.selectAll();
}

/** One app launch for usage stats (the core counts and sends them, core/usage.ts). */
async function countLaunch(): Promise<void> {
  const conn = await connect(socketPath).catch(() => null);
  if (!conn) return;
  try {
    await conn.client.call("usage.launch", {});
  } catch (err) {
    log.debug("usage.launch failed", err);
  } finally {
    conn.close();
  }
}

/**
 * Stop a core and wait until it has exited, not only stopped answering: until
 * then it still has the database open and the PTY host, and a core started
 * next to it would fight it over both. One that won't exit is killed.
 */
async function stopCore(pid: number): Promise<void> {
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const exited = async (ms: number) => {
    for (const until = Date.now() + ms; Date.now() < until; ) {
      if (!alive()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return !alive();
  };
  process.kill(pid, "SIGTERM");
  if (await exited(10_000)) return;
  log.warn(`core ${pid} did not exit in 10 s: killing it`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  await exited(2000);
}

/** Settings → About, the sidebar's core status, Restart Core: stop the core and start one from this app's code (it takes the terminals over). */
async function restartCore(): Promise<void> {
  const conn = await connect(socketPath).catch(() => null);
  if (conn) {
    try {
      const hello = await conn.client.call("core.hello", {});
      if (!ownCore(hello)) throw new Error(`the core on ${socketPath} is not this app's (its state is in ${hello.stateDir ?? "an unknown place"}); stop it yourself`);
      conn.close(); // the core closes only once its clients are gone
      await stopCore(hello.pid);
    } finally {
      conn.close();
    }
  }
  spawnCore();
  for (const until = Date.now() + 5000; Date.now() < until; ) {
    if (await canConnect()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`core did not start; see ${coreLog()}`);
}

const coreLog = () => path.join(logDir(), "core.log");
/** The core's stdout and stderr: what bypasses its logger, e.g. Node's fatal errors. */
const coreOutput = () => path.join(logDir(), "core.out.log");

/** The last `n` lines of a log file. */
function tailOf(file: string, n: number): string[] {
  try {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, 64 * 1024));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    return buf.toString("utf8").split("\n").filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

function spawnCore(): void {
  fs.mkdirSync(cmdHome(), { recursive: true });
  fs.mkdirSync(logDir(), { recursive: true });
  // Only this file is appended to by the child itself, so it isn't rotated: start over when large.
  const out = coreOutput();
  try {
    if (fs.statSync(out).size > 5 * 1024 * 1024) fs.rmSync(out);
  } catch {}
  const fd = fs.openSync(out, "a");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (USAGE_KEY) env.CMD_USAGE_KEY = USAGE_KEY;
  let node = "node";
  if (app.isPackaged) (node = process.execPath), (env.ELECTRON_RUN_AS_NODE = "1");
  // --instance also tells cores apart in `ps` (scripts/stop-core.mjs --all).
  const child = spawn(node, ["--no-warnings", path.join(coreRoot(), "packages/core/src/main.ts"), `--instance=${devBuild ? "dev" : "release"}`], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env,
  });
  fs.closeSync(fd);
  log.info(`started a core, pid ${child.pid}`);
  // While this app runs, a core that dies without reporting it (killed by a
  // signal, a native crash, Node's own fatal errors) is reported from here.
  // 70: the core's crash handler has recorded it already. SIGTERM/SIGINT: stopped on purpose.
  child.on("exit", (code, signal) => {
    log.info(`core ${child.pid} exited`, { code, signal });
    const stopped = signal === "SIGTERM" || signal === "SIGINT" || signal === "SIGHUP" || code === 0 || code === 70;
    const output = tailOf(out, 40);
    if (stopped || output.some((l) => l.includes("already running"))) return;
    recordCrash("core", "exit", signal ? `Core killed by ${signal}` : `Core exited with code ${code}`, output.join("\n") || null, {}, tailOf(coreLog(), 80));
  });
  child.unref();
}

/** A core process is alive for this state dir (sync check of its pid file). */
function coreProcessAlive(): boolean {
  try {
    process.kill(Number(fs.readFileSync(path.join(cmdHome(), "core.pid"), "utf8")), 0);
    return true;
  } catch {
    return false;
  }
}

// No core running: start one now, before Electron is ready, so it boots alongside
// the app instead of after the window. (A stale pid file just means ensureCore
// finds nothing to connect to and starts one then.)
let coreSpawned = !coreProcessAlive() && (spawnCore(), true);

async function ensureCore(): Promise<void> {
  if (!coreSpawned && (await canConnect())) await checkCoreBuild();
  if (!coreSpawned && !(await canConnect())) (spawnCore(), (coreSpawned = true));
  for (const until = Date.now() + 5000; Date.now() < until; ) {
    if (await canConnect()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`core did not start; see ${coreLog()}`);
}

// ── window ──────────────────────────────────────────────

/** An app window showing a Space (see spaces.ts, which decides which). */
function createWindow(spaceId: string, b: Bounds): BrowserWindow {
  performance.mark("boot:window-start");
  const win = new BrowserWindow({
    ...b,
    minWidth: 760,
    minHeight: 480,
    title: app.getName(),
    icon: devIcon, // Windows/Linux; macOS uses the Dock icon
    show: false,
    // macOS: content under an inset title bar, traffic lights over the sidebar.
    // Elsewhere: the platform's own frame, window controls and menu bar.
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 12 } } : {}),
    backgroundColor: savedAppearance().background,
    acceptFirstMouse: true, // a click on a window in the background also lands (selects, focuses a terminal)
    webPreferences: {
      preload: path.join(here, "../preload/index.cjs"),
      sandbox: false, // preload talks to the core socket via node:net
      contextIsolation: true,
      webviewTag: true, // browser windows
      scrollBounce: true, // macOS rubber banding (off by default in Electron), e.g. at the strip's ends
    },
  });
  if (b.maximized) win.maximize();
  // Subframes are Magic widgets: they stay on their own page. host.js turns link
  // clicks into open-url; a widget that sets location itself gets a browser too.
  win.webContents.on("will-frame-navigate", (e) => {
    if (e.isMainFrame || e.url.startsWith("cmd-widget:")) return;
    e.preventDefault();
    if (/^https?:/i.test(e.url)) win.webContents.send("open-url", e.url);
  });
  performance.mark("boot:window-created");
  win.once("ready-to-show", () => (performance.mark("boot:ready-to-show"), win.show()));
  // The renderer reads its Space from the URL before the core answers.
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?space=${encodeURIComponent(spaceId)}`);
  else win.loadFile(path.join(here, "../renderer/index.html"), { query: { space: spaceId } });
  return win;
}

const spaces = new SpaceWindows(createWindow);

// ── utility windows ─────────────────────────────────────
// One native Settings window (⌘,), like a macOS app's: a sidebar of categories,
// drawn like the main window's. And one Task Manager (Window menu): what cmd's
// processes use. Each has its own page and bundle (renderer/<page>.html).

type UtilityPage = "settings" | "tasks";
const utility = new Map<UtilityPage, BrowserWindow>();
const isSettings = (w: BrowserWindow | null | undefined) => !!w && w === utility.get("settings");
/** Settings or the Task Manager: not an app window. */
const isUtility = (w: BrowserWindow | null | undefined) => !!w && [...utility.values()].includes(w);

/** at: a page inside the window to show (Settings: "remote", "remote/pair"). */
function openUtility(page: UtilityPage, o: { title: string; width: number; height: number; minWidth: number; minHeight: number }, at?: string): BrowserWindow {
  const open = utility.get(page);
  if (open && !open.isDestroyed()) {
    open.show();
    open.focus();
    if (at) open.webContents.send("settings-page", at);
    return open;
  }
  const win = new BrowserWindow({
    ...o,
    show: false,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 12 } } : {}),
    backgroundColor: savedAppearance().background,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(here, "../preload/index.cjs"),
      sandbox: false,
      contextIsolation: true,
    },
  });
  utility.set(page, win);
  win.on("closed", () => utility.get(page) === win && utility.delete(page));
  win.once("ready-to-show", () => win.show());
  const search = at ? `?page=${encodeURIComponent(at)}` : "";
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}.html${search}`);
  else win.loadFile(path.join(here, `../renderer/${page}.html`), { search });
  return win;
}

const openSettings = (at?: string) => openUtility("settings", { title: "Settings", width: 860, height: 620, minWidth: 700, minHeight: 440 }, at);
const openTaskManager = () => openUtility("tasks", { title: "Task Manager", width: 720, height: 520, minWidth: 520, minHeight: 300 });

/** App windows, not Settings or the Task Manager. */
const appWindows = () => BrowserWindow.getAllWindows().filter((w) => !isUtility(w));

// ── IPC ─────────────────────────────────────────────────

const winOf = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender);

ipcMain.on("badge", (_e, count: number) => app.dock?.setBadge(count > 0 ? String(count) : ""));
ipcMain.on("progress", (e, value: number) => BrowserWindow.fromWebContents(e.sender)?.setProgressBar(typeof value === "number" ? value : -1));
ipcMain.on("bounce", () => app.dock?.bounce("informational"));
// System sounds by name (a widget's cmd.sound); one at a time, so a burst doesn't pile up.
let sounding = false;
ipcMain.on("play-sound", (_e, name: string) => {
  if (sounding || process.platform !== "darwin" || !(SYSTEM_SOUNDS as readonly string[]).includes(name)) return;
  sounding = true;
  execFile("/usr/bin/afplay", [`/System/Library/Sounds/${name}.aiff`], () => (sounding = false));
});

// System notifications (the UI decides when; see packages/core/src/notifications.ts).
// Shown from here, not the renderer, for system sounds by name and so a window's
// newer notification replaces its older one in Notification Center (by tag).
interface NotifyOptions {
  tag: string;
  title: string;
  body: string;
  /** "default", a macOS system sound name, or null for silent. */
  sound: string | null;
  paneId: string | null;
}
const shown = new Map<string, Notification>();
ipcMain.on("notify", (e, o: NotifyOptions) => {
  if (!Notification.isSupported()) return;
  const sender = winOf(e);
  shown.get(o.tag)?.close();
  const n = new Notification({
    title: o.title,
    body: o.body,
    silent: o.sound === null,
    ...(o.sound && o.sound !== "default" ? { sound: o.sound } : {}),
  });
  n.on("click", () => {
    if (!sender || sender.isDestroyed()) return;
    if (sender.isMinimized()) sender.restore();
    // macOS usually activates the app on a notification click; make sure of it.
    app.focus({ steal: true });
    sender.show();
    sender.focus();
    if (o.paneId) sender.webContents.send("notification-click", o.paneId);
  });
  n.on("close", () => shown.get(o.tag) === n && shown.delete(o.tag));
  shown.set(o.tag, n);
  n.show();
});
/** Looking at the window it came from: its notification is no longer news. */
ipcMain.on("notify-close", (_e, tag: string) => {
  shown.get(tag)?.close();
  shown.delete(tag);
});
ipcMain.on("appearance", (_e, a: Appearance) => {
  setAppearance(a);
  setDockIcon(a.dockIcon ?? null);
  for (const w of appWindows()) w.setBackgroundColor(a.background);
});
ipcMain.on("menu-state", (_e, state: MenuState) => applyMenuState(state));
ipcMain.on("space-show", (e, spaceId: string, o: { select?: string; newWindow?: boolean }) => spaces.show(spaceId, o ?? {}, winOf(e)));
ipcMain.on("space-lost", (e) => {
  const win = winOf(e);
  if (win) spaces.lost(win);
});
ipcMain.handle("choose-folder", async (e) => {
  const opts = { properties: ["openDirectory" as const, "createDirectory" as const], buttonLabel: "Open Space" };
  const win = winOf(e);
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : (r.filePaths[0] ?? null);
});
ipcMain.handle("choose-save-path", async (e, defaultPath: string) => {
  const opts = { defaultPath, properties: ["createDirectory" as const, "showOverwriteConfirmation" as const] };
  const win = winOf(e);
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  return r.canceled ? null : (r.filePath ?? null);
});
ipcMain.on("close-window", (e) => winOf(e)?.close());
ipcMain.on("edit-native", (e, op: string, guestId?: number) => editNative(e.sender, op, guestId));
// URLs (https:, mailto:) go to their default app; anything else is a file path.
ipcMain.on("clipboard-write", (_e, text: unknown) => typeof text === "string" && clipboard.writeText(text));
// Nothing to open it with (an unknown scheme, a missing file) is the user's to know, not a crash.
ipcMain.on("open-path", async (e, p: string) => {
  const error = /^[a-z][\w+.-]+:/i.test(p)
    ? await shell.openExternal(p).then(() => "", (err: Error) => err.message)
    : await shell.openPath(p);
  if (!error) return;
  log.warn("could not open", { target: p, error });
  const opts = { type: "warning" as const, message: `cmd could not open ${p}`, detail: error };
  const win = winOf(e);
  void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
});
ipcMain.on("settings-window", (_e, page?: string) => void openSettings(typeof page === "string" ? page : undefined));
ipcMain.on("check-updates", () => checkForUpdates());
// The Task Manager: Electron's own processes, and showing a terminal in the app window of its Space.
ipcMain.handle("app-metrics", () => appMetrics());
ipcMain.on("task-manager", () => openTaskManager());
ipcMain.on("show-pane", (_e, spaceId: string, paneId: string) => spaces.show(spaceId, { select: paneId }, appWindows()[0] ?? null));
ipcMain.on("install-update", () => void updater().then((u) => u.installUpdate()));
ipcMain.handle("restart-core", () => restartCore());
// The preload connects where main decided (dev builds use their own core).
ipcMain.on("core-socket", (e) => (e.returnValue = socketPath));
ipcMain.on("reveal-path", (_e, p: string) => shell.showItemInFolder(p));
ipcMain.handle("trash-path", (_e, p: string) => shell.trashItem(p));
// Uncaught errors in the app's pages (renderer/src/errors.ts): each one once per launch.
const rendererErrors = new Set<string>();
ipcMain.on("renderer-error", (e, r: { kind: string; message: string; stack: string | null }) => {
  const key = `${r.message}\n${r.stack?.split("\n").find((l) => l.trim().startsWith("at ")) ?? ""}`;
  if (rendererErrors.has(key)) return;
  rendererErrors.add(key);
  const from = BrowserWindow.fromWebContents(e.sender);
  const page = isSettings(from) ? "settings" : isUtility(from) ? "tasks" : "app";
  recordCrash("renderer", r.kind, r.message, r.stack, { page });
});
/** Settings → About: the app's side of the diagnostics (core.info is the core's). */
ipcMain.handle("app-info", async () => ({
  version: app.getVersion(),
  dev: devBuild,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  build: sourceBuildId(repoRoot),
  home: cmdHome(),
  logs: logDir(),
  coreLog: coreLog(),
  updateLog: path.join(logDir(), "update.log"),
  crashes: crashStatus(devBuild),
  updates: (await updater()).updateStatus(),
}));
ipcMain.handle("feedback-status", () => feedbackStatus(devBuild));
ipcMain.handle("whats-new", () => claimWhatsNew(uiData, app.getVersion(), hadUiData, devBuild));
ipcMain.handle("onboarding", () => claimOnboarding(uiData, hadUiData));
ipcMain.on("onboarding-seen", (_e, ids: unknown) => Array.isArray(ids) && recordOnboarding(uiData, ids.filter((x): x is string => typeof x === "string")));
ipcMain.handle("send-feedback", (_e, r: FeedbackRequest) => sendFeedback(r, crashContext()));
ipcMain.on("open-settings", (_e, p: string) => {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, SETTINGS_TEMPLATE);
  }
  void shell.openPath(p);
});
ipcMain.handle("keybindings", () => keybindings);
ipcMain.handle("set-keybinding", (_e, id: string, keys: string[] | null) => writeKeybinding(id, keys));
ipcMain.handle("reset-keybindings", () => resetKeybindings());
ipcMain.on("record-shortcut", (e, on: boolean) => {
  if (recordingShortcut === on) return;
  recordingShortcut = on;
  refreshMenu();
  if (on) e.sender.once("destroyed", () => ((recordingShortcut = false), refreshMenu()));
});
// SF Symbols, rendered natively at the exact point size and pixel density the UI
// shows them (native/sfsymbols.swift), so they stay crisp. PNG data URLs, black
// template images; the UI tints them via CSS masks.
const SF_HELPER = path.join(repoRoot, "apps/desktop/native/build/sfsymbols");
const symbolCache = new Map<string, SymbolImage>();
/** Helper runs in flight, by symbol key: concurrent requests for the same symbols share one. */
const symbolRuns = new Map<string, Promise<void>>();

// Rendered symbols are kept on disk (per macOS release and helper build), so a
// launch doesn't wait for the helper (about 0.5 s cold) before the first paint.
const symbolStamp = (() => {
  try {
    return `${os.release()}-${fs.statSync(SF_HELPER).mtimeMs}`;
  } catch {
    return null;
  }
})();
const symbolFile = path.join(app.getPath("userData"), "sf-symbols.json");
try {
  const saved = JSON.parse(fs.readFileSync(symbolFile, "utf8")) as { stamp: string; symbols: Record<string, SymbolImage> };
  if (symbolStamp && saved.stamp === symbolStamp) for (const [k, v] of Object.entries(saved.symbols)) symbolCache.set(k, v);
} catch {}
let symbolSave: ReturnType<typeof setTimeout> | undefined;
function saveSymbols(): void {
  if (!symbolStamp) return;
  clearTimeout(symbolSave);
  symbolSave = setTimeout(() => {
    const body = JSON.stringify({ stamp: symbolStamp, symbols: Object.fromEntries(symbolCache) });
    void fs.promises.writeFile(symbolFile, body).catch(() => {});
  }, 1000);
}

async function renderSymbols(names: string[], size: number, weight: string, scale: number): Promise<Record<string, SymbolImage>> {
  const key = (n: string) => `${n}@${size}@${weight}@${scale}`;
  const missing = names.filter((n) => !symbolCache.has(key(n)));
  // SF Symbols are macOS-only (and Apple-only by licence): Lucide icons elsewhere
  // (CMD_LUCIDE_ICONS=1 shows them on macOS too, to check the mapping).
  if (process.platform !== "darwin" || process.env.CMD_LUCIDE_ICONS === "1") {
    for (const n of missing) symbolCache.set(key(n), lucideSymbol(n, size, weight));
    return Object.fromEntries(names.map((n) => [n, symbolCache.get(key(n)) ?? null]));
  }
  if (missing.length && symbolStamp) {
    // Off the main thread: a synchronous spawn here held up every window's first paint.
    const todo = missing.filter((n) => !symbolRuns.has(key(n)));
    if (todo.length) {
      const run = new Promise<void>((resolve) => {
        execFile(SF_HELPER, [String(size), weight, String(scale), ...todo], { encoding: "utf8", timeout: 5000, maxBuffer: 64 << 20 }, (_err, stdout) => {
          try {
            const out = JSON.parse(stdout || "{}") as Record<string, { png: string; w: number; h: number }>;
            for (const n of todo) {
              const o = out[n];
              symbolCache.set(key(n), o ? { url: `data:image/png;base64,${o.png}`, w: o.w, h: o.h } : null);
            }
            saveSymbols();
          } catch {
            // fall through to the fallback below
          }
          for (const n of todo) symbolRuns.delete(key(n));
          resolve();
        });
      });
      for (const n of todo) symbolRuns.set(key(n), run);
    }
    await Promise.all(missing.map((n) => symbolRuns.get(key(n))));
  }
  for (const n of missing) {
    if (symbolCache.has(key(n))) continue;
    // Fallback without the helper: Electron's image, resized (high quality) to the exact size.
    const img = nativeImage.createFromNamedImage(n);
    if (img.isEmpty()) {
      symbolCache.set(key(n), null);
      continue;
    }
    // Same square, even-sided box as the helper; the image is fitted inside (mask contain).
    const side = Math.ceil(size / 2) * 2;
    const { width, height } = img.getSize();
    const k = side / Math.max(width, height);
    const px = img.resize({ width: Math.round(width * k * scale), height: Math.round(height * k * scale), quality: "best" });
    symbolCache.set(key(n), { url: px.toDataURL(), w: side, h: side, contain: true });
  }
  return Object.fromEntries(names.map((n) => [n, symbolCache.get(key(n)) ?? null]));
}

ipcMain.handle("sf-symbols", (_e, req: { names: string[]; size: number; weight?: string; scale?: number }) =>
  renderSymbols(req.names, req.size, req.weight ?? "regular", Math.max(1, Math.min(3, Math.round(req.scale ?? 2)))),
);
ipcMain.on("open-keybindings", () => void shell.openPath(ensureKeybindingsFile()));
ipcMain.on("open-docs", () => void shell.openPath(path.join(repoRoot, "docs", "00-overview.md")));
ipcMain.on("focus", (e) => {
  const win = winOf(e);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

ipcMain.handle("confirm", async (e, o: { message: string; detail?: string; confirm: string }) => {
  const opts = { type: "warning" as const, message: o.message, detail: o.detail, buttons: [o.confirm, "Cancel"], defaultId: 0, cancelId: 1 };
  const win = winOf(e);
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return r.response === 0;
});

const widgetFrames = new Map<string, string[]>(); // token → allowed media origins
ipcMain.handle("widget-frame", (_e, media: unknown) => {
  const origins = [...new Set((Array.isArray(media) ? media : []).map(mediaOrigin).filter((o): o is string => !!o))].sort();
  if (!origins.length) return "cmd-widget://frame/";
  const key = origins.join(" ");
  let token = [...widgetFrames].find(([, v]) => v.join(" ") === key)?.[0];
  if (!token) widgetFrames.set((token = randomUUID()), origins);
  return `cmd-widget://frame/${token}`;
});

ipcMain.handle("context-menu", (e, items: ContextItem[]) => {
  return new Promise<string | null>((resolve) => {
    let chosen: string | null = null;
    const template = (list: ContextItem[]): Electron.MenuItemConstructorOptions[] =>
      list.map((it) =>
        "separator" in it
          ? { type: "separator" as const }
          : it.submenu
            ? { label: it.label, enabled: it.enabled ?? true, submenu: template(it.submenu) }
            : { label: it.label, enabled: it.enabled ?? true, ...(it.checked !== undefined ? { type: "checkbox" as const, checked: it.checked } : {}), click: () => (chosen = it.id) },
      );
    const menu = Menu.buildFromTemplate(template(items));
    menu.popup({ window: winOf(e) ?? undefined, callback: () => resolve(chosen) });
  });
});

// ── browser windows (webview guests) ───────────────────

// Guests get no Node, only cmd's guest preload, their own session; links that open new windows
// become new cmd browser windows.
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (_ev, prefs, params) => {
    // Only cmd's own guest preload, in an isolated world: it reports presses to
    // the app (preload/guest.ts, renderer/src/embed.ts).
    prefs.preload = path.join(here, "../preload/guest.cjs");
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.scrollBounce = true; // pages bounce at their edges, like the rest of the app
    prefs.safeDialogs = true; // a page looping alert() can be stopped
    if (!/^(https?|about|file):/i.test(params.src ?? "")) params.src = "about:blank";
  });
  // The app's own pages' warnings and errors go to main.log (browser windows' pages and Magic widgets' don't).
  if (contents.getType() === "window") {
    contents.on("console-message", (e) => {
      if ((e.level !== "warning" && e.level !== "error") || e.sourceId.startsWith("cmd-widget:")) return;
      const where = e.sourceId ? ` (${path.basename(e.sourceId.replace(/\?.*$/, ""))}:${e.lineNumber})` : "";
      rendererLog[e.level === "error" ? "error" : "warn"](`${e.message}${where}`);
    });
  }
  if (contents.getType() === "webview") {
    contents.setWindowOpenHandler(({ url }) => {
      const host = contents.hostWebContents;
      if (host && /^https?:/i.test(url)) host.send("open-url", url);
      return { action: "deny" };
    });
  }
});

// ── lifecycle ───────────────────────────────────────────

app.whenReady().then(async () => {
  performance.mark("boot:app-ready");
  nativeTheme.themeSource = savedAppearance().source;
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    copyright: "© 2026 Jan Oelze",
    website: "https://github.com/janoelze/cmd",
    iconPath: devIcon,
  });
  protocol.handle("cmd-widget", (req) => {
    const dir = path.join(repoRoot, "packages/core/src/magic/prompt");
    const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${read("kit.css")}</style><script>${read("host.js")}</script></head><body></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": widgetCsp(widgetFrames.get(new URL(req.url).pathname.slice(1)) ?? []), "cache-control": "no-store" } });
  });
  // Magic widgets may not leave their page, open anything, or ask for permissions.
  session.defaultSession.setPermissionRequestHandler((wc, _permission, done, details) => {
    done(!/^cmd-widget:/.test(details.requestingUrl ?? ""));
  });
  protocol.handle("cmd-file", (req) => {
    const file = new URL(req.url).searchParams.get("path") ?? "";
    if (!path.isAbsolute(file) || !CMD_FILE_TYPES.test(file)) return new Response("not an image or media file", { status: 403 });
    return electronNet.fetch(pathToFileURL(file).href);
  });
  // First: the window loads its bundle while the menu is built and the core is
  // checked or started; the preload connects as soon as the socket answers.
  spaces.restore();
  // Decoding and setting it takes ~80 ms on this thread: not while the first window starts (dev builds only).
  if (devIcon) setTimeout(() => app.dock?.setIcon(devIcon), 1000);
  else if (!devBuild) setTimeout(() => startDockIcon(dockIcons, savedAppearance().dockIcon ?? null), 1000);
  ensureCore().then(
    () => (performance.mark("boot:core-reachable"), spaces.followCore(socketPath, appWindows), servePreviews(socketPath), void countLaunch()),
    (err: Error) => (log.error("the core did not start", err), dialog.showErrorBox("cmd: the core did not start", err.message)),
  );
  followCrashReports(socketPath);
  // Its bundle (about 570 KB) is parsed on this thread; its first check is 30 s away anyway.
  setTimeout(() => void startUpdater(), 5000);
  const send = commandSender(() => spaces.reopen(), { openSettings, openTaskManager, checkForUpdates, isUtility, appWindows });
  refreshMenu = () => buildMenu(send, recordingShortcut ? {} : keybindings.bindings);
  refreshMenu();
  watchKeybindings((next) => {
    keybindings = next;
    refreshMenu();
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("keybindings", next);
  });
  app.dock?.setMenu(
    Menu.buildFromTemplate([
      { label: "New Terminal", click: () => send("file.newTerminal") },
      { label: "New Claude Session", click: () => send("file.newClaude") },
    ]),
  );
  app.on("activate", () => {
    if (appWindows().length === 0) spaces.reopen();
  });
});

// Closing the window does not stop the core: terminals keep running.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
