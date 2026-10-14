// Agents, a built-in widget package (docs/56, "Built-ins and dogfooding"): every agent in
// this workspace, or all of them, at a glance. Who waits for you first, then who is
// working, then the rest, most recent first; subagents under their host. A click goes to
// the agent's terminal (a subagent's: its host's), in its workspace. The counts are the
// title bar's status, and its menu switches the scope, kept per window.

import type { ReactNode } from "react";
import { Window, View, List, ListSection, ListRow, ListRowIcon, ListRowContent, ListRowEnd, Chip, useAgents, useStoredState, useNow, fmt, cmd, type Agent } from "@cmd/widget-api";

type Scope = "workspace" | "all";

/** Waiting for you, working, the rest: the section an agent (and its subagents) sit in. */
const SECTIONS = [
  { title: "Waiting for you", tone: "needs" as const, has: (a: Agent) => a.bucket === "needs" },
  { title: "Working", has: (a: Agent) => a.bucket !== "needs" && (a.state === "working" || a.state === "starting") },
  { title: "Idle", has: (a: Agent) => a.bucket !== "needs" && a.state !== "working" && a.state !== "starting" },
];

/** Hosts with their subagents under them, each level most recent first. */
function tree(agents: Agent[]): { roots: Agent[]; under: (a: Agent) => Agent[] } {
  const ids = new Set(agents.map((a) => a.id));
  const kids = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const a of agents) {
    if (a.parentId && ids.has(a.parentId)) kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a]);
    else roots.push(a);
  }
  const recent = (x: Agent, y: Agent) => y.stateSince - x.stateSince;
  roots.sort(recent);
  for (const list of kids.values()) list.sort(recent);
  return { roots, under: (a) => kids.get(a.id) ?? [] };
}

/** The window that shows an agent: its own terminal's, else its host's (a subagent lives in its host's terminal). */
function windowOf(a: Agent, byId: Map<string, Agent>): string | null {
  let at: Agent | undefined = a;
  while (at && !at.terminalId && at.parentId) at = byId.get(at.parentId);
  return at?.windowId ?? a.windowId;
}

function Row({ agent, depth, now, go }: { agent: Agent; depth: number; now: number; go: (a: Agent) => void }) {
  return (
    <ListRow depth={depth} onClick={() => go(agent)}>
      <ListRowIcon icon={agent.icon} light={agent.light} />
      <ListRowContent title={agent.name} place={agent.place ?? undefined} detail={agent.statusLine} tone={agent.bucket === "needs" ? "needs" : undefined} />
      <ListRowEnd>
        <Chip>{fmt.ago(agent.stateSince, now)}</Chip>
      </ListRowEnd>
    </ListRow>
  );
}

export default function Agents() {
  const [scope, setScope] = useStoredState<Scope>("scope", "workspace");
  const agents = useAgents({ scope });
  const now = useNow(15_000);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const { roots, under } = tree(agents);
  const go = (a: Agent) => {
    const w = windowOf(a, byId);
    if (w) void cmd.windows.select(w).catch(() => {});
  };
  const rows = (a: Agent, depth: number): ReactNode[] => [<Row key={a.id} agent={a} depth={depth} now={now} go={go} />, ...under(a).flatMap((c) => rows(c, depth + 1))];

  const waiting = agents.filter((a) => a.bucket === "needs").length;
  const working = agents.filter((a) => a.state === "working" || a.state === "starting").length;
  const done = agents.filter((a) => a.state === "done").length;
  const status = [waiting && `${waiting} waiting for you`, working && `${working} working`, done && `${done} done`].filter(Boolean).join(" · ") || null;

  return (
    <Window
      status={status}
      menu={[
        { label: "This Workspace", checked: scope === "workspace", run: () => setScope("workspace") },
        { label: "All Workspaces", checked: scope === "all", run: () => setScope("all") },
      ]}
    >
      <View
        state={
          agents.length ? null : { icon: "person.2", title: scope === "all" ? "No agents running" : "No agents in this workspace", text: "Agents you start show up here as they work." }
        }
      >
        <List>
          {SECTIONS.map((s) => {
            const mine = roots.filter(s.has);
            return mine.length ? (
              <ListSection key={s.title} title={s.title} count={mine.length} tone={s.tone}>
                {mine.flatMap((a) => rows(a, 0))}
              </ListSection>
            ) : null;
          })}
        </List>
      </View>
    </Window>
  );
}
