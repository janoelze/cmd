// The Mac's state as the phone sees it: the bootstrap, kept current by events,
// and what Now makes of it (one item per terminal, agents first by urgency).
// Only structured data: agent states from hooks, pane attention and processes,
// never what's on a screen.

import { useEffect, useState } from "react";
import { bucketOf, type Agent, type CoreEvent, type Pane, type Space } from "@cmd/protocol";
import type { Connection, Phase } from "./connection.ts";
import type { Light } from "./ui.tsx";

export interface Model {
  panes: Map<string, Pane>;
  agents: Map<string, Agent>;
  spaces: Map<string, Space>;
  scope: "view" | "control";
  host: string;
}

/** The bootstrap, kept current by events. Stays (stale) while offline. */
export function useModel(conn: Connection, phase: Phase): Model | null {
  const [model, setModel] = useState<Model | null>(null);
  useEffect(() => {
    if (phase.kind !== "online") return;
    const b = phase.boot;
    setModel({
      panes: new Map(b.panes.map((p) => [p.id, p])),
      agents: new Map(b.agents.map((a) => [a.id, a])),
      spaces: new Map(b.spaces.map((s) => [s.id, s])),
      scope: b.device?.scope ?? "view",
      host: b.host?.name ?? "your Mac",
    });
  }, [phase]);
  useEffect(
    () =>
      conn.onEvent((e: CoreEvent) =>
        setModel((m) => {
          if (!m) return m;
          const next = { ...m };
          if (e.type === "pane.updated") next.panes = new Map(m.panes).set(e.pane.id, e.pane);
          else if (e.type === "pane.removed") (next.panes = new Map(m.panes)).delete(e.paneId);
          else if (e.type === "agent.updated") next.agents = new Map(m.agents).set(e.agent.id, e.agent);
          else if (e.type === "agent.removed") (next.agents = new Map(m.agents)).delete(e.agentId);
          else if (e.type === "space.updated") next.spaces = new Map(m.spaces).set(e.space.id, e.space);
          else if (e.type === "space.removed") (next.spaces = new Map(m.spaces)).delete(e.id);
          else return m;
          return next;
        }),
      ),
    [conn],
  );
  return model;
}

export type Group = "needs" | "working" | "done" | "rest";

export interface Item {
  paneId: string;
  agent: Agent | null;
  pane: Pane;
  title: string;
  spaceId: string;
  space: string;
  light: Light;
  group: Group;
  /** The second line: the agent's question or tool, the running program, or why it wants you. */
  detail: string | null;
  since: number;
}

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "login", "-zsh", "-bash"]);
const firstLine = (s: string | null | undefined) => s?.split("\n").find((l) => l.trim())?.trim().slice(0, 160) ?? null;
const AGENT = { claude: "Claude", codex: "Codex", gemini: "Gemini", opencode: "OpenCode" } as Record<string, string>;

export function itemOf(m: Model, pane: Pane): Item {
  const a = pane.agentId ? (m.agents.get(pane.agentId) ?? null) : null;
  const running = !SHELLS.has(pane.foreground);
  let light: Light = "idle";
  let group: Group = "rest";
  if (a?.state === "needs_input" || (!a && pane.attention)) (light = "needs"), (group = "needs");
  else if (a && (a.state === "working" || a.state === "starting")) (light = "working"), (group = "working");
  else if (a && bucketOf(a) === "unseen") (light = "unseen"), (group = "done");
  else if (a?.state === "done") light = "done";
  else if (!a && running) (light = "working"), (group = "working");
  const kind = a ? (AGENT[a.kind] ?? a.kind) : null;
  return {
    paneId: pane.id,
    agent: a,
    pane,
    // A program's own title (Claude names its task), else the agent's kind, else the shell's.
    title: a?.name ?? (a && SHELLS.has(pane.title) ? kind! : pane.title),
    spaceId: pane.spaceId,
    space: m.spaces.get(pane.spaceId)?.name ?? "",
    light,
    group,
    detail: a ? (a.detail ?? firstLine(a.lastMessage) ?? firstLine(a.lastPrompt)) : pane.attention ? "Wants you" : running ? pane.foreground : null,
    since: a?.stateSince ?? pane.lastActivityAt,
  };
}

/** Now's sections: what needs you (longest waiting first), what's working, what just finished, the rest. */
export function sections(m: Model, spaceId: string | null): { group: Group; title: string; items: Item[] }[] {
  const items = [...m.panes.values()].filter((p) => !spaceId || p.spaceId === spaceId).map((p) => itemOf(m, p));
  const by = (g: Group) => items.filter((i) => i.group === g);
  const oldest = (x: Item[]) => x.sort((p, q) => p.since - q.since);
  const newest = (x: Item[]) => x.sort((p, q) => q.since - p.since);
  return [
    { group: "needs" as const, title: "Needs you", items: oldest(by("needs")) },
    { group: "working" as const, title: "Working", items: newest(by("working")) },
    { group: "done" as const, title: "Done", items: newest(by("done")) },
    { group: "rest" as const, title: "Terminals", items: newest(by("rest")) },
  ].filter((s) => s.items.length);
}

/** Open Spaces in switcher order, with how many of their terminals need you. */
export function spaceList(m: Model): { space: Space; needs: number }[] {
  const needs = new Map<string, number>();
  for (const p of m.panes.values()) if (itemOf(m, p).group === "needs") needs.set(p.spaceId, (needs.get(p.spaceId) ?? 0) + 1);
  return [...m.spaces.values()].filter((s) => s.closedAt === null).sort((a, b) => a.order - b.order).map((space) => ({ space, needs: needs.get(space.id) ?? 0 }));
}

export function stateText(i: Item): string {
  const a = i.agent;
  if (!a) return i.light === "needs" ? "Wants you" : i.light === "working" ? `Running ${i.pane.foreground}` : "Shell";
  return { needs_input: "Needs you", working: "Working", starting: "Starting", done: "Done", idle: "Idle", exited: "Exited", failed: "Failed" }[a.state] ?? a.state;
}
