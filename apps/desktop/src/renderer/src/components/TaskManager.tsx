// The Task Manager sheet (Window → Task Manager): what cmd's processes use,
// polled every 2 s. The app's own Electron processes (main/metrics.ts), the
// core and PTY host (core.processes), and each terminal's whole process tree
// (Pane.usage, sampled by the core), which expands to its largest processes.
// A terminal can be shown in its workspace's window or ended. A sheet dressed
// as one of the app's windows, like Send Feedback and What's New.
//
// TaskManager polls and acts; TaskManagerView draws a snapshot, as the
// window-design skill's data window (a toolbar, one table in sections, a quiet
// footer), so TaskManager.story.tsx can show every state.

import { useEffect, useMemo, useState } from "react";
import type { Pane, ProcessStat, Workspace } from "@cmd/protocol";
import type { AppProcess } from "../../../main/metrics.ts";
import { DataGrid, Dialog, StatusLine, Text, ToolbarButton, ToolbarSpacer, View, WindowToolbar, type GridCell, type GridRowInfo, type GridSort } from "@cmd/ui";
import { cmd } from "../bridge.ts";
import { formatBytes } from "../model.ts";

const POLL_MS = 2000;
export const ICON = "gauge.with.dots.needle.33percent";

export interface Snapshot {
  app: AppProcess[];
  core: { core: ProcessStat | null; ptyHost: ProcessStat | null } | null;
  panes: Pane[];
  workspaces: Workspace[];
}

interface Row {
  key: string;
  name: string;
  detail?: string;
  pid: number | null;
  memory: number | null;
  cpu: number | null;
  processes?: number;
  pane?: Pane;
  children?: Row[];
}

type SortKey = "name" | "memory" | "cpu" | "pid";
type Sort = { key: SortKey; desc: boolean };

const COLUMNS = [
  { key: "name", label: "Name", grow: true },
  { key: "memory", label: "Memory", align: "end" },
  { key: "cpu", label: "CPU", align: "end" },
  { key: "pid", label: "PID", align: "end", hide: "narrow" },
] as const;

async function poll(): Promise<Snapshot> {
  const [app, core, panes, workspaces] = await Promise.all([
    cmd.appMetrics(),
    cmd.call("core.processes", {}).catch(() => null),
    cmd.call("pane.list", {}),
    cmd.call("workspace.list", {}),
  ]);
  return { app, core, panes, workspaces };
}

function sortRows(rows: Row[], s: Sort): Row[] {
  const val = (r: Row) => (s.key === "name" ? r.name.toLowerCase() : (r[s.key] ?? -1));
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    const c = x < y ? -1 : x > y ? 1 : 0;
    return s.desc ? -c : c;
  });
}

const sum = (rows: Row[], k: "memory" | "cpu") => rows.reduce((n, r) => n + (r[k] ?? 0), 0);

export function TaskManager({ open = true, onClose }: { open?: boolean; onClose: () => void }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Polls while open; it stops as the sheet starts to fade out.
  useEffect(() => {
    if (!open) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await poll();
        if (!live) return;
        setSnap(s);
        setError(null);
      } catch (err) {
        if (live) setError((err as Error).message);
      }
      if (live) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} window={{ icon: ICON, name: "Task Manager" }} width={720} height={520} position="center" padded={false}>
      <TaskManagerView
        snap={snap}
        error={error}
        onShow={(p) => (onClose(), cmd.showPane(p.workspaceId, p.id))}
        onEnd={async (name, p) => {
          if (!(await cmd.confirm({ message: `End “${name}”?`, detail: "Its terminal and every process in it are stopped.", confirm: "End Terminal" }))) return false;
          void cmd.call("pane.kill", { paneId: p.id });
          return true;
        }}
      />
    </Dialog>
  );
}

function sectionsOf(snap: Snapshot, sort: Sort) {
  const app: Row[] = snap.app.map((p) => ({ key: `app:${p.pid}`, name: p.name, detail: ["Browser", "Tab", "GPU"].includes(p.type) || p.name === p.type ? undefined : p.type, pid: p.pid, memory: p.memory, cpu: p.cpu }));
  const core: Row[] = [];
  const c = snap.core?.core;
  const h = snap.core?.ptyHost;
  core.push({ key: "core", name: "Core", pid: c?.pid ?? null, memory: c?.memory ?? null, cpu: c?.cpu ?? null });
  if (h) core.push({ key: "pty-host", name: "PTY host", detail: "terminals", pid: h.pid, memory: h.memory, cpu: h.cpu });
  const workspaceName = new Map(snap.workspaces.map((s) => [s.id, s.name]));
  const terminals: Row[] = snap.panes
    .filter((p) => p.exitCode === null && p.pid > 0)
    .map((p) => {
      const name = p.title || p.foreground || p.shell;
      return {
        key: `pane:${p.id}`,
        name,
        detail: [p.foreground !== name && p.foreground, workspaceName.get(p.workspaceId)].filter(Boolean).join(" · "),
        pid: p.pid,
        memory: p.usage?.memory ?? null,
        cpu: p.usage?.cpu ?? null,
        processes: p.usage?.processes,
        pane: p,
        children: p.usage?.top.map((t) => ({ key: `pane:${p.id}:${t.pid}`, name: t.name, pid: t.pid, memory: t.memory, cpu: null })),
      };
    });
  return [
    { title: "App", rows: sortRows(app, sort) },
    { title: "Core", rows: sortRows(core, sort) },
    { title: "Terminals", rows: sortRows(terminals, sort) },
  ];
}

/** A table line: a section's heading, a process, one of a terminal's processes, or a section's "None". */
type Line = { key: string; cells: GridCell[]; info: GridRowInfo; row?: Row; parent?: Row };

const num = (v: number | null, f: (n: number) => string): GridCell => (v === null ? { node: "–", kind: "null" as const } : { node: f(v), kind: "number" as const });
const named = (r: Row): GridCell => ({
  node: r.detail ? (
    <>
      {r.name} <Text tone="dim">{r.detail}</Text>
    </>
  ) : (
    r.name
  ),
  tip: r.processes !== undefined ? `${r.processes} process${r.processes === 1 ? "" : "es"} in this terminal` : undefined,
});

export interface TaskManagerViewProps {
  /** Null until the first poll answers. */
  snap: Snapshot | null;
  /** The last poll failed (the core isn't answering). */
  error: string | null;
  onShow: (pane: Pane) => void;
  /** Ends a terminal; false when the person changed their mind. */
  onEnd: (name: string, pane: Pane) => Promise<boolean>;
}

export function TaskManagerView({ snap, error, onShow, onEnd }: TaskManagerViewProps) {
  const [sort, setSort] = useState<Sort>({ key: "memory", desc: true });
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const sections = useMemo(() => (snap ? sectionsOf(snap, sort) : []), [snap, sort]);
  const lines = useMemo(() => {
    const out: Line[] = [];
    for (const s of sections) {
      out.push({ key: `section:${s.title}`, cells: [s.title, num(sum(s.rows, "memory"), formatBytes), num(sum(s.rows, "cpu"), (n) => n.toFixed(1)), ""], info: { heading: true } });
      if (s.rows.length === 0) out.push({ key: `none:${s.title}`, cells: [<Text tone="dim">None</Text>, "", "", ""], info: {} });
      for (const r of s.rows) {
        const open = expanded.has(r.key);
        out.push({
          key: r.key,
          row: r,
          cells: [named(r), num(r.memory, formatBytes), num(r.cpu, (n) => n.toFixed(1)), num(r.pid, String)],
          info: { expanded: r.children?.length ? open : undefined, onToggle: () => toggle(r.key) },
        });
        if (open) for (const c of r.children ?? []) out.push({ key: c.key, parent: r, cells: [<Text tone="dim">{c.name}</Text>, num(c.memory, formatBytes), num(c.cpu, (n) => n.toFixed(1)), num(c.pid, String)], info: { depth: 1 } });
      }
    }
    return out;
  }, [sections, expanded]);

  const all = sections.flatMap((s) => s.rows);
  const sel = all.find((r) => r.key === selected) ?? null;
  const toggle = (key: string) =>
    setExpanded((e) => {
      const n = new Set(e);
      if (!n.delete(key)) n.add(key);
      return n;
    });
  /** The process a line stands for: one of a terminal's processes selects its terminal. */
  const rowAt = (i: number) => lines[i]?.row ?? lines[i]?.parent ?? null;
  const show = (r: Row | null) => r?.pane && onShow(r.pane);
  const end = (r: Row | null) => r?.pane && void onEnd(r.name, r.pane).then((ended) => ended && setSelected(null));
  // Numbers sort biggest first, names A to Z; a second click turns it round.
  const onSort = (s: GridSort | null) => {
    const key = (s?.key ?? sort.key) as SortKey;
    setSort(key === sort.key ? { key, desc: !sort.desc } : { key, desc: key !== "name" });
  };

  return (
    <View
      toolbar={
        <WindowToolbar label="Task Manager">
          <ToolbarSpacer />
          <ToolbarButton icon="macwindow" label="Show" showLabel disabled={!sel?.pane} onClick={() => show(sel)} />
          <ToolbarButton icon="xmark.circle" label="End Terminal" showLabel tone="danger" disabled={!sel?.pane} onClick={() => end(sel)} />
        </WindowToolbar>
      }
      footer={
        snap && (
          <StatusLine end={error ? "Core not responding" : undefined}>
            {formatBytes(sum(all, "memory"))} · {sum(all, "cpu").toFixed(1)}% CPU
          </StatusLine>
        )
      }
      state={snap ? null : error ? { kind: "error", title: "Couldn’t reach the core", text: error } : { kind: "loading" }}
      scroll={false}
    >
      <DataGrid
        columns={COLUMNS}
        rows={lines.map((l) => l.cells)}
        rowKey={(_, i) => lines[i]!.key}
        rowInfo={(i) => lines[i]?.info}
        sort={sort}
        onSort={onSort}
        selected={sel ? lines.findIndex((l) => l.row === sel) : null}
        onRowClick={(i) => setSelected(rowAt(i)?.key ?? null)}
        onRowDoubleClick={(i) => show(rowAt(i))}
      />
    </View>
  );
}
