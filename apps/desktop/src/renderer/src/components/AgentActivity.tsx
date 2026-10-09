// Agent Activity, a built-in widget (docs/16-widgets.md): every agent in this
// Workspace, or all of them, at a glance: who waits for you first, then who is
// working, then what finished. Rows say what the sidebar says (fieldsOf), so
// the two never disagree; a click goes to the agent's terminal. The counts are
// the title bar's status, and its menu switches the scope.

import { Button, List, ListRow, Stack, Text, View, useFlip, type DotState } from "@cmd/ui";
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { bucketOf, type Agent } from "@cmd/protocol";
import { newAgent, selectPane } from "../actions.ts";
import { cmd } from "../bridge.ts";
import { fieldsOf, whereOf, type SidebarRow } from "../model.ts";
import { showWorkspace } from "../workspaces.tsx";
import { useStore } from "../store.ts";
import type { WindowViewProps } from "../windows/registry.ts";
import { useWidgetStatus } from "../widgets.ts";
import { shortAgo } from "./SidebarRows.tsx";

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
  const scope = win.state.scope === "all" ? "all" : "workspace";
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Agents re-sort as their state changes: they glide to their new place.
  const listRef = useRef<HTMLDivElement>(null);
  useFlip(listRef, { selector: "[data-key]" });
  const { roots, children } = useMemo(() => {
    const shown = [...s.agents.values()].filter((a) => scope === "all" || a.workspaceId === win.workspaceId);
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
  }, [s.agents, scope, win.workspaceId]);

  const all = [...s.agents.values()].filter((a) => scope === "all" || a.workspaceId === win.workspaceId);
  const counts = {
    needs: all.filter((a) => bucketOf(a) === "needs").length,
    working: all.filter((a) => a.state === "working" || a.state === "starting").length,
    done: all.filter((a) => a.state === "done").length,
  };

  // The title bar's status: who waits, who works, what's done (its menu has the scope).
  useWidgetStatus(win.id, [counts.needs && `${counts.needs} waiting for you`, counts.working && `${counts.working} working`, counts.done && `${counts.done} done`].filter(Boolean).join(" · ") || null, "summary");

  const go = (a: Agent) => {
    // Subagents without a terminal of their own live in their host's.
    let at: Agent | undefined = a;
    while (at && !at.paneId && at.parentId) at = s.agents.get(at.parentId);
    const pane = at?.paneId;
    if (!pane) return;
    if (at!.workspaceId === s.workspaceId) selectPane(pane);
    else showWorkspace(at!.workspaceId, { select: pane });
    void cmd.call("agent.markSeen", { agentId: a.id }).catch(() => {});
  };

  const lines: ActivityLine[] = [];
  const add = (a: Agent, depth: number) => {
    const r: SidebarRow = { key: a.id, pane: a.paneId ? (s.panes.get(a.paneId) ?? null) : null, win: null, agent: a, children: [], urgent: null };
    const f = fieldsOf(r, undefined, now);
    const sp = s.workspaces.get(a.workspaceId);
    const where = whereOf(a.git, a.cwd, sp);
    lines.push({
      key: a.id,
      depth,
      icon: f.icon,
      light: f.light,
      name: f.name,
      status: f.status?.text,
      place: [scope === "all" ? sp?.name : undefined, where?.text].filter(Boolean).join(" · "),
      placeTip: where?.tip,
      time: shortAgo(a.stateSince, now),
      needs: bucketOf(a) === "needs",
      onClick: () => go(a),
    });
    for (const c of children.get(a.id) ?? []) add(c, depth + 1);
  };
  for (const a of roots) add(a, 0);

  return <AgentActivityView lines={lines} scope={scope} listRef={listRef} onNew={() => void newAgent("claude")} />;
}

/** One agent's row: what the sidebar says about it (fieldsOf), where it works, since when. */
export interface ActivityLine {
  key: string;
  /** Subagents sit under their host. */
  depth: number;
  icon: string;
  light?: DotState;
  name: ReactNode;
  status?: ReactNode;
  place: string;
  placeTip?: string;
  time: string;
  /** Waiting for you: its status in the needs tone. */
  needs: boolean;
  onClick: () => void;
}

/** The list, drawn (AgentActivity.story.tsx shows every state). */
export function AgentActivityView({ lines, scope, listRef, onNew }: { lines: ActivityLine[]; scope: "all" | "workspace"; listRef?: Ref<HTMLDivElement>; onNew: () => void }) {
  return (
    <View
      bodyRef={listRef}
      state={
        lines.length
          ? null
          : { kind: "empty", icon: "person.2", title: scope === "all" ? "No agents running" : "No agents in this workspace", text: "Agents you start show up here as they work.", action: <Button onClick={onNew}>New Claude Session</Button> }
      }
    >
      <List>
        {lines.map((l) => (
          <ListRow
            key={l.key}
            flipKey={l.key}
            depth={l.depth}
            icon={l.icon}
            light={l.light}
            title={l.name}
            tone={l.needs ? "needs" : undefined}
            detail={l.status}
            end={
              <Stack gap="none" align="end">
                <span data-tip={l.placeTip}>
                  <Text size="xs" tone="dim" truncate>
                    {l.place}
                  </Text>
                </span>
                <Text size="xs" tone="dim">
                  {l.time}
                </Text>
              </Stack>
            }
            onClick={l.onClick}
          />
        ))}
      </List>
    </View>
  );
}
