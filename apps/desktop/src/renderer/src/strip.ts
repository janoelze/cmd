// PaperWM-style strip: geometry, snapping and reveal, as pure functions.
// Windows are laid out left to right, `pad` from the edges and `gap` apart; the strip scrolls
// horizontally by an offset (px). Widths are fractions of the viewport.

export const MIN_WIDTH = 320;
/** Width presets cycled with ⌃⌘R / double-click (PaperWM's golden-ratio steps). */
export const WIDTH_PRESETS = [0.382, 0.5, 0.618, 1] as const;
export const DEFAULT_FRACTION = 0.5;

export interface Slot {
  /** Left edge in strip coordinates. */
  x: number;
  w: number;
}

/** The widest a window may be: the viewport minus the padding on both sides. */
export function maxWidth(viewport: number, pad: number): number {
  return Math.max(MIN_WIDTH, viewport - 2 * pad);
}

export function clampWidth(w: number, viewport: number, pad: number): number {
  return Math.round(Math.max(Math.min(MIN_WIDTH, maxWidth(viewport, pad)), Math.min(w, maxWidth(viewport, pad))));
}

/** Pixel width for a stored fraction (fraction 1 = full width minus padding). */
export function widthFor(fraction: number, viewport: number, pad: number): number {
  return clampWidth(fraction * maxWidth(viewport, pad), viewport, pad);
}

export function fractionFor(w: number, viewport: number, pad: number): number {
  return Math.min(1, Math.max(0.05, w / maxWidth(viewport, pad)));
}

/** Next preset larger than the current fraction, wrapping to the smallest. */
export function nextPreset(fraction: number): number {
  return WIDTH_PRESETS.find((p) => p > fraction + 0.01) ?? WIDTH_PRESETS[0];
}

export function layout(widths: number[], pad: number, gap = pad): { slots: Slot[]; total: number } {
  const slots: Slot[] = [];
  let x = pad;
  for (const w of widths) {
    slots.push({ x, w });
    x += w + gap;
  }
  return { slots, total: widths.length ? x - gap + pad : pad };
}

export function maxOffset(total: number, viewport: number): number {
  return Math.max(0, total - viewport);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Offsets where a window edge lines up with the viewport edge (plus the ends). */
export function snapPoints(slots: Slot[], viewport: number, pad: number, total: number): number[] {
  const max = maxOffset(total, viewport);
  const pts = new Set<number>([0, max]);
  for (const s of slots) {
    pts.add(clamp(Math.round(s.x - pad), 0, max)); // window flush left
    pts.add(clamp(Math.round(s.x + s.w + pad - viewport), 0, max)); // window flush right
  }
  return [...pts].sort((a, b) => a - b);
}

/**
 * Where to settle after free scrolling. With momentum (direction ≠ 0) prefer the
 * next snap point in that direction, so a flick carries on to the next window
 * instead of falling back; otherwise take the nearest.
 */
export function snapTarget(offset: number, points: number[], direction: -1 | 0 | 1): number {
  if (points.length === 0) return offset;
  const nearest = points.reduce((a, b) => (Math.abs(b - offset) < Math.abs(a - offset) ? b : a));
  if (direction === 0) return nearest;
  const ahead = points.filter((p) => (direction > 0 ? p >= offset - 1 : p <= offset + 1));
  if (ahead.length === 0) return nearest;
  return direction > 0 ? Math.min(...ahead) : Math.max(...ahead);
}

/** Smallest scroll that makes window i fully visible (left-aligned if it doesn't fit). */
export function revealOffset(offset: number, slot: Slot, viewport: number, pad: number, total: number): number {
  const max = maxOffset(total, viewport);
  const left = slot.x - pad;
  const right = slot.x + slot.w + pad - viewport;
  if (left < offset) return clamp(left, 0, max);
  if (right > offset) return clamp(Math.min(right, left), 0, max);
  return clamp(offset, 0, max);
}

export function fullyVisible(slot: Slot, offset: number, viewport: number): boolean {
  return slot.x >= offset - 0.5 && slot.x + slot.w <= offset + viewport + 0.5;
}

/** Which window the strip "landed on" at an offset, given the scroll direction. */
export function landedOn(slots: Slot[], offset: number, viewport: number, pad: number, direction: -1 | 0 | 1): number {
  if (slots.length === 0) return -1;
  // The window flush with the edge we moved towards; else the most visible one.
  const edge = direction >= 0 ? offset + viewport : offset;
  if (direction !== 0) {
    const i = slots.findIndex((s) =>
      direction > 0 ? Math.abs(s.x + s.w + pad - edge) < 2 : Math.abs(s.x - pad - edge) < 2,
    );
    if (i >= 0) return i;
  }
  let best = 0;
  let bestVis = -1;
  // Most visible by fraction, so a narrow window fully in view beats a wide one half in view;
  // ties go to the leftmost.
  slots.forEach((s, i) => {
    const vis = Math.max(0, Math.min(s.x + s.w, offset + viewport) - Math.max(s.x, offset)) / s.w;
    if (vis > bestVis + 1e-6) [best, bestVis] = [i, vis];
  });
  return best;
}
