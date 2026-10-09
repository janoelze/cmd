// Sidebars (docs/21-sidebars.md): any window can be docked to the left or right
// edge of the app window, out of the board's layout. Which window sits where
// is per-workspace layout, kept in workspace.view["docks"] like grid order and the canvas
// camera. Pure helpers; App owns the state, components/Dock.tsx draws a side.

export type Side = "left" | "right";
export const SIDES: readonly Side[] = ["left", "right"];

export interface DockSide {
  /** The docked window (a terminal's is its pane id); null: empty. */
  id: string | null;
  /** px; null: the default. */
  width: number | null;
  /** Hidden from View → Show Left/Right Sidebar; the window stays docked. */
  hidden: boolean;
}

export type Docks = Record<Side, DockSide>;

export const DOCK_WIDTH = { default: 280, min: 200, max: 480 } as const;
/** Room the board keeps however wide the sidebars are. */
export const MIN_BOARD = 320;

const EMPTY_SIDE: DockSide = { id: null, width: null, hidden: false };
export const EMPTY_DOCKS: Docks = { left: EMPTY_SIDE, right: EMPTY_SIDE };

/** A stored value as Docks (older or partial values fill in empty sides). */
export function readDocks(v: unknown): Docks {
  const side = (x: unknown): DockSide => {
    const o = (x && typeof x === "object" ? x : {}) as Partial<DockSide>;
    return {
      id: typeof o.id === "string" ? o.id : null,
      width: typeof o.width === "number" ? o.width : null,
      hidden: o.hidden === true,
    };
  };
  const o = (v && typeof v === "object" ? v : {}) as Partial<Record<Side, unknown>>;
  return { left: side(o.left), right: side(o.right) };
}

/** Sides whose window is gone (closed, moved to another workspace) count as empty. */
export function liveDocks(d: Docks, alive: (id: string) => boolean): Docks {
  const fix = (s: DockSide): DockSide => (s.id && !alive(s.id) ? { ...s, id: null } : s);
  return { left: fix(d.left), right: fix(d.right) };
}

export function sideOf(d: Docks, id: string | null | undefined): Side | null {
  if (!id) return null;
  return d.left.id === id ? "left" : d.right.id === id ? "right" : null;
}

/** Windows shown as sidebars (docked, side not hidden). */
export function shownIds(d: Docks): Set<string> {
  return new Set(SIDES.flatMap((s) => (d[s].id && !d[s].hidden ? [d[s].id!] : [])));
}

/** Every docked window, shown or hidden: not part of the board. */
export function dockedIds(d: Docks): Set<string> {
  return new Set(SIDES.flatMap((s) => (d[s].id ? [d[s].id!] : [])));
}

/**
 * Dock `id` to `side`. It leaves the other side if it was there; the window
 * that held `side` goes back to the board. Docking shows the side.
 */
export function dock(d: Docks, id: string, side: Side): Docks {
  const other: Side = side === "left" ? "right" : "left";
  return {
    ...d,
    [side]: { ...d[side], id, hidden: false },
    [other]: d[other].id === id ? { ...d[other], id: null } : d[other],
  } as Docks;
}

/** Back to the board (the side keeps its width for the next window). */
export function undock(d: Docks, id: string): Docks {
  const side = sideOf(d, id);
  return side ? { ...d, [side]: { ...d[side], id: null } } : d;
}

/**
 * Widths for the shown sides in an app window `total` px wide: each its own
 * width (or the default) within min/max, then narrowed so the board keeps
 * MIN_BOARD, the right side first and never below min. Hidden or empty: 0.
 */
export function dockWidths(d: Docks, total: number): Record<Side, number> {
  const want = (s: Side) =>
    d[s].id && !d[s].hidden ? Math.max(DOCK_WIDTH.min, Math.min(DOCK_WIDTH.max, d[s].width ?? DOCK_WIDTH.default)) : 0;
  const w = { left: want("left"), right: want("right") };
  let over = w.left + w.right + MIN_BOARD - total;
  for (const s of ["right", "left"] as const) {
    if (over <= 0 || !w[s]) continue;
    const cut = Math.min(over, w[s] - DOCK_WIDTH.min);
    w[s] -= cut;
    over -= cut;
  }
  return w;
}
