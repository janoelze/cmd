// DataGrid: rows and columns of values (a table's rows, a query's result, a
// list of columns), the kit's table. A sticky header; a click on a column
// sorts by it (asc, then desc, then off) when the caller takes onSort; cells
// are one line each, cut with an ellipsis, the whole value in the tooltip.
// Numbers sit to the right, NULL and blobs are dim. Rows take a context menu.

import type { MouseEvent, ReactNode } from "react";
import { ICON, Icon } from "./icon.tsx";

const cls = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export interface GridColumn {
  key: string;
  label: ReactNode;
  /** A second line under the label (a column's type). */
  note?: ReactNode;
  /** Values sit to the right (numbers). */
  align?: "start" | "end";
  /** Takes the width left over (the name or title column); the others keep their natural width. */
  grow?: boolean;
  /** Dropped when the space it sits in is narrower than this (narrow: 360px, regular: 600px): the columns that matter least. */
  hide?: "narrow" | "regular";
  /** Holds only an icon or a status dot: as narrow as it, with no label. */
  icon?: boolean;
}

/** A cell: a node, or a value with how to show it. */
export type GridCell = ReactNode | { node: ReactNode; kind?: "null" | "number" | "blob" | "text"; tip?: string; align?: "start" | "end" };

export interface GridSort {
  key: string;
  desc: boolean;
}

export interface DataGridProps {
  columns: readonly GridColumn[];
  rows: readonly (readonly GridCell[])[];
  /** A key per row (its index by default). */
  rowKey?: (row: readonly GridCell[], index: number) => string | number;
  sort?: GridSort | null;
  /** Header clicks sort: asc, then desc, then off (null). */
  onSort?: (sort: GridSort | null) => void;
  onRowContextMenu?: (index: number, e: MouseEvent<HTMLTableRowElement>) => void;
  /** A click selects a row (an inspector shows it). */
  onRowClick?: (index: number, e: MouseEvent<HTMLTableRowElement>) => void;
  /** The selected row's index. */
  selected?: number | null;
  /** Values in the code font (data, not labels). */
  mono?: boolean;
  /** A row number before each row. */
  numbered?: boolean;
  /** Under the rows, inside the scroll: a "Show more" button. */
  footer?: ReactNode;
  className?: string;
}

const isSpec = (c: GridCell): c is Exclude<GridCell, ReactNode> => typeof c === "object" && c !== null && "node" in c && !("$$typeof" in (c as object));

export function DataGrid({ columns, rows, rowKey, sort, onSort, onRowContextMenu, onRowClick, selected, mono, numbered, footer, className }: DataGridProps) {
  const next = (key: string): GridSort | null => (sort?.key !== key ? { key, desc: false } : sort.desc ? null : { key, desc: true });
  return (
    <div className={cls("ui-grid", className)} data-mono={mono || undefined}>
      <table>
        <thead>
          <tr>
            {numbered && <th className="ui-grid-num" aria-label="Row" />}
            {columns.map((c) => {
              const sorted = sort?.key === c.key ? (sort.desc ? "descending" : "ascending") : undefined;
              const head = (
                <>
                  <span className="ui-grid-label">{c.label}</span>
                  {sorted && <Icon name={sort!.desc ? "chevron.down" : "chevron.up"} size={ICON.disclosure} />}
                </>
              );
              return (
                <th key={c.key} data-align={c.align} data-grow={c.grow || undefined} data-hide={c.hide} data-icon={c.icon || undefined} aria-sort={sorted}>
                  {onSort ? (
                    <button type="button" className="ui-grid-sort" onClick={() => onSort(next(c.key))}>
                      {head}
                    </button>
                  ) : (
                    <span className="ui-grid-sort">{head}</span>
                  )}
                  {c.note != null && <span className="ui-grid-note">{c.note}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={rowKey ? rowKey(r, i) : i}
              aria-selected={selected === i || undefined}
              onClick={onRowClick && ((e) => onRowClick(i, e))}
              onContextMenu={
                onRowContextMenu &&
                ((e) => {
                  e.preventDefault();
                  onRowContextMenu(i, e);
                })
              }
            >
              {numbered && <td className="ui-grid-num">{i + 1}</td>}
              {r.map((c, j) => {
                const spec = isSpec(c) ? c : { node: c };
                return (
                  <td key={j} data-kind={spec.kind} data-align={spec.align ?? columns[j]?.align} data-hide={columns[j]?.hide} data-icon={columns[j]?.icon || undefined} data-grow={columns[j]?.grow || undefined} data-tip={spec.tip}>
                    {spec.node}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {footer != null && <div className="ui-grid-footer">{footer}</div>}
    </div>
  );
}
