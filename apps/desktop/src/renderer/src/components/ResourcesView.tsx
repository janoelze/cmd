// Resources, a built-in widget (docs/16-widgets.md): what each terminal of this
// Space (or every Space) uses, CPU and memory of its whole process tree
// (Pane.usage, sampled by the core while a UI is connected), busiest first; a
// terminal expands to its largest processes. Then cmd itself. Polled every 2 s,
// as the Task Manager (Window → Task Manager) is, which has the full detail.

import { EmptyState, ListRow, ListSection, ListValue, Panel, PanelBody, Twisty } from "@cmd/ui";
import { useEffect, useState } from "react";
import type { Pane, ProcessStat } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { fieldsOf, formatBytes } from "../model.ts";
import { useStore } from "../store.ts";
import { goTo, scopeOf, useWidgetStatus } from "../widgets.ts";
import type { WindowViewProps } from "../windows/registry.ts";

const POLL_MS = 2000;
/** A terminal this busy is worth a second look. */
const HOT_CPU = 80;

interface Sample {
  panes: Pane[];
  /** cmd's own: the app's processes, then the background process and the terminals' host. */
  app: { cpu: number; memory: number };
  core: { cpu: number; memory: number };
}

function useSample(): Sample | null {
  const [sample, setSample] = useState<Sample | null>(null);
  useEffect(() => {
    let stale = false;
    type Use = { cpu: number; memory: number };
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

const pct = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;

export function ResourcesView({ win }: WindowViewProps) {
  const s = useStore();
  const sample = useSample();
  const scope = scopeOf(win.state.scope);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((o) => (o.has(id) ? new Set([...o].filter((x) => x !== id)) : new Set([...o, id])));

  const panes = (sample?.panes ?? [])
    .filter((p) => p.exitCode === null && p.usage && (scope === "all" || p.spaceId === win.spaceId))
    .sort((a, b) => b.usage!.cpu - a.usage!.cpu || b.usage!.memory - a.usage!.memory);
  const total = panes.reduce((t, p) => ({ cpu: t.cpu + p.usage!.cpu, memory: t.memory + p.usage!.memory }), { cpu: 0, memory: 0 });
  const now = Date.now();

  useWidgetStatus(win.id, panes.length > 0 ? `${pct(total.cpu)} · ${formatBytes(total.memory)}` : null, "usage");
  const values = (cpu: number, memory: number) => (
    <>
      <ListValue strong={cpu >= HOT_CPU}>{pct(cpu)}</ListValue>
      <span className="rs-mem">
        <ListValue>{formatBytes(memory)}</ListValue>
      </span>
    </>
  );

  const row = (p: Pane) => {
    const u = p.usage!;
    const live = s.panes.get(p.id) ?? p;
    const agent = live.agentId ? (s.agents.get(live.agentId) ?? null) : null;
    const f = fieldsOf({ key: p.id, pane: live, win: null, agent, children: [], urgent: null }, undefined, now);
    const top = u.top.slice(0, 3).map((t) => t.name);
    const space = scope === "all" ? s.spaces.get(p.spaceId)?.name : undefined;
    const isOpen = open.has(p.id);
    return (
      <div key={p.id}>
        <ListRow
          lead={u.top.length > 0 ? <Twisty open={isOpen} onToggle={() => toggle(p.id)} /> : <span className="ui-twisty" />}
          icon={f.icon}
          light={u.cpu >= HOT_CPU ? "working" : undefined}
          title={f.name}
          detail={[top.join(", "), u.processes > 1 ? `${u.processes} processes` : null, space].filter(Boolean).join(" · ")}
          end={values(u.cpu, u.memory)}
          onClick={() => goTo(p.id, p.spaceId)}
        />
        {isOpen &&
          u.top.map((t) => (
            <ListRow key={t.pid} depth={2} title={t.name} place={`${t.pid}`} end={<span className="rs-mem"><ListValue>{formatBytes(t.memory)}</ListValue></span>} />
          ))}
      </div>
    );
  };

  return (
    <Panel className="rs">
      <PanelBody>
        {panes.length > 0 && (
          <ListSection title="Terminals" count={panes.length}>
            {panes.map(row)}
          </ListSection>
        )}
        {sample && panes.length === 0 && (
          <EmptyState compact icon="gauge.with.dots.needle.33percent" title="Nothing running">
            {scope === "all" ? "Open a terminal and what runs in it shows up here." : "Open a terminal in this Space and what runs in it shows up here."}
          </EmptyState>
        )}
        {sample && (
          <ListSection title="cmd">
            <ListRow icon="macwindow" title="App" end={values(sample.app.cpu, sample.app.memory)} />
            <ListRow icon="gearshape.2" title="Background" tip="Keeps your terminals and agents running while the app is closed" end={values(sample.core.cpu, sample.core.memory)} />
          </ListSection>
        )}
      </PanelBody>
    </Panel>
  );
}
