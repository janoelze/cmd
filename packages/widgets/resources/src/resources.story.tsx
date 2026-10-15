// Terminal Usage's states for the UI Workbench (`pnpm workbench widgets/resources`): the widget
// against the fake host, one variant per state. The terminals and cmd's own numbers are the native
// Resources story's (windows/resources/ResourcesView.story.tsx), so the two can be compared side by
// side; the sparklines start with the widget, so a still has one sample. `cmd widget preview`
// draws the first six.

import type { HostData } from "@cmd/widget-api/testing/host";
import { agent, appUsage, pane, usage } from "@cmd/widget-api/testing/fixtures";
import TerminalUsage from "./resources.tsx";

export default TerminalUsage;

const MB = 2 ** 20;
const top = (...names: string[]) => names.map((name, i) => ({ name, memory: (100 - i * 30) * MB }));

/** The native story's four terminals: two agents at work, a dev server, an idle shell. */
const terminals = [
  pane({ title: "Claude · window design", agentId: "a1" }),
  pane({ title: "pnpm dev", command: "pnpm dev" }),
  pane({ title: "Codex · sqlite viewer", agentId: "a2" }),
  pane({ title: "zsh" }),
];
const agents = [agent({ id: "a1", name: "Claude · window design", terminalId: "t-claude-window-design" }), agent({ id: "a2", name: "Codex · sqlite viewer", kind: "codex", terminalId: "t-codex-sqlite-viewer" })];
const samples = [
  usage({ id: "t-claude-window-design", cpu: 92, memory: 812 * MB, processes: 9, top: top("claude", "node", "rg") }),
  usage({ id: "t-pnpm-dev", cpu: 21.4, memory: 1240 * MB, processes: 14, top: top("Electron Helper (Renderer)", "node", "esbuild") }),
  usage({ id: "t-codex-sqlite-viewer", cpu: 6.1, memory: 288 * MB, processes: 4, top: top("codex", "node") }),
  usage({ id: "t-zsh", cpu: 0.2, memory: 6 * MB, processes: 1, top: top("zsh") }),
];
/** cmd itself, as the native story has it. */
const own = appUsage({ app: { cpu: 8.2, memory: 640 * MB }, background: { cpu: 1.4, memory: 96 * MB } });

/** A busy workspace: agents at work, a dev server, an idle shell; then cmd itself. */
export const Busy: HostData = { terminals, agents, terminalUsage: samples, appUsage: own };

/** Every workspace's terminals, from the title menu: each with its workspace's name. */
export const EveryWorkspace: HostData = {
  workspace: { name: "cmd" },
  terminals: [...terminals.slice(0, 2), { ...terminals[2]!, workspaceId: "ws-2" }, { ...terminals[3]!, workspaceId: "ws-3" }],
  agents,
  terminalUsage: samples.map((u, i) => ({ ...u, workspaceId: ["ws-1", "ws-1", "ws-2", "ws-3"][i]! })),
  workspaces: [{ id: "ws-1", name: "cmd" }, { id: "ws-2", name: "fl-studio-web" }, { id: "ws-3", name: "Home" }],
  appUsage: own,
  state: { scope: "all" },
};

/** One quiet terminal. */
export const OneTerminal: HostData = { terminals: terminals.slice(3), terminalUsage: samples.slice(3), appUsage: own };

/** Nothing running in this workspace: cmd's own use still shows. */
export const NothingRunning: HostData = { terminals: [], terminalUsage: [], appUsage: own };

/** Terminals cmd hasn't sampled yet. */
export const Measuring: HostData = { terminals, agents, terminalUsage: [], appUsage: own };

/** Many terminals, sorted by memory from its header. */
export const Many: HostData = {
  terminals: Array.from({ length: 40 }, (_, i) => pane({ title: `job ${i + 1}` })),
  terminalUsage: Array.from({ length: 40 }, (_, i) => usage({ id: `t-job-${i + 1}`, cpu: (i * 37) % 100, memory: ((i * 53) % 900) * MB + MB, processes: 1 + (i % 5) })),
  appUsage: own,
  state: { sort: { key: "memory", desc: true } },
};

/** Nothing running, and cmd can't tell what it uses itself. */
export const Empty: HostData = { terminals: [], terminalUsage: [], appUsage: appUsage({ app: null, background: null }) };
