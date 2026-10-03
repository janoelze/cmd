// Electron main: makes sure a core is running, then opens the window.
// The core is a separate, detached process so terminals survive UI reloads and restarts.

// Boot timeline marks (boot:*), read by the boot benchmark; the renderer adds its own.
performance.mark("boot:main-script");
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net as electronNet, Notification, protocol, session, shell } from "electron";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { SETTINGS_TEMPLATE, mediaOrigin, widgetCsp } from "@cmd/protocol";
import { cmdHome, configDir, connect, defaultSocketPath, ipcPath, sourceBuildId } from "@cmd/protocol/node";
import type { ContextItem, MenuState } from "../shared/commands.ts";
import { applyMenuState, buildMenu, commandSender } from "./menu.ts";
import { lucideSymbol, type SymbolImage } from "./icons.ts";
import { savedAppearance, setAppearance, type Appearance } from "./appearance.ts";
import { SpaceWindows, type Bounds } from "./spaces.ts";
import { ensureKeybindingsFile, loadKeybindings, watchKeybindings, type KeybindingsSnapshot } from "./keybindings.ts";

// Loaded after launch: the updater isn't needed to show the first window.
const updater = () => import("./updater.ts");
const checkForUpdates = () => void updater().then((u) => u.checkForUpdates(devBuild));

/**
 * Development builds (pnpm dev, and pnpm dist, which packages as "cmd dev") sit
 * next to the installed app: a red icon, their own name, and their own core and
 * state, so they never attach to (and offer to restart) the core your real
 * terminals run in. Settings and keybindings stay shared. $CMD_HOME still wins.
 */
const devBuild = !app.isPackaged || app.getName() === "cmd dev";
if (devBuild) {
  app.setName("cmd dev");
  if (!process.env.CMD_HOME) {
    process.env.CMD_CONFIG_DIR ??= configDir();
    process.env.CMD_HOME = path.join(path.dirname(cmdHome()), "cmd-dev"); // next to the real state dir
    process.env.CMD_SOCKET ??= path.join(os.tmpdir(), "cmd-dev", "core.sock");
  }
}

let keybindings: KeybindingsSnapshot = loadKeybindings();

if (process.env.CMD_NO_SANDBOX) app.commandLine.appendSwitch("no-sandbox");
// Tests: render as on a Retina display regardless of the actual screen.
if (process.env.CMD_FORCE_SCALE) app.commandLine.appendSwitch("force-device-scale-factor", process.env.CMD_FORCE_SCALE);

// cmd-file://local/?path=<abs path> — read-only access to local images/media for the app's own
// pages (Markdown windows show relative images). Registered on the default
// session only; browser windows use their own session and can't reach it.
// cmd-widget://frame/ — the page every Magic widget runs in (docs/12-magic-windows.md):
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
const socketPath = defaultSocketPath();
// Chromium's profile (browser-window cookies, caches) lives in the state dir, so
// $CMD_HOME isolates it too. By default it would be Application Support/<app name>,
// which for "cmd" is the core's own state dir. Dev builds used to be named
// "@cmd/desktop": move that profile over once.
const uiData = path.join(cmdHome(), "ui");
const legacyUiData = path.join(app.getPath("appData"), "@cmd", "desktop");
if (!process.env.CMD_HOME && !fs.existsSync(uiData) && fs.existsSync(legacyUiData)) {
  try {
    fs.mkdirSync(cmdHome(), { recursive: true });
    fs.renameSync(legacyUiData, uiData);
  } catch {}
}
app.setPath("userData", uiData);

// Packaged builds carry their icon in the bundle (.icns / .ico); dev runs use the PNG.
const devIcon = app.isPackaged ? undefined : path.join(here, "../../build/dev/icon.png");

function canConnect(): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.createConnection(ipcPath(socketPath));
    c.once("connect", () => (c.destroy(), resolve(true)));
    c.once("error", () => resolve(false));
  });
}

/**
 * A core outlives the app on purpose, so after pulling or editing core code an
 * old core may still be serving. Detect that and offer to restart it.
 */
async function checkCoreBuild(): Promise<void> {
  const conn = await connect(socketPath);
  try {
    const hello = await conn.client.call("core.hello", {});
    const current = sourceBuildId(repoRoot);
    if (hello.build === current) return;
    const panes = await conn.client.call("pane.list", {}).catch(() => []);
    const { response } = await dialog.showMessageBox({
      type: "warning",
      message: "The running core is outdated",
      detail:
        `The core process (pid ${hello.pid}) was started from older code than this app. ` +
        `Restart it to pick up the changes.\n\nRestarting closes ${panes.length} open terminal${panes.length === 1 ? "" : "s"}. ` +
        `Claude and Codex sessions can be resumed afterwards.`,
      buttons: ["Restart Core", "Keep Old Core"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
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
 * worker, shell integration). The newest few copies are kept.
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
    const old = fs
      .readdirSync(base)
      .map((name) => ({ name, mtime: fs.statSync(path.join(base, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(3);
    for (const o of old) fs.rmSync(path.join(base, o.name), { recursive: true, force: true });
    return dir;
  } catch {
    return repoRoot;
  }
}

async function stopCore(pid: number): Promise<void> {
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50 && (await canConnect()); i++) await new Promise((r) => setTimeout(r, 100));
}

/** Settings → About: stop the core (its terminals close) and start one from this app's code. */
async function restartCore(): Promise<void> {
  const conn = await connect(socketPath).catch(() => null);
  if (conn) {
    try {
      await stopCore((await conn.client.call("core.hello", {})).pid);
    } finally {
      conn.close();
    }
  }
  spawnCore();
  for (const until = Date.now() + 5000; Date.now() < until; ) {
    if (await canConnect()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`core did not start; see ${path.join(cmdHome(), "core.log")}`);
}

function spawnCore(): void {
  const home = cmdHome();
  fs.mkdirSync(home, { recursive: true });
  const log = fs.openSync(path.join(home, "core.log"), "a");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let node = "node";
  if (app.isPackaged) (node = process.execPath), (env.ELECTRON_RUN_AS_NODE = "1");
  const child = spawn(node, ["--no-warnings", path.join(coreRoot(), "packages/core/src/main.ts")], {
    detached: true,
    stdio: ["ignore", log, log],
    env,
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
  throw new Error(`core did not start; see ${path.join(cmdHome(), "core.log")}`);
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
  // Subframes are Magic widgets: they stay on their own page.
  win.webContents.on("will-frame-navigate", (e) => {
    if (!e.isMainFrame && !e.url.startsWith("cmd-widget:")) e.preventDefault();
  });
  performance.mark("boot:window-created");
  win.once("ready-to-show", () => (performance.mark("boot:ready-to-show"), win.show()));
  // The renderer reads its Space from the URL before the core answers.
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?space=${encodeURIComponent(spaceId)}`);
  else win.loadFile(path.join(here, "../renderer/index.html"), { query: { space: spaceId } });
  return win;
}

const spaces = new SpaceWindows(createWindow);

// ── settings window ─────────────────────────────────────
// One native Settings window (⌘,), like a macOS app's: translucent sidebar of
// categories. Its own page and bundle (renderer/settings.html).

let settingsWin: BrowserWindow | null = null;
const isSettings = (w: BrowserWindow | null | undefined) => !!w && w === settingsWin;

function openSettings(): BrowserWindow {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }
  const win = new BrowserWindow({
    width: 800,
    height: 580,
    minWidth: 660,
    minHeight: 420,
    title: "Settings",
    show: false,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 20, y: 19 }, vibrancy: "sidebar" as const, visualEffectState: "followWindow" as const, backgroundColor: "#00000000" }
      : { backgroundColor: savedAppearance().background }),
    fullscreenable: false,
    webPreferences: {
      preload: path.join(here, "../preload/index.cjs"),
      sandbox: false,
      contextIsolation: true,
    },
  });
  settingsWin = win;
  win.on("closed", () => (settingsWin = null));
  win.once("ready-to-show", () => win.show());
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/settings.html`);
  else win.loadFile(path.join(here, "../renderer/settings.html"));
  return win;
}

/** App windows, not the Settings window. */
const appWindows = () => BrowserWindow.getAllWindows().filter((w) => !isSettings(w));

// ── IPC ─────────────────────────────────────────────────

const winOf = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender);

ipcMain.on("badge", (_e, count: number) => app.dock?.setBadge(count > 0 ? String(count) : ""));
ipcMain.on("bounce", () => app.dock?.bounce("informational"));

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
ipcMain.on("close-window", (e) => winOf(e)?.close());
ipcMain.on("open-path", (_e, p: string) => void shell.openPath(p));
ipcMain.on("settings-window", () => void openSettings());
ipcMain.on("check-updates", () => checkForUpdates());
ipcMain.handle("restart-core", () => restartCore());
// The preload connects where main decided (dev builds use their own core).
ipcMain.on("core-socket", (e) => (e.returnValue = socketPath));
ipcMain.on("reveal-path", (_e, p: string) => shell.showItemInFolder(p));
/** Settings → About: the app's side of the diagnostics (core.info is the core's). */
ipcMain.handle("app-info", async () => ({
  version: app.getVersion(),
  dev: devBuild,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  build: sourceBuildId(repoRoot),
  home: cmdHome(),
  coreLog: path.join(cmdHome(), "core.log"),
  updateLog: path.join(cmdHome(), "update.log"),
  updates: (await updater()).updateStatus(),
}));
ipcMain.on("open-settings", (_e, p: string) => {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, SETTINGS_TEMPLATE);
  }
  void shell.openPath(p);
});
ipcMain.handle("keybindings", () => keybindings);
// SF Symbols, rendered natively at the exact point size and pixel density the UI
// shows them (native/sfsymbols.swift), so they stay crisp. PNG data URLs, black
// template images; the UI tints them via CSS masks.
const SF_HELPER = path.join(repoRoot, "apps/desktop/native/build/sfsymbols");
const symbolCache = new Map<string, SymbolImage>();

function renderSymbols(names: string[], size: number, weight: string, scale: number): Record<string, SymbolImage> {
  const key = (n: string) => `${n}@${size}@${weight}@${scale}`;
  const missing = names.filter((n) => !symbolCache.has(key(n)));
  // SF Symbols are macOS-only (and Apple-only by licence): Lucide icons elsewhere
  // (CMD_LUCIDE_ICONS=1 shows them on macOS too, to check the mapping).
  if (process.platform !== "darwin" || process.env.CMD_LUCIDE_ICONS === "1") {
    for (const n of missing) symbolCache.set(key(n), lucideSymbol(n, size, weight));
    return Object.fromEntries(names.map((n) => [n, symbolCache.get(key(n)) ?? null]));
  }
  if (missing.length && fs.existsSync(SF_HELPER)) {
    const r = spawnSync(SF_HELPER, [String(size), weight, String(scale), ...missing], { encoding: "utf8", timeout: 5000 });
    try {
      const out = JSON.parse(r.stdout || "{}") as Record<string, { png: string; w: number; h: number }>;
      for (const n of missing) {
        const o = out[n];
        symbolCache.set(key(n), o ? { url: `data:image/png;base64,${o.png}`, w: o.w, h: o.h } : null);
      }
    } catch {
      // fall through to the fallback below
    }
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
    const menu = Menu.buildFromTemplate(
      items.map((it) =>
        "separator" in it
          ? { type: "separator" as const }
          : { label: it.label, enabled: it.enabled ?? true, click: () => (chosen = it.id) },
      ),
    );
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
  if (devIcon) app.dock?.setIcon(devIcon);
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
  ensureCore().then(
    () => (performance.mark("boot:core-reachable"), spaces.followCore(socketPath, appWindows)),
    (err: Error) => dialog.showErrorBox("cmd: the core did not start", err.message),
  );
  if (!devBuild) void updater().then((u) => u.startUpdater(socketPath));
  const send = commandSender(() => spaces.reopen(), { openSettings, checkForUpdates, isSettings, appWindows });
  buildMenu(send, keybindings.bindings);
  watchKeybindings((next) => {
    keybindings = next;
    buildMenu(send, next.bindings);
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
