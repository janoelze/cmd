// View-model helpers: sidebar rows, agent trees, labels.

import { bucketOf, sortRows, type Agent, type Pane, type PaneId } from "@cmd/protocol";
import type { State } from "./store.ts";

export interface SidebarRow {
  key: string;
  pane: Pane | null;
  agent: Agent | null;
  children: SidebarRow[];
  /** Most urgent agent in this subtree; drives sorting and the collapsed badge. */
  urgent: Agent | null;
}

const RANK = { needs: 0, unseen: 1, rest: 2 } as const;

export function buildRows(s: State): SidebarRow[] {
  const agents = [...s.agents.values()];
  const childrenOf = new Map<string, Agent[]>();
  for (const a of agents) if (a.parentId && s.agents.has(a.parentId)) {
    childrenOf.set(a.parentId, [...(childrenOf.get(a.parentId) ?? []), a]);
  }

  const toRow = (pane: Pane | null, agent: Agent | null): SidebarRow => {
    const children = agent
      ? (childrenOf.get(agent.id) ?? []).map((c) => toRow(c.paneId ? s.panes.get(c.paneId) ?? null : null, c))
      : [];
    let urgent = agent;
    for (const c of children) {
      if (c.urgent && (!urgent || RANK[bucketOf(c.urgent)] < RANK[bucketOf(urgent)])) urgent = c.urgent;
    }
    return { key: agent?.id ?? pane!.id, pane, agent, children, urgent };
  };

  const isChild = (a: Agent | null) => !!a?.parentId && s.agents.has(a.parentId);
  const roots: SidebarRow[] = [];
  for (const pane of s.panes.values()) {
    const agent = pane.agentId ? s.agents.get(pane.agentId) ?? null : null;
    if (!isChild(agent)) roots.push(toRow(pane, agent));
  }
  // Hosts whose terminal is gone but whose workers are still running.
  const orphans: SidebarRow[] = [];
  for (const a of agents) if (!a.paneId && !isChild(a)) orphans.push(toRow(null, a));

  const sortable = roots.map((r) => ({ pane: r.pane!, agent: r.urgent, row: r }));
  const sorted = sortRows(sortable).map((x) => (x as (typeof sortable)[number]).row);
  return [...sorted, ...orphans];
}

/** Rows in display order, children included (for ⌃⌘1–9 and ⌘[ / ⌘]). */
export function flatten(rows: SidebarRow[]): SidebarRow[] {
  return rows.flatMap((r) => [r, ...flatten(r.children)]);
}

const GENERIC_TITLES = new Set(["claude code", "claude", "codex", "gemini", "opencode", "amp", "zsh", "bash"]);

/** Terminal title without agent spinner glyphs (✳ ◐ ⠋ …). */
function cleanTitle(t: string | undefined): string {
  return (t ?? "").replace(/^[\s✳✻✽✶✢·•*◐◑◒◓⠀-⣿]+/u, "").trim();
}

/** Like the fork: terminal title, else last prompt, else spawn prompt, else agent name. */
export function rowTitle(r: SidebarRow): string {
  const a = r.agent;
  const t = cleanTitle(r.pane?.title);
  const generic = !t || GENERIC_TITLES.has(t.toLowerCase()) || t === r.pane?.foreground;
  if (a) return a.name ?? (!generic ? t : null) ?? a.lastPrompt ?? a.spawn.prompt ?? a.kind;
  return t || r.pane?.foreground || "terminal";
}

export function rowDetail(r: SidebarRow, now: number): string {
  const a = r.agent;
  if (!a) return shortPath(r.pane?.cwd ?? "");
  switch (a.state) {
    case "needs_input":
      return a.detail ?? "Needs input";
    case "working":
      return a.detail ?? "Working…";
    case "done":
      return `Done ${ago(a.stateSince, now)}`;
    case "starting":
      return "Starting…";
    case "exited":
      return "Exited";
    case "failed":
      return a.detail ?? "Failed";
    default:
      return `${a.kind} · idle`;
  }
}

export type Led = "needs" | "unseen" | "done" | "working" | "idle" | "shell" | "off";

export function ledOf(a: Agent | null): Led {
  if (!a) return "shell";
  const b = bucketOf(a);
  if (b === "needs") return "needs";
  if (b === "unseen") return "unseen";
  if (a.state === "done") return "done";
  if (a.state === "working" || a.state === "starting") return "working";
  if (a.state === "exited" || a.state === "failed") return "off";
  return "idle";
}

export function project(cwd: string): string {
  return shortPath(cwd).split("/").filter(Boolean).pop() ?? "~";
}

/** Stable per-project hue (FNV-1a), as in the ghostty-agents fork. */
export function projectHue(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return (h >>> 0) % 360;
}

export function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function paneOfRow(r: SidebarRow): PaneId | null {
  return r.pane?.id ?? null;
}

// ── grid slots ───────────────────────────────────────────

/**
 * Tile order for the grid: the remembered order first (dropping closed panes),
 * then panes not placed yet, oldest first, so new terminals take the next slot.
 */
export function arrangeTiles<T extends { id: string; createdAt: number }>(order: string[], panes: T[]): T[] {
  const byId = new Map(panes.map((p) => [p.id, p]));
  const placed = order.map((id) => byId.get(id)).filter((p): p is T => !!p);
  const seen = new Set(placed.map((p) => p.id));
  const rest = panes.filter((p) => !seen.has(p.id)).sort((a, b) => a.createdAt - b.createdAt);
  return [...placed, ...rest];
}

/** Columns × rows for n tiles: as square as possible, wider than tall. */
export function gridShape(n: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

/** Move `id` to index `to`, shifting the tiles in between (insert, not swap). */
export function moveInOrder(ids: string[], id: string, to: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const target = Math.max(0, Math.min(to, ids.length - 1));
  if (from === target) return ids;
  const next = ids.filter((x) => x !== id);
  next.splice(target, 0, id);
  return next;
}


// ── focus after close ────────────────────────────────────

/** Record a visit: most recent first, no duplicates, capped. */
export function pushHistory(history: string[], id: string, cap = 50): string[] {
  return [id, ...history.filter((x) => x !== id)].slice(0, cap);
}

/**
 * Which terminal to focus after the selected one disappears:
 * 1. the most recently used one that still exists (like macOS windows / VS Code),
 * 2. else its neighbour in the view's order before it closed (next, else previous),
 * 3. else the first one left.
 */
export function nextAfterClose(closed: string, history: string[], orderBefore: string[], alive: Set<string>): string | null {
  const recent = history.find((id) => id !== closed && alive.has(id));
  if (recent) return recent;
  const i = orderBefore.indexOf(closed);
  if (i >= 0) {
    const after = orderBefore.slice(i + 1).find((id) => alive.has(id));
    if (after) return after;
    const before = orderBefore.slice(0, i).reverse().find((id) => alive.has(id));
    if (before) return before;
  }
  return alive.values().next().value ?? null;
}

// ── resource usage ───────────────────────────────────────

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** "412 MB · 3%" (CPU only when noticeable). */
export function usageLabel(u: { memory: number; cpu: number } | null): string | null {
  if (!u) return null;
  const cpu = u.cpu >= 1 ? ` · ${Math.round(u.cpu)}%` : "";
  return `${formatBytes(u.memory)}${cpu}`;
}

/** Tooltip: totals plus the largest processes in the tree. */
export function usageTooltip(u: { memory: number; cpu: number; processes: number; top: { name: string; memory: number }[] } | null): string | undefined {
  if (!u) return undefined;
  const lines = [`${formatBytes(u.memory)} memory · ${u.cpu.toFixed(1)}% CPU · ${u.processes} process${u.processes === 1 ? "" : "es"}`];
  for (const t of u.top) lines.push(`${formatBytes(t.memory).padStart(7)}  ${t.name}`);
  return lines.join("\n");
}
