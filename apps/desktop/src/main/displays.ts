// Window placement per display setup: where each workspace's app window sat on the
// laptop alone, at the desk, with the projector. A setup is the arrangement of
// connected displays; workspaces.ts records user moves under the current one and
// puts windows back when a setup returns. Pure, so it is tested without Electron.

import type { Bounds } from "./workspaces.ts";

interface Rect { x: number; y: number; width: number; height: number }

/** setup key → workspace id → bounds, most recently used setup last. */
export type Placements = Record<string, Record<string, Bounds>>;

/** Setups remembered; the least recently used one goes first. */
export const MAX_SETUPS = 10;

/**
 * The key of a display setup: every display's bounds, sorted. Bounds, not
 * display ids: ids aren't promised to survive a reboot or another dock, and
 * the arrangement is what decides where windows fit. The same monitor moved
 * from left to right of the laptop is another setup.
 */
export function setupKey(displays: readonly { bounds: Rect }[]): string {
  return displays
    .map(({ bounds: b }) => `${b.x},${b.y},${b.width}x${b.height}`)
    .sort()
    .join(";");
}

export function placementFor(placements: Placements, key: string, workspaceId: string): Bounds | undefined {
  return placements[key]?.[workspaceId];
}

/** The setup was just used: it moves last, and the oldest beyond MAX_SETUPS are dropped. */
export function touch(placements: Placements, key: string): Placements {
  const others = Object.entries(placements).filter(([k]) => k !== key).slice(-(MAX_SETUPS - 1));
  return { ...Object.fromEntries(others), [key]: placements[key] ?? {} };
}

/** Remember where a workspace's window sits in a setup. */
export function record(placements: Placements, key: string, workspaceId: string, bounds: Bounds): Placements {
  const next = touch(placements, key);
  next[key] = { ...next[key], [workspaceId]: bounds };
  return next;
}

/** Placements read from windows.json, dropping whatever isn't one. */
export function parsePlacements(raw: unknown): Placements {
  if (!raw || typeof raw !== "object") return {};
  const out: Placements = {};
  for (const [key, workspaces] of Object.entries(raw)) {
    if (!workspaces || typeof workspaces !== "object") continue;
    const ok = Object.entries(workspaces as Record<string, Partial<Bounds> | null>).filter(([, b]) => typeof b?.width === "number" && typeof b?.height === "number");
    out[key] = Object.fromEntries(ok) as Record<string, Bounds>;
  }
  return out;
}
