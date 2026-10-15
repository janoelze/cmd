// Terminal Usage, a built-in widget package (docs/57; the native Resources widget's job): what
// each terminal of this workspace (or every workspace, from the title menu) uses now, CPU and
// memory of its whole process tree, busiest first, with the last two minutes of the totals as
// sparklines inside their tiles and the totals in the title bar; then cmd itself, the app and the
// background process that keeps terminals running. All live from cmd's samples: the terminals'
// (useTerminalUsage, API 1.2) and cmd's own (useAppUsage, 1.3). A terminal with an agent says the
// agent's name, as the sidebar does; another workspace's says that workspace's name
// (useWorkspaces, 1.3). A click on a row goes to its terminal; a header sorts.

import {
  Window,
  View,
  Tiles,
  Stat,
  Sparkline,
  Panes,
  Pane,
  Text,
  DataGrid,
  StatusLine,
  useTerminals,
  useTerminalUsage,
  useAgents,
  useWorkspaces,
  useAppUsage,
  useStoredState,
  cmd,
  type GridColumn,
  type GridSort,
} from "@cmd/widget-api";
import { useEffect, useState } from "react";

type Scope = "workspace" | "all";
type Use = { cpu: number; memory: number };

/** Samples kept for the sparklines: about two minutes. */
export const HISTORY = 60;
/** A terminal this busy is worth a second look: its light is on. */
export const HOT_CPU = 80;

/** A CPU share as it reads: one decimal below 10. */
export const share = (n: number) => (n < 10 ? n.toFixed(1) : String(Math.round(n)));
export const pct = (n: number) => `${share(n)}%`;
/** Memory as the Resources widget and Task Manager write it: whole MB, GB with a decimal below 10. */
export function mem(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`;
}

/** Titles a terminal gets from its shell or agent, which say nothing of what runs in it (the sidebar's list). */
const GENERIC = new Set(["claude code", "claude", "codex", "gemini", "opencode", "amp", "zsh", "bash", "fish", "sh", "pwsh"]);

/** A terminal as the table shows it. */
export interface Row extends Use {
  id: string;
  name: string;
  icon: string;
  /** Its largest processes, by name. */
  top: string[];
  processes: number;
  /** Its workspace's name, shown with every workspace's terminals. */
  workspace: string | null;
  /** Its window, where a click goes. */
  windowId: string | null;
}

const VALUE: Record<string, (r: Row) => number | string> = { name: (r) => r.name.toLowerCase(), top: (r) => r.top.join(", "), cpu: (r) => r.cpu, memory: (r) => r.memory };

/** Rows in the sort's order; busiest first without one (CPU, then memory), as the native table always is. */
export function sorted(rows: Row[], sort: GridSort | null): Row[] {
  const by = sort && VALUE[sort.key];
  return [...rows].sort((a, b) => {
    if (!by) return b.cpu - a.cpu || b.memory - a.memory;
    const x = by(a), y = by(b);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return sort!.desc ? -c : c;
  });
}

const values = (u: Use) => [pct(u.cpu), mem(u.memory)];
const columns = (first: string, extra: GridColumn[] = []): GridColumn[] => [{ key: "mark", label: "", icon: true }, { key: "name", label: first, grow: true }, ...extra, { key: "cpu", label: "CPU", align: "end" }, { key: "memory", label: "Memory", align: "end" }];

export default function TerminalUsage() {
  const [scope, setScope] = useStoredState<Scope>("scope", "workspace");
  const [sort, setSort] = useStoredState<{ key: string; desc: boolean } | null>("sort", null);
  const all = scope === "all";
  const query = all ? { scope } : {};
  const terminals = useTerminals(query);
  const usage = useTerminalUsage(query);
  const agents = new Map(useAgents(query).map((a) => [a.id, a]));
  const names = new Map(useWorkspaces().map((w) => [w.id, w.name]));
  const own = useAppUsage();
  const [history, setHistory] = useState<Use[]>([]);

  const byId = new Map(terminals.map((t) => [t.id, t]));
  const rows: Row[] = usage.map((u) => {
    const t = byId.get(u.id);
    // An agent's terminal goes by the agent's name and its kind's icon, as in the sidebar; a shell by its title, or by its largest process when the title says nothing.
    const agent = t?.agentId ? agents.get(t.agentId) : undefined;
    const title = t?.title.trim() ?? "";
    const name = agent?.name || (GENERIC.has(title.toLowerCase()) ? u.top[0]?.name : null) || title || "Terminal";
    return { id: u.id, name, icon: agent?.icon ?? "terminal", cpu: u.cpu, memory: u.memory, top: u.top.slice(0, 3).map((p) => p.name), processes: u.processes, workspace: all ? (names.get(u.workspaceId) ?? null) : null, windowId: t?.windowId ?? null };
  });
  const total = rows.reduce<Use>((s, r) => ({ cpu: s.cpu + r.cpu, memory: s.memory + r.memory }), { cpu: 0, memory: 0 });
  const processes = rows.reduce((n, r) => n + r.processes, 0);

  // One entry per sample (the newest `at`): the totals over time, for the sparklines. A new scope starts over.
  const sampled = usage.reduce((m, u) => Math.max(m, u.at), own?.at ?? 0);
  useEffect(() => setHistory([]), [scope]);
  useEffect(() => {
    if (sampled) setHistory((h) => [...h, total].slice(-HISTORY));
  }, [sampled, scope]);

  const app = own?.app && own.background ? own : null;
  const state = !own && rows.length === 0
    ? { kind: "loading" as const }
    : rows.length === 0 && !app
      ? { icon: "gauge.with.dots.needle.33percent", title: "Nothing running", text: all ? "Open a terminal and what runs in it shows up here." : "Open a terminal in this workspace and what runs in it shows up here." }
      : null;
  const shown = sorted(rows, sort);

  return (
    <Window
      status={rows.length ? `${pct(total.cpu)} · ${mem(total.memory)}` : null}
      menu={[
        { label: "This Workspace", checked: !all, run: () => setScope("workspace") },
        { label: "All Workspaces", checked: all, run: () => setScope("all") },
      ]}
    >
      <View inset state={state}>
        <Panes>
          <Pane wide>
            <Tiles min={120} gap={4}>
              <Stat label="CPU" value={share(total.cpu)} unit="%">
                <Sparkline values={history.map((u) => u.cpu)} series={0} />
              </Stat>
              <Stat label="Memory" value={mem(total.memory)}>
                <Sparkline values={history.map((u) => u.memory)} series={1} />
              </Stat>
            </Tiles>
          </Pane>
          {rows.length > 0 ? (
            <Pane wide title="Terminals" aside={rows.length}>
              <DataGrid
                columns={columns("Terminal", [{ key: "top", label: "Busiest", hide: "regular", dim: true }])}
                rows={shown.map((r) => ({
                  key: r.id,
                  cells: [r.icon, r.workspace ? `${r.name} · ${r.workspace}` : r.name, r.top.join(", "), ...values(r)],
                  ...(r.cpu >= HOT_CPU ? { light: "working" as const } : {}),
                  tip: [r.name, r.top.join(", "), r.processes > 1 ? `${r.processes} processes` : null, r.workspace].filter(Boolean).join("\n"),
                }))}
                sort={sort}
                onSort={setSort}
                onRowClick={(id) => void cmd.windows.select(shown.find((r) => r.id === id)?.windowId ?? id).catch(() => {})}
              />
            </Pane>
          ) : (
            <Pane wide title="Terminals">
              {/* A terminal cmd hasn't sampled yet is measured in a moment. */}
              <Text tone="dim">{terminals.length ? "Measuring…" : all ? "No terminals are running." : "No terminals are running in this workspace."}</Text>
            </Pane>
          )}
          {app && (
            <Pane wide title="cmd">
              <DataGrid
                columns={columns("Part")}
                rows={[
                  { key: "app", cells: ["macwindow", "App", ...values(app.app!)] },
                  { key: "background", cells: ["gearshape.2", "Background", ...values(app.background!)], tip: "Keeps your terminals and agents running while the app is closed" },
                ]}
              />
            </Pane>
          )}
        </Panes>
        {own && <StatusLine>{`${rows.length} ${rows.length === 1 ? "terminal" : "terminals"} · ${processes} ${processes === 1 ? "process" : "processes"}`}</StatusLine>}
      </View>
    </Window>
  );
}
