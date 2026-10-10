// The web content policy: what pages in browser windows (<webview> guests in
// the persist:cmd-browser session, and their pop-ups) may do. Guests get cmd's
// guest preload and no Node, only in that session; the session denies
// permissions by default and asks the person once per site for the ones that
// matter, in a sheet over the app window the page is in (renderer:
// SitePermissionSheet.tsx); the answers are kept in site-permissions.json next
// to trusted-certificates.json. The rules themselves are in web-policy.ts.

import { app, BrowserWindow, ipcMain, session, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cmdHome, logger } from "@cmd/protocol/node";
import { BROWSER_PARTITION, guestPartitionAllowed, isAsked, parseDecisions, permissionVerdict, siteOf, type SiteDecisions, type SitePermission, type SitePermissionRequest } from "./web-policy.ts";

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
});

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
let kept: SiteDecisions | null = null;

function decisions(): SiteDecisions {
  if (kept) return kept;
  try {
    kept = parseDecisions(JSON.parse(fs.readFileSync(file(), "utf8")));
  } catch {
    kept = {};
  }
  return kept;
}

function remember(site: string, kind: SitePermission, allow: boolean): void {
  const all = decisions();
  all[site] = { ...all[site], [kind]: allow };
  try {
    fs.writeFileSync(file(), JSON.stringify(all, null, 2));
  } catch (e) {
    log.warn(`couldn't save ${file()}: ${(e as Error).message}`);
  }
}

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

/** The browser session's permission handlers, and the answers from the sheet. */
export function startWebSession(): void {
  const ses = session.fromPartition(BROWSER_PARTITION);
  ses.setPermissionCheckHandler((_wc, permission, origin) => permissionVerdict(permission, siteOf(origin), decisions()) === "allow");
  ses.setPermissionRequestHandler((wc, permission, done, details) => {
    const site = siteOf(details.requestingUrl);
    const verdict = permissionVerdict(permission, site, decisions());
    const host = wc && appWindowOf(wc);
    if (verdict !== "ask" || !site || !isAsked(permission) || !host || host.isDestroyed()) {
      if (verdict !== "allow") log.info(`denied ${permission} to ${site ?? details.requestingUrl}`);
      return done(verdict === "allow");
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
    void ask(wc, host, { site, kind: permission, ...extra }).then(done);
  });
  ipcMain.on("site-permission-answer", (e, id: unknown, allow: unknown) => {
    const w = typeof id === "string" ? waiting.get(id) : undefined;
    if (!w || w.host !== e.sender) return;
    w.answer(allow === true ? true : allow === false ? false : null);
  });
}
