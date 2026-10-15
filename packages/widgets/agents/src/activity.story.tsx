// The Agents widget's states for the UI Workbench (`pnpm workbench widgets/agents`): the
// widget (the default export) against the fake host, one variant per state, each the
// host's data. The Workbench runs the widget on it and draws the tree it sends.

import type { HostData } from "@cmd/widget-api/testing/host";
import { agent } from "@cmd/widget-api/testing/fixtures";
import Agents from "./activity.tsx";

export default Agents;

const min = (n: number) => Date.now() - n * 60_000;
const team = [
  agent({ name: "Tours", state: "waiting", statusLine: "Wants to run pnpm e2e", place: "cmd-tours", stateSince: min(2) }),
  agent({ name: "Perf", state: "working", statusLine: "Running the stress test", place: "cmd-perf", stateSince: min(6) }),
  agent({ name: "Explore", state: "working", statusLine: "Reading packages/core/src/agents", parentId: "a-perf", depth: 1, terminalId: null, windowId: null, stateSince: min(1) }),
  agent({ name: "Docs", state: "done", statusLine: "Wrote the API reference", place: "cmd", stateSince: min(14) }),
  agent({ name: "Codex", kind: "codex", state: "idle", place: "web", stateSince: min(95) }),
];

/** One ranked list: waiting for you first, then working (a subagent under its host), then finished, then the rest; the counts in the title bar. */
export const Busy: HostData = { agents: team };

/** All Workspaces from the title menu: agents of other workspaces too. */
export const AllWorkspaces: HostData = { state: { scope: "all" }, agents: [...team, agent({ name: "Release", state: "waiting", statusLine: "Approve the tag?", workspaceId: "ws-2", place: "release" })] };

/** In a narrow window, as in a sidebar. */
export const Narrow: HostData & { size: "narrow" } = { agents: team, size: "narrow" };

/** No agents in this workspace yet. */
export const Empty: HostData = { agents: [] };
