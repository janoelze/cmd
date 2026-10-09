// Workbench stories (pnpm workbench resourcesview): the Resources widget, Resources
// with stand-in samples: a busy workspace, one terminal, every workspace, nothing
// running, loading, and every size.

import type { PaneId } from "@cmd/protocol";
import { AllSizes, RefWindow, series, type SizeName } from "../reference/RefWindow.tsx";
import { Resources, type ResourcesProps, type TerminalUse } from "./ResourcesView.tsx";

const MB = 1024 * 1024;
const term = (n: number, name: string, icon: string, cpu: number, memory: number, top: string[], processes: number, workspace?: string): TerminalUse => ({ id: `p${n}` as PaneId, name, icon, cpu, memory: memory * MB, top, processes, workspace });

const TERMINALS = [
  term(1, "Claude · window design", "sparkle", 92, 812, ["claude", "node", "rg"], 9),
  term(2, "pnpm dev", "terminal", 21.4, 1240, ["Electron Helper (Renderer)", "node", "esbuild"], 14),
  term(3, "Codex · sqlite viewer", "sparkle", 6.1, 288, ["codex", "node"], 4),
  term(4, "zsh", "terminal", 0.2, 6, ["zsh"], 1),
];
const CPU = series(60, 7, 110, 30);
const MEM = series(60, 3, 2300, 120);
const history = CPU.map((cpu, i) => ({ cpu, memory: MEM[i]! * MB }));

const noop = () => {};
const base: ResourcesProps = { terminals: TERMINALS, history, app: { cpu: 8.2, memory: 640 * MB }, background: { cpu: 1.4, memory: 96 * MB }, all: false, onShow: noop, onOpenTaskManager: noop };

function W({ size = "regular", ...p }: Partial<ResourcesProps> & { size?: SizeName }) {
  return (
    <RefWindow icon="gauge.with.dots.needle.33percent" name="Resources · cmd" size={size}>
      <Resources {...base} {...p} />
    </RefWindow>
  );
}

export const Default = () => <W />;
export const Sizes = () => <AllSizes render={(s) => <W size={s} />} />;
export const OneTerminal = () => <W terminals={TERMINALS.slice(3)} history={history.map((h) => ({ cpu: h.cpu / 40, memory: 6 * MB }))} />;
export const EveryWorkspace = () => <W all terminals={TERMINALS.map((t, i) => ({ ...t, workspace: ["cmd", "cmd", "fl-studio-web", "Home"][i] }))} />;
export const NothingRunning = () => <W terminals={[]} history={history.map(() => ({ cpu: 0, memory: 0 }))} />;
export const Loading = () => <W terminals={null} history={[]} app={null} background={null} />;
