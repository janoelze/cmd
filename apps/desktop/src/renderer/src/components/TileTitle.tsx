// Title bar of a window tile, the same for every window type
// (docs/10-window-titles.md): Mark · Name · Dirty ……… Kind | Place | Status.
// Each field is a Slot, so state changes animate instead of popping.

import { fieldsOf, windowIdOf, type SidebarRow, type WindowFields } from "../model.ts";
import { typeFor } from "../windows/registry.ts";
import { useEffect, useRef, useState } from "react";
import { editTitle, useTitleEdit, useWindowStatus, type TitleEdit } from "../windowActions.ts";
import { DirtyDot, Mark, Slot } from "./Slot.tsx";
import { RemoteBadge } from "./Remote.tsx";

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
  // A status can be a button ("Updated 12s ago" refreshes); presses on it don't start a drag.
  const action = useWindowStatus(row.win?.id ?? null)?.action;
  const edit = useTitleEdit(row.win?.id ?? null);
  return (
    <div className="tile-title" onPointerDown={onPointerDown} onContextMenu={onContextMenu} onDoubleClick={onDoubleClick} data-tip={title}>
      <Mark light={f.light} icon={f.icon} />
      <span className={`tile-name${edit ? " editing" : ""}`}>
        {edit ? (
          <TitleInput id={row.win!.id} edit={edit} />
        ) : (
          <>
            <Slot value={{ text: f.name }} fade />
            <DirtyDot on={!!f.dirty} />
          </>
        )}
      </span>
      <RemoteBadge id={windowIdOf(row)} />
      <span className="tile-meta">
        <Slot className="slot-kind" value={f.kind ? { text: f.kind } : undefined} />
        {/* A divider only after a field that's there. */}
        <Slot className="slot-place" value={f.place ? { text: f.place } : undefined} clipStart divider={!!f.kind} />
        <span
          className="tile-status"
          onPointerDown={action ? (e) => e.stopPropagation() : undefined}
          onClick={action ? (e) => (e.stopPropagation(), action.run()) : undefined}
        >
          <Slot className={`slot-status${action ? " actionable" : ""}`} value={f.status} divider={!!(f.kind || f.place)} title={action?.title} />
        </span>
      </span>
    </div>
  );
}

/** The name as an input (windowActions.ts → editTitle): ⏎ submits, Esc (or leaving it empty) closes it. */
function TitleInput({ id, edit }: { id: string; edit: TitleEdit }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const close = () => editTitle(id, null);
  return (
    <input
      ref={ref}
      className="tile-title-input"
      value={text}
      placeholder={edit.placeholder}
      spellCheck={false}
      // Typing and selecting text, not dragging the window.
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (text.trim()) edit.submit(text.trim());
          close();
        } else if (e.key === "Escape") close();
      }}
      onBlur={() => !text.trim() && close()}
    />
  );
}
