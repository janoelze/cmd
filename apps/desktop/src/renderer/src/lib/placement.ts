// Where a new window goes on the board and which window is selected when the selected one
// closes, like tabs by default: a new window right after the one it was opened from (behind the
// others opened from it since you last selected something else), and closing selects the next
// window, or goes back to its opener if you went nowhere else; on the canvas, the nearest instead.
// ui.newWindows and ui.afterClose switch to "at the end" and "the last one used". Pure; the
// store places arrivals (lib/store.ts), shell/selection.ts picks after a close.

import type { Settings, WindowId } from "@cmd/protocol";
import { arrangeTiles } from "./model.ts";

export type NewWindows = Settings["ui.newWindows"];
export type AfterClose = Settings["ui.afterClose"];

/** Which window each was opened from, per workspace (workspace.view["openers"]). */
export type Openers = Record<WindowId, WindowId>;

/** The windows opened from one window since the selection last moved elsewhere (workspace.view["openers.run"]). */
export interface Run {
  opener: WindowId;
  ids: WindowId[];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `order` with `id` put in: after `opener` and the windows opened from it just before (`run`), else at the end. */
export function insertNew(order: string[], id: string, opener: string | null, run: string[], mode: NewWindows): string[] {
  const rest = order.filter((x) => x !== id);
  const i = mode === "next" && opener ? rest.indexOf(opener) : -1;
  if (i < 0) return [...rest, id];
  let at = i + 1;
  while (at < rest.length && run.includes(rest[at]!)) at++;
  rest.splice(at, 0, id);
  return rest;
}

/** Openers of the windows still there, so the record doesn't grow. */
export function liveOpeners(openers: Openers, alive: (id: string) => boolean): Openers {
  return Object.fromEntries(Object.entries(openers).filter(([id, by]) => alive(id) && alive(by)));
}

/**
 * The view keys to write when window `id` comes into a workspace (`view`, with the windows
 * already `here`): its place in grid.order beside its opener (else the selected window, unless
 * that's in a sidebar), its opener and the run it joins. null: it has its place already (reopened, shell/closed.ts).
 */
export function arrival(
  view: Record<string, unknown>,
  here: { id: string; createdAt: number }[],
  id: string,
  openerId: string | null,
  mode: NewWindows,
): { "grid.order": string[]; openers?: Openers; "openers.run"?: Run } | null {
  const stored = (view["grid.order"] as string[] | undefined) ?? [];
  if (stored.includes(id)) return null;
  const docks = view["docks"] as Record<string, { id?: string | null } | undefined> | undefined;
  const by = openerId ?? (view["selection.pane"] as string | null | undefined) ?? null;
  const opener = by && here.some((w) => w.id === by) && docks?.left?.id !== by && docks?.right?.id !== by ? by : null;
  const openers = (view["openers"] as Openers | undefined) ?? {};
  const run = view["openers.run"] as Run | null | undefined;
  const siblings = run?.opener === opener ? run.ids.filter((x) => here.some((w) => w.id === x)) : [];
  const order = insertNew(arrangeTiles(stored, here).map((w) => w.id), id, opener, siblings, mode);
  if (!opener) return { "grid.order": order };
  const alive = new Set(order);
  return { "grid.order": order, openers: { ...liveOpeners(openers, (x) => alive.has(x)), [id]: opener }, "openers.run": { opener, ids: [...siblings, id] } };
}

export interface Closing {
  closed: string;
  /** Selections, most recent first (the closed window at the head when it was selected). */
  history: string[];
  /** The board's order before it closed. */
  order: string[];
  alive: Set<string>;
  /** The window it was opened from, if known. */
  opener: string | null;
  /** On the canvas: where the windows were, to pick the nearest. */
  rects?: Record<string, Box> | null;
}

/** The window to select once the selected one is gone; null when none is left. */
export function afterClose(c: Closing, rule: AfterClose): string | null {
  const { closed, alive } = c;
  if (rule === "recent") {
    const recent = c.history.find((id) => id !== closed && alive.has(id));
    if (recent) return recent;
  } else {
    // Opened from a window and closed without going anywhere else: back to that one.
    const at = c.history.indexOf(closed);
    if (c.opener && alive.has(c.opener) && at >= 0 && c.history[at + 1] === c.opener) return c.opener;
    const near = c.rects ? nearest(c.rects, closed, alive) : null;
    if (near) return near;
  }
  const i = c.order.indexOf(closed);
  if (i >= 0) {
    const after = c.order.slice(i + 1).find((id) => alive.has(id));
    if (after) return after;
    const before = c.order.slice(0, i).reverse().find((id) => alive.has(id));
    if (before) return before;
  }
  return alive.values().next().value ?? null;
}

/** The live window whose centre is closest to the closed one's. */
function nearest(rects: Record<string, Box>, closed: string, alive: Set<string>): string | null {
  const r = rects[closed];
  if (!r) return null;
  const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const c = centre(r);
  let best: string | null = null;
  let bestD = Infinity;
  for (const [id, b] of Object.entries(rects)) {
    if (id === closed || !alive.has(id)) continue;
    const p = centre(b);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d < bestD) {
      best = id;
      bestD = d;
    }
  }
  return best;
}
