// Mini browser window: toolbar (back, forward, reload/stop, URL) over an Electron
// <webview>. A webview is composited into the page, so it moves with the window
// layer's transforms and sheets (palette, settings) can draw over it — a native
// WebContentsView would always sit on top. Navigation and titles are reported to
// the core (window.update), so the window survives restarts. A device size
// (devices.ts, chosen from the window's menu) pins the page to that viewport,
// scaled down to fit and centred in the window.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { WebviewTag } from "electron";
import type { AppWindow } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { ICON, Symbol } from "./Symbol.tsx";
import { SCROLLBAR_CSS } from "../scrollbars.ts";
import { setWindowStatus } from "../windowActions.ts";
import { handleEmbedMessage } from "../embed.ts";
import { deviceById, type Device } from "../devices.ts";

/** Room around an emulated device: sides and bottom, and the top (its caption). */
const PAD = 16;
const CAPTION = 28;

export function BrowserView({ win, focused }: { win: AppWindow; focused: boolean }) {
  const url = typeof win.state.url === "string" ? win.state.url : null;
  const ref = useRef<WebviewTag | null>(null);
  const [address, setAddress] = useState(url ?? "");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });
  const input = useRef<HTMLInputElement>(null);
  // The URL the webview was created with; later navigation happens inside it.
  const [initial] = useState(url ?? "about:blank");
  const device = deviceById(typeof win.state.device === "string" ? win.state.device : undefined);
  const [initialAgent] = useState(device?.userAgent);
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
  }, [win.id]);

  // Status: "Loading…" (transient, so fast loads don't flash it; see components/Slot.tsx).
  useEffect(
    () => setWindowStatus(win.id, loading ? { label: "Loading…", key: "loading", transient: true } : null),
    [win.id, loading],
  );
  useEffect(() => () => setWindowStatus(win.id, null), [win.id]);

  // Navigation requested from elsewhere (cmd open, another client): follow it.
  useEffect(() => {
    const wv = ref.current;
    if (!wv || !url) return;
    try {
      if (wv.getURL() !== url) void wv.loadURL(url);
    } catch {
      // not attached yet; the initial src covers it
    }
  }, [url]);

  // A new, blank browser window starts with the address field focused.
  useEffect(() => {
    if (focused && initial === "about:blank") input.current?.focus();
  }, [focused, initial]);

  const go = async (text: string) => {
    try {
      const w = await cmd.call("window.update", { id: win.id, state: { url: text } });
      setEditing(false);
      ref.current?.loadURL(typeof w.state.url === "string" ? w.state.url : "about:blank");
      ref.current?.focus();
    } catch {
      input.current?.select();
    }
  };

  return (
    <div className="browser">
      <div className="window-toolbar">
        <button className="icon-btn" disabled={!nav.back} onClick={() => ref.current?.goBack()} title="Back">
          <Symbol name="chevron.left" size={ICON.toolbar} />
        </button>
        <button className="icon-btn" disabled={!nav.forward} onClick={() => ref.current?.goForward()} title="Forward">
          <Symbol name="chevron.right" size={ICON.toolbar} />
        </button>
        <button
          className="icon-btn"
          onClick={() => (loading ? ref.current?.stop() : ref.current?.reload())}
          title={loading ? "Stop" : "Reload"}
        >
          <Symbol name={loading ? "xmark" : "arrow.clockwise"} size={ICON.toolbar} />
        </button>
        <input
          ref={input}
          className="address"
          value={editing ? address : address === "about:blank" ? "" : address}
          placeholder="Enter a URL"
          spellCheck={false}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void go(address);
            if (e.key === "Escape") {
              setAddress(ref.current?.getURL() ?? url ?? "");
              ref.current?.focus();
            }
          }}
        />
        <button className="icon-btn" onClick={() => url && cmd.openPath(url)} title="Open in default browser">
          <Symbol name="safari" size={ICON.toolbar} />
        </button>
      </div>
      <div ref={stage} className={device ? "browser-stage device" : "browser-stage"}>
        <webview
          ref={ref as never}
          className="webview"
          data-embed
          src={initial}
          partition="persist:cmd-browser"
          {...(initialAgent ? { useragent: initialAgent } : {})}
          style={device ? deviceStyle(device, room) : undefined}
        />
        {device && <div className="device-caption">{caption(device, room)}</div>}
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
