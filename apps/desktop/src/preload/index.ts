// Bridges the renderer to the core socket. Reconnects if the core restarts.

import os from "node:os";
import path from "node:path";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { BootReport, CoreEvent, Method, Params, Result } from "@cmd/protocol";
import { connect, type Connection } from "@cmd/protocol/node";
import type { ContextItem, MenuState } from "../shared/commands.ts";
import { allowedAppUrl } from "../shared/app-url.ts";
import type { KeybindingsSnapshot } from "../shared/ipc.ts";
import type { Appearance } from "../main/appearance.ts";
import type { UpdateStatus } from "../main/updater.ts";
import type { CrashStatus } from "../main/crash.ts";
import type { FeedbackRequest, FeedbackStatus } from "../shared/ipc.ts";
import type { WhatsNewClaim } from "../main/whats-new.ts";
import type { NotifyAccess, NotifyPermission } from "../main/notify-permission.ts";
import type { OnboardingClaim } from "../shared/ipc.ts";
import type { AppProcess } from "../shared/ipc.ts";
import type { MacDevice, SiteDecisions, SitePermission, SitePermissionRequest } from "../shared/ipc.ts";
import type { OpenFrom } from "../shared/ipc.ts";

export interface AppInfo {
  version: string;
  /** pnpm dev or a pnpm dist build: own core and state, no self-update. */
  dev: boolean;
  electron: string;
  chrome: string;
  /** Source hash of the core this app ships, and the folder it runs its core from (isCurrentCore). */
  build: string;
  root: string;
  home: string;
  /** Where the logs and crash reports are (release and development builds each have their own). */
  logs: string;
  coreLog: string;
  updateLog: string;
  updates: UpdateStatus;
  crashes: CrashStatus;
}

/** Boot steps of the preload (e2e/startup.mjs): its world has its own performance timeline, so the page reads them here. */
const boot: Record<string, number> = { "boot:preload": performance.timeOrigin + performance.now() };
const bootMark = (name: string) => (boot[name] = performance.timeOrigin + performance.now());
type Status = "connecting" | "connected" | "disconnected";

/**
 * window.cmd reaches a shell, so only the app's own pages get it (out/renderer/*.html,
 * or the dev server in pnpm dev): should anything else ever load in an app window
 * (main prevents that, web-session.ts), it gets no cmd and no connection.
 */
const ownPage = allowedAppUrl(location.href, { rendererDir: path.join(__dirname, "../renderer"), devUrl: process.env.ELECTRON_RENDERER_URL });

/** Main decides which core this app uses (development builds run their own). */
const socketPath: string = ipcRenderer.sendSync("core-socket");
let conn: Connection | null = null;
let ready: Promise<Connection>;
const eventListeners = new Set<(e: CoreEvent) => void>();
const statusListeners = new Set<(s: Status) => void>();

function setStatus(s: Status): void {
  for (const fn of statusListeners) fn(s);
}

// Not before main has checked the core's build (and restarted a stale one).
const checked: Promise<unknown> = ipcRenderer.invoke("core-checked").catch(() => {});

function open(): Promise<Connection> {
  setStatus("connecting");
  ready = (async () => {
    await checked;
    bootMark("boot:core-checked");
    // The window opens while the core starts (main/app.ts), so the first
    // attempts fail; retry quickly at first, then back off to 500 ms.
    for (let attempt = 0; ; attempt++) {
      try {
        const c = await connect(socketPath);
        bootMark("boot:socket");
        conn = c;
        c.client.onEvent((e) => {
          for (const fn of eventListeners) fn(e);
        });
        c.closed.then(() => {
          conn = null;
          setStatus("disconnected");
          setTimeout(open, 500);
        });
        setStatus("connected");
        return c;
      } catch {
        await new Promise((r) => setTimeout(r, Math.min(500, 20 * 1.15 ** attempt)));
      }
    }
  })();
  return ready;
}
if (ownPage) open();

const api = {
  /** When the preload's steps happened (epoch ms), for e2e/startup.mjs. */
  boot: () => ({ ...boot }),
  /** The user's home folder ($HOME counts, so a tour's fixture home is "~" too). */
  homeDir: os.homedir(),
  /** The system's "Show scroll bars": "always", or "fade" after scrolling (Automatic and When scrolling). */
  scrollBars: ipcRenderer.sendSync("show-scroll-bars") as "always" | "fade",
  async call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    const c = conn ?? (await ready);
    return c.client.call(method, params);
  },
  /** Whether the core serves `method` (the methods its core.hello listed); true until it answered. */
  has: (method: Method): boolean => conn?.client.has(method) ?? true,
  /** The protocol the core speaks (core.hello), null before it answered or from a core too old to say. */
  protocol: (): number | null => conn?.hello?.protocol ?? null,
  onEvent(fn: (e: CoreEvent) => void): () => void {
    eventListeners.add(fn);
    return () => eventListeners.delete(fn);
  },
  /** Fires immediately with "connected" if already connected. */
  onStatus(fn: (s: Status) => void): () => void {
    statusListeners.add(fn);
    if (conn) fn("connected");
    return () => statusListeners.delete(fn);
  },
  setBadge: (count: number) => ipcRenderer.send("badge", count),
  /** The Dock icon's progress bar: 0–1, >1 indeterminate, <0 none. */
  setProgress: (value: number) => ipcRenderer.send("progress", value),
  bounce: () => ipcRenderer.send("bounce"),
  /** A macOS system sound by name (SYSTEM_SOUNDS), e.g. a widget's cmd.sound(). */
  playSound: (name: string) => ipcRenderer.send("play-sound", name),
  /** A system notification; a newer one with the same tag replaces it (see main/app.ts). */
  notify: (o: { tag: string; title: string; body: string; sound: string | null; paneId: string | null }) =>
    ipcRenderer.send("notify", o),
  closeNotification: (tag: string) => ipcRenderer.send("notify-close", tag),
  onNotificationClick(fn: (paneId: string) => void): () => void {
    const h = (_e: unknown, paneId: string) => fn(paneId);
    ipcRenderer.on("notification-click", h);
    return () => ipcRenderer.off("notification-click", h);
  },
  /** Whether macOS shows cmd's notifications; null where it can't tell (main/notify-permission.ts). */
  notifyPermission: (): Promise<NotifyPermission | null> => ipcRenderer.invoke("notify-permission"),
  /** macOS's "Allow notifications?" prompt, if not answered yet; then the status. */
  requestNotifyPermission: (): Promise<NotifyPermission | null> => ipcRenderer.invoke("notify-permission-request"),
  /** System Settings → Notifications, at cmd. */
  openNotifySettings: () => ipcRenderer.send("notify-settings"),
  sendTestNotification: () => ipcRenderer.send("notify-test"),
  /** A notification was posted that macOS won't show (once per launch). */
  onNotifyBlocked(fn: (access: NotifyAccess) => void): () => void {
    const h = (_e: unknown, access: NotifyAccess) => fn(access);
    ipcRenderer.on("notify-blocked", h);
    return () => ipcRenderer.off("notify-blocked", h);
  },
  /** Native appearance (traffic lights, menus, vibrancy), window background and Dock icon for the active theme. */
  setAppearance: (a: Appearance) => ipcRenderer.send("appearance", a),
  focusWindow: () => ipcRenderer.send("focus"),
  /**
   * A URL or file in its default app (a URL with a scheme other than file: goes
   * to open-external, anything else to open-file). `from` says who chose it:
   * "user" for cmd's own menus and buttons, "content" for links in terminal
   * output and files, which main confirms first when they'd launch something.
   */
  openPath: (target: string, o: { from: OpenFrom }) => ipcRenderer.send(/^[a-z][\w+.-]+:/i.test(target) && !/^file:/i.test(target) ? "open-external" : "open-file", target, { from: o.from }),
  /** The Settings window (opens it, or brings it to the front), optionally at a page (e.g. "remote"). */
  openSettings: (page?: string) => ipcRenderer.send("settings-window", page),
  /** Settings window: main asks to show a page. */
  onSettingsPage(fn: (page: string) => void): () => void {
    const h = (_e: unknown, page: string) => fn(page);
    ipcRenderer.on("settings-page", h);
    return () => ipcRenderer.off("settings-page", h);
  },
  checkForUpdates: () => ipcRenderer.send("check-updates"),
  /** Task Manager: Electron's processes (CPU% since the previous call), and showing a terminal in its workspace's window. */
  appMetrics: (): Promise<AppProcess[]> => ipcRenderer.invoke("app-metrics"),
  openTaskManager: () => ipcRenderer.send("task-manager"),
  showPane: (workspaceId: string, paneId: string) => ipcRenderer.send("show-pane", workspaceId, paneId),
  /** Restart into a downloaded update. */
  installUpdate: () => ipcRenderer.send("install-update"),
  /** Settings → Updates & About. */
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app-info"),
  restartCore: (): Promise<void> => ipcRenderer.invoke("restart-core"),
  /** What the core does before it answers (docs/50): the report now, and each change (null once it answers). */
  coreBoot: (): Promise<BootReport | null> => ipcRenderer.invoke("core-boot"),
  onCoreBoot(fn: (r: BootReport | null) => void): () => void {
    const h = (_e: unknown, r: BootReport | null) => fn(r);
    ipcRenderer.on("core-boot", h);
    return () => ipcRenderer.off("core-boot", h);
  },
  /** Resize this window (Window → Resize to 1500 × 900). */
  setWindowSize: (width: number, height: number) => ipcRenderer.send("set-window-size", width, height),
  revealPath: (p: string) => ipcRenderer.send("reveal-path", p),
  /** Move a file or folder to the Trash (Finder's Put Back works). */
  trashPath: (p: string): Promise<void> => ipcRenderer.invoke("trash-path", p),
  /** Trust, for good, the certificate a browser window's page was just refused for (main/certificates.ts). */
  allowCertificate: (url: string): Promise<boolean> => ipcRenderer.invoke("allow-certificate", url),
  /** An uncaught error in this page (renderer/src/lib/errors.ts). */
  reportError: (r: { kind: string; message: string; stack: string | null }) => ipcRenderer.send("renderer-error", r),
  openSettingsFile: (p: string) => ipcRenderer.send("open-settings", p),
  openKeybindingsFile: () => ipcRenderer.send("open-keybindings"),
  openDocs: () => ipcRenderer.send("open-docs"),
  /** Help → Send Feedback… (shell/Feedback.tsx). */
  feedbackStatus: (): Promise<FeedbackStatus> => ipcRenderer.invoke("feedback-status"),
  sendFeedback: (r: FeedbackRequest): Promise<void> => ipcRenderer.invoke("send-feedback", r),
  /** After an update, the first app window gets the version to show What's New since (main/whats-new.ts). */
  whatsNew: (): Promise<WhatsNewClaim> => ipcRenderer.invoke("whats-new"),
  /** The first app window after a launch gets the onboarding steps already shown (main/onboarding.ts). */
  onboarding: (): Promise<OnboardingClaim | null> => ipcRenderer.invoke("onboarding"),
  /** Onboarding steps shown (done or skipped): not shown again at launch. */
  onboardingSeen: (ids: string[]) => ipcRenderer.send("onboarding-seen", ids),
  closeWindow: () => ipcRenderer.send("close-window"),
  /** A browser window's page is shown by this webview guest now (null: none), for its inspector (main/inspector.ts, docs/59). */
  inspectorGuest: (windowId: string, guestId: number | null) => ipcRenderer.send("inspector-guest", windowId, guestId),
  /** The address of a browser window's DevTools front end; the same for the window, so a reload reconnects. */
  inspectorUrl: (windowId: string): Promise<string> => ipcRenderer.invoke("inspector-url", windowId),
  /** A browser window's page moved to another guest (or got one): its inspector reconnects. */
  onInspectorTarget(fn: (windowId: string) => void): () => void {
    const h = (_e: unknown, id: string) => fn(id);
    ipcRenderer.on("inspector-target", h);
    return () => ipcRenderer.off("inspector-target", h);
  },
  /** Inspect Element in a browser window's page (main/page-menu.ts): open or show its inspector, which reveals the node. */
  onInspectElement(fn: (windowId: string) => void): () => void {
    const h = (_e: unknown, id: string) => fn(id);
    ipcRenderer.on("inspect-element", h);
    return () => ipcRenderer.off("inspect-element", h);
  },
  /** Copy / Select All natively in the focused frame, or in a browser window's page by its WebContents id (main/app.ts). */
  editNative: (op: "copy" | "selectAll", guestId?: number) => ipcRenderer.send("edit-native", op, guestId),

  /** Menu bar / Dock menu commands, by command id. */
  onCommand(fn: (id: string) => void): () => void {
    const h = (_e: unknown, id: string) => fn(id);
    ipcRenderer.on("command", h);
    return () => ipcRenderer.off("command", h);
  },
  setMenuState: (s: MenuState) => ipcRenderer.send("menu-state", s),
  /** Links from browser windows that want a new window. */
  onOpenUrl(fn: (url: string) => void): () => void {
    const h = (_e: unknown, url: string) => fn(url);
    ipcRenderer.on("open-url", h);
    return () => ipcRenderer.off("open-url", h);
  },
  /** A page in a browser window asks for a permission (main/web-session.ts); done: its sheet is no longer needed. */
  onSitePermission(fn: (r: SitePermissionRequest) => void, done: (id: string) => void): () => void {
    const h = (_e: unknown, r: SitePermissionRequest) => fn(r);
    const d = (_e: unknown, id: string) => done(id);
    ipcRenderer.on("site-permission", h);
    ipcRenderer.on("site-permission-done", d);
    return () => (ipcRenderer.off("site-permission", h), ipcRenderer.off("site-permission-done", d));
  },
  /** Allow or Don't Allow (kept for the site); null: dismissed, asked again next time. */
  answerSitePermission: (id: string, allow: boolean | null) => ipcRenderer.send("site-permission-answer", id, allow),
  /** macOS refused cmd a device a site was allowed (once per device and launch). */
  onMediaBlocked(fn: (devices: MacDevice[]) => void): () => void {
    const h = (_e: unknown, d: MacDevice[]) => fn(d);
    ipcRenderer.on("media-blocked", h);
    return () => ipcRenderer.off("media-blocked", h);
  },
  /** System Settings → Privacy & Security at the camera's or microphone's list. */
  openMediaSettings: (d: MacDevice) => ipcRenderer.send("media-settings", d),
  /** The answers kept per site (Settings → Browser). */
  sitePermissions: (): Promise<SiteDecisions> => ipcRenderer.invoke("site-permissions"),
  /** The kept answers changed (a sheet answered, or Settings removed one). */
  onSitePermissionsChanged(fn: () => void): () => void {
    const h = () => fn();
    ipcRenderer.on("site-permissions-changed", h);
    return () => ipcRenderer.off("site-permissions-changed", h);
  },
  /** Forgets a site's answer to one permission, or all of them (null); the answers left. */
  forgetSitePermission: (site: string, kind: SitePermission | null): Promise<SiteDecisions> => ipcRenderer.invoke("site-permission-forget", site, kind),
  /** A site signed in, in the browser windows' session (main: SIGN_IN_COOKIES). */
  onSignedIn(fn: (site: string) => void): () => void {
    const h = (_e: unknown, site: string) => fn(site);
    ipcRenderer.on("signed-in", h);
    return () => ipcRenderer.off("signed-in", h);
  },
  keybindings: (): Promise<KeybindingsSnapshot> => ipcRenderer.invoke("keybindings"),
  /** Bind shortcuts to a command in keybindings.json; null restores its defaults. */
  setKeybinding: (id: string, keys: string[] | null): Promise<void> => ipcRenderer.invoke("set-keybinding", id, keys),
  /** keybindings.json back to its template: every default shortcut. */
  resetKeybindings: (): Promise<void> => ipcRenderer.invoke("reset-keybindings"),
  /** Menu shortcuts off while the Settings window records one. */
  recordShortcut: (on: boolean) => ipcRenderer.send("record-shortcut", on),
  onKeybindings(fn: (s: KeybindingsSnapshot) => void): () => void {
    const h = (_e: unknown, s: KeybindingsSnapshot) => fn(s);
    ipcRenderer.on("keybindings", h);
    return () => ipcRenderer.off("keybindings", h);
  },
  /**
   * Show a workspace (docs/11-workspaces.md). Main decides where: the app window that
   * already shows it, else this one (newWindow: a new one). select: a window to
   * select there.
   */
  showWorkspace: (workspaceId: string, o: { select?: string; newWindow?: boolean } = {}) => ipcRenderer.send("workspace-show", workspaceId, o),
  /** This window's workspace was closed or forgotten: switch it to Home, or close it if Home is shown elsewhere. */
  workspaceLost: () => ipcRenderer.send("workspace-lost"),
  /** Main tells this window which workspace to show. */
  onShowWorkspace(fn: (o: { workspaceId: string; select?: string }) => void): () => void {
    const h = (_e: unknown, o: { workspaceId: string; select?: string }) => fn(o);
    ipcRenderer.on("workspace-show", h);
    return () => ipcRenderer.off("workspace-show", h);
  },
  /** Native folder picker; null when cancelled. */
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke("choose-folder"),
  /** Native save panel (untitled text windows), starting at `defaultPath`; null when cancelled. */
  chooseSavePath: (defaultPath: string): Promise<string | null> => ipcRenderer.invoke("choose-save-path", defaultPath),
  /** Write bytes the renderer made (a Jam rendered to audio) to a path from chooseSavePath. */
  writeFile: (file: string, data: Uint8Array): Promise<void> => ipcRenderer.invoke("write-file", file, data),
  /** Native sheet; resolves true when confirmed. */
  confirm: (o: { message: string; detail?: string; confirm: string }): Promise<boolean> => ipcRenderer.invoke("confirm", o),
  /** Native sheet with only OK: something couldn't be done, and why. */
  alert: (o: { message: string; detail?: string }): Promise<void> => ipcRenderer.invoke("alert", o),
  /** The URL of a Magic widget frame whose CSP allows media from these origins (cmd-widget://, main process). */
  widgetFrame: (media: string[], kit?: number): Promise<string> => ipcRenderer.invoke("widget-frame", media, kit),
  /** Put text on the clipboard, also while the app isn't focused (navigator.clipboard needs focus): OSC 52 from a background terminal. */
  writeClipboard: (text: string) => ipcRenderer.send("clipboard-write", text),
  /** The path of a file dropped from Finder ("" for one that isn't on disk). */
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
  /** Turn the drag starting now into a native one of these files: Finder, other apps and cmd's own windows get real files (renderer/src/lib/drags.ts). */
  startFileDrag: (paths: string[]) => ipcRenderer.send("start-file-drag", paths),
  /** Native context menu; resolves with the chosen item id or null. */
  contextMenu: (items: ContextItem[]): Promise<string | null> => ipcRenderer.invoke("context-menu", items),
};

export type CmdBridge = typeof api;

bootMark("boot:preload-done");
if (ownPage) contextBridge.exposeInMainWorld("cmd", api);
else console.warn(`window.cmd is only for cmd's own pages, not ${location.href.slice(0, 200)}`);
