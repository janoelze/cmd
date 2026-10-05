// Native SF Symbols, rendered by macOS at the exact point size and pixel density
// shown (main process → native/sfsymbols), displayed 1:1 and tinted with
// currentColor through a CSS mask, like an AppKit template image.

import { useEffect, useState, useSyncExternalStore } from "react";
import { cmd } from "../bridge.ts";

type Img = { url: string; w: number; h: number; contain?: boolean } | null;

/** Icon sizes (points): the kit's scale. */
export { ICON } from "@cmd/ui";

// ── pixel density (re-render symbols when the window moves to another display) ──
const dprListeners = new Set<() => void>();
let dpr = Math.max(1, Math.min(3, Math.round(window.devicePixelRatio || 1)));
function watchDpr(): void {
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  mq.addEventListener(
    "change",
    () => {
      dpr = Math.max(1, Math.min(3, Math.round(window.devicePixelRatio || 1)));
      for (const fn of dprListeners) fn();
      watchDpr();
    },
    { once: true },
  );
}
watchDpr();
const useDpr = () =>
  useSyncExternalStore(
    (fn) => (dprListeners.add(fn), () => dprListeners.delete(fn)),
    () => dpr,
  );

// ── batched loading: every symbol mounted in the same frame → one request per size ──
const cache = new Map<string, Img>();
const pending = new Map<string, { names: Set<string>; size: number; weight: string; scale: number; waiters: (() => void)[] }>();

function load(name: string, size: number, weight: string, scale: number): Promise<void> {
  const key = `${name}@${size}@${weight}@${scale}`;
  if (cache.has(key)) return Promise.resolve();
  const batchKey = `${size}@${weight}@${scale}`;
  let batch = pending.get(batchKey);
  if (!batch) {
    batch = { names: new Set(), size, weight, scale, waiters: [] };
    pending.set(batchKey, batch);
    const b = batch;
    setTimeout(() => {
      pending.delete(batchKey);
      void cmd.sfSymbols({ names: [...b.names], size, weight, scale }).then(
        (r) => {
          for (const n of b.names) cache.set(`${n}@${size}@${weight}@${scale}`, r[n] ?? null);
          for (const w of b.waiters) w();
        },
        () => b.waiters.forEach((w) => w()),
      );
    }, 0);
  }
  batch.names.add(name);
  return new Promise((resolve) => batch!.waiters.push(resolve));
}

export function Symbol({
  name,
  size = 14,
  // Medium reads crisper than regular at 11–13 pt (thin strokes are mostly edge).
  weight = "medium",
  className = "",
}: {
  name: string;
  /** Point size (like a font size). */
  size?: number;
  weight?: "ultralight" | "thin" | "light" | "regular" | "medium" | "semibold" | "bold";
  className?: string;
}) {
  const scale = useDpr();
  const key = `${name}@${size}@${weight}@${scale}`;
  const [img, setImg] = useState<Img | undefined>(cache.get(key));
  useEffect(() => {
    let live = true;
    if (cache.has(key)) setImg(cache.get(key));
    else void load(name, size, weight, scale).then(() => live && setImg(cache.get(key)));
    return () => {
      live = false;
    };
  }, [key, name, size, weight, scale]);

  // The box is the rendered canvas (square, even, whole points), so the bitmap maps
  // 1:1 to device pixels and centres on whole pixels.
  const even = Math.ceil(size / 2) * 2;
  const w = img ? img.w : even;
  const h = img ? img.h : even;
  return (
    <span
      className={`sf ${className}`}
      data-symbol={name}
      data-pt={size}
      aria-hidden
      style={{
        width: w,
        height: h,
        ...(img ? { WebkitMaskImage: `url(${img.url})`, maskImage: `url(${img.url})` } : { opacity: 0 }),
        // fallback images (no native helper) aren't square: fit, don't stretch
        ...(img?.contain ? { WebkitMaskSize: "contain", maskSize: "contain" } : {}),
      }}
    />
  );
}
