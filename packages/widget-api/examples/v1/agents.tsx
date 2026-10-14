// The example widget of API 1 (docs/56, "Writing the UI"): the agents of this workspace,
// those waiting for you first, a click going to the agent's terminal, the scope in the
// title menu. Tests in test/testing.test.tsx render it against the fake host; it is the
// API's promise kept in code, so it uses only API 1.

import { Window, View, List, ListSection, ListRow, ListRowIcon, ListRowContent, ListRowEnd, Chip, useAgents, useStoredState, useNow, fmt, cmd, type Agent } from "@cmd/widget-api";

function Row({ agent, now }: { agent: Agent; now: number }) {
  return (
    <ListRow depth={agent.depth} onClick={() => agent.windowId && cmd.windows.select(agent.windowId)}>
      <ListRowIcon icon={agent.icon} light={agent.light} />
      <ListRowContent title={agent.name} place={agent.place ?? undefined} detail={agent.statusLine} tone={agent.bucket === "needs" ? "needs" : undefined} />
      <ListRowEnd>
        <Chip>{fmt.ago(agent.stateSince, now)}</Chip>
      </ListRowEnd>
    </ListRow>
  );
}

export default function AgentActivity() {
  const [scope, setScope] = useStoredState<"workspace" | "all">("scope", "workspace");
  const agents = useAgents({ scope });
  const now = useNow(15_000);
  const waiting = agents.filter((a) => a.bucket === "needs");
  const working = agents.filter((a) => a.bucket !== "needs" && a.state === "working");
  const rest = agents.filter((a) => a.bucket !== "needs" && a.state !== "working");
  const status = [waiting.length && `${waiting.length} waiting for you`, working.length && `${working.length} working`].filter(Boolean).join(" · ") || null;

  return (
    <Window
      status={status}
      menu={[
        { label: "This Workspace", checked: scope === "workspace", run: () => setScope("workspace") },
        { label: "All Workspaces", checked: scope === "all", run: () => setScope("all") },
      ]}
    >
      <View state={agents.length ? null : { icon: "person.2", title: "No agents", text: "Start one with ⌥⌘N." }}>
        <List>
          {waiting.length > 0 && (
            <ListSection title="Waiting for you" count={waiting.length} tone="needs">
              {waiting.map((a) => <Row key={a.id} agent={a} now={now} />)}
            </ListSection>
          )}
          {working.length > 0 && (
            <ListSection title="Working" count={working.length}>
              {working.map((a) => <Row key={a.id} agent={a} now={now} />)}
            </ListSection>
          )}
          {rest.length > 0 && (
            <ListSection title="Others" count={rest.length}>
              {rest.map((a) => <Row key={a.id} agent={a} now={now} />)}
            </ListSection>
          )}
        </List>
      </View>
    </Window>
  );
}
