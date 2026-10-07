// Mini browser window: toolbar (back, forward, reload/stop, URL) over an Electron
// <webview>. A webview is composited into the page, so it moves with the window
// layer's transforms and sheets (palette, settings) can draw over it — a native
// WebContentsView would always sit on top. Navigation and titles are reported to
// the core (window.update), so the window survives restarts. A device size
// (devices.ts, chosen from the window's menu) pins the page to that viewport,
// scaled down to fit and centred in the window. A new, blank window has no
// webview yet (about:blank would paint white): it shows a themed empty view and
// creates the webview with the first address entered.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { WebviewTag } from "electron";
import type { AppWindow } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { EmptyState, SCROLLBAR_CSS, ToolbarAddressField, ToolbarButton, ToolbarGroup, WindowToolbar, type FindResults } from "@cmd/ui";
import { registerWindowActions, setWindowStatus } from "../windowActions.ts";
import { useFind } from "../find.tsx";
import { handleEmbedMessage } from "../embed.ts";
import { deviceById, type Device } from "../devices.ts";

/** Room around an emulated device: sides and bottom, and the top (its caption). */
const PAD = 16;
const CAPTION = 28;

/** `allowpopups` as a string: React drops a bare `true` on <webview> (Electron's types say boolean). */
export const POPUPS = "true" as unknown as boolean;

const isBlank = (u: string | null | undefined): u is null | undefined | "" | "about:blank" =>
  !u || u === "about:blank";

export function BrowserView({ win, focused }: { win: AppWindow; focused: boolean }) {
  const url = typeof win.state.url === "string" ? win.state.url : null;
  const ref = useRef<WebviewTag | null>(null);
  const [address, setAddress] = useState(isBlank(url) ? "" : url);
  const [loading, setLoading] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });
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
    // Pages get the app's scrollbars, so every window's look the same.
    const ready = () => void wv.insertCSS(SCROLLBAR_CSS).catch(() => {});
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
    return () => {
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
    wv.addEventListener("found-in-page", found as never);
    return () => void wv.removeEventListener("found-in-page", found as never);
  }, [live]);
  useEffect(() => registerWindowActions(win.id, { find: live ? find.request : undefined }), [win.id, live, find.request]);

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
        {device && initial && <div className="device-caption">{caption(device, room)}</div>}
      </div>
    </div>
  );
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
