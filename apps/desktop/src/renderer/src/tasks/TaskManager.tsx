// The Task Manager window (Window → Task Manager): what cmd's processes use,
// polled every 2 s. The app's own Electron processes (main/metrics.ts), the
// core and PTY host (core.processes), and each terminal's whole process tree
// (Pane.usage, sampled by the core), which expands to its largest processes.
// A terminal can be shown in its Space's window or ended.

import { Fragment, useEffect, useMemo, useState } from "react";
import type { Pane, ProcessStat, Space } from "@cmd/protocol";
import type { AppProcess } from "../../../main/metrics.ts";
import { cmd } from "../bridge.ts";
import { formatBytes } from "../model.ts";

const POLL_MS = 2000;

interface Snapshot {
  app: AppProcess[];
  core: { core: ProcessStat | null; ptyHost: ProcessStat | null } | null;
  panes: Pane[];
  spaces: Space[];
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

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "name", label: "Name", numeric: false },
  { key: "memory", label: "Memory", numeric: true },
  { key: "cpu", label: "CPU", numeric: true },
  { key: "pid", label: "PID", numeric: true },
];

async function poll(): Promise<Snapshot> {
  const [app, core, panes, spaces] = await Promise.all([
    cmd.appMetrics(),
    cmd.call("core.processes", {}).catch(() => null),
    cmd.call("pane.list", {}),
    cmd.call("space.list", {}),
  ]);
  return { app, core, panes, spaces };
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

export function TaskManager() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>({ key: "memory", desc: true });
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
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
  }, []);

  const sections = useMemo(() => {
    if (!snap) return [];
    const app: Row[] = snap.app.map((p) => ({ key: `app:${p.pid}`, name: p.name, detail: ["Browser", "Tab", "GPU"].includes(p.type) || p.name === p.type ? undefined : p.type, pid: p.pid, memory: p.memory, cpu: p.cpu }));
    const core: Row[] = [];
    const c = snap.core?.core;
    const h = snap.core?.ptyHost;
    core.push({ key: "core", name: "Core", pid: c?.pid ?? null, memory: c?.memory ?? null, cpu: c?.cpu ?? null });
    if (h) core.push({ key: "pty-host", name: "PTY host", detail: "terminals", pid: h.pid, memory: h.memory, cpu: h.cpu });
    const spaceName = new Map(snap.spaces.map((s) => [s.id, s.name]));
    const terminals: Row[] = snap.panes
      .filter((p) => p.exitCode === null && p.pid > 0)
      .map((p) => {
        const name = p.title || p.foreground || p.shell;
        return {
        key: `pane:${p.id}`,
        name,
        detail: [p.foreground !== name && p.foreground, spaceName.get(p.spaceId)].filter(Boolean).join(" · "),
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
  }, [snap, sort]);

  const all = sections.flatMap((s) => s.rows);
  const sel = all.find((r) => r.key === selected) ?? null;
  const toggle = (key: string) =>
    setExpanded((e) => {
      const n = new Set(e);
      if (!n.delete(key)) n.add(key);
      return n;
    });
  const show = (r: Row | null) => r?.pane && cmd.showPane(r.pane.spaceId, r.pane.id);
  const end = (r: Row | null) => {
    if (!r?.pane) return;
    if (!confirm(`End “${r.name}”?\n\nIts terminal and every process in it are stopped.`)) return;
    void cmd.call("pane.kill", { paneId: r.pane.id });
    setSelected(null);
  };
  const header = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, desc: !s.desc } : { key: k, desc: k !== "name" }));

  return (
    <div className="tm">
      <div className="tm-bar">
        <h1>Task Manager</h1>
      </div>
      <div className="tm-table" role="grid">
        <div className="tm-head" role="row">
          {COLUMNS.map((c) => (
            <button key={c.key} className={`tm-col tm-${c.key}${sort.key === c.key ? " sorted" : ""}`} onClick={() => header(c.key)}>
              {c.label}
              {sort.key === c.key && <span className="tm-arrow">{sort.desc ? "▾" : "▴"}</span>}
            </button>
          ))}
        </div>
        <div className="tm-body">
          {!snap && <div className="tm-empty">{error ?? "Loading…"}</div>}
          {sections.map((s) => (
            <Fragment key={s.title}>
              <div className="tm-section" role="row">
                <span className="tm-name">{s.title}</span>
                <span className="tm-memory">{formatBytes(sum(s.rows, "memory"))}</span>
                <span className="tm-cpu">{sum(s.rows, "cpu").toFixed(1)}</span>
                <span className="tm-pid" />
              </div>
              {s.rows.length === 0 && <div className="tm-empty">None</div>}
              {s.rows.map((r) => {
                const open = expanded.has(r.key);
                return (
                  <Fragment key={r.key}>
                    <ProcessRow
                      row={r}
                      selected={selected === r.key}
                      expanded={r.children?.length ? open : undefined}
                      onToggle={() => toggle(r.key)}
                      onSelect={() => setSelected(r.key)}
                      onOpen={() => show(r)}
                    />
                    {open && r.children?.map((c) => <ProcessRow key={c.key} row={c} child selected={false} onSelect={() => setSelected(r.key)} />)}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
      <div className="tm-foot">
        <span className="tm-total">
          {snap ? `${formatBytes(sum(all, "memory"))} · ${sum(all, "cpu").toFixed(1)}% CPU` : ""}
          {error && snap ? " · core not responding" : ""}
        </span>
        <button disabled={!sel?.pane} onClick={() => show(sel)}>
          Show
        </button>
        <button disabled={!sel?.pane} onClick={() => end(sel)}>
          End Terminal
        </button>
      </div>
    </div>
  );
}

function ProcessRow({
  row,
  child = false,
  selected,
  expanded,
  onToggle,
  onSelect,
  onOpen,
}: {
  row: Row;
  child?: boolean;
  selected: boolean;
  /** undefined: nothing to expand. */
  expanded?: boolean;
  onToggle?: () => void;
  onSelect: () => void;
  onOpen?: () => void;
}) {
  const tip = row.processes !== undefined ? `${row.processes} process${row.processes === 1 ? "" : "es"} in this terminal` : undefined;
  return (
    <div className={`tm-row${child ? " child" : ""}${selected ? " sel" : ""}`} role="row" onMouseDown={onSelect} onDoubleClick={onOpen} data-tip={tip}>
      <span className="tm-name">
        {!child && (
          <span
            className={`tm-disclosure${expanded === undefined ? " none" : expanded ? " open" : ""}`}
            onMouseDown={(e) => (e.stopPropagation(), onSelect(), onToggle?.())}
          >
            ▸
          </span>
        )}
        <span className="tm-label">{row.name}</span>
        {row.detail && <span className="tm-detail">{row.detail}</span>}
      </span>
      <span className="tm-memory">{row.memory === null ? "–" : formatBytes(row.memory)}</span>
      <span className="tm-cpu">{row.cpu === null ? "–" : row.cpu.toFixed(1)}</span>
      <span className="tm-pid">{row.pid ?? "–"}</span>
    </div>
  );
}
