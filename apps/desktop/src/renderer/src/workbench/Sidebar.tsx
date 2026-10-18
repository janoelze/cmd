// The UI Workbench's sidebar (docs/48), from the catalog: the kit's components by the
// file they live in (a dim icon: no story shows them yet), then the stories by folder,
// a story's variants under it once it is open. Type to filter all of it.

import { useEffect, useState } from "react";
import { List, ListRow, ListRowContent, ListRowIcon, ListSection, SearchField } from "@cmd/ui";
import type { Catalog, ComponentInfo, StoryInfo } from "./catalog/index.ts";

export type Selection = { kind: "component"; id: string } | { kind: "story"; id: string; variant?: string } | null;

interface Group {
  key: string;
  title: string;
  components: ComponentInfo[];
  stories: StoryInfo[];
}

/** Kit families (by file, in index.ts's order), then story folders (by their first segment). */
function groups(catalog: Catalog): Group[] {
  const out = new Map<string, Group>();
  const at = (key: string, title: string) => out.get(key) ?? out.set(key, { key, title, components: [], stories: [] }).get(key)!;
  for (const c of catalog.components.filter((c) => c.kit)) {
    const base = c.file.split("/").pop()!.replace(/\.tsx?$/, "");
    at(`kit:${base}`, base.replace(/^./, (x) => x.toUpperCase())).components.push(c);
  }
  for (const s of catalog.stories) {
    const top = s.group.split("/")[0]!;
    at(`stories:${top}`, top === "ui" ? "Kit stories" : top.replace(/^./, (x) => x.toUpperCase())).stories.push(s);
  }
  return [...out.values()];
}

export function Sidebar({ catalog, selection, onSelect }: { catalog: Catalog; selection: Selection; onSelect: (s: Selection) => void }) {
  const [query, setQuery] = useState("");
  const all = groups(catalog);
  const holds = (g: Group) => (selection?.kind === "component" ? g.components.some((c) => c.id === selection.id) : g.stories.some((s) => s.id === selection?.id));
  const [open, setOpen] = useState<Set<string>>(() => new Set(all.filter(holds).map((g) => g.key)));
  // Whatever gets selected (a link, a script), its section opens.
  const at = all.find(holds)?.key;
  useEffect(() => void (at && setOpen((o) => (o.has(at) ? o : new Set(o).add(at)))), [at]);
  const toggle = (key: string) => setOpen((o) => (o.has(key) ? (o.delete(key), new Set(o)) : new Set(o).add(key)));
  const covered = new Set(catalog.stories.flatMap((s) => s.components));

  const q = query.trim().toLowerCase();
  const hit = (...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q));
  const shown = all
    .map((g) => ({
      ...g,
      components: g.components.filter((c) => hit(c.name)),
      stories: g.stories.filter((s) => hit(s.title, s.id, ...s.variants.map((v) => v.name))),
    }))
    .filter((g) => g.components.length || g.stories.length);

  return (
    <div className="wb-side">
      <div className="wb-side-search">
        <SearchField value={query} onChange={setQuery} placeholder="Filter" fill />
      </div>
      <div className="wb-side-list">
        <List>
          {shown.map((g) => (
            <ListSection key={g.key} title={g.title} count={g.components.length + g.stories.length} open={!!q || open.has(g.key)} onToggle={() => toggle(g.key)}>
              {g.components.map((c) => (
                <ListRow key={c.id} tip={covered.has(c.id) ? undefined : "No story shows it yet"} selected={selection?.kind === "component" && selection.id === c.id} onClick={() => onSelect({ kind: "component", id: c.id })}>
                  <ListRowIcon icon="copy-simple" tone={covered.has(c.id) ? undefined : "dim"} />
                  <ListRowContent title={c.name} />
                </ListRow>
              ))}
              {g.stories.map((s) => {
                const here = selection?.kind === "story" && selection.id === s.id;
                const sub = s.group.split("/").slice(1).join("/");
                return [
                  <ListRow key={s.id} selected={here && !selection.variant} onClick={() => onSelect({ kind: "story", id: s.id })}>
                    <ListRowIcon icon="stack" />
                    <ListRowContent title={s.title} place={sub || undefined} />
                  </ListRow>,
                  ...(here || q
                    ? s.variants
                        .filter((v) => !q || here || hit(v.name, s.title))
                        .map((v) => (
                          <ListRow key={`${s.id}/${v.name}`} depth={1} selected={here && selection.variant === v.name} onClick={() => onSelect({ kind: "story", id: s.id, variant: v.name })}>
                            <ListRowContent title={v.name} />
                          </ListRow>
                        ))
                    : []),
                ];
              })}
            </ListSection>
          ))}
        </List>
      </div>
    </div>
  );
}
