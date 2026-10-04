// Agent Activity, a built-in widget (docs/16-widgets.md): every agent in this
// Space, or all of them, at a glance: who waits for you first, then who is
// working, then what finished. Rows say what the sidebar says (fieldsOf), so
// the two never disagree; a click goes to the agent's terminal.

import { Button, EmptyState, Segmented } from "@cmd/ui";
import { useEffect, useMemo, useState } from "react";
import { bucketOf, type Agent } from "@cmd/protocol";
import { newAgent, selectPane } from "../actions.ts";
import { cmd } from "../bridge.ts";
import { fieldsOf, project, type SidebarRow } from "../model.ts";
import { showSpace } from "../spaces.tsx";
import { useStore } from "../store.ts";
import type { WindowViewProps } from "../windows/registry.ts";
import { Mark } from "./Slot.tsx";
import { shortAgo } from "./SidebarRows.tsx";
import "./widgets.css";

/** Waiting for you, then working, then the rest; most recent first within each. */
const RANK = { needs: 0, working: 1, unseen: 2, rest: 3 } as const;
function rank(a: Agent): number {
  const b = bucketOf(a);
  if (b === "needs") return RANK.needs;
  if (a.state === "working" || a.state === "starting") return RANK.working;
  return b === "unseen" ? RANK.unseen : RANK.rest;
}

export function AgentActivity({ win }: WindowViewProps) {
  const s = useStore();
  const scope = win.state.scope === "all" ? "all" : "space";
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const { roots, children } = useMemo(() => {
    const shown = [...s.agents.values()].filter((a) => scope === "all" || a.spaceId === win.spaceId);
    const ids = new Set(shown.map((a) => a.id));
    const children = new Map<string, Agent[]>();
    const roots: Agent[] = [];
    for (const a of shown) {
      if (a.parentId && ids.has(a.parentId)) children.set(a.parentId, [...(children.get(a.parentId) ?? []), a]);
      else roots.push(a);
    }
    const order = (x: Agent, y: Agent) => rank(x) - rank(y) || y.stateSince - x.stateSince;
    roots.sort(order);
    for (const list of children.values()) list.sort(order);
    return { roots, children };
  }, [s.agents, scope, win.spaceId]);

  const all = [...s.agents.values()].filter((a) => scope === "all" || a.spaceId === win.spaceId);
  const counts = {
    needs: all.filter((a) => bucketOf(a) === "needs").length,
    working: all.filter((a) => a.state === "working" || a.state === "starting").length,
    done: all.filter((a) => a.state === "done").length,
  };

  const go = (a: Agent) => {
    // Subagents without a terminal of their own live in their host's.
    let at: Agent | undefined = a;
    while (at && !at.paneId && at.parentId) at = s.agents.get(at.parentId);
    const pane = at?.paneId;
    if (!pane) return;
    if (at!.spaceId === s.spaceId) selectPane(pane);
    else showSpace(at!.spaceId, { select: pane });
    void cmd.call("agent.markSeen", { agentId: a.id }).catch(() => {});
  };

  const row = (a: Agent, depth: number) => {
    const r: SidebarRow = { key: a.id, pane: a.paneId ? (s.panes.get(a.paneId) ?? null) : null, win: null, agent: a, children: [], urgent: null };
    const f = fieldsOf(r, undefined, now);
    const space = scope === "all" ? s.spaces.get(a.spaceId)?.name : undefined;
    return (
      <div key={a.id}>
        <button className="aa-row" data-depth={depth || undefined} data-needs={bucketOf(a) === "needs" || undefined} onClick={() => go(a)}>
          <Mark light={f.light} icon={f.icon} />
          <span className="aa-main">
            <span className="aa-name">{f.name}</span>
            {f.status && <span className="aa-status">{f.status.text}</span>}
          </span>
          <span className="aa-side">
            <span className="aa-place">{[space, a.cwd ? project(a.cwd) : undefined].filter(Boolean).join(" · ")}</span>
            <span className="aa-time">{shortAgo(a.stateSince, now)}</span>
          </span>
        </button>
        {children.get(a.id)?.map((c) => row(c, depth + 1))}
      </div>
    );
  };

  const setScope = (v: "space" | "all") => void cmd.call("window.update", { id: win.id, state: { scope: v } }).catch(() => {});
  return (
    <div className="aa">
      <div className="aa-bar">
        <span className="aa-summary">
          {counts.needs > 0 && <span className="aa-count" data-tone="needs">{counts.needs} waiting for you</span>}
          {counts.working > 0 && <span className="aa-count">{counts.working} working</span>}
          {counts.done > 0 && <span className="aa-count">{counts.done} done</span>}
          {!all.length && <span className="aa-count">No agents</span>}
        </span>
        <Segmented size="sm" value={scope} options={[{ value: "space", label: "This Space" }, { value: "all", label: "All Spaces" }]} onChange={setScope} />
      </div>
      <div className="aa-list">
        {roots.length ? (
          roots.map((a) => row(a, 0))
        ) : (
          <EmptyState compact icon="person.2" title={scope === "all" ? "No agents running" : "No agents in this Space"} action={<Button onClick={() => void newAgent("claude")}>New Claude Session</Button>}>
            Agents you start show up here as they work.
          </EmptyState>
        )}
      </div>
    </div>
  );
}
