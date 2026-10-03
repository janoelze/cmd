// Electron main: makes sure a core is running, then opens the window.
// The core is a separate, detached process so terminals survive UI reloads and restarts.

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { cmdHome, connect, defaultSocketPath, sourceBuildId } from "@cmd/protocol/node";
import type { ContextItem, MenuState } from "../shared/commands.ts";
import { applyMenuState, buildMenu, commandSender } from "./menu.ts";
import { ensureKeybindingsFile, loadKeybindings, watchKeybindings, type KeybindingsSnapshot } from "./keybindings.ts";

let keybindings: KeybindingsSnapshot = loadKeybindings();

if (process.env.CMD_NO_SANDBOX) app.commandLine.appendSwitch("no-sandbox");

const here = import.meta.dirname; // apps/desktop/out/main
const repoRoot = path.resolve(here, "../../../..");
const socketPath = defaultSocketPath();

function canConnect(): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.createConnection(socketPath);
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
    process.kill(hello.pid, "SIGTERM");
    for (let i = 0; i < 50 && (await canConnect()); i++) await new Promise((r) => setTimeout(r, 100));
  } catch {
    // An unresponsive or very old core: leave it, the UI shows the error.
  } finally {
    conn.close();
  }
}

async function ensureCore(): Promise<void> {
  if (await canConnect()) await checkCoreBuild();
  if (await canConnect()) return;
  const home = cmdHome();
  fs.mkdirSync(home, { recursive: true });
  const log = fs.openSync(path.join(home, "core.log"), "a");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn("node", ["--no-warnings", path.join(repoRoot, "packages/core/src/main.ts")], {
    detached: true,
    stdio: ["ignore", log, log],
    env,
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    if (await canConnect()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`core did not start; see ${path.join(home, "core.log")}`);
}

// ── window ──────────────────────────────────────────────

interface Bounds { x?: number; y?: number; width: number; height: number; maximized?: boolean }
const boundsFile = () => path.join(cmdHome(), "window.json");

function loadBounds(): Bounds {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), "utf8")) as Bounds;
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x !== undefined && b.y !== undefined && b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + 40 > a.y;
    });
    return visible ? b : { width: b.width, height: b.height };
  } catch {
    return { width: 1400, height: 900 };
  }
}

function trackBounds(win: BrowserWindow): void {
  let t: NodeJS.Timeout | undefined;
  const save = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (win.isDestroyed() || win.isFullScreen()) return;
      const b: Bounds = { ...win.getNormalBounds(), maximized: win.isMaximized() };
      fs.mkdirSync(cmdHome(), { recursive: true });
      fs.writeFileSync(boundsFile(), JSON.stringify(b));
    }, 300);
  };
  win.on("resize", save);
  win.on("move", save);
  win.on("close", save);
}

function createWindow(): BrowserWindow {
  const b = loadBounds();
  const win = new BrowserWindow({
    ...b,
    minWidth: 760,
    minHeight: 480,
    title: "cmd",
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 12 },
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: path.join(here, "../preload/index.mjs"),
      sandbox: false, // preload talks to the core socket via node:net
      contextIsolation: true,
      webviewTag: true, // browser windows
    },
  });
  if (b.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  trackBounds(win);
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(here, "../renderer/index.html"));
  return win;
}

// ── IPC ─────────────────────────────────────────────────

const winOf = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender);

ipcMain.on("badge", (_e, count: number) => app.dock?.setBadge(count > 0 ? String(count) : ""));
ipcMain.on("bounce", () => app.dock?.bounce("informational"));
ipcMain.on("menu-state", (_e, state: MenuState) => applyMenuState(state));
ipcMain.on("close-window", (e) => winOf(e)?.close());
ipcMain.on("open-path", (_e, p: string) => void shell.openPath(p));
ipcMain.on("open-settings", (_e, p: string) => {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "// cmd settings. Changes apply live.\n{\n}\n");
  }
  void shell.openPath(p);
});
ipcMain.handle("keybindings", () => keybindings);
// SF Symbols by name, as PNG data URLs (black template images; the UI tints them via CSS masks).
const symbolCache = new Map<string, string | null>();
ipcMain.handle("sf-symbols", (_e, names: string[]) =>
  Object.fromEntries(
    names.map((n) => {
      if (!symbolCache.has(n)) {
        const img = nativeImage.createFromNamedImage(n);
        symbolCache.set(n, img.isEmpty() ? null : img.toDataURL());
      }
      return [n, symbolCache.get(n)];
    }),
  ),
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

// Guests get no Node, no preload, their own session; links that open new windows
// become new cmd browser windows.
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (_ev, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
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
  nativeTheme.themeSource = "dark";
  const send = commandSender(createWindow);
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
  await ensureCore();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Closing the window does not stop the core: terminals keep running.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
