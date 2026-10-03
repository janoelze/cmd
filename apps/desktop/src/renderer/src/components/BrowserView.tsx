// Mini browser window: toolbar (back, forward, reload/stop, URL) over an Electron
// <webview>. A webview is composited into the page, so it moves with the window
// layer's transforms and sheets (palette, settings) can draw over it — a native
// WebContentsView would always sit on top. Navigation and titles are reported to
// the core (window.update), so the window survives restarts.

import { useEffect, useRef, useState } from "react";
import type { WebviewTag } from "electron";
import type { AppWindow } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { Symbol } from "./Symbol.tsx";

export function BrowserView({ win, focused }: { win: AppWindow; focused: boolean }) {
  const ref = useRef<WebviewTag | null>(null);
  const [address, setAddress] = useState(win.url ?? "");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });
  const input = useRef<HTMLInputElement>(null);
  // The URL the webview was created with; later navigation happens inside it.
  const [initial] = useState(win.url ?? "about:blank");

  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const navigated = (e: { url: string }) => {
      setAddress(e.url);
      setNav({ back: wv.canGoBack(), forward: wv.canGoForward() });
      void cmd.call("window.update", { id: win.id, url: e.url }).catch(() => {});
    };
    const titled = (e: { title: string }) => void cmd.call("window.update", { id: win.id, title: e.title }).catch(() => {});
    const start = () => setLoading(true);
    const stop = () => setLoading(false);
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
    };
  }, [win.id]);

  // Navigation requested from elsewhere (cmd open, another client): follow it.
  useEffect(() => {
    const wv = ref.current;
    if (!wv || !win.url) return;
    try {
      if (wv.getURL() !== win.url) void wv.loadURL(win.url);
    } catch {
      // not attached yet; the initial src covers it
    }
  }, [win.url]);

  // A new, blank browser window starts with the address field focused.
  useEffect(() => {
    if (focused && initial === "about:blank") input.current?.focus();
  }, [focused, initial]);

  const go = async (text: string) => {
    try {
      const w = await cmd.call("window.update", { id: win.id, url: text });
      setEditing(false);
      ref.current?.loadURL(w.url ?? "about:blank");
      ref.current?.focus();
    } catch {
      input.current?.select();
    }
  };

  return (
    <div className="browser">
      <div className="window-toolbar">
        <button className="icon-btn" disabled={!nav.back} onClick={() => ref.current?.goBack()} title="Back">
          <Symbol name="chevron.left" size={13} />
        </button>
        <button className="icon-btn" disabled={!nav.forward} onClick={() => ref.current?.goForward()} title="Forward">
          <Symbol name="chevron.right" size={13} />
        </button>
        <button
          className="icon-btn"
          onClick={() => (loading ? ref.current?.stop() : ref.current?.reload())}
          title={loading ? "Stop" : "Reload"}
        >
          <Symbol name={loading ? "xmark" : "arrow.clockwise"} size={13} />
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
              setAddress(ref.current?.getURL() ?? win.url ?? "");
              ref.current?.focus();
            }
          }}
        />
        <button className="icon-btn" onClick={() => win.url && cmd.openPath(win.url)} title="Open in default browser">
          <Symbol name="safari" size={13} />
        </button>
      </div>
      <webview ref={ref as never} className="webview" src={initial} partition="persist:cmd-browser" />
    </div>
  );
}
