// Resources, a built-in widget (docs/16-widgets.md): what each terminal of this
// Workspace (or every workspace) uses, CPU and memory of its whole process tree
// (Pane.usage, sampled by the core while a UI is connected), busiest first, with
// the last two minutes as sparklines; then cmd itself. Polled every 2 s, as the
// Task Manager (Window → Task Manager) is, which has the full detail.
//
// ResourcesView polls and keeps the history; Resources draws it, as the
// window-design skill's chart window (stats with sparklines, then tables), so
// ResourcesView.story.tsx can show every state.

import { DataGrid, LinkButton, ListMark, Pane, Panes, Sparkline, Stat, StatusLine, Text, Tiles, View } from "@cmd/ui";
import { useEffect, useState } from "react";
import type { Pane as TermPane, PaneId, ProcessStat } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { fieldsOf, formatBytes } from "../model.ts";
import { useStore } from "../store.ts";
import { goTo, scopeOf, useWidgetStatus } from "../widgets.ts";
import type { WindowViewProps } from "../windows/registry.ts";

const POLL_MS = 2000;
/** Samples kept for the sparklines: two minutes. */
const HISTORY = 60;
/** A terminal this busy is worth a second look. */
const HOT_CPU = 80;

type Use = { cpu: number; memory: number };

interface Sample {
  panes: TermPane[];
  /** cmd's own: the app's processes, then the background process and the terminals' host. */
  app: Use;
  core: Use;
}

function useSample(): Sample | null {
  const [sample, setSample] = useState<Sample | null>(null);
  useEffect(() => {
    let stale = false;
    const sum = (xs: (ProcessStat | Use | null)[]): Use => xs.reduce<Use>((t, x) => (x ? { cpu: t.cpu + x.cpu, memory: t.memory + x.memory } : t), { cpu: 0, memory: 0 });
    const poll = async () => {
      const [panes, app, core] = await Promise.all([
        cmd.call("pane.list", {}),
        cmd.appMetrics().catch(() => []),
        cmd.call("core.processes", {}).catch(() => null),
      ]);
      if (!stale) setSample({ panes, app: sum(app), core: sum([core?.core ?? null, core?.ptyHost ?? null]) });
    };
    void poll().catch(() => {});
    const t = setInterval(() => void poll().catch(() => {}), POLL_MS);
    return () => ((stale = true), clearInterval(t));
  }, []);
  return sample;
}

/** A CPU share as it reads: one decimal below 10. */
const share = (n: number) => (n < 10 ? n.toFixed(1) : String(Math.round(n)));
export const pct = (n: number) => `${share(n)}%`;

/** A terminal as Resources shows it. */
export interface TerminalUse extends Use {
  id: PaneId;
  name: string;
  icon: string;
  /** Its largest processes, by name. */
  top: string[];
  processes: number;
  /** Its workspace, when every workspace's terminals are shown. */
  workspace?: string;
}

export interface ResourcesProps {
  /** Null until the first sample. */
  terminals: TerminalUse[] | null;
  /** The terminals' total CPU and memory, oldest first (the last is now). */
  history: Use[];
  app: Use | null;
  background: Use | null;
  /** Every workspace's terminals, not just this one's. */
  all: boolean;
  onShow: (id: PaneId) => void;
  onOpenTaskManager: () => void;
}

export function Resources(p: ResourcesProps) {
  const now = p.history.at(-1) ?? { cpu: 0, memory: 0 };
  const values = (u: Use) => [
    { node: pct(u.cpu), kind: "number" as const },
    { node: formatBytes(u.memory), kind: "number" as const },
  ];
  const columns = (first: string, extra: { key: string; label: string; hide?: "regular" }[] = []) => [
    { key: "mark", label: "", icon: true },
    { key: "name", label: first, grow: true },
    ...extra,
    { key: "cpu", label: "CPU", align: "end" as const },
    { key: "memory", label: "Memory", align: "end" as const },
  ];
  const terminals = p.terminals ?? [];
  const processes = terminals.reduce((n, t) => n + t.processes, 0);
  return (
    <View
      inset
      state={
        p.terminals === null
          ? { kind: "loading" }
          : terminals.length === 0 && !p.app
            ? { kind: "empty", icon: "gauge.with.dots.needle.33percent", title: "Nothing running", text: p.all ? "Open a terminal and what runs in it shows up here." : "Open a terminal in this workspace and what runs in it shows up here." }
            : null
      }
      footer={
        p.terminals && (
          <StatusLine end={<LinkButton tone="dim" onClick={p.onOpenTaskManager}>Task Manager</LinkButton>}>
            {terminals.length} {terminals.length === 1 ? "terminal" : "terminals"} · {processes} processes
          </StatusLine>
        )
      }
    >
      <Panes>
        <Pane wide>
          <Tiles min={120} gap="xl">
            <Stat label="CPU" value={share(now.cpu)} unit="%">
              <Sparkline values={p.history.map((u) => u.cpu)} series={0} />
            </Stat>
            <Stat label="Memory" value={formatBytes(now.memory)}>
              <Sparkline values={p.history.map((u) => u.memory)} series={1} />
            </Stat>
          </Tiles>
        </Pane>
        {terminals.length > 0 ? (
          <Pane wide title="Terminals" aside={terminals.length}>
            <DataGrid
              columns={columns("Terminal", [{ key: "top", label: "Busiest", hide: "regular" }])}
              rows={terminals.map((t) => [
                <ListMark key="m" icon={t.icon} light={t.cpu >= HOT_CPU ? "working" : undefined} />,
                { node: t.workspace ? `${t.name} · ${t.workspace}` : t.name, tip: [t.name, t.top.join(", "), t.processes > 1 ? `${t.processes} processes` : null, t.workspace].filter(Boolean).join("\n") },
                { node: <Text tone="dim">{t.top.join(", ")}</Text> },
                ...values(t),
              ])}
              rowKey={(_, i) => terminals[i]!.id}
              onRowClick={(i) => p.onShow(terminals[i]!.id)}
            />
          </Pane>
        ) : (
          <Pane wide title="Terminals">
            <Text tone="dim">{p.all ? "No terminals are running." : "No terminals are running in this workspace."}</Text>
          </Pane>
        )}
        {p.app && p.background && (
          <Pane wide title="cmd">
            <DataGrid
              columns={columns("Part")}
              rows={[
                [<ListMark key="m" icon="macwindow" />, "App", ...values(p.app)],
                [<ListMark key="m" icon="gearshape.2" />, { node: "Background", tip: "Keeps your terminals and agents running while the app is closed" }, ...values(p.background)],
              ]}
            />
          </Pane>
        )}
      </Panes>
    </View>
  );
}

export function ResourcesView({ win }: WindowViewProps) {
  const s = useStore();
  const sample = useSample();
  const scope = scopeOf(win.state.scope);
  const [history, setHistory] = useState<Use[]>([]);

  const panes = (sample?.panes ?? [])
    .filter((p) => p.exitCode === null && p.usage && (scope === "all" || p.workspaceId === win.workspaceId))
    .sort((a, b) => b.usage!.cpu - a.usage!.cpu || b.usage!.memory - a.usage!.memory);
  const total = panes.reduce((t, p) => ({ cpu: t.cpu + p.usage!.cpu, memory: t.memory + p.usage!.memory }), { cpu: 0, memory: 0 });
  // One entry per sample: the totals over time, for the sparklines.
  useEffect(() => {
    if (sample) setHistory((h) => [...h, total].slice(-HISTORY));
  }, [sample]);

  useWidgetStatus(win.id, panes.length > 0 ? `${pct(total.cpu)} · ${formatBytes(total.memory)}` : null, "usage");

  const now = Date.now();
  const terminals: TerminalUse[] | null = sample
    ? panes.map((p) => {
        const u = p.usage!;
        const live = s.panes.get(p.id) ?? p;
        const agent = live.agentId ? (s.agents.get(live.agentId) ?? null) : null;
        const f = fieldsOf({ key: p.id, pane: live, win: null, agent, children: [], urgent: null }, undefined, now);
        return { id: p.id, name: f.name, icon: f.icon, cpu: u.cpu, memory: u.memory, top: u.top.slice(0, 3).map((t) => t.name), processes: u.processes, workspace: scope === "all" ? s.workspaces.get(p.workspaceId)?.name : undefined };
      })
    : null;

  return (
    <Resources
      terminals={terminals}
      history={history}
      app={sample?.app ?? null}
      background={sample?.core ?? null}
      all={scope === "all"}
      onShow={(id) => goTo(id, panes.find((p) => p.id === id)?.workspaceId ?? win.workspaceId)}
      onOpenTaskManager={() => cmd.openTaskManager()}
    />
  );
}
