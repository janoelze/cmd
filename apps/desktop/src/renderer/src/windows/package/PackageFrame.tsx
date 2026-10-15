// A frame widget's content (docs/56, "The frame surface, for pixels"): a package widget with
// `"surface": "frame"` draws its view.html in the one frame host (lib/frames.ts), a sandboxed
// iframe on cmd-widget://package/ (main/package-frames.ts) inside the kit's WebStage. The core
// says what it may load (widget.frameSource: the package folder, the grant's hosts); the page
// starts with the theme's variables, the window's state and config, and gets them again as
// they change. What it asks goes through the widget API: its state, batched (widget.frame
// state.set); every other verb and live topic through frame-api.ts, as the window's, a verb that
// needs a press only right after one in the frame (the host's gesture rule).

import { TOKENS, WebStage } from "@cmd/ui";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { configValues, type AppWindow, type WidgetEntry } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import { useFrame } from "../../lib/frames.ts";
import { PlacementContext } from "../registry.ts";
import { openFrameApi, type FrameApi } from "./frame-api.ts";

/** How long state.set from a frame waits for more before it goes to the core (a slider sends many). */
const STATE_BATCH_MS = 300;

export function PackageFrame({ win, entry, active, reload }: { win: AppWindow; entry: WidgetEntry | undefined; active: boolean; reload: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [painted, setPainted] = useState(false);
  const kv = (win.state.kv as Record<string, unknown> | undefined) ?? {};
  const config = configOf(entry, win);
  const latest = useRef({ kv, config });
  latest.current = { kv, config };
  const grant = JSON.stringify(entry?.ask ?? null) + JSON.stringify(entry?.permissions ?? null);
  const placement = useContext(PlacementContext);
  /** The page's widget API, one per load of its URL. */
  const api = useRef<FrameApi | null>(null);

  // The page's URL: asked again when the grant changes or the package reloads (a save, a restart).
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    setPainted(false);
    void cmd
      .call("widget.frameSource", { windowId: win.id })
      .then((s) => (s && live ? cmd.packageFrame({ dir: s.dir, media: s.media, init: { ...themeOf(ref.current?.parentElement), state: latest.current.kv, config: latest.current.config, placement } }) : null))
      .then((u) => {
        url = u;
        if (live) setSrc(u);
        else if (u) cmd.releasePackageFrame(u);
      })
      .catch((e: Error) => console.warn(`widget ${win.id}: its frame couldn't start: ${e.message}`));
    return () => {
      live = false;
      if (url) cmd.releasePackageFrame(url);
    };
  }, [win.id, grant, reload]);
  // Before paint, as the frame host listens: the page's first call finds its API.
  useLayoutEffect(() => {
    if (!src) return;
    const a = openFrameApi(win.id, (m) => post(m));
    api.current = a;
    return () => {
      a.close();
      if (api.current === a) api.current = null;
    };
  }, [win.id, src]);

  // state.set from the page, a moment later in one go.
  const pending = useRef(new Map<string, unknown>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = () => {
    timer.current = null;
    for (const [key, value] of pending.current)
      void cmd.call("widget.frame", { windowId: win.id, verb: "state.set", params: [key, value] }).then(
        (r) => r.ok || console.warn(`widget ${win.id}: ${r.error.message}`),
        (e: Error) => console.warn(`widget ${win.id}: ${e.message}`),
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
      } else if (m.type === "state" && typeof m.key === "string" && m.key.length <= 200) {
        pending.current.set(m.key, m.value ?? null);
        timer.current ??= setTimeout(flush, STATE_BATCH_MS);
      } else if (m.type === "error") console.warn(`widget ${win.id}: ${String(m.message).slice(0, 300)}`);
    },
    { active, wantsPress: (m) => api.current?.wantsPress(m) ?? false },
  );

  // What changes while it runs: the window's state, its config, the theme.
  const kvText = JSON.stringify(kv);
  useEffect(() => void (painted && post({ type: "state", state: latest.current.kv })), [painted, kvText]);
  const configText = JSON.stringify(config);
  useEffect(() => void (painted && post({ type: "config", config: latest.current.config })), [painted, configText]);
  useEffect(() => {
    if (!painted) return;
    const send = () => post({ type: "theme", ...themeOf(ref.current?.parentElement) });
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
    <WebStage>
      {src && <iframe key={src} ref={ref} data-embed data-painted={painted || undefined} sandbox="allow-scripts" src={src} title={win.title} />}
    </WebStage>
  );
}

/** The window's config as the page sees it: the manifest's defaults, then the person's values; never a secret. */
const configOf = (entry: WidgetEntry | undefined, win: AppWindow): Record<string, unknown> => configValues(entry?.config, win.state.config as Record<string, unknown> | undefined);

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
