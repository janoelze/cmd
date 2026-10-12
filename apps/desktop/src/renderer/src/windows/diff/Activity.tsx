// Prototype: Live Diff across worktrees. What several agents, each in a worktree
// of one project, are changing on disk, as an overview: one row per agent (what
// it touches now, how much, on which branch), its files newest first under it,
// and the files more than one of them changed, first, because those are the
// ones that will conflict. A second lens groups the same files by area.

import { Badge, Callout, Chip, Diff, Inline, List, ListRow, ListRowContent, ListRowEnd, ListRowIcon, ListSection, Split, Stack, StatusLine, Text, ToolbarButton, ToolbarSegmented, ToolbarSpacer, Twisty, View, WindowToolbar } from "@cmd/ui";
import type { DotState } from "@cmd/ui";
import { useState } from "react";
import type { GitFile } from "@cmd/protocol";
import { projectHue } from "../../lib/model.ts";

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

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <Inline gap={1.5}>
      {added > 0 && (
        <Text size="xs" mono tone="success">
          +{added}
        </Text>
      )}
      {removed > 0 && (
        <Text size="xs" mono tone="danger">
          −{removed}
        </Text>
      )}
    </Inline>
  );
}

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

/** A changed file; a click shows its lines beside the list. Changed by more than one lane, it says whether they touch the same lines. */
function FileRow({ e, depth = 0, who, selected, onSelect }: { e: Entry; depth?: number; who?: boolean; selected: boolean; onSelect: () => void }) {
  const f = e.changes[0]!.f;
  const st = LETTER[f.state];
  const many = e.changes.length > 1;
  const same = many ? clash(e.changes) : null;
  const committed = e.changes.every((c) => c.f.committed);
  return (
    <ListRow depth={depth} selected={selected} dim={committed && !selected} tip={`${e.rel}${committed ? "\nCommitted" : ""}`} onClick={onSelect}>
      <ListRowIcon icon={<Badge size="sm" tone={st.tone}>{st.letter}</Badge>} />
      <ListRowContent title={base(e.rel)} place={dir(e.rel)} detail={many ? (same ? `Both change ${same}` : "Different places in the file") : undefined} tone={same ? "needs" : undefined} />
      <ListRowEnd>
        <Inline gap={2}>
          {who &&
            e.changes.map(({ lane }) => (
              <Chip key={lane.id} hue={projectHue(lane.branch)} tip={`${lane.name} on ${lane.branch}`}>
                {lane.name}
              </Chip>
            ))}
          <Counts {...sum(e.changes.map((c) => c.f))} />
          <Text size="xs" tone="dim">
            {age(f.ago)}
          </Text>
        </Inline>
      </ListRowEnd>
    </ListRow>
  );
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
          <Inline gap={2}>
            <Chip hue={projectHue(lane.branch)} tip={`${lane.name} on ${lane.branch}`}>
              {lane.name}
            </Chip>
            <Text size="sm" tone="dim">
              {f.committed ? "Committed" : "Uncommitted"} · {hunks} {hunks === 1 ? "change" : "changes"} · {age(f.ago)}
            </Text>
            <Counts {...f} />
          </Inline>
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

/** Live Diff over every checkout of a project with work in it (a prototype: data in, nothing fetched). */
export function ActivityView({ lanes, initialLens = "agents", initialSelected = null }: { lanes: Lane[]; initialLens?: "agents" | "files"; /** The file shown at first, as "<section>:<path>" (shared:, area:, or a lane's id). */ initialSelected?: string | null }) {
  const [lens, setLens] = useState(initialLens);
  const [open, setOpen] = useState<Map<string, boolean>>(new Map());
  const [all, setAll] = useState<Set<string>>(new Set());
  const every = entries(lanes);
  const shared = every.filter((e) => e.changes.length > 1);
  /** The file shown, by where its row is: "<section>:<path>"; and whose change of it. */
  const [sel, setSel] = useState<string | null>(initialSelected);
  const [whose, setWhose] = useState<string | null>(null);
  /** Rows in the order shown, for ↑ and ↓. */
  const order: string[] = [];
  const row = (key: string, e: Entry, p: { depth?: number; who?: boolean } = {}) => {
    order.push(key);
    return <FileRow key={key} e={e} {...p} selected={sel === key} onSelect={() => (setSel(key), setWhose(null))} />;
  };
  const picked = sel ? entryOf(sel, lanes, every) : null;
  const change = picked && (picked.changes.find((c) => c.lane.id === whose) ?? picked.changes[0]!);
  const sorted = [...lanes].sort((a, b) => Math.min(...a.files.map((f) => f.ago), Infinity) - Math.min(...b.files.map((f) => f.ago), Infinity));
  const total = sum(lanes.flatMap((l) => l.files));
  const files = new Set(lanes.flatMap((l) => l.files.map((f) => f.rel))).size;

  const agents = (
    <ListSection title="Agents" count={lanes.length}>
      {sorted.map((l) => {
        const isOpen = open.get(l.id) ?? false;
        const newest = [...l.files].sort((a, b) => a.ago - b.ago);
        const shown = all.has(l.id) ? newest : newest.slice(0, FIRST);
        const now = newest[0];
        const t = sum(l.files);
        const toggle = () => setOpen((m) => new Map(m).set(l.id, !isOpen));
        return (
          <div key={l.id} style={{ display: "contents" }}>
            <ListRow onClick={toggle} tip={l.main ? "The workspace's own checkout" : `Worktree on ${l.branch}`}>
              <Twisty open={isOpen} onToggle={toggle} />
              <ListRowIcon icon="sparkle" light={l.light} />
              <ListRowContent
                title={l.name}
                detail={now ? `${now.committed ? "Committed" : now.ago < 60_000 ? "Writing" : "Changed"} ${base(now.rel)} · ${age(now.ago)}${l.ahead ? ` · ${l.ahead} ${l.ahead === 1 ? "commit" : "commits"}` : ""}` : "No changes yet"}
              />
              <ListRowEnd>
                <Inline gap={2}>
                  {!l.main && <Chip hue={projectHue(l.branch)}>{l.branch}</Chip>}
                  <Counts {...t} />
                </Inline>
              </ListRowEnd>
            </ListRow>
            {isOpen && shown.map((f) => row(`${l.id}:${f.rel}`, { rel: f.rel, changes: [{ lane: l, f }] }, { depth: 1 }))}
            {isOpen && newest.length > shown.length && (
              <ListRow depth={1} onClick={() => setAll((s) => new Set(s).add(l.id))}>
                <ListRowContent title={<Text tone="dim">{`${newest.length - shown.length} more files`}</Text>} place={[...new Set(newest.slice(FIRST).map((f) => area(f.rel)))].slice(0, 3).join(", ")} />
              </ListRow>
            )}
          </div>
        );
      })}
    </ListSection>
  );

  const areas = new Map<string, Entry[]>();
  for (const e of every) areas.set(area(e.rel), [...(areas.get(area(e.rel)) ?? []), e]);
  const byArea = (
    <>
      {[...areas.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([name, es]) => (
          <ListSection key={name} title={name} count={es.length} open={open.get(`area:${name}`) ?? true} onToggle={() => setOpen((m) => new Map(m).set(`area:${name}`, !(m.get(`area:${name}`) ?? true)))}>
            {es.slice(0, all.has(`area:${name}`) ? undefined : FIRST).map((e) => row(`area:${e.rel}`, e, { who: true }))}
            {es.length > FIRST && !all.has(`area:${name}`) && (
              <ListRow onClick={() => setAll((s) => new Set(s).add(`area:${name}`))}>
                <ListRowContent title={<Text tone="dim">{`${es.length - FIRST} more files`}</Text>} />
              </ListRow>
            )}
          </ListSection>
        ))}
    </>
  );

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
      <List>
        {shared.length > 0 && (
          <ListSection title="Changed in more than one worktree" count={shared.length} tone="needs">
            {shared.map((e) => row(`shared:${e.rel}`, e, { who: true }))}
          </ListSection>
        )}
        {lens === "agents" ? agents : byArea}
      </List>
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
        <StatusLine end={<Counts {...total} />}>
          {lanes.length} checkouts · {files} files
        </StatusLine>
      }
      state={!lanes.length ? { kind: "empty", icon: "checkmark.circle", title: "Nothing changed" } : null}
      scroll={false}
    >
      {picked && change ? (
        <Split side="start" pane={list} width={{ min: 240, ideal: 320, max: 480 }}>
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
