// Infinite canvas: camera maths, placement and framing, as pure functions.
// Windows have rects in world coordinates (px at zoom 1). The camera is the
// world point at the viewport's top-left plus a zoom; screen = (world - cam) * zoom.

import { gridShape } from "./model.ts";
import type { Rect, Viewport } from "./layouts.ts";

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2;
/** Below this zoom windows are drawn as cards (title, status, last lines), not live. */
export const CARD_ZOOM = 0.45;
/** The background's dot spacing: window edges, sizes and gaps all land on it. */
export const DOT = 24;
export const DEFAULT_W = 30 * DOT;
export const DEFAULT_H = 19 * DOT;
export const MIN_W = 14 * DOT;
export const MIN_H = 8 * DOT;
/** Spacing between placed windows, and the grid moves/resizes snap to. */
export const GAP = DOT;
export const SNAP = DOT;
/** Space kept around windows when framing them. */
export const FRAME_PAD = 48;

export const DEFAULT_CAMERA: Camera = { x: -FRAME_PAD, y: -FRAME_PAD, zoom: 1 };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const clampZoom = (z: number) => clamp(z, MIN_ZOOM, MAX_ZOOM);
export const snap = (v: number, step = SNAP) => Math.round(v / step) * step;

export function toWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: cam.x + sx / cam.zoom, y: cam.y + sy / cam.zoom };
}

/** Zoom by a factor, keeping the world point under screen (sx, sy) fixed. */
export function zoomAt(cam: Camera, factor: number, sx: number, sy: number): Camera {
  const zoom = clampZoom(cam.zoom * factor);
  const p = toWorld(cam, sx, sy);
  return { x: p.x - sx / zoom, y: p.y - sy / zoom, zoom };
}

export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

export function bounds(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const r = Math.max(...rects.map((r) => r.x + r.w));
  const b = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: r - x, h: b - y };
}

/**
 * A free spot for a new window: next to `near` (right, then below, left, above),
 * else next to the closest window that has room. Never overlaps existing windows.
 */
export function place(existing: Rect[], near: Rect | null, w = DEFAULT_W, h = DEFAULT_H): Rect {
  if (existing.length === 0) return { x: 0, y: 0, w, h };
  const anchor = near ?? existing[existing.length - 1]!;
  const around = (r: Rect): Rect[] => [
    { x: r.x + r.w + GAP, y: r.y, w, h },
    { x: r.x, y: r.y + r.h + GAP, w, h },
    { x: r.x - w - GAP, y: r.y, w, h },
    { x: r.x, y: r.y - h - GAP, w, h },
  ];
  const cx = anchor.x + anchor.w / 2;
  const cy = anchor.y + anchor.h / 2;
  const dist = (r: Rect) => Math.hypot(r.x + w / 2 - cx, r.y + h / 2 - cy);
  // The anchor's own neighbours first, in that order; then the nearest anywhere.
  const free = (r: Rect) => !existing.some((e) => overlaps(r, e, GAP - 1));
  const first = around(anchor).find(free);
  if (first) return first;
  const candidates = existing.flatMap(around).filter(free).sort((a, b) => dist(a) - dist(b));
  if (candidates[0]) return candidates[0];
  const all = bounds(existing)!;
  return { x: all.x + all.w + GAP, y: anchor.y, w, h }; // unreachable in practice
}

/**
 * Rects for every id: stored ones as they are; missing ones placed next to `near`
 * (the selected window) at its size. With nothing stored yet (first time on the
 * canvas), windows start out as an even grid.
 */
export function arrange(
  ids: string[],
  stored: Record<string, Rect>,
  near: string | null,
): { rects: Map<string, Rect>; added: boolean } {
  const rects = new Map<string, Rect>();
  for (const id of ids) if (stored[id]) rects.set(id, stored[id]!);
  const missing = ids.filter((id) => !stored[id]);
  if (missing.length === 0) return { rects, added: false };
  if (rects.size === 0) {
    const { cols } = gridShape(missing.length);
    missing.forEach((id, i) =>
      rects.set(id, { x: (i % cols) * (DEFAULT_W + GAP), y: Math.floor(i / cols) * (DEFAULT_H + GAP), w: DEFAULT_W, h: DEFAULT_H }),
    );
    return { rects, added: true };
  }
  let anchor = (near && rects.get(near)) || null;
  for (const id of missing) {
    const r = place([...rects.values()], anchor, anchor?.w, anchor?.h);
    rects.set(id, r);
    anchor = r;
  }
  return { rects, added: true };
}

/** A camera showing `r` whole and centred, at most at `maxZoom`. */
export function frame(r: Rect, vp: Viewport, maxZoom = 1, pad = FRAME_PAD): Camera {
  const zoom = clampZoom(Math.min(maxZoom, (vp.w - 2 * pad) / r.w, (vp.h - 2 * pad) / r.h));
  return { x: r.x + r.w / 2 - vp.w / 2 / zoom, y: r.y + r.h / 2 - vp.h / 2 / zoom, zoom };
}

/** Whether `r` is fully on screen. */
export function visible(cam: Camera, r: Rect, vp: Viewport): boolean {
  const a = toWorld(cam, 0, 0);
  const b = toWorld(cam, vp.w, vp.h);
  return r.x >= a.x - 0.5 && r.y >= a.y - 0.5 && r.x + r.w <= b.x + 0.5 && r.y + r.h <= b.y + 0.5;
}

/**
 * The smallest camera move that shows `r` (like the strip's reveal). Zooms out
 * only if it doesn't fit; zoomed out to cards, comes in to full size so the
 * window can be used.
 */
export function reveal(cam: Camera, r: Rect, vp: Viewport, pad = GAP): Camera {
  if (cam.zoom < CARD_ZOOM) return frame(r, vp, 1);
  const fits = r.w * cam.zoom <= vp.w - 2 * pad && r.h * cam.zoom <= vp.h - 2 * pad;
  if (!fits) return frame(r, vp, cam.zoom, pad);
  if (visible(cam, r, vp)) return cam;
  const p = pad / cam.zoom;
  const vw = vp.w / cam.zoom;
  const vh = vp.h / cam.zoom;
  const x = r.x - p < cam.x ? r.x - p : r.x + r.w + p > cam.x + vw ? r.x + r.w + p - vw : cam.x;
  const y = r.y - p < cam.y ? r.y - p : r.y + r.h + p > cam.y + vh ? r.y + r.h + p - vh : cam.y;
  return { x, y, zoom: cam.zoom };
}

/** Interpolate cameras so the zoom changes evenly (log scale) along the way. */
export function lerpCamera(a: Camera, b: Camera, t: number, vp: Viewport): Camera {
  const zoom = Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * t);
  // Interpolate the viewport centre rather than its corner, so zooming doesn't swing sideways.
  const ca = toWorld(a, vp.w / 2, vp.h / 2);
  const cb = toWorld(b, vp.w / 2, vp.h / 2);
  const cx = ca.x + (cb.x - ca.x) * t;
  const cy = ca.y + (cb.y - ca.y) * t;
  return { x: cx - vp.w / 2 / zoom, y: cy - vp.h / 2 / zoom, zoom };
}

/** Clamp a window's size to the minimum, snapped. */
export function sized(r: Rect): Rect {
  return { x: snap(r.x), y: snap(r.y), w: Math.max(MIN_W, snap(r.w)), h: Math.max(MIN_H, snap(r.h)) };
}
