// Prototype: Live Diff across worktrees. What several agents, each in a worktree
// of one project, are changing on disk, as an overview: one row per agent (what
// it touches now, how much, on which branch), its files newest first under it,
// and the files more than one of them changed, first, because those are the
// ones that will conflict. A second lens groups the same files by area.

import { Callout, DataGrid, Diff, Inline, Split, Stack, StatusDot, StatusLine, Text, ToolbarButton, ToolbarSegmented, ToolbarSpacer, View, WindowToolbar } from "@cmd/ui";
import type { GridCell, GridRowInfo } from "@cmd/ui";
import type { DotState } from "@cmd/ui";
import { useState, type ReactNode } from "react";
import type { GitFile } from "@cmd/protocol";

/** A file a lane changed: since its branch left the main branch, committed or not. */
export interface LaneFile {
  rel: string;
  state: GitFile["state"];
  added: number;
  removed: number;
  /** Last written, ms before now. */
  ago: number;
  /** Only in commits (nothing uncommitted left in it). */
  committed?: boolean;
  /** Its diff's lines (against the merge base), from the first hunk header. */
  lines?: readonly string[];
}

/** A checkout and who works in it: the workspace's own, or a linked worktree. */
export interface Lane {
  id: string;
  /** The agent working there, else the folder's name. */
  name: string;
  branch: string;
  main?: boolean;
  light: DotState;
  /** Commits ahead of the main branch. */
  ahead: number;
  files: LaneFile[];
}

const LETTER: Record<GitFile["state"], { letter: string; tone: "success" | "warning" | "danger" | "accent" | "neutral" }> = {
  modified: { letter: "M", tone: "warning" },
  added: { letter: "A", tone: "success" },
  untracked: { letter: "U", tone: "success" },
  deleted: { letter: "D", tone: "danger" },
  renamed: { letter: "R", tone: "accent" },
  conflict: { letter: "!", tone: "danger" },
  ignored: { letter: "I", tone: "neutral" },
};

/** Files a lane shows before "N more". */
const FIRST = 4;

const age = (ms: number) => (ms < 10_000 ? "now" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);
const base = (rel: string) => rel.split("/").pop()!;
const dir = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : undefined);
/** A file's area: its first two folders (packages/core, apps/desktop, docs). */
const area = (rel: string) => rel.split("/").slice(0, -1).slice(0, rel.startsWith("apps/") || rel.startsWith("packages/") ? 2 : 1).join("/") || "(top level)";
const sum = (fs: LaneFile[]) => fs.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 });

/** One lane's change to a file. */
interface Change {
  lane: Lane;
  f: LaneFile;
}

/** The old file's lines each hunk covers ("@@ -a,b"). */
const ranges = (lines: readonly string[] = []) =>
  lines.flatMap((l) => {
    const m = /^@@ -(\d+)(?:,(\d+))?/.exec(l);
    return m ? [[+m[1]!, +m[1]! + Math.max(1, +(m[2] ?? 1)) - 1] as const] : [];
  });

/** Lines of the base two or more changes both touch, as "386–391", or null: same file, different places. */
function clash(changes: Change[]): string | null {
  const rs = changes.map((c) => ranges(c.f.lines));
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++)
      for (const [a1, a2] of rs[i]!)
        for (const [b1, b2] of rs[j]!)
          if (a1 <= b2 && b1 <= a2) (lo = Math.min(lo, Math.max(a1, b1))), (hi = Math.max(hi, Math.min(a2, b2)));
  return lo === Infinity ? null : lo === hi ? `line ${lo}` : `lines ${lo}–${hi}`;
}

/** A file and every lane that changed it, newest first. */
interface Entry {
  rel: string;
  changes: Change[];
}

/** The selected file's lines, one lane's change at a time (the toolbar picks whose). */
function FileDiff({ e, change }: { e: Entry; change: Change }) {
  const { lane, f } = change;
  const same = e.changes.length > 1 ? clash(e.changes) : null;
  const hunks = ranges(f.lines).length;
  return (
    <View scroll={false}>
      <Stack pad="inset" gap={2}>
        <Stack gap={0.5}>
          <Inline gap={2}>
            <Text strong>{base(e.rel)}</Text>
            <Text tone="dim">{dir(e.rel)}</Text>
          </Inline>
          <Text size="sm" tone="dim">
            {lane.name} · {lane.main ? "main checkout" : lane.branch} · {f.committed ? "committed" : "uncommitted"} · {hunks} {hunks === 1 ? "change" : "changes"} · +{f.added} −{f.removed} · {age(f.ago)}
          </Text>
        </Stack>
        {same && (
          <Callout tone="warning" compact>
            {e.changes.map((c) => c.lane.name).join(" and ")} both change {same}.
          </Callout>
        )}
      </Stack>
      {f.lines?.length ? <Diff fill lines={f.lines} /> : <Diff fill note={f.state === "deleted" ? "Deleted" : "No line changes"} />}
    </View>
  );
}

/** Every changed file with who changed it, newest change first. */
function entries(lanes: Lane[]): Entry[] {
  const by = new Map<string, Entry>();
  for (const lane of lanes)
    for (const f of lane.files) {
      const e = by.get(f.rel) ?? by.set(f.rel, { rel: f.rel, changes: [] }).get(f.rel)!;
      e.changes.push({ lane, f });
    }
  for (const e of by.values()) e.changes.sort((a, b) => a.f.ago - b.f.ago);
  return [...by.values()].sort((a, b) => a.changes[0]!.f.ago - b.changes[0]!.f.ago);
}

/** A grid row: its cells, how it sits, and what a click does. */
interface Row {
  key: string;
  cells: GridCell[];
  info?: GridRowInfo;
  /** A file's row: selecting it shows its diff. */
  file?: boolean;
  onClick?: () => void;
}

const lines = (t: { added: number; removed: number }) => ({ node: [t.added && `+${t.added}`, t.removed && `−${t.removed}`].filter(Boolean).join(" "), kind: "number" as const });
const when = (ms: number) => ({ node: age(ms), kind: "number" as const });
const dim = (on: boolean | undefined, node: ReactNode) => (on ? <Text tone="dim">{node}</Text> : node);
/** A file's name, its folder after it, dim. */
const fileName = (rel: string, faded?: boolean) => (
  <Inline gap={1.5}>
    {dim(faded, base(rel))}
    {dir(rel) && <Text tone="dim">{dir(rel)}</Text>}
  </Inline>
);

/** Live Diff over every checkout of a project with work in it (a prototype: data in, nothing fetched). */
export function ActivityView({ lanes, initialLens = "agents", initialSelected = null }: { lanes: Lane[]; initialLens?: "agents" | "files"; /** The file shown at first, as "<section>:<path>" (shared:, area:, or a lane's id). */ initialSelected?: string | null }) {
  const [lens, setLens] = useState(initialLens);
  const [open, setOpen] = useState<Map<string, boolean>>(new Map());
  const [all, setAll] = useState<Set<string>>(new Set());
  /** The file shown, by where its row is: "<section>:<path>"; and whose change of it. */
  const [sel, setSel] = useState<string | null>(initialSelected);
  const [whose, setWhose] = useState<string | null>(null);
  const every = entries(lanes);
  const shared = every.filter((e) => e.changes.length > 1);
  const sorted = [...lanes].sort((a, b) => Math.min(...a.files.map((f) => f.ago), Infinity) - Math.min(...b.files.map((f) => f.ago), Infinity));
  const total = sum(lanes.flatMap((l) => l.files));
  const files = new Set(lanes.flatMap((l) => l.files.map((f) => f.rel))).size;
  const picked = sel ? entryOf(sel, lanes, every) : null;
  const change = picked && (picked.changes.find((c) => c.lane.id === whose) ?? picked.changes[0]!);
  const toggle = (key: string, def: boolean) => setOpen((m) => new Map(m).set(key, !(m.get(key) ?? def)));

  const rows: Row[] = [];
  const heading = (key: string, name: ReactNode, t?: { added: number; removed: number }) => rows.push({ key, cells: ["", name, "", t ? lines(t) : "", ""], info: { heading: true } });
  /** A file's row; `who` lists the lanes that changed it, and says when they touch the same lines. */
  const fileRow = (key: string, e: Entry, depth: number, who: boolean) => {
    const committed = e.changes.every((c) => c.f.committed);
    const same = e.changes.length > 1 ? clash(e.changes) : null;
    const names = e.changes.map((c) => c.lane.name).join(", ");
    rows.push({
      key,
      file: true,
      info: { depth },
      cells: [
        same ? (
          <span key="s" data-tip={`Both change ${same}`}>
            <Text size="xs" mono strong tone="warning">
              !
            </Text>
          </span>
        ) : (
          <Text key="s" size="xs" mono tone="dim">
            {LETTER[e.changes[0]!.f.state].letter}
          </Text>
        ),
        fileName(e.rel, committed),
        who ? (same ? <Text tone="warning">{`${names} · same lines`}</Text> : <Text tone="dim">{names}</Text>) : <Text tone="dim">{committed ? "committed" : ""}</Text>,
        lines(sum(e.changes.map((c) => c.f))),
        when(e.changes[0]!.f.ago),
      ],
    });
  };
  const more = (key: string, n: number, depth: number) => rows.push({ key: `more:${key}`, info: { depth }, cells: ["", <Text key="m" tone="dim">{`${n} more files`}</Text>, "", "", ""], onClick: () => setAll((s) => new Set(s).add(key)) });

  if (shared.length) {
    heading("h:shared", `In more than one worktree`);
    for (const e of shared) fileRow(`shared:${e.rel}`, e, 0, true);
  }
  if (lens === "agents") {
    heading("h:agents", "Agents");
    for (const l of sorted) {
      const isOpen = open.get(l.id) ?? false;
      const newest = [...l.files].sort((a, b) => a.ago - b.ago);
      rows.push({
        key: `lane:${l.id}`,
        info: { expanded: newest.length ? isOpen : undefined, onToggle: () => toggle(l.id, false) },
        onClick: () => toggle(l.id, false),
        cells: [<StatusDot key="d" state={l.light} />, l.name, <Text key="b" tone="dim">{l.main ? "main checkout" : l.branch}</Text>, lines(sum(l.files)), newest[0] ? when(newest[0].ago) : ""],
      });
      if (!isOpen) continue;
      const shown = all.has(l.id) ? newest : newest.slice(0, FIRST);
      for (const f of shown) fileRow(`${l.id}:${f.rel}`, { rel: f.rel, changes: [{ lane: l, f }] }, 1, false);
      if (newest.length > shown.length) more(l.id, newest.length - shown.length, 1);
    }
  } else {
    const areas = new Map<string, Entry[]>();
    for (const e of every) areas.set(area(e.rel), [...(areas.get(area(e.rel)) ?? []), e]);
    for (const [name, es] of [...areas.entries()].sort((a, b) => b[1].length - a[1].length)) {
      heading(`h:${name}`, name, sum(es.flatMap((e) => e.changes.map((c) => c.f))));
      const key = `area:${name}`;
      for (const e of es.slice(0, all.has(key) ? undefined : FIRST)) fileRow(`area:${e.rel}`, e, 0, true);
      if (es.length > FIRST && !all.has(key)) more(key, es.length - FIRST, 0);
    }
  }
  const order = rows.filter((r) => r.file).map((r) => r.key);
  const at = rows.findIndex((r) => r.key === sel);

  const list = (
    <div
      style={{ display: "contents" }}
      onKeyDown={(ev) => {
        const i = sel ? order.indexOf(sel) : -1;
        const next = ev.key === "ArrowDown" ? order[i + 1] : ev.key === "ArrowUp" ? order[i - 1] : ev.key === "Escape" ? null : undefined;
        if (next === undefined) return;
        ev.preventDefault();
        setSel(next), setWhose(null);
      }}
    >
      <View focusable>
        <DataGrid
          columns={[
            { key: "mark", label: "", icon: true },
            { key: "name", label: "Name", grow: true },
            { key: "who", label: lens === "agents" ? "Branch" : "Agents", hide: "regular" },
            { key: "lines", label: "Lines", align: "end" },
            { key: "when", label: "Changed", align: "end", hide: "narrow" },
          ]}
          rows={rows.map((r) => r.cells)}
          rowKey={(_, i) => rows[i]!.key}
          rowInfo={(i) => rows[i]!.info}
          selected={at >= 0 ? at : null}
          onRowClick={(i) => {
            const r = rows[i]!;
            if (r.file) setSel(r.key), setWhose(null);
            else r.onClick?.();
          }}
        />
      </View>
    </div>
  );

  return (
    <View
      toolbar={
        <WindowToolbar label="Changes">
          <ToolbarSegmented label="Group" value={lens} options={[{ value: "agents", label: "Agents" }, { value: "files", label: "Areas" }]} onChange={setLens} />
          <ToolbarSpacer />
          {picked && picked.changes.length > 1 && (
            <ToolbarSegmented label="Whose change" value={change!.lane.id} options={picked.changes.map((c) => ({ value: c.lane.id, label: c.lane.name }))} onChange={setWhose} />
          )}
          {picked && <ToolbarButton icon="xmark" label="Close" shortcut="Esc" onClick={() => setSel(null)} />}
        </WindowToolbar>
      }
      footer={
        <StatusLine end={<span>{`+${total.added} −${total.removed}`}</span>}>
          {lanes.length} checkouts · {files} files
        </StatusLine>
      }
      state={!lanes.length ? { kind: "empty", icon: "checkmark.circle", title: "Nothing changed" } : null}
      scroll={false}
    >
      {picked && change ? (
        <Split side="start" pane={list} width={{ min: 280, ideal: 380, max: 560 }}>
          <FileDiff e={picked} change={change} />
        </Split>
      ) : (
        list
      )}
    </View>
  );
}

/** The entry a row's key names: a shared or area row's file (every lane's change), or one lane's file. */
function entryOf(key: string, lanes: Lane[], every: Entry[]): Entry | null {
  const at = key.indexOf(":");
  const where = key.slice(0, at), rel = key.slice(at + 1);
  if (where === "shared" || where === "area") return every.find((e) => e.rel === rel) ?? null;
  const lane = lanes.find((l) => l.id === where);
  const f = lane?.files.find((x) => x.rel === rel);
  return lane && f ? { rel, changes: [{ lane, f }] } : null;
}
