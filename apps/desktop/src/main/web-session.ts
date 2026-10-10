// The web content policy: what pages in browser windows (<webview> guests in
// the persist:cmd-browser session, and their pop-ups) may do. Guests get cmd's
// guest preload and no Node, only in that session; the session denies
// permissions by default and asks the person once per site for the ones that
// matter, in a sheet over the app window the page is in (renderer:
// SitePermissionSheet.tsx); the answers are kept in site-permissions.json next
// to trusted-certificates.json, and Settings → Browser lists and removes them.
// The rules themselves are in web-policy.ts.

import { app, BrowserWindow, ipcMain, session, shell, systemPreferences, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cmdHome, logger } from "@cmd/protocol/node";
import { allowedAppUrl, type AppPages } from "../shared/app-url.ts";
import { BROWSER_PARTITION, forgetDecision, guestPartitionAllowed, isAsked, macDevices, macMediaStep, macPrivacyPane, parseDecisions, permissionVerdict, siteOf, type SiteDecisions, type SitePermission, type MacAccess, type MacDevice, type SitePermissionRequest } from "./web-policy.ts";

const log = logger("web");
const here = import.meta.dirname; // apps/desktop/out/main

// Guests get no Node, only cmd's guest preload, their own session. Links that
// open new windows become new cmd browser windows; a sized window.open (sign-in
// pop-ups: Google SSO, OAuth) gets a real pop-up, which keeps window.opener so
// it can hand the result back and close itself.

/** Pages' pop-ups (not the app's windows), each with the app window it came from. Their console stays out of main.log. */
const popups = new WeakMap<WebContents, WebContents | null>();

/** The app window a guest or pop-up belongs to (where "open-url" goes). */
const appWindowOf = (contents: WebContents): WebContents | null =>
  popups.has(contents) ? popups.get(contents)! : contents.getType() === "webview" ? (contents.hostWebContents ?? null) : null;

function handleWindowOpen(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (!/^(https?|about):/i.test(url)) return { action: "deny" };
    if (disposition === "new-window") {
      const parent = BrowserWindow.fromWebContents(appWindowOf(contents) ?? contents) ?? undefined;
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          parent,
          show: true,
          autoHideMenuBar: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, safeDialogs: true },
        },
      };
    }
    if (/^https?:/i.test(url)) appWindowOf(contents)?.send("open-url", url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (child) => {
    popups.set(child.webContents, appWindowOf(contents));
    handleWindowOpen(child.webContents);
  });
}

app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (ev, prefs, params) => {
    // Web content only ever runs in the browser session: never the app's own, where cmd-file: reads media files.
    if (!guestPartitionAllowed(params.partition)) {
      log.warn(`refused a guest outside ${BROWSER_PARTITION} (${params.partition || "no partition"})`);
      return ev.preventDefault();
    }
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
  if (contents.getType() === "webview") handleWindowOpen(contents);
  // App and utility windows (pop-ups from pages are in the browser session).
  else if (contents.getType() === "window" && contents.session !== session.fromPartition(BROWSER_PARTITION)) guardAppWindow(contents);
});

// ── app and utility windows ─────────────────────────────
// They carry window.cmd, which reaches a shell: their page never changes and they
// open no windows. A web link that gets this far (one the renderer missed) opens
// in a browser window instead, like a widget's link (open-url).

let pages: { pages: AppPages; appWindows: () => BrowserWindow[] } | null = null;

function guardAppWindow(contents: WebContents): void {
  contents.on("will-navigate", (e) => {
    if (popups.has(contents) || (pages && allowedAppUrl(e.url, pages.pages))) return;
    e.preventDefault();
    log.warn(`kept an app window on its page (not ${e.url.slice(0, 200)})`);
    forward(contents, e.url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    forward(contents, url);
    return { action: "deny" };
  });
}

/** http(s) to open-url in this app window, or from Settings, in the front app window. */
function forward(contents: WebContents, url: string): void {
  if (!/^https?:/i.test(url) || !pages) return;
  const all = pages.appWindows().filter((w) => w.webContents.session === session.defaultSession && !popups.has(w.webContents));
  const to = all.find((w) => w.webContents === contents) ?? all.find((w) => w.isFocused()) ?? all[0];
  to?.webContents.send("open-url", url);
}

/**
 * Cookies that mean "signed in" to a site, by domain: when one is set in the
 * browser windows' session, every app window hears "signed-in" with the site,
 * so a page showing a sign-in wall elsewhere (the YouTube widget) can reload.
 */
const SIGN_IN_COOKIES: Record<string, string[]> = { "youtube.com": ["LOGIN_INFO", "SID", "__Secure-3PSID"] };
app.whenReady().then(() => {
  let last = 0;
  session.fromPartition(BROWSER_PARTITION).cookies.on("changed", (_e, cookie, _cause, removed) => {
    if (removed) return;
    const site = Object.keys(SIGN_IN_COOKIES).find((d) => (cookie.domain ?? "").replace(/^\./, "").endsWith(d));
    if (!site || !SIGN_IN_COOKIES[site]!.includes(cookie.name) || Date.now() - last < 2000) return;
    last = Date.now();
    for (const w of BrowserWindow.getAllWindows()) if (!popups.has(w.webContents)) w.webContents.send("signed-in", site);
  });
});
/** A page's pop-up (not one of the app's windows). */
export const isPopup = (contents: WebContents): boolean => popups.has(contents);

// ── site permissions ────────────────────────────────────

const file = () => path.join(cmdHome(), "site-permissions.json");
/** The answers as last read, and the file's mtime and size then: an edited or deleted file applies at the next request. */
let kept: { decisions: SiteDecisions; stamp: string } | null = null;

function decisions(): SiteDecisions {
  let stamp = "none";
  try {
    const st = fs.statSync(file());
    stamp = `${st.mtimeMs} ${st.size}`;
  } catch {}
  if (kept?.stamp === stamp) return kept.decisions;
  let read: SiteDecisions = {};
  try {
    if (stamp !== "none") read = parseDecisions(JSON.parse(fs.readFileSync(file(), "utf8")));
  } catch (e) {
    log.warn(`couldn't read ${file()}: ${(e as Error).message}`);
  }
  kept = { decisions: read, stamp };
  return read;
}

/** Writes the answers (only ever well-formed ones: what decisions() parsed, changed here) and tells app windows (an open Settings); false if it couldn't. */
function save(all: SiteDecisions): boolean {
  try {
    fs.writeFileSync(file(), JSON.stringify(all, null, 2));
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && fromApp(w.webContents)) w.webContents.send("site-permissions-changed");
    return true;
  } catch (e) {
    log.warn(`couldn't save ${file()}: ${(e as Error).message}`);
    return false;
  }
}

function remember(site: string, kind: SitePermission, allow: boolean): void {
  const all = { ...decisions() };
  all[site] = { ...all[site], [kind]: allow };
  save(all);
}

/**
 * Settings → Browser: forgets a site's answer to one permission, or (kind null)
 * all of its answers, so the site is asked again. Only removes: the site must be
 * an http(s) origin and the kind a permission cmd asks for, else it throws.
 */
function forget(site: unknown, kind: unknown): SiteDecisions {
  const before = decisions();
  const after = forgetDecision(before, site, kind);
  if (after === before) return before;
  if (!save(after)) throw new Error("Couldn't save the change. Check that cmd's folder is writable.");
  log.info(`forgot ${site as string} ${(kind as string | null) ?? "(all)"}`);
  return decisions();
}

/** Only the app's own windows (not pages, nor their pop-ups) may read or change the answers. */
const fromApp = (sender: WebContents) => sender.session !== session.fromPartition(BROWSER_PARTITION) && !popups.has(sender);

/** Sheets showing, by request id: answer(null) is dismissed (not kept). */
const waiting = new Map<string, { host: WebContents; answer: (allow: boolean | null) => void }>();
/** The same site asking for the same thing again while its sheet is up gets that sheet's answer. */
const asking = new Map<string, Promise<boolean>>();

function ask(page: WebContents, host: WebContents, req: Omit<SitePermissionRequest, "id">): Promise<boolean> {
  const key = `${req.site} ${req.kind}`;
  const pending = asking.get(key);
  if (pending) return pending;
  const id = randomUUID();
  const answered = new Promise<boolean>((resolve) => {
    const gone = () => answer(null);
    const answer = (allow: boolean | null) => {
      if (!waiting.delete(id)) return;
      asking.delete(key);
      page.off("destroyed", gone);
      host.off("destroyed", gone);
      host.off("did-navigate", gone);
      if (!host.isDestroyed()) host.send("site-permission-done", id);
      if (allow !== null) remember(req.site, req.kind, allow);
      log.info(`${req.site} ${req.kind}: ${allow === null ? "not answered" : allow ? "allowed" : "not allowed"}`);
      resolve(allow === true);
    };
    waiting.set(id, { host, answer });
    // The page closed, or the app window closed or reloaded (its sheet is gone).
    page.once("destroyed", gone);
    host.once("destroyed", gone);
    host.once("did-navigate", gone);
    host.send("site-permission", { id, ...req } satisfies SitePermissionRequest);
  });
  asking.set(key, answered);
  return answered;
}

// ── macOS camera and microphone ─────────────────────────

/** Devices macOS refused that the person has been told about, this launch. */
const told = new Set<MacDevice>();

/**
 * cmd's answer to a media request, passed through macOS: its prompt when it
 * hasn't decided (askForMediaAccess), else no, with a toast in the app window
 * (once per device and launch) that says where to turn it on.
 */
async function withMacAccess(allowed: boolean, mediaTypes: readonly string[] | undefined, site: string, host: WebContents | null): Promise<boolean> {
  // Fake devices (e2e) aren't the Mac's camera: macOS has nothing to say about them.
  if (process.platform !== "darwin" || app.commandLine.hasSwitch("use-fake-device-for-media-stream")) return allowed;
  const devices = macDevices(mediaTypes);
  const step = macMediaStep(allowed, devices, (d) => systemPreferences.getMediaAccessStatus(d) as MacAccess);
  if (step.kind === "allow" || step.kind === "deny") return step.kind === "allow";
  let refused = step.kind === "tell" ? step.devices : [];
  if (step.kind === "ask") {
    for (const d of step.devices) if (!(await systemPreferences.askForMediaAccess(d))) refused = [...refused, d];
    log.info(`macOS ${refused.length ? `refused ${refused.join(" and ")}` : `gave ${step.devices.join(" and ")}`} (asked for ${site})`);
  } else log.info(`macOS refuses ${refused.join(" and ")}, so ${site} doesn't get it`);
  const tell = refused.filter((d) => !told.has(d));
  if (tell.length && host && !host.isDestroyed()) {
    tell.forEach((d) => told.add(d));
    host.send("media-blocked", tell);
  }
  return !refused.length;
}

/**
 * The browser session's permission handlers and the answers from the sheet; the
 * app's own pages, which app windows stay on. Before the first window opens.
 */
export function startWebSession(o: { pages: AppPages; appWindows: () => BrowserWindow[] }): void {
  pages = o;
  const ses = session.fromPartition(BROWSER_PARTITION);
  ses.setPermissionCheckHandler((_wc, permission, origin) => permissionVerdict(permission, siteOf(origin), isAsked(permission) ? decisions() : {}) === "allow");
  ses.setPermissionRequestHandler((wc, permission, done, details) => {
    const site = siteOf(details.requestingUrl);
    const verdict = permissionVerdict(permission, site, isAsked(permission) ? decisions() : {});
    const host = wc && appWindowOf(wc);
    const media = permission === "media" && site ? (allowed: boolean) => withMacAccess(allowed, "mediaTypes" in details ? details.mediaTypes : undefined, site, host) : (allowed: boolean) => Promise.resolve(allowed);
    if (verdict !== "ask" || !site || !isAsked(permission) || !host || host.isDestroyed()) {
      if (verdict !== "allow") log.info(`denied ${permission} to ${site ?? details.requestingUrl}`);
      return void media(verdict === "allow").then(done, () => done(false));
    }
    const extra: Partial<SitePermissionRequest> = {};
    if ("mediaTypes" in details) {
      const types = details.mediaTypes ?? [];
      Object.assign(extra, { video: types.includes("video"), audio: types.includes("audio") });
    }
    if ("externalURL" in details && details.externalURL) {
      const name = app.getApplicationNameForProtocol(details.externalURL);
      if (name) extra.app = name.replace(/\.app$/, "");
    }
    void ask(wc, host, { site, kind: permission, ...extra })
      .then(media)
      .then(done, () => done(false));
  });
  ipcMain.on("site-permission-answer", (e, id: unknown, allow: unknown) => {
    const w = typeof id === "string" ? waiting.get(id) : undefined;
    if (!w || w.host !== e.sender) return;
    w.answer(allow === true ? true : allow === false ? false : null);
  });
  ipcMain.on("media-settings", (e, d: unknown) => {
    if (fromApp(e.sender) && (d === "camera" || d === "microphone")) void shell.openExternal(macPrivacyPane(d));
  });
  ipcMain.handle("site-permissions", (e) => {
    if (!fromApp(e.sender)) throw new Error("Not allowed here.");
    return decisions();
  });
  ipcMain.handle("site-permission-forget", (e, site: unknown, kind: unknown) => {
    if (!fromApp(e.sender)) throw new Error("Not allowed here.");
    return forget(site, kind);
  });
}
