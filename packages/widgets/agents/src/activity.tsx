// Agents, a built-in widget package (docs/56, "Built-ins and dogfooding"): every agent in
// this workspace, or all of them, at a glance, in one ranked list as the native Agent
// Activity: who waits for you first, then who is working, then what finished that you
// haven't seen, then the rest, most recent first; subagents under their host. A row's end
// says where it works and how long ago, as the sidebar does. A click goes to
// the agent's terminal (a subagent's: its host's), in its workspace. The counts are the
// title bar's status, and its menu switches the scope, kept per window.

import type { ReactNode } from "react";
import { Window, View, List, ListRow, ListRowIcon, ListRowContent, ListRowEnd, Stack, Text, useAgents, useStoredState, useNow, fmt, cmd, type Agent } from "@cmd/widget-api";

type Scope = "workspace" | "all";

/** Waiting for you, then working, then finished and not seen yet, then the rest. */
export function rank(a: Agent): number {
  if (a.bucket === "needs") return 0;
  if (a.state === "working" || a.state === "starting") return 1;
  return a.bucket === "unseen" ? 2 : 3;
}

/** Hosts with their subagents under them, each level by rank, then most recent first. */
function tree(agents: Agent[]): { roots: Agent[]; under: (a: Agent) => Agent[] } {
  const ids = new Set(agents.map((a) => a.id));
  const kids = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const a of agents) {
    if (a.parentId && ids.has(a.parentId)) kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a]);
    else roots.push(a);
  }
  const order = (x: Agent, y: Agent) => rank(x) - rank(y) || y.stateSince - x.stateSince;
  roots.sort(order);
  for (const list of kids.values()) list.sort(order);
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
    <ListRow depth={depth} tip={agent.cwd} onClick={() => go(agent)}>
      <ListRowIcon icon={agent.icon} light={agent.light} />
      <ListRowContent title={agent.name} detail={agent.statusLine} tone={agent.bucket === "needs" ? "needs" : undefined} />
      <ListRowEnd>
        <Stack gap={0} align="end">
          {agent.place && (
            <Text size="xs" tone="dim" truncate>
              {agent.place}
            </Text>
          )}
          <Text size="xs" tone="dim">
            {fmt.ago(agent.stateSince, now)}
          </Text>
        </Stack>
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
        <List>{roots.flatMap((a) => rows(a, 0))}</List>
      </View>
    </Window>
  );
}
