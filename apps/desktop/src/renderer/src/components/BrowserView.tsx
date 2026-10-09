// Mini browser window: toolbar (back, forward, reload/stop, URL) over an Electron
// <webview>. A webview is composited into the page, so it moves with the window
// layer's transforms and sheets (palette, settings) can draw over it — a native
// WebContentsView would always sit on top. Navigation and titles are reported to
// the core (window.update), so the window survives restarts. A device size
// (devices.ts, chosen from the window's menu) pins the page to that viewport,
// scaled down to fit and centred in the window. A new, blank window has no
// webview yet (about:blank would paint white): it shows a themed empty view and
// creates the webview with the first address entered. A page that fails to load
// (offline, no server, a certificate this Mac doesn't trust) shows why over the
// webview, which would otherwise stay white; certificates: main/certificates.ts.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { WebviewTag } from "electron";
import type { AppWindow } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { Button, EmptyState, PAGE_SCROLLBAR_CSS, scrollbarScript, ToolbarAddressField, ToolbarButton, ToolbarGroup, WindowToolbar, type FindResults } from "@cmd/ui";
import { registerWindowActions, setWindowStatus } from "../windowActions.ts";
import { useFind } from "../find.tsx";
import { handleEmbedMessage } from "../embed.ts";
import { deviceById, type Device } from "../devices.ts";

/** Room around an emulated device: sides and bottom, and the top (its caption). */
const PAD = 16;
const CAPTION = 28;

/** `allowpopups` as a string: React drops a bare `true` on <webview> (Electron's types say boolean). */
export const POPUPS = "true" as unknown as boolean;

/** A main-frame load that failed: what the browser window shows instead of a white page. */
type Failure = { url: string; code: number };

/** Chromium's certificate errors (net_error_list.h: -200 to -299). */
const isCertError = (code: number) => code <= -200 && code > -300;

const isBlank = (u: string | null | undefined): u is null | undefined | "" | "about:blank" =>
  !u || u === "about:blank";

export function BrowserView({ win, focused }: { win: AppWindow; focused: boolean }) {
  const url = typeof win.state.url === "string" ? win.state.url : null;
  const ref = useRef<WebviewTag | null>(null);
  const [address, setAddress] = useState(isBlank(url) ? "" : url);
  const [loading, setLoading] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [failed, setFailed] = useState<Failure | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const device = deviceById(typeof win.state.device === "string" ? win.state.device : undefined);
  // What the webview was created with (null: not yet, the window is blank); later navigation happens inside it.
  const [initial, setInitial] = useState(() => (isBlank(url) ? null : { src: url, agent: device?.userAgent }));
  const live = initial !== null;
  const stage = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setRoom({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A device's own user agent (phones), else the app's; the page reloads so the site sees it.
  const agent = device?.userAgent;
  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const want = agent ?? navigator.userAgent;
    try {
      if (wv.getUserAgent() === want) return;
      wv.setUserAgent(want);
      wv.reload();
    } catch {
      // not attached yet; the initial useragent attribute covers it
    }
  }, [agent]);

  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const navigated = (e: { url: string }) => {
      setAddress(e.url);
      setNav({ back: wv.canGoBack(), forward: wv.canGoForward() });
      void cmd.call("window.update", { id: win.id, state: { url: e.url } }).catch(() => {});
    };
    const titled = (e: { title: string }) => void cmd.call("window.update", { id: win.id, title: e.title }).catch(() => {});
    const start = () => setLoading(true);
    const stop = () => setLoading(false);
    // ERR_ABORTED (-3) is a load another navigation replaced, or a download: not a failure.
    const failedLoad = (e: { errorCode: number; validatedURL: string; isMainFrame: boolean }) => {
      if (!e.isMainFrame || e.errorCode === -3) return;
      setFailed({ url: e.validatedURL, code: e.errorCode });
      setAddress(e.validatedURL);
    };
    const starting = (e: { isMainFrame: boolean; isInPlace: boolean }) => e.isMainFrame && !e.isInPlace && setFailed(null);
    // Pages get the app's scrollbars (drawn over them, and fading), so every window's look the same.
    const ready = () => {
      // Shown once it has something to show: it fades in over the window's well instead of
      // flashing white (styles.css .webview).
      wv.setAttribute("data-painted", "");
      void wv.insertCSS(PAGE_SCROLLBAR_CSS).catch(() => {});
      void wv.executeJavaScript(scrollbarScript({ always: cmd.scrollBars === "always" })).catch(() => {});
    };
    // What the page's preload reports (preload/guest.ts): presses, sideways scrolls.
    const reported = (e: { channel: string; args: unknown[] }) => {
      if (e.channel === "cmd-embed") handleEmbedMessage(wv as unknown as HTMLElement, e.args[0]);
    };
    wv.addEventListener("ipc-message", reported as never);
    wv.addEventListener("dom-ready", ready);
    wv.addEventListener("did-navigate", navigated as never);
    wv.addEventListener("did-navigate-in-page", navigated as never);
    wv.addEventListener("page-title-updated", titled as never);
    wv.addEventListener("did-start-loading", start);
    wv.addEventListener("did-stop-loading", stop);
    wv.addEventListener("did-fail-load", failedLoad as never);
    wv.addEventListener("did-start-navigation", starting as never);
    return () => {
      wv.removeEventListener("did-fail-load", failedLoad as never);
      wv.removeEventListener("did-start-navigation", starting as never);
      wv.removeEventListener("did-navigate", navigated as never);
      wv.removeEventListener("did-navigate-in-page", navigated as never);
      wv.removeEventListener("page-title-updated", titled as never);
      wv.removeEventListener("did-start-loading", start);
      wv.removeEventListener("did-stop-loading", stop);
      wv.removeEventListener("dom-ready", ready);
      wv.removeEventListener("ipc-message", reported as never);
    };
  }, [win.id, live]);

  // Status: "Loading…" (transient, so fast loads don't flash it; see components/Slot.tsx).
  useEffect(
    () => setWindowStatus(win.id, loading ? { label: "Loading…", key: "loading", transient: true } : null),
    [win.id, loading],
  );
  useEffect(() => () => setWindowStatus(win.id, null), [win.id]);

  // Navigation requested from elsewhere (cmd open, another client), or the first
  // address entered in a blank window: follow it.
  useEffect(() => {
    if (isBlank(url)) return;
    const wv = ref.current;
    if (!wv) {
      setInitial((cur) => cur ?? { src: url, agent });
      return;
    }
    try {
      if (wv.getURL() !== url) wv.loadURL(url).catch(() => {});
    } catch {
      // not attached yet; the initial src covers it
    }
  }, [url]);

  // A blank browser window has the address field focused.
  useEffect(() => {
    if (focused && !live) input.current?.focus();
  }, [focused, live]);

  // Find in the page: Chromium's own find, which counts as it goes (found-in-page). Case only.
  const report = useRef<(r: FindResults | null) => void>(() => {});
  const lastQuery = useRef("");
  const lastCase = useRef(false);
  const find = useFind({
    supports: { wholeWord: false, regex: false },
    find: (query, o, step, r) => {
      const wv = ref.current;
      report.current = r;
      if (!wv) return r(query ? { index: -1, count: 0 } : null);
      if (!query) return (wv.stopFindInPage("clearSelection"), (lastQuery.current = ""));
      // A new query (or new options) starts a find session; a step continues it.
      const fresh = step === 0 || query !== lastQuery.current;
      lastQuery.current = query;
      lastCase.current = o.caseSensitive;
      wv.findInPage(query, { forward: step >= 0, findNext: fresh, matchCase: o.caseSensitive });
    },
    clear: () => {
      lastQuery.current = "";
      ref.current?.stopFindInPage("clearSelection");
    },
    selection: async () => (await ref.current?.executeJavaScript("String(getSelection())").catch(() => "")) ?? "",
  }, { placeholder: "Find in Page", onClose: () => ref.current?.focus() });
  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const found = (e: { result: { activeMatchOrdinal: number; matches: number } }) => report.current({ index: e.result.activeMatchOrdinal - 1, count: e.result.matches });
    // A new page (a link, a reload, one still loading when you typed): find in it too.
    const loaded = () => lastQuery.current && wv.findInPage(lastQuery.current, { findNext: true, matchCase: lastCase.current });
    wv.addEventListener("found-in-page", found as never);
    wv.addEventListener("did-stop-loading", loaded);
    return () => (wv.removeEventListener("found-in-page", found as never), void wv.removeEventListener("did-stop-loading", loaded));
  }, [live]);
  useEffect(() => registerWindowActions(win.id, { find: live ? find.request : undefined }), [win.id, live, find.request]);

  const retry = () => failed && ref.current?.loadURL(failed.url).catch(() => {});
  const proceed = async () => {
    if (failed && (await cmd.allowCertificate(failed.url))) retry();
  };

  const go = async (text: string) => {
    try {
      const w = await cmd.call("window.update", { id: win.id, state: { url: text } });
      const next = typeof w.state.url === "string" ? w.state.url : null;
      if (isBlank(next)) return;
      if (!ref.current) return setInitial({ src: next, agent });
      // Rejects when the load fails or another navigation supersedes it; the webview shows that itself.
      ref.current.loadURL(next).catch(() => {});
      ref.current.focus();
    } catch {
      input.current?.focus();
    }
  };

  return (
    <div className="browser">
      <WindowToolbar label="Browser">
        <ToolbarGroup>
          <ToolbarButton icon="chevron.left" label="Back" disabled={!nav.back} onClick={() => ref.current?.goBack()} />
          <ToolbarButton icon="chevron.right" label="Forward" disabled={!nav.forward} onClick={() => ref.current?.goForward()} />
          <ToolbarButton icon={loading ? "xmark" : "arrow.clockwise"} label={loading ? "Stop" : "Reload"} disabled={!live} onClick={() => (loading ? ref.current?.stop() : ref.current?.reload())} priority={2} />
        </ToolbarGroup>
        <ToolbarAddressField
          ref={input}
          value={isBlank(address) ? "" : address}
          placeholder="Enter a URL"
          minWidth={90}
          onSubmit={(text) => {
            setAddress(text);
            void go(text);
          }}
          onEscape={() => ref.current?.focus()}
        />
        <ToolbarButton icon="safari" label="Open in Default Browser" disabled={!live} onClick={() => url && cmd.openPath(url)} secondary priority={1} />
      </WindowToolbar>
      {find.bar}
      <div ref={stage} className={device ? "browser-stage device" : "browser-stage"}>
        {initial ? (
          <webview
            ref={ref as never}
            className="webview"
            data-embed
            src={initial.src}
            partition="persist:cmd-browser"
            // Lets pages open windows (target=_blank, window.open): main turns them into browser windows.
            allowpopups={POPUPS}
            {...(initial.agent ? { useragent: initial.agent } : {})}
            style={device ? deviceStyle(device, room) : undefined}
          />
        ) : (
          <EmptyState className="browser-blank" icon="globe" title="New Tab" onMouseDown={(e) => (e.preventDefault(), input.current?.focus())}>
            Type a web address, localhost:3000, or a file path
          </EmptyState>
        )}
        {failed && (
          <EmptyState
            className="browser-failed"
            icon={isCertError(failed.code) ? "lock.slash" : "exclamationmark.triangle.fill"}
            title={isCertError(failed.code) ? "Connection Not Private" : "Page Didn't Load"}
            action={
              <>
                {isCertError(failed.code) && <Button size="sm" onClick={() => void proceed()}>Continue Anyway</Button>}
                <Button size="sm" onClick={retry}>Try Again</Button>
              </>
            }
          >
            {failureText(failed)}
          </EmptyState>
        )}
        {device && initial && <div className="device-caption">{caption(device, room)}</div>}
      </div>
    </div>
  );
}

function failureText(f: Failure): string {
  let host = f.url;
  try {
    host = new URL(f.url).host || f.url;
  } catch {
    // not a URL; show it as typed
  }
  if (isCertError(f.code)) return `This Mac doesn't trust the certificate of ${host}. Continue only if you know the site, like your company's own servers.`;
  switch (f.code) {
    case -105:
    case -137:
      return `Couldn't find ${host}. Check the address.`;
    case -102:
      return `${host} refused the connection. Is the server running?`;
    case -106:
      return "You're offline. Check your connection and try again.";
    case -7:
    case -118:
      return `${host} took too long to respond.`;
    case -6:
      return "That file doesn't exist.";
    default:
      return `${host} couldn't be reached.`;
  }
}

const scaleFor = (d: Device, room: { w: number; h: number }) =>
  Math.min(1, Math.max(0.1, (room.w - 2 * PAD) / d.width), Math.max(0.1, (room.h - CAPTION - PAD) / d.height));

/** The page at the device's size, scaled to fit and centred below the caption. */
function deviceStyle(d: Device, room: { w: number; h: number }): CSSProperties {
  const s = scaleFor(d, room);
  return {
    position: "absolute",
    left: Math.max(PAD, (room.w - d.width * s) / 2),
    top: CAPTION,
    width: d.width,
    height: d.height,
    flex: "none",
    transform: `scale(${s})`,
    transformOrigin: "0 0",
  };
}

function caption(d: Device, room: { w: number; h: number }): string {
  const pct = Math.round(scaleFor(d, room) * 100);
  return `${d.name} · ${d.width}×${d.height}${pct < 100 ? ` · ${pct}%` : ""}`;
}
