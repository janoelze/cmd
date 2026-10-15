// Terminal Usage's states for the UI Workbench (`pnpm workbench widgets/resources`): the widget
// against the fake host, one variant per state, each the host's data (stand-in samples).

import type { HostData } from "@cmd/widget-api/testing/host";
import { agent, pane, usage } from "@cmd/widget-api/testing/fixtures";
import TerminalUsage from "./resources.tsx";

export default TerminalUsage;

const MB = 2 ** 20;
const top = (...names: [string, number][]) => names.map(([name, mb]) => ({ name, memory: mb * MB }));

const terminals = [
  pane({ title: "Claude · window design", agentId: "a1" }),
  pane({ title: "pnpm dev", command: "pnpm dev" }),
  pane({ title: "Codex · sqlite viewer", agentId: "a2" }),
  pane({ title: "zsh" }),
];
// The agents in two of them: their rows say the agent's name and its kind's icon, as the sidebar does.
const agents = [agent({ id: "a1", name: "Claude · window design", terminalId: "t-claude-window-design" }), agent({ id: "a2", name: "Codex · sqlite viewer", kind: "codex", terminalId: "t-codex-sqlite-viewer" })];
const samples = [
  usage({ id: "t-claude-window-design", cpu: 92, memory: 812 * MB, processes: 9, top: top(["claude", 600], ["node", 200], ["rg", 12]) }),
  usage({ id: "t-pnpm-dev", cpu: 21.4, memory: 1240 * MB, processes: 14, top: top(["Electron Helper (Renderer)", 700], ["node", 400], ["esbuild", 140]) }),
  usage({ id: "t-codex-sqlite-viewer", cpu: 6.1, memory: 288 * MB, processes: 4, top: top(["codex", 200], ["node", 88]) }),
  usage({ id: "t-zsh", cpu: 0.2, memory: 6 * MB, top: top(["zsh", 6]) }),
];

/** A busy workspace: an agent at work, a dev server, an idle shell. */
export const Busy: HostData = { terminals, agents, terminalUsage: samples };

/** Every workspace's terminals, from the title menu: where each runs. */
export const EveryWorkspace: HostData = {
  terminals: [...terminals, pane({ title: "make watch", workspaceId: "ws-2", cwd: "/Users/me/src/fl-studio-web" })],
  terminalUsage: [...samples, usage({ id: "t-make-watch", workspaceId: "ws-2", cpu: 44, memory: 420 * MB, processes: 6, top: top(["make", 4], ["node", 400]) })],
  state: { scope: "all" },
};

/** One quiet terminal. */
export const OneTerminal: HostData = { terminals: [pane()], terminalUsage: [usage()] };

/** In a narrow window, as in a sidebar: the least important columns give way. */
export const Narrow: HostData & { size: "narrow" } = { terminals, agents, terminalUsage: samples, size: "narrow" };

/** Terminals cmd hasn't sampled yet. */
export const Loading: HostData = { terminals, terminalUsage: [] };

/** Nothing running in this workspace. */
export const Empty: HostData = { terminals: [], terminalUsage: [] };

/** Many terminals, sorted by memory. */
export const Many: HostData = {
  terminals: Array.from({ length: 40 }, (_, i) => pane({ title: `job ${i + 1}` })),
  terminalUsage: Array.from({ length: 40 }, (_, i) => usage({ id: `t-job-${i + 1}`, cpu: (i * 37) % 100, memory: ((i * 53) % 900) * MB + MB, processes: 1 + (i % 5) })),
  state: { sort: { key: "memory", desc: true } },
};
