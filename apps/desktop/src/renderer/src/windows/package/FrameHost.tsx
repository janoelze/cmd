// A package's page in a sandboxed frame (docs/56, "The frame surface"): what a frame widget's
// window (PackageFrame.tsx) and a Frame element of a tree (FrameElement.tsx, API 1.2) both draw,
// one implementation over the one frame host (lib/frames.ts). Its iframe sits in the kit's
// WebStage on cmd-widget://package/ (main/package-frames.ts, which `serve` asks for the URL);
// the page starts with the theme's variables, the window's state and config and the element's
// data, and gets them again as they change (the theme follows the app's). With `windowId` its
// `cmd` reaches the widget API (frame-api.ts, a new frame id per load) and its state goes to the
// window, batched; without one (a story) it draws, and its calls are refused. What the page
// posts with `cmd.post` goes to `onPost`. Each host has its own iframe, token and Gesture.

import { TOKENS, WebStage } from "@cmd/ui";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { WindowId } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import { useFrame } from "../../lib/frames.ts";
import type { PackageFrameRequest } from "../../../../shared/ipc.ts";
import { openFrameApi, type FrameApi } from "./frame-api.ts";

/** How long state.set from a frame waits for more before it goes to the core (a slider sends many). */
const STATE_BATCH_MS = 300;

/** What a page starts with. */
export type FrameInit = PackageFrameRequest["init"];

export interface FrameHostProps {
  /** The window whose widget API the page uses; null: none (its calls are refused). */
  windowId: WindowId | null;
  /** The iframe's accessible name. */
  title: string;
  /** The page's URL for these first values (main serves it), or null when there is none to show. */
  serve(init: FrameInit): Promise<string | null>;
  /** The page loads again when this changes (a grant, a save, another page). */
  reloadKey: string;
  /** Its window is the selected one (the Gesture's rule). */
  active: boolean;
  /** The window's state and config, as the page sees them. */
  kv: Record<string, unknown>;
  config: Record<string, unknown>;
  placement?: "board" | "sidebar";
  /** A Frame element's data (null for a frame widget's page). */
  data?: unknown;
  /** The page sent a value (`cmd.post`). */
  onPost?(value: unknown): void;
  style?: CSSProperties;
}

export function FrameHost({ windowId, title, serve, reloadKey, active, kv, config, placement, data = null, onPost, style }: FrameHostProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [painted, setPainted] = useState(false);
  const latest = useRef({ kv, config, data, onPost, serve, placement });
  latest.current = { kv, config, data, onPost, serve, placement };
  /** The page's widget API, one per load of its URL. */
  const api = useRef<FrameApi | null>(null);

  // The page's URL, asked again when reloadKey changes.
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    setPainted(false);
    const l = latest.current;
    void l
      .serve({ ...themeOf(stage.current), state: l.kv, config: l.config, data: l.data, ...(l.placement ? { placement: l.placement } : {}) })
      .then((u) => {
        url = u;
        if (live) setSrc(u);
        else if (u) cmd.releasePackageFrame(u);
      })
      .catch((e: Error) => console.warn(`widget ${windowId ?? "story"}: its frame couldn't start: ${e.message}`));
    return () => {
      live = false;
      if (url) cmd.releasePackageFrame(url);
    };
  }, [reloadKey]);
  // Before paint, as the frame host listens: the page's first call finds its API.
  useLayoutEffect(() => {
    if (!src || !windowId) return;
    const a = openFrameApi(windowId, (m) => post(m));
    api.current = a;
    return () => {
      a.close();
      if (api.current === a) api.current = null;
    };
  }, [windowId, src]);

  // state.set from the page, a moment later in one go.
  const pending = useRef(new Map<string, unknown>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = () => {
    timer.current = null;
    if (windowId)
      for (const [key, value] of pending.current)
        void cmd.call("widget.frame", { windowId, verb: "state.set", params: [key, value] }).then(
          (r) => r.ok || console.warn(`widget ${windowId}: ${r.error.message}`),
          (e: Error) => console.warn(`widget ${windowId}: ${e.message}`),
        );
    pending.current.clear();
  };
  useEffect(() => () => void (timer.current && (clearTimeout(timer.current), flush())), []);

  const post = useFrame(
    ref,
    (m, pressed) => {
      if (api.current?.message(m, pressed)) return;
      if (m.type === "ready") {
        setPainted(true);
        post({ type: "state", state: latest.current.kv });
        post({ type: "data", data: latest.current.data });
      } else if (m.type === "state" && typeof m.key === "string" && m.key.length <= 200) {
        pending.current.set(m.key, m.value ?? null);
        timer.current ??= setTimeout(flush, STATE_BATCH_MS);
      } else if (m.type === "post") latest.current.onPost?.(m.value ?? null);
      else if (m.type === "error") console.warn(`widget ${windowId ?? "story"}: ${String(m.message).slice(0, 300)}`);
    },
    { active, wantsPress: (m) => api.current?.wantsPress(m) ?? false },
  );

  // What changes while it runs: the window's state, its config, the element's data, the theme.
  const kvText = JSON.stringify(kv);
  useEffect(() => void (painted && post({ type: "state", state: latest.current.kv })), [painted, kvText]);
  const configText = JSON.stringify(config);
  useEffect(() => void (painted && post({ type: "config", config: latest.current.config })), [painted, configText]);
  const dataText = JSON.stringify(data);
  useEffect(() => void (painted && post({ type: "data", data: latest.current.data })), [painted, dataText]);
  useEffect(() => {
    if (!painted) return;
    const send = () => post({ type: "theme", ...themeOf(stage.current) });
    send();
    const o = new MutationObserver(send);
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-appearance"] });
    return () => o.disconnect();
  }, [painted]);
  // Never stay hidden if the page doesn't say it's ready.
  useEffect(() => {
    if (!src) return;
    const t = setTimeout(() => setPainted(true), 1500);
    return () => clearTimeout(t);
  }, [src]);

  return (
    <WebStage ref={stage} style={style}>
      {src && <iframe key={src} ref={ref} data-embed data-painted={painted || undefined} sandbox="allow-scripts" src={src} title={title} />}
    </WebStage>
  );
}

/** The theme where the frame is drawn: every design token's value there, and the appearance. */
function themeOf(at: Element | null | undefined): { appearance: "dark" | "light"; vars: Record<string, string> } {
  const style = getComputedStyle(at ?? document.documentElement);
  const vars: Record<string, string> = {};
  for (const t of TOKENS) {
    const v = style.getPropertyValue(t.name).trim();
    if (v) vars[t.name] = v;
  }
  return { appearance: document.documentElement.dataset.appearance === "light" ? "light" : "dark", vars };
}
