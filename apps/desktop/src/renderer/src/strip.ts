// PaperWM-style strip: geometry and reveal, as pure functions.
// Windows are laid out left to right, `pad` from the edges and `gap` apart; the strip scrolls
// horizontally (freely, no snapping) by an offset (px). Widths are fractions of the viewport.

export const MIN_WIDTH = 320;
/** Width presets cycled with ⌃⌘R / double-click (PaperWM's golden-ratio steps). */
export const WIDTH_PRESETS = [0.382, 0.5, 0.618, 1] as const;
export const DEFAULT_FRACTION = 0.5;
/** ⌥⌘+ / ⌥⌘− change a window's width by this fraction of the viewport. */
export const WIDTH_STEP = 0.1;

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

/**
 * One step wider (dir 1) or narrower (-1), snapped to the WIDTH_STEP grid so
 * odd widths (dragged, presets) land on it. `min` is the fraction of MIN_WIDTH.
 */
export function stepFraction(fraction: number, dir: 1 | -1, min = 0): number {
  const grid = Math.round(fraction / WIDTH_STEP);
  const onGrid = Math.abs(grid * WIDTH_STEP - fraction) < 0.01;
  const next = (onGrid ? grid + dir : dir > 0 ? Math.ceil(fraction / WIDTH_STEP) : Math.floor(fraction / WIDTH_STEP)) * WIDTH_STEP;
  return Math.round(Math.min(1, Math.max(Math.min(1, min), WIDTH_STEP, next)) * 1000) / 1000;
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

/** Smallest scroll that makes window i fully visible (left-aligned if it doesn't fit). */
export function revealOffset(offset: number, slot: Slot, viewport: number, pad: number, total: number): number {
  const max = maxOffset(total, viewport);
  const left = slot.x - pad;
  const right = slot.x + slot.w + pad - viewport;
  if (left < offset) return clamp(left, 0, max);
  if (right > offset) return clamp(Math.min(right, left), 0, max);
  return clamp(offset, 0, max);
}

/**
 * Stored widths with `id` set to `fraction`, dropping windows that no longer
 * exist. The strip holds terminals (panes) and other windows alike.
 */
export function withWidth(
  widths: Record<string, number>,
  id: string,
  fraction: number,
  live: { panes: ReadonlyMap<string, unknown>; windows: ReadonlyMap<string, unknown> },
): Record<string, number> {
  const next = Object.fromEntries(Object.entries(widths).filter(([k]) => live.panes.has(k) || live.windows.has(k)));
  next[id] = fraction;
  return next;
}
