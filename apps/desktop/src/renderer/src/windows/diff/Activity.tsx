// Live Diff across worktrees (docs/53-livediff-worktrees.md): what several agents, each in a
// worktree of one project, are changing on disk, as an overview: the files more than one of
// them changed first (Clashes: the same lines are the ones that will conflict), then one row
// per agent (how much, on which branch, when), its files under it, the biggest changes first; or the same
// files by area. A file opens in a pane under the list, whole (FileDiff), one agent's change
// at a time; the footer says whose. Data in (lanes, worktrees.ts), texts loaded on open.

import { DataGrid, Separator, Diff, Inline, Split, Stack, StatusDot, StatusLine, Text, IconButton, Segmented, ToolbarSegmented, View, WindowToolbar } from "@cmd/ui";
import type { GridCell, GridRowInfo } from "@cmd/ui";
import type { DotState } from "@cmd/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { GitFile } from "@cmd/protocol";
import { changedBaseLines, FileDiff, type FileDiffHandle } from "./FileDiff.tsx";

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
  /** The whole file at the merge base and now: the diff pane draws them with FileDiff (else it loads them, else `lines`). */
  before?: string;
  after?: string;
  /** For a file another lane changed too: the base lines its changes cover (else they come from the texts or `lines`). */
  hunks?: [number, number][];
  /** Changes when the file does (its mtime): an open diff loads it again. */
  version?: number;
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
  /** Its checkout and what its files are compared with, for loading a file's texts. */
  top?: string;
  base?: string | null;
}

/** A file's texts as the core gives them (git.fileVersions). */
export interface FileVersions {
  before: string;
  after: string;
  binary: boolean;
  tooLarge: boolean;
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

const age = (ms: number) => (!Number.isFinite(ms) ? "" : ms < 10_000 ? "now" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);
const base = (rel: string) => rel.split("/").pop()!;
const dir = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : undefined);
/** A file's area: its first two folders (packages/core, apps/desktop, docs). */
const area = (rel: string) => rel.split("/").slice(0, -1).slice(0, rel.startsWith("apps/") || rel.startsWith("packages/") ? 2 : 1).join("/") || "(top level)";
/** Lines changed, added and removed together: what "biggest" sorts by. */
const size = (fs: LaneFile[]) => fs.reduce((n, f) => n + f.added + f.removed, 0);
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
  const rs = changes.map((c) => c.f.hunks ?? (c.f.before !== undefined && c.f.after !== undefined ? changedBaseLines(c.f.before, c.f.after) : ranges(c.f.lines)));
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
function DiffPane({ e, change, place, onPlace, onWhose, onClose, load }: { e: Entry; change: Change; /** Where the view is among the changes (FileDiff says; the footer shows the count). */ place: { count: number; at: number }; onPlace: (p: { count: number; at: number }) => void; onWhose: (laneId: string) => void; onClose: () => void; load?: (lane: Lane, rel: string) => Promise<FileVersions> }) {
  const { lane, f } = change;
  const same = e.changes.length > 1 ? clash(e.changes) : null;
  // Every lane's texts of the file (the others mark the clash), loaded again when it changes; the last ones stay meanwhile.
  const [loaded, setLoaded] = useState<Map<string, FileVersions>>(new Map());
  const changed = e.changes.map((c) => `${c.lane.id}@${c.f.version ?? 0}`).join();
  useEffect(() => {
    if (!load || e.changes.every((c) => c.f.before !== undefined)) return;
    let live = true;
    void Promise.all(e.changes.map((c) => load(c.lane, e.rel).then((v) => [`${c.lane.id}:${e.rel}`, v] as const, () => null))).then((rs) => {
      if (live) setLoaded((m) => new Map([...m, ...rs.filter((r) => r !== null)]));
    });
    return () => void (live = false);
  }, [e.rel, changed]); // eslint-disable-line react-hooks/exhaustive-deps
  const textsOf = (c: Change): FileVersions | undefined => (c.f.before !== undefined && c.f.after !== undefined ? { before: c.f.before, after: c.f.after, binary: false, tooLarge: false } : loaded.get(`${c.lane.id}:${e.rel}`));
  const texts = textsOf(change);
  const whole = !!texts && !texts.binary && !texts.tooLarge;
  const nav = useRef<FileDiffHandle>(null);
  const hunks = place.count;
  return (
    <View scroll={false}>
      <Stack pad="inset" padY={2}>
        <Stack gap={0.5}>
          <Inline justify="between">
            <Inline gap={2}>
              <Text strong>{base(e.rel)}</Text>
              <Text tone="dim">{dir(e.rel)}</Text>
            </Inline>
            <Inline gap={2}>
              {whole && hunks > 1 && (
                <Inline gap={0.5}>
                  <Text size="sm" tone="dim">{`${Math.max(1, place.at + 1)} of ${hunks}`}</Text>
                  <IconButton icon="chevron.up" label="Previous Change" size="sm" onClick={() => nav.current?.prev()} />
                  <IconButton icon="chevron.down" label="Next Change" size="sm" onClick={() => nav.current?.next()} />
                </Inline>
              )}
              {e.changes.length > 1 && <Segmented size="sm" label="Whose change" value={lane.id} options={e.changes.map((c) => ({ value: c.lane.id, label: c.lane.name }))} onChange={onWhose} />}
              <IconButton icon="xmark" label="Close" shortcut="Esc" size="sm" onClick={onClose} />
            </Inline>
          </Inline>
          {same && (
            <Text size="sm" tone="warning">
              {e.changes.map((c) => c.lane.name).join(" and ")} both change {same}.
            </Text>
          )}
        </Stack>
      </Stack>
      <Separator />
      {whole ? (
        <FileDiff
          ref={nav}
          key={`${lane.id}:${e.rel}`}
          path={e.rel}
          before={texts.before}
          after={texts.after}
          others={e.changes.flatMap((c) => {
            const t = c !== change ? textsOf(c) : undefined;
            return t && !t.binary && !t.tooLarge ? [{ name: c.lane.name, after: t.after }] : [];
          })}
          onPlace={onPlace}
        />
      ) : texts?.binary ? (
        <Diff fill note="Binary file" />
      ) : texts?.tooLarge ? (
        <Diff fill note="Too large to show" />
      ) : load && !texts ? (
        <View state={{ kind: "loading" }} />
      ) : f.lines?.length ? (
        <Diff fill lines={f.lines} />
      ) : (
        <Diff fill note={f.state === "deleted" ? "Deleted" : "No line changes"} />
      )}
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
  // The biggest first: lines changed, every lane's together.
  return [...by.values()].sort((a, b) => size(b.changes.map((c) => c.f)) - size(a.changes.map((c) => c.f)));
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
/** A file's name, its folder after it, dim. */
const fileName = (rel: string, faded?: boolean) => (
  <Inline gap={1.5}>
    <Text tone={faded ? "dim" : undefined}>{base(rel)}</Text>
    {dir(rel) && <Text tone="dim">{dir(rel)}</Text>}
  </Inline>
);

/** Live Diff over every checkout of a project with work in it (a prototype: data in, nothing fetched). */
export function ActivityView({ lanes, initialLens = "agents", initialSelected = null, load }: { lanes: Lane[]; initialLens?: "agents" | "files"; /** The file shown at first, as "<section>:<path>" (shared:, area:, or a lane's id). */ initialSelected?: string | null; /** A file's texts, for lanes whose files don't carry them (git.fileVersions). */ load?: (lane: Lane, rel: string) => Promise<FileVersions> }) {
  const [lens, setLens] = useState(initialLens);
  const [open, setOpen] = useState<Map<string, boolean>>(new Map());
  const [all, setAll] = useState<Set<string>>(new Set());
  /** The file shown, by where its row is: "<section>:<path>"; and whose change of it. */
  const [sel, setSel] = useState<string | null>(initialSelected);
  const [whose, setWhose] = useState<string | null>(null);
  /** Where the open diff is among its changes (from FileDiff; a patch's hunks without it). */
  const [diffPlace, setPlace] = useState<{ count: number; at: number } | null>(null);
  const every = entries(lanes);
  const shared = every.filter((e) => e.changes.length > 1);
  // The biggest changes first: lanes by the lines they changed, files the same way.
  const sorted = [...lanes].sort((a, b) => size(b.files) - size(a.files));
  const total = sum(lanes.flatMap((l) => l.files));
  const files = new Set(lanes.flatMap((l) => l.files.map((f) => f.rel))).size;
  const picked = sel ? entryOf(sel, lanes, every) : null;
  const change = picked && (picked.changes.find((c) => c.lane.id === whose) ?? picked.changes[0]!);
  // FileDiff says once it shows the file; a patch's hunks until then.
  useEffect(() => setPlace(null), [sel, whose]);
  const place = diffPlace ?? { count: ranges(change?.f.lines).length, at: -1 };
  /** The diff shown, kept while its pane folds away. */
  const shownDiff = useRef<{ e: Entry; change: Change } | null>(null);
  if (picked && change) shownDiff.current = { e: picked, change };
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
    heading("h:shared", "Clashes");
    // Same lines first: those will conflict; the rest are only the same file.
    for (const e of [...shared].sort((a, b) => Number(!!clash(b.changes)) - Number(!!clash(a.changes)))) fileRow(`shared:${e.rel}`, e, 0, true);
  }
  if (lens === "agents") {
    heading("h:agents", "Agents");
    for (const l of sorted) {
      const isOpen = open.get(l.id) ?? false;
      const biggest = [...l.files].sort((a, b) => size([b]) - size([a]));
      const last = Math.min(...l.files.map((f) => f.ago));
      rows.push({
        key: `lane:${l.id}`,
        info: { expanded: biggest.length ? isOpen : undefined, onToggle: () => toggle(l.id, false) },
        onClick: () => toggle(l.id, false),
        cells: [<StatusDot key="d" state={l.light} />, l.name, <Text key="b" tone="dim">{l.main ? "main checkout" : l.branch}</Text>, lines(sum(l.files)), biggest.length ? when(last) : ""],
      });
      if (!isOpen) continue;
      const shown = all.has(l.id) ? biggest : biggest.slice(0, FIRST);
      for (const f of shown) fileRow(`${l.id}:${f.rel}`, { rel: f.rel, changes: [{ lane: l, f }] }, 1, false);
      if (biggest.length > shown.length) more(l.id, biggest.length - shown.length, 1);
    }
  } else {
    const areas = new Map<string, Entry[]>();
    for (const e of every) areas.set(area(e.rel), [...(areas.get(area(e.rel)) ?? []), e]);
    for (const [name, es] of [...areas.entries()].sort((a, b) => size(b[1].flatMap((e) => e.changes.map((c) => c.f))) - size(a[1].flatMap((e) => e.changes.map((c) => c.f))))) {
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
          headless
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
        </WindowToolbar>
      }
      footer={
        // A file open: what its change is; else the totals.
        picked && change ? (
          <StatusLine end={<span>{`+${change.f.added} −${change.f.removed} · ${age(change.f.ago)}`}</span>}>
            {`${change.lane.name} · ${change.lane.main ? "main checkout" : change.lane.branch} · ${change.f.committed ? "committed" : "uncommitted"} · ${place.count} ${place.count === 1 ? "change" : "changes"}`}
          </StatusLine>
        ) : (
          <StatusLine end={<span>{`+${total.added} −${total.removed}`}</span>}>
            {lanes.length} checkouts · {files} files
          </StatusLine>
        )
      }
      state={!lanes.length ? { kind: "empty", icon: "checkmark.circle", title: "Nothing changed" } : null}
      scroll={false}
    >
      <Split side="bottom" open={!!(picked && change)} pane={shownDiff.current && <DiffPane e={shownDiff.current.e} change={shownDiff.current.change} place={place} onPlace={setPlace} load={load} onWhose={setWhose} onClose={() => setSel(null)} />} size={{ min: 120, ideal: 300, max: 2000 }}>
        {list}
      </Split>
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
