// Prototype: Live Diff across worktrees. What several agents, each in a worktree
// of one project, are changing on disk, as an overview: one row per agent (what
// it touches now, how much, on which branch), its files newest first under it,
// and the files more than one of them changed, first, because those are the
// ones that will conflict. A second lens groups the same files by area.

import { Badge, Chip, Inline, List, ListRow, ListRowContent, ListRowEnd, ListRowIcon, ListSection, Segmented, StatusLine, Text, Twisty, View, WindowToolbar } from "@cmd/ui";
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

function FileRow({ f, depth, who }: { f: LaneFile; depth?: number; who?: Lane[] }) {
  const st = LETTER[f.state];
  return (
    <ListRow depth={depth} dim={f.committed} tip={`${f.rel}${f.committed ? "\nCommitted" : ""}`}>
      <ListRowIcon icon={<Badge size="sm" tone={st.tone}>{st.letter}</Badge>} />
      <ListRowContent title={base(f.rel)} place={dir(f.rel)} />
      <ListRowEnd>
        <Inline gap={2}>
          {who?.map((l) => (
            <Chip key={l.id} hue={projectHue(l.branch)} tip={`${l.name} on ${l.branch}`}>
              {l.name}
            </Chip>
          ))}
          <Counts added={f.added} removed={f.removed} />
          <Text size="xs" tone="faint">
            {age(f.ago)}
          </Text>
        </Inline>
      </ListRowEnd>
    </ListRow>
  );
}

/** The files more than one lane changed, with who changed each, newest first. */
function overlaps(lanes: Lane[]) {
  const by = new Map<string, { f: LaneFile; who: Lane[] }>();
  for (const l of lanes)
    for (const f of l.files) {
      const e = by.get(f.rel);
      if (!e) by.set(f.rel, { f, who: [l] });
      else e.who.push(l), e.f.ago > f.ago && (e.f = f);
    }
  return [...by.values()].filter((e) => e.who.length > 1).sort((a, b) => a.f.ago - b.f.ago);
}

/** Live Diff over every checkout of a project with work in it (a prototype: data in, nothing fetched). */
export function ActivityView({ lanes, initialLens = "agents" }: { lanes: Lane[]; initialLens?: "agents" | "files" }) {
  const [lens, setLens] = useState(initialLens);
  const [open, setOpen] = useState<Map<string, boolean>>(new Map());
  const [all, setAll] = useState<Set<string>>(new Set());
  const shared = overlaps(lanes);
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
            {isOpen && shown.map((f) => <FileRow key={f.rel} f={f} depth={1} />)}
            {isOpen && newest.length > shown.length && (
              <ListRow depth={1} onClick={() => setAll((s) => new Set(s).add(l.id))}>
                <ListRowContent title={<Text tone="faint">{`${newest.length - shown.length} more files`}</Text>} place={[...new Set(newest.slice(FIRST).map((f) => area(f.rel)))].slice(0, 3).join(", ")} />
              </ListRow>
            )}
          </div>
        );
      })}
    </ListSection>
  );

  const areas = new Map<string, { f: LaneFile; who: Lane[] }[]>();
  const seen = new Map<string, { f: LaneFile; who: Lane[] }>();
  for (const l of lanes)
    for (const f of l.files) {
      const e = seen.get(f.rel);
      if (e) e.who.push(l);
      else seen.set(f.rel, { f, who: [l] });
    }
  for (const e of seen.values()) areas.set(area(e.f.rel), [...(areas.get(area(e.f.rel)) ?? []), e]);
  const byArea = (
    <>
      {[...areas.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([name, es]) => (
          <ListSection key={name} title={name} count={es.length} open={open.get(`area:${name}`) ?? true} onToggle={() => setOpen((m) => new Map(m).set(`area:${name}`, !(m.get(`area:${name}`) ?? true)))}>
            {es
              .sort((a, b) => a.f.ago - b.f.ago)
              .slice(0, all.has(`area:${name}`) ? undefined : FIRST)
              .map((e) => (
                <FileRow key={e.f.rel} f={e.f} who={e.who} />
              ))}
            {es.length > FIRST && !all.has(`area:${name}`) && (
              <ListRow onClick={() => setAll((s) => new Set(s).add(`area:${name}`))}>
                <ListRowContent title={<Text tone="faint">{`${es.length - FIRST} more files`}</Text>} />
              </ListRow>
            )}
          </ListSection>
        ))}
    </>
  );

  return (
    <View
      toolbar={
        <WindowToolbar label="Changes">
          <Segmented value={lens} options={[{ value: "agents", label: "Agents" }, { value: "files", label: "Areas" }]} onChange={setLens} size="sm" />
        </WindowToolbar>
      }
      footer={
        <StatusLine end={<Counts {...total} />}>
          {lanes.length} checkouts · {files} files
        </StatusLine>
      }
      state={!lanes.length ? { kind: "empty", icon: "checkmark.circle", title: "Nothing changed" } : null}
    >
      <List>
        {shared.length > 0 && (
          <ListSection title="Changed in more than one worktree" count={shared.length} tone="needs">
            {shared.map((e) => (
              <FileRow key={e.f.rel} f={e.f} who={e.who} />
            ))}
          </ListSection>
        )}
        {lens === "agents" ? agents : byArea}
      </List>
    </View>
  );
}
