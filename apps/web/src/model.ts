// The Mac's state as the phone sees it: the bootstrap, kept current by events,
// and what Now makes of it (one item per terminal, agents first by urgency).
// Only structured data: agent states from hooks, pane attention and processes,
// never what's on a screen.

import { useEffect, useState } from "react";
import { bucketOf, type Agent, type CoreEvent, type Pane, type Workspace } from "@cmd/protocol";
import type { Connection, Phase } from "./connection.ts";
import type { Light } from "./ui.tsx";

export interface Model {
  panes: Map<string, Pane>;
  agents: Map<string, Agent>;
  workspaces: Map<string, Workspace>;
  scope: "view" | "control";
  host: string;
}

/** A Mac still on cmd 0.23 or older says Space: `spaces`, `spaceId` and `space.*` events. The client deploys first, so it reads both. */
type Legacy = { spaces?: Workspace[]; spaceId?: string; space?: Workspace };
const paneOf = (p: Pane): Pane => (p.workspaceId ? p : { ...p, workspaceId: (p as Pane & Legacy).spaceId ?? "" });

/** The bootstrap, kept current by events. Stays (stale) while offline. */
export function useModel(conn: Connection, phase: Phase): Model | null {
  const [model, setModel] = useState<Model | null>(null);
  useEffect(() => {
    if (phase.kind !== "online") return;
    const b = phase.boot;
    setModel({
      panes: new Map(b.panes.map((p) => [p.id, paneOf(p)])),
      agents: new Map(b.agents.map((a) => [a.id, a])),
      workspaces: new Map((b.workspaces ?? (b as Legacy).spaces ?? []).map((s) => [s.id, s])),
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
          const type = (e.type as string).replace(/^space\./, "workspace.");
          if (e.type === "pane.updated") next.panes = new Map(m.panes).set(e.pane.id, paneOf(e.pane));
          else if (e.type === "pane.removed") (next.panes = new Map(m.panes)).delete(e.paneId);
          else if (e.type === "agent.updated") next.agents = new Map(m.agents).set(e.agent.id, e.agent);
          else if (e.type === "agent.removed") (next.agents = new Map(m.agents)).delete(e.agentId);
          else if (type === "workspace.updated") {
            const w = (e as { workspace?: Workspace } & Legacy).workspace ?? (e as Legacy).space!;
            next.workspaces = new Map(m.workspaces).set(w.id, w);
          } else if (type === "workspace.removed") (next.workspaces = new Map(m.workspaces)).delete((e as { id: string }).id);
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
  workspaceId: string;
  workspace: string;
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
    workspaceId: pane.workspaceId,
    workspace: m.workspaces.get(pane.workspaceId)?.name ?? "",
    light,
    group,
    detail: a ? (a.detail ?? firstLine(a.lastMessage) ?? firstLine(a.lastPrompt)) : pane.attention ? "Wants you" : running ? pane.foreground : null,
    since: a?.stateSince ?? pane.lastActivityAt,
  };
}

/** Now's sections: what needs you (longest waiting first), what's working, what just finished, the rest. */
export function sections(m: Model, workspaceId: string | null): { group: Group; title: string; items: Item[] }[] {
  const items = [...m.panes.values()].filter((p) => !workspaceId || p.workspaceId === workspaceId).map((p) => itemOf(m, p));
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

/** Open workspaces in switcher order, with how many of their terminals need you. */
export function workspaceList(m: Model): { workspace: Workspace; needs: number }[] {
  const needs = new Map<string, number>();
  for (const p of m.panes.values()) if (itemOf(m, p).group === "needs") needs.set(p.workspaceId, (needs.get(p.workspaceId) ?? 0) + 1);
  return [...m.workspaces.values()].filter((s) => s.closedAt === null).sort((a, b) => a.order - b.order).map((workspace) => ({ workspace, needs: needs.get(workspace.id) ?? 0 }));
}

export function stateText(i: Item): string {
  const a = i.agent;
  if (!a) return i.light === "needs" ? "Wants you" : i.light === "working" ? `Running ${i.pane.foreground}` : "Shell";
  return { needs_input: "Needs you", working: "Working", starting: "Starting", done: "Done", idle: "Idle", exited: "Exited", failed: "Failed" }[a.state] ?? a.state;
}
