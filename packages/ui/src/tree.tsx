// Tree: files and folders (the Files window and sidebar), one row per entry with a
// disclosure, an icon, the name, a mark (git's letter), and size and date columns
// that drop out when the view is narrow. Rows take a selection, a drop target, a
// git tone and a faded look (hidden or ignored files); `dense` is the sidebar's
// version, rows inset and rounded like the Navigator's, a guide per level. The
// caller owns keys, drag and drop and menus: the pieces pass DOM props through.
// TreeHeader names the columns above it and sorts by one (the caller sorts).

import { forwardRef, useRef, type HTMLAttributes, type ReactNode } from "react";
import { ICON, Icon } from "./icon.tsx";

const cls = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/** The tree's list: focusable, scrolls; `dropping` rings it (a drop into the root folder). */
export const Tree = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { dense?: boolean; dropping?: boolean }>(function Tree({ dense, dropping, className, ...rest }, ref) {
  return <div ref={ref} role="tree" tabIndex={0} className={cls("ui-tree", className)} data-dense={dense || undefined} data-dropping={dropping || undefined} {...rest} />;
});

export interface TreeSort {
  key: "name" | "size" | "date";
  desc: boolean;
}

/** The first click on a column: names A to Z, sizes and dates largest and newest first (as Finder). */
const FIRST: Record<TreeSort["key"], boolean> = { name: false, size: true, date: true };

/** The column heads, on the rows' grid: a click sorts by a column, again the other way. */
export function TreeHeader({ sort, onSort }: { sort: TreeSort; onSort: (s: TreeSort) => void }) {
  const head = (key: TreeSort["key"], label: string, className: string) => {
    const on = sort.key === key;
    return (
      <button type="button" className={className} aria-sort={on ? (sort.desc ? "descending" : "ascending") : undefined} onClick={() => onSort({ key, desc: on ? !sort.desc : FIRST[key] })}>
        <span>{label}</span>
        {on && <Icon name={sort.desc ? "chevron.down" : "chevron.up"} size={ICON.disclosure} />}
      </button>
    );
  };
  return (
    <div className="ui-tree-row ui-tree-head" role="row">
      <span />
      <span />
      {head("name", "Name", "ui-tree-sort ui-tree-name")}
      <span />
      {head("size", "Size", "ui-tree-sort ui-tree-col")}
      {head("date", "Modified", "ui-tree-sort ui-tree-col")}
    </div>
  );
}

/** A git state, as its colour: renamed reads as modified, untracked as added. */
export type TreeTone = "modified" | "added" | "deleted" | "conflict" | "ignored";

export interface TreeRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  depth: number;
  /** A folder: open or not (a disclosure). Leave it out for a file. */
  open?: boolean;
  onToggle?: () => void;
  icon: string;
  /** The icon in the folder colour. */
  folder?: boolean;
  /** The name, or a TreeRename in its place. */
  name: ReactNode;
  /** A letter or dot after the name (git's state), in the row's tone. */
  mark?: ReactNode;
  markTip?: string;
  tone?: TreeTone;
  /** Hidden files: faded. */
  faded?: boolean;
  selected?: boolean;
  /** The folder a drag would drop into. */
  dropping?: boolean;
  size?: ReactNode;
  date?: ReactNode;
}

export const TreeRow = forwardRef<HTMLDivElement, TreeRowProps>(function TreeRow({ depth, open, onToggle, icon, folder, name, mark, markTip, tone, faded, selected, dropping, size, date, className, style, ...rest }, ref) {
  return (
    <div
      ref={ref}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={open}
      className={cls("ui-tree-row", className)}
      data-selected={selected || undefined}
      data-dropping={dropping || undefined}
      data-faded={faded || undefined}
      data-tone={tone}
      style={{ ...style, ["--depth" as string]: depth }}
      {...rest}
    >
      {open !== undefined ? (
        <button
          type="button"
          className={cls("ui-twisty", open && "open")}
          tabIndex={-1}
          aria-label={open ? "Collapse" : "Expand"}
          onMouseDown={(ev) => ev.stopPropagation()}
          onClick={onToggle}
        >
          <Icon name="chevron.right" size={ICON.disclosure} />
        </button>
      ) : (
        <span />
      )}
      <span className="ui-tree-icon" data-folder={folder || undefined}>
        <Icon name={icon} size={ICON.row} />
      </span>
      {typeof name === "string" ? <span className="ui-tree-name">{name}</span> : name}
      <span className="ui-tree-mark" data-tip={markTip}>
        {mark}
      </span>
      <span className="ui-tree-col">{size}</span>
      <span className="ui-tree-col">{date}</span>
    </div>
  );
});

/**
 * Renaming in place, like Finder: a field in the name's place, its text exactly where
 * the name's was, the name without its extension selected. Return or leaving it calls
 * onDone with the new name, Escape with the old one; once.
 */
export function TreeRename({ name, folder, onDone }: { name: string; folder?: boolean; onDone: (name: string) => void }) {
  const done = useRef(false);
  const finish = (v: string) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      className="ui-tree-rename"
      defaultValue={name}
      autoFocus
      spellCheck={false}
      onFocus={(ev) => {
        const dot = folder ? -1 : name.lastIndexOf(".");
        ev.currentTarget.setSelectionRange(0, dot > 0 ? dot : name.length);
      }}
      onKeyDown={(ev) => {
        ev.stopPropagation(); // not the tree's keys
        if (ev.key === "Enter") finish(ev.currentTarget.value);
        else if (ev.key === "Escape") finish(name);
      }}
      onBlur={(ev) => finish(ev.currentTarget.value)}
      onMouseDown={(ev) => ev.stopPropagation()}
      onDoubleClick={(ev) => ev.stopPropagation()}
    />
  );
}
