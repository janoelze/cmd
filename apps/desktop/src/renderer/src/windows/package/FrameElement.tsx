// The Frame element (API 1.2; protocol widget-elements-1.2.ts): a page of the widget's package
// inside its tree, drawn by the shared frame host (FrameHost.tsx) with the window's widget API,
// its own iframe, token and Gesture, so several can share a window. What it needs to draw comes
// from FramesContext, which the package view gives a live window (PackageView.tsx) and a story
// gives its own page; without one (Magic's preview, a package's story, the phone) its label
// stands in, so a tree stays drawable without running pixels. `data` goes to the page as it
// changes; what the page posts (`cmd.post`) goes to the process as onMessage, plain data only
// and at most POSTS_PER_SECOND, and never as a press (the core's press model).

import { EmptyState } from "@cmd/ui";
import { createContext, useContext, useRef } from "react";
import { checkValue, type WindowId, type WireValue } from "@cmd/protocol";
import { on, str, type Drawn } from "./draw.ts";
import { FrameHost, type FrameInit } from "./FrameHost.tsx";

/** What a window gives its Frames to draw with. */
export interface Frames {
  /** The window whose widget API the pages use; null: none (a story). */
  windowId: WindowId | null;
  /** A page of the package (its `src`), served with these first values. */
  serve(src: string, init: FrameInit): Promise<string | null>;
  /** The pages load again when this changes (a grant, the process restarting). */
  reloadKey: string;
  active: boolean;
  kv: Record<string, unknown>;
  config: Record<string, unknown>;
  placement?: "board" | "sidebar";
}

export const FramesContext = createContext<Frames | null>(null);

/** Messages a page may send its process a second. */
export const POSTS_PER_SECOND = 20;

export function FrameElement({ p, ctx }: Drawn) {
  const frames = useContext(FramesContext);
  const src = str(p.src) ?? "";
  const label = str(p.label) ?? "";
  const height = typeof p.height === "number" && p.height > 0 ? Math.min(p.height, 4000) : undefined;
  const send = on(ctx, p.onMessage, "onMessage");
  const sent = useRef<number[]>([]);
  if (!frames || !src) return <EmptyState icon="rectangle.dashed" title={label || "Frame"} compact>Drawn in the widget's window.</EmptyState>;
  const onPost = (value: unknown) => {
    if (!send) return;
    const now = Date.now();
    sent.current = sent.current.filter((t) => now - t < 1000);
    if (sent.current.length >= POSTS_PER_SECOND) return void console.warn(`widget ${ctx.windowId}: its frame posts more than ${POSTS_PER_SECOND} a second; some were dropped`);
    const c = checkValue("value", value);
    if (!c.ok) return void console.warn(`widget ${ctx.windowId}: its frame posted ${c.why}`);
    sent.current.push(now);
    send(c.value as WireValue);
  };
  return (
    <FrameHost
      windowId={frames.windowId}
      title={label}
      serve={(init) => frames.serve(src, init)}
      reloadKey={`${frames.reloadKey}\n${src}`}
      active={frames.active}
      kv={frames.kv}
      config={frames.config}
      placement={frames.placement}
      data={p.data ?? null}
      onPost={onPost}
      style={height ? { flex: "none", height, background: "transparent" } : { minHeight: "var(--frame-min-h)", background: "transparent" }}
    />
  );
}
