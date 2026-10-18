// Files and folders as the Files window lists them: column heads that sort (TreeHeader),
// rows with a disclosure, an icon, a git mark and size and date columns; the sidebar's
// dense version; renaming in place. The caller sorts; here the rows follow the header.
import { useState } from "react";
import { Tree, TreeHeader, TreeRename, TreeRow, type TreeSort } from "./tree.tsx";

const ROWS = [
  { name: "apps", folder: true, size: 0, date: 3 },
  { name: "packages", folder: true, size: 0, date: 1 },
  { name: "CHANGELOG.md", size: 48_200, date: 2, mark: "M", tone: "modified" as const },
  { name: "package.json", size: 2_310, date: 5 },
  { name: "README.md", size: 9_870, date: 9 },
];
const fmt = (n: number) => (n ? `${(n / 1000).toFixed(1)} KB` : "—");

/** Sorted by the header: click a column, again for the other way (sizes and dates largest and newest first). */
export const Sorted = () => {
  const [sort, setSort] = useState<TreeSort>({ key: "name", desc: false });
  const rows = [...ROWS].sort((a, b) => {
    const d = sort.key === "name" ? a.name.localeCompare(b.name) : sort.key === "size" ? a.size - b.size : b.date - a.date;
    return sort.desc ? -d : d;
  });
  return (
    <div style={{ width: 560, height: 240, display: "flex", flexDirection: "column" }}>
      <TreeHeader sort={sort} onSort={setSort} />
      <Tree>
        {rows.map((r, i) => (
          <TreeRow key={r.name} depth={0} open={r.folder ? false : undefined} icon={r.folder ? "folder" : "file"} folder={r.folder} name={r.name} mark={r.mark} tone={r.tone} selected={i === 2} size={fmt(r.size)} date={`${r.date}d ago`} />
        ))}
      </Tree>
    </div>
  );
};

/** The sidebar's version: rows inset and rounded, a guide per level, a hidden file faded. */
export const Dense = () => (
  <div style={{ width: 260, height: 200, display: "flex", flexDirection: "column" }}>
    <Tree dense>
      <TreeRow depth={0} open icon="folder" folder name="packages" />
      <TreeRow depth={1} open icon="folder" folder name="ui" />
      <TreeRow depth={2} icon="file" name="tree.tsx" mark="M" tone="modified" selected />
      <TreeRow depth={2} icon="file" name="tree.story.tsx" mark="U" tone="added" />
      <TreeRow depth={1} icon="file" name=".DS_Store" faded />
    </Tree>
  </div>
);

/** Renaming in place: the name a field, its extension left out of the selection; Enter keeps it, Escape puts it back. */
export const Renaming = () => {
  const [name, setName] = useState("notes.md");
  const [editing, setEditing] = useState(true);
  return (
    <div style={{ width: 320, height: 120, display: "flex", flexDirection: "column" }}>
      <Tree dense>
        <TreeRow depth={0} icon="file" name="README.md" />
        <TreeRow depth={0} icon="file" selected name={editing ? <TreeRename name={name} onDone={(n) => (setName(n), setEditing(false))} /> : name} onDoubleClick={() => setEditing(true)} />
        <TreeRow depth={0} icon="folder" folder name="src" />
      </Tree>
    </div>
  );
};
