// Terminal Usage, a built-in widget package (docs/57; the native Resources widget's job, less
// cmd's own processes): what each terminal of this workspace (or every workspace, from the title
// menu) uses now, CPU and memory of its whole process tree, busiest first, live from cmd's
// samples (useTerminalUsage, API 1.2), with the last two minutes of the totals as sparklines and
// the totals in the title bar. A click on a row goes to its terminal; a header sorts. A terminal
// cmd hasn't sampled yet isn't listed, so terminals with no sample yet read as loading.

import {
  Window,
  View,
  Stack,
  Tiles,
  Stat,
  Sparkline,
  Panes,
  Pane,
  DataGrid,
  StatusLine,
  useTerminals,
  useTerminalUsage,
  useWorkspace,
  useStoredState,
  fmt,
  cmd,
  type GridColumn,
  type GridSort,
  type TerminalUsage,
} from "@cmd/widget-api";
import { useEffect, useState } from "react";

type Scope = "workspace" | "all";
type Use = { cpu: number; memory: number };

/** Samples kept for the sparklines: about two minutes. */
export const HISTORY = 60;
/** A terminal this busy is worth a second look: its light is on. */
export const HOT_CPU = 80;

/** A CPU share as it reads: one decimal below 10. */
export const pct = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
const folder = (cwd: string) => cwd.replace(/\/+$/, "").split("/").pop() || cwd;

/** A terminal as the table shows it. */
export interface Row extends Use {
  id: string;
  name: string;
  icon: string;
  /** Its largest processes, by name. */
  top: string[];
  processes: number;
  /** Where it runs (its folder), shown with every workspace's. */
  where: string;
  /** Its window, where a click goes. */
  windowId: string | null;
}

const VALUE: Record<string, (r: Row) => number | string> = { name: (r) => r.name.toLowerCase(), top: (r) => r.top.join(", "), where: (r) => r.where, cpu: (r) => r.cpu, memory: (r) => r.memory };

/** Rows in the sort's order; busiest first without one (CPU, then memory). */
export function sorted(rows: Row[], sort: GridSort | null): Row[] {
  const by = sort && VALUE[sort.key];
  return [...rows].sort((a, b) => {
    if (!by) return b.cpu - a.cpu || b.memory - a.memory;
    const x = by(a), y = by(b);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return sort!.desc ? -c : c;
  });
}

export default function TerminalUsage() {
  const [scope, setScope] = useStoredState<Scope>("scope", "workspace");
  const [sort, setSort] = useStoredState<{ key: string; desc: boolean } | null>("sort", null);
  const query = scope === "all" ? { scope } : {};
  const terminals = useTerminals(query);
  const usage = useTerminalUsage(query);
  const workspace = useWorkspace();
  const [history, setHistory] = useState<Use[]>([]);

  const named = new Map(terminals.map((t) => [t.id, t]));
  const rows: Row[] = usage.map((u: TerminalUsage) => {
    const t = named.get(u.id);
    return { id: u.id, name: t?.title || t?.command || "Terminal", icon: t?.agentId ? "sparkles" : "terminal", cpu: u.cpu, memory: u.memory, top: u.top.slice(0, 3).map((p) => p.name), processes: u.processes, where: u.workspaceId === workspace?.id && workspace?.name ? workspace.name : t ? folder(t.cwd) : "", windowId: t?.windowId ?? null };
  });
  const total = rows.reduce<Use>((s, r) => ({ cpu: s.cpu + r.cpu, memory: s.memory + r.memory }), { cpu: 0, memory: 0 });
  const processes = rows.reduce((n, r) => n + r.processes, 0);

  // One entry per sample (the newest `at`): the totals over time, for the sparklines. A new scope starts over.
  const sampled = usage.reduce((m, u) => Math.max(m, u.at), 0);
  useEffect(() => setHistory([]), [scope]);
  useEffect(() => {
    if (sampled) setHistory((h) => [...h, total].slice(-HISTORY));
  }, [sampled, scope]);

  const all = scope === "all";
  const state = terminals.length === 0 && rows.length === 0
    ? { icon: "gauge.with.dots.needle.33percent", title: "Nothing running", text: all ? "Open a terminal and what runs in it shows up here." : "Open a terminal in this workspace and what runs in it shows up here." }
    : rows.length === 0
      ? { kind: "loading" as const, title: "Measuring…" }
      : null;

  const columns: GridColumn[] = [
    { key: "mark", label: "", icon: true },
    { key: "name", label: "Terminal", grow: true },
    ...(all ? [{ key: "where", label: "Workspace", hide: "narrow" as const, dim: true }] : []),
    { key: "top", label: "Busiest", hide: "regular", dim: true },
    { key: "cpu", label: "CPU", align: "end" },
    { key: "memory", label: "Memory", align: "end" },
  ];
  const shown = sorted(rows, sort);

  return (
    <Window
      status={rows.length ? `${pct(total.cpu)} · ${fmt.bytes(total.memory)}` : null}
      menu={[
        { label: "This Workspace", checked: !all, run: () => setScope("workspace") },
        { label: "All Workspaces", checked: all, run: () => setScope("all") },
      ]}
    >
      <View inset state={state}>
        <Panes>
          <Pane wide>
            <Tiles min={120} gap={4}>
              <Stack gap={1}>
                <Stat label="CPU" value={pct(total.cpu).slice(0, -1)} unit="%" />
                {history.length > 1 && <Sparkline values={history.map((u) => u.cpu)} color="current" />}
              </Stack>
              <Stack gap={1}>
                <Stat label="Memory" value={fmt.bytes(total.memory)} />
                {history.length > 1 && <Sparkline values={history.map((u) => u.memory)} color="neutral" />}
              </Stack>
            </Tiles>
          </Pane>
          <Pane wide title="Terminals" aside={rows.length}>
            <DataGrid
              columns={columns}
              rows={shown.map((r) => ({
                key: r.id,
                cells: [r.icon, r.name, ...(all ? [r.where] : []), r.top.join(", "), pct(r.cpu), fmt.bytes(r.memory)],
                ...(r.cpu >= HOT_CPU ? { light: "working" as const } : {}),
                tip: [r.name, r.top.join(", "), r.processes > 1 ? `${r.processes} processes` : null, all ? r.where : null].filter(Boolean).join("\n"),
              }))}
              sort={sort}
              onSort={setSort}
              onRowClick={(id) => void cmd.windows.select(shown.find((r) => r.id === id)?.windowId ?? id).catch(() => {})}
            />
          </Pane>
        </Panes>
        {rows.length > 0 && <StatusLine>{`${rows.length} ${rows.length === 1 ? "terminal" : "terminals"} · ${processes} ${processes === 1 ? "process" : "processes"}`}</StatusLine>}
      </View>
    </Window>
  );
}
