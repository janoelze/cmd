// Title bar of a window tile, the same for every window type
// (docs/10-window-titles.md): Mark · Name · Dirty ……… Kind · Place · Status.
// Each field is a Slot, so state changes animate instead of popping.

import { fieldsOf, type SidebarRow, type WindowFields } from "../model.ts";
import { typeFor } from "../windows/registry.ts";
import { useWindowStatus } from "../windowActions.ts";
import { DirtyDot, Mark, Slot } from "./Slot.tsx";

/** SF Symbol for a window kind (from the core's window type registry). */
export const iconFor = (kind: string) => typeFor(kind)?.icon ?? "macwindow";

/** A row's title fields, with the window's live status. */
export function useFields(row: SidebarRow | undefined, now = Date.now()): WindowFields | undefined {
  const live = useWindowStatus(row?.win?.id ?? null);
  return row ? fieldsOf(row, live, now) : undefined;
}

export function TileTitle({
  row,
  onPointerDown,
  onContextMenu,
  onDoubleClick,
  title,
}: {
  row: SidebarRow;
  onPointerDown?: (e: React.PointerEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  title?: string;
}) {
  const f = useFields(row)!;
  return (
    <div className="tile-title" onPointerDown={onPointerDown} onContextMenu={onContextMenu} onDoubleClick={onDoubleClick} title={title}>
      <Mark light={f.light} icon={f.icon} />
      <span className="tile-name">
        <Slot value={{ text: f.name }} fade />
        <DirtyDot on={!!f.dirty} />
      </span>
      <span className="tile-meta">
        <Slot className="slot-kind" value={{ text: f.kind }} />
        <Slot className="slot-place" value={f.place ? { text: f.place } : undefined} clipStart />
        <Slot className="slot-status" value={f.status} />
      </span>
    </div>
  );
}
