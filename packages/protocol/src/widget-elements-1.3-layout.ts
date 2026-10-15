// API 1.3's layout by size (docs/57, "1.3 additions" A1–A3): a widget whose layout follows the
// room it has. `Adapt` holds `Case`s and the renderer mounts the first whose conditions its own
// box meets, measured there, so a resize switches layouts without a message to the widget's
// process. `Stack justify` and `Text fit` are props of 1.0 elements, merged into their rows in
// widget-elements.ts. And the box a widget's env carries (`env.box`, `useSize()`): the window
// content's size in px, rounded down to BOX_STEP and sent at most every BOX_EVERY_MS while resizing,
// for logic that needs numbers (how many rows fit), not for layouts (that's Adapt).

import { PREVIEW_SIZES, type PreviewSize } from "./magic-package.ts";
import type { ApiElementSpec } from "./widget-spec.ts";

const since = "1.3";
const px = (doc: string) => ({ type: "number", doc }) as const;

/** API 1.3's layout elements, merged into API_ELEMENTS. */
export const ELEMENTS_1_3_LAYOUT = {
  Adapt: {
    doc: "A layout per size: draws the first Case its own box fits (its width and height in px, a Pane's when it sits in one), switched by cmd as the window resizes, without a round-trip to the widget. For a widget with a small and a large face; `Hide below` is enough to drop one thing from a narrow window, and `useSize()` is for numbers in logic (how many rows fit). Only the Case drawn is mounted: a field's draft in it is lost when the case changes. Give it room to measure: directly in a View, a Pane or a growing Stack; a height condition needs a box whose height isn't its content's.",
    since,
    props: {},
    events: {},
    children: "elements",
    childrenDoc: "Cases, the most demanding first; a Case without conditions last, as the fallback (without one, nothing is drawn while none fits).",
  },
  Case: {
    doc: "One layout of an Adapt, drawn while the Adapt's box meets every condition given (each in px, inclusive); a Case without conditions always fits. Outside an Adapt it draws its children.",
    since,
    props: {
      minWidth: px("Drawn from this width up."),
      maxWidth: px("Drawn up to this width."),
      minHeight: px("Drawn from this height up."),
      maxHeight: px("Drawn up to this height."),
    },
    events: {},
    children: "elements",
    childrenDoc: "The layout.",
  },
} as const satisfies Record<string, ApiElementSpec>;

/** Stack's 1.3 prop (widget-elements.ts spreads it into Stack's row). */
export const STACK_1_3 = {
  justify: { type: ["start", "center", "end", "between"], since, doc: "Where the children sit along the column: with `grow`, `center` puts them in the middle of the window, `between` the first at the top and the last at the bottom." },
} as const;

/** Text's 1.3 prop (widget-elements.ts spreads it into Text's row). */
export const TEXT_1_3 = {
  fit: { type: "boolean", since, doc: "Grows with its container's width, on one line, from its size up to the display size: a title that fills a column (a track's name, a countdown)." },
} as const;

// ── the box ─────────────────────────────────────────────

/** A box's size in px (`env.box`, `useSize()`). */
export interface ApiBox {
  width: number;
  height: number;
}

/** A box's sides are rounded down to this many px (never more room than there is), so a resize doesn't wake the widget for every pixel. */
export const BOX_STEP = 8;
/** While a window resizes, its box goes to the widget at most this often (ms); the last one always arrives. */
export const BOX_EVERY_MS = 200;

/** A box as the widget gets it: each side rounded down to BOX_STEP, never negative; null for anything that isn't a box. */
export function roundBox(box: unknown): ApiBox | null {
  if (!box || typeof box !== "object") return null;
  const { width, height } = box as Record<string, unknown>;
  if (typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  const r = (n: number) => Math.max(0, Math.floor(n / BOX_STEP) * BOX_STEP);
  return { width: r(width), height: r(height) };
}

/** A width's size class (`env.size`, `Hide`): narrow below 360 px, regular below 600, wide from there. */
export const sizeClassOf = (width: number): "narrow" | "regular" | "wide" => (width < 360 ? "narrow" : width < 600 ? "regular" : "wide");

/** The title bar over a widget's content (the kit's --window-bar-h), which a window's box doesn't include. */
export const WINDOW_BAR_H = 28;

/** What a widget at a reference size (PREVIEW_SIZES) gets as its env's `size` and `box`: the fake host's per-size env (the Workbench's Sizes, `cmd widget preview --sizes`). */
export function sizeEnv(size: PreviewSize): { size: "narrow" | "regular" | "wide"; box: ApiBox } {
  const [width, height] = PREVIEW_SIZES[size];
  return { size: sizeClassOf(width), box: roundBox({ width, height: height - WINDOW_BAR_H })! };
}
