// View-model helpers: sidebar rows, agent trees, labels.

import { bucketOf, type Agent, type AppWindow, type Pane, type PaneId } from "@cmd/protocol";
import type { State } from "./store.ts";
import { typeFor, viewFor } from "./windows/registry.ts";

/**
 * A sidebar row and, when it has a window, a layout item. Terminal rows have a
 * pane (window id = pane id); browser/file rows have `win`; a host agent whose
 * terminal is gone has neither.
 */
export interface SidebarRow {
  key: string;
  pane: Pane | null;
  /** Non-terminal window (browser, files). */
  win: AppWindow | null;
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
    return { key: agent?.id ?? pane!.id, pane, win: null, agent, children, urgent };
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

  for (const w of s.windows.values()) {
    roots.push({ key: w.id, pane: null, win: w, agent: null, children: [], urgent: null });
  }

  // needs-input first (longest wait first), then done-but-unseen (oldest first),
  // then everything else by recency — same rule as @cmd/protocol's sortRows.
  const activity = (r: SidebarRow) => Math.max(r.pane?.lastActivityAt ?? r.win?.updatedAt ?? 0, r.agent?.stateSince ?? 0);
  const sorted = [...roots].sort((a, b) => {
    const ba = RANK[bucketOf(a.urgent)];
    const bb = RANK[bucketOf(b.urgent)];
    if (ba !== bb) return ba - bb;
    if (ba === RANK.rest) return activity(b) - activity(a);
    return a.urgent!.stateSince - b.urgent!.stateSince;
  });
  return [...sorted, ...orphans];
}

/** The window a row stands for (terminal: pane id), if any. */
export function windowIdOf(r: SidebarRow): string | null {
  return r.win?.id ?? r.pane?.id ?? null;
}

export function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.host || u.protocol.replace(":", "");
  } catch {
    return url;
  }
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

/** Live status a window reports (see windowActions.ts); terminals have none. */
export interface LiveStatus {
  label: string;
  key?: string;
  transient?: boolean;
  dirty?: boolean;
}

/** A window's title fields, the same for every type (docs/10-window-titles.md). */
export interface WindowFields {
  /** What it is about: short, no path. */
  name: string;
  /** What runs or is open in it: the process, or the type, lowercase. Absent when it equals the name. */
  kind?: string;
  /** Where it lives (folder, host); never equal to the name. */
  place?: string;
  /** Live state; `key` says which state, so a changed text with the same key updates in place. */
  status?: { text: string; key: string; transient?: boolean };
  dirty?: boolean;
  /** Agents: the status light (Mark). Everything else shows `icon`. */
  light?: Led;
  icon: string;
}

export function fieldsOf(r: SidebarRow, live: LiveStatus | undefined, now: number): WindowFields {
  let f: WindowFields;
  if (r.win) {
    const w = r.win;
    const type = typeFor(w.kind);
    const d = viewFor(w.kind)?.describe?.(w) ?? {};
    f = {
      name: d.name || w.title || type?.title || w.kind,
      kind: (type?.title ?? w.kind).toLowerCase(),
      place: d.place || undefined,
      status: live ? { text: live.label, key: live.key ?? live.label, transient: live.transient } : undefined,
      dirty: live?.dirty,
      icon: type?.icon ?? "macwindow",
    };
  } else {
    const a = r.agent;
    const p = r.pane;
    const t = cleanTitle(p?.title);
    const generic = !t || GENERIC_TITLES.has(t.toLowerCase()) || t === p?.foreground;
    const cwd = p?.cwd ?? a?.cwd;
    const attn = p?.attention ?? null;
    f = {
      // Like the fork: agent name, else terminal title, else last prompt, else spawn prompt.
      name: a
        ? (a.name ?? (!generic ? t : null) ?? a.lastPrompt ?? a.spawn.prompt ?? a.kind)
        : (!generic ? t : null) || p?.foreground || "Terminal",
      kind: p?.foreground || a?.kind || "terminal",
      place: cwd ? shortPath(cwd) : undefined,
      // A terminal's attention marker (a bell, a notification, a finished command;
      // see packages/core/src/notifications.ts) shows like an agent's state until seen.
      status: a ? agentStatus(a, now) : attn ? { text: attn.text, key: `attention:${attn.kind}` } : undefined,
      light: a ? ledOf(a) : attn ? (attn.urgent ? "needs" : "unseen") : undefined,
      icon: "terminal",
    };
  }
  // Rule 2: no repeats (a shell named after its process, a page titled with its host).
  if (f.kind === f.name) f.kind = undefined;
  if (f.place === f.name) f.place = undefined;
  return f;
}

function agentStatus(a: Agent, now: number): { text: string; key: string } {
  const text = (() => {
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
        return "idle";
    }
  })();
  return { text, key: a.state };
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
  if (n < 1024) return `${n} B`;
  return `${Math.round(n / 1024)} KB`;
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
