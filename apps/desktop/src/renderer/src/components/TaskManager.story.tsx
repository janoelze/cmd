// Workbench stories (pnpm workbench taskmanager): the Task Manager's content with a
// stand-in snapshot: cmd's processes, a few terminals (one opened to its
// processes), the sheet as the app shows it, the core not answering, loading,
// and every size.

import type { Pane, Workspace } from "@cmd/protocol";
import { Dialog } from "@cmd/ui";
import { useState } from "react";
import { AllSizes, RefWindow, type SizeName } from "../reference/RefWindow.tsx";
import { ICON, TaskManagerView, type Snapshot, type TaskManagerViewProps } from "./TaskManager.tsx";

const MB = 1024 * 1024;
const WORKSPACES = [{ id: "w1", name: "cmd" }, { id: "w2", name: "fl-studio-web" }] as Workspace[];
const pane = (n: number, title: string, foreground: string, workspaceId: string, cpu: number, memory: number, top: [string, number][]) =>
  ({
    id: `p${n}`,
    title,
    foreground,
    shell: "zsh",
    workspaceId,
    pid: 4000 + n * 10,
    exitCode: null,
    usage: { cpu, memory: memory * MB, processes: top.length, top: top.map(([name, mb], i) => ({ name, pid: 4000 + n * 10 + i + 1, memory: mb * MB })) },
  }) as unknown as Pane;

const SNAP: Snapshot = {
  app: [
    { pid: 812, type: "Browser", name: "cmd", cpu: 3.2, memory: 182 * MB },
    { pid: 815, type: "GPU", name: "GPU", cpu: 6.8, memory: 240 * MB },
    { pid: 818, type: "Tab", name: "Window 1", cpu: 4.1, memory: 310 * MB },
    { pid: 821, type: "Utility", name: "Network Service", cpu: 0.2, memory: 22 * MB },
  ],
  core: { core: { pid: 702, cpu: 1.1, memory: 96 * MB }, ptyHost: { pid: 705, cpu: 0.4, memory: 48 * MB } },
  panes: [
    pane(1, "Claude · window design", "claude", "w1", 42.5, 812, [["claude", 520], ["node", 210], ["rg", 82]]),
    pane(2, "pnpm dev", "node", "w1", 21.4, 1240, [["Electron Helper (Renderer)", 610], ["node", 420], ["esbuild", 210]]),
    pane(3, "zsh", "zsh", "w2", 0.0, 6, [["zsh", 6]]),
  ],
  workspaces: WORKSPACES,
};

function W({ size = "wide", ...p }: Partial<TaskManagerViewProps> & { size?: SizeName }) {
  const [log, setLog] = useState<string | null>(null);
  return (
    <RefWindow icon={ICON} name="Task Manager" size={size}>
      <TaskManagerView snap={SNAP} error={null} onShow={(x) => setLog(`show ${x.id}`)} onEnd={async (n) => (setLog(`end ${n}`), true)} {...p} />
      {log && <span hidden>{log}</span>}
    </RefWindow>
  );
}

export const Default = () => <W />;
/** As the app shows it: a sheet dressed as a window (TaskManager). */
export const Sheet = () => (
  <Dialog open onClose={() => {}} window={{ icon: ICON, name: "Task Manager" }} width={720} height={520} position="center" padded={false}>
    <TaskManagerView snap={SNAP} error={null} onShow={() => {}} onEnd={async () => false} />
  </Dialog>
);
export const Sizes = () => <AllSizes render={(s) => <W size={s} />} />;
export const NoTerminals = () => <W snap={{ ...SNAP, panes: [] }} />;
export const NotResponding = () => <W error="Timed out" />;
export const Loading = () => <W snap={null} />;
export const Unreachable = () => <W snap={null} error="connect ENOENT /tmp/cmd.sock" />;
