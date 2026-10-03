// Window layouts. Each view mode is a pure function from (order, viewport, view
// state) to a rectangle per window plus how dragging behaves. WindowsView
// renders whatever a layout returns, so all modes share one set of windows,
// one drag/push implementation and one animation path. Rects are in "content"
// coordinates; the strip scrolls and the canvas pans/zooms (WindowsView
// transforms the track).

import { gridShape } from "./model.ts";
import { layout as stripSlots } from "./strip.ts";

export type ViewMode = "focus" | "grid" | "strip" | "canvas";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  rects: Map<string, Rect>;
  /** Windows not shown in this mode (kept mounted, keep their size). */
  hidden: Set<string>;
  /** Insertion index for a pointer at (x, y) in content coordinates; -1 = no reordering. */
  dropIndex(x: number, y: number): number;
  /** Outlines shown while dragging (grid: every cell; strip: none, the target is enough). */
  slots: Rect[];
  /** Title bars, borders and gutters. */
  chrome: boolean;
  /** Windows can be resized by their right edge. */
  resizable: boolean;
  /** Scrollable content width (strip); 0 = no horizontal scrolling. */
  contentWidth: number;
}

export interface Viewport {
  w: number;
  h: number;
}

export function gridLayout(ids: string[], vp: Viewport, gutter: number): Layout {
  const { cols, rows } = gridShape(ids.length);
  const cw = (vp.w - gutter * (cols + 1)) / cols;
  const ch = (vp.h - gutter * (rows + 1)) / rows;
  const cell = (i: number): Rect => ({
    x: gutter + (i % cols) * (cw + gutter),
    y: gutter + Math.floor(i / cols) * (ch + gutter),
    w: cw,
    h: ch,
  });
  const rects = new Map(ids.map((id, i) => [id, cell(i)]));
  return {
    rects,
    hidden: new Set(),
    dropIndex: (x, y) => {
      const col = Math.max(0, Math.min(cols - 1, Math.floor((x - gutter / 2) / (cw + gutter))));
      const row = Math.max(0, Math.min(rows - 1, Math.floor((y - gutter / 2) / (ch + gutter))));
      return Math.min(row * cols + col, ids.length - 1);
    },
    slots: Array.from({ length: cols * rows }, (_, i) => cell(i)),
    chrome: true,
    resizable: false,
    contentWidth: 0,
  };
}

/** Bottom space reserved for the strip's position bar. */
export const STRIP_BAR = 3;

export function stripLayout(ids: string[], widths: number[], vp: Viewport, gutter: number): Layout {
  const { slots, total } = stripSlots(widths, gutter);
  const h = vp.h - 2 * gutter - STRIP_BAR;
  const rects = new Map(ids.map((id, i) => [id, { x: slots[i]!.x, y: gutter, w: slots[i]!.w, h }]));
  return {
    rects,
    hidden: new Set(),
    dropIndex: (x) => {
      // The window under the pointer; in a gutter, the nearer neighbour.
      let best = 0;
      let bestDist = Infinity;
      slots.forEach((s, i) => {
        const d = x < s.x ? s.x - x : x > s.x + s.w ? x - (s.x + s.w) : 0;
        if (d < bestDist) [best, bestDist] = [i, d];
      });
      return best;
    },
    slots: [],
    chrome: true,
    resizable: true,
    contentWidth: total,
  };
}

/** Canvas: windows where they were put (world coordinates; WindowsView applies the camera). */
export function canvasLayout(rects: Map<string, Rect>): Layout {
  return {
    rects,
    hidden: new Set(),
    dropIndex: () => -1,
    slots: [],
    chrome: true,
    resizable: false,
    contentWidth: 0,
  };
}

export function focusLayout(ids: string[], selected: string | null, vp: Viewport): Layout {
  const shown = ids.includes(selected ?? "") ? selected! : ids[0];
  const full = { x: 0, y: 0, w: vp.w, h: vp.h };
  return {
    rects: new Map(ids.map((id) => [id, full])),
    hidden: new Set(ids.filter((id) => id !== shown)),
    dropIndex: () => -1,
    slots: [],
    chrome: false,
    resizable: false,
    contentWidth: 0,
  };
}
