// Title bar of a window tile, the same for every window type
// (docs/10-window-titles.md): Mark · Name · Dirty ……… Kind | Place | Status.
// Each field is a Slot, so state changes animate instead of popping.
// The Mark of a window that shows a file or folder (a text file, a file browser's
// folder, a terminal's working directory) drags that file, like the icon in a
// macOS document's title bar (drags.ts); a browser window's drags its link.

import { fieldsOf, windowIdOf, type SidebarRow, type WindowFields } from "../model.ts";
import { stateStr, typeFor, viewFor } from "../windows/registry.ts";
import { showContextMenu } from "../context.ts";
import { ICON, Symbol } from "./Symbol.tsx";
import { useEffect, useRef, useState } from "react";
import { editTitle, useTitleEdit, useWindowStatus, type TitleEdit } from "../windowActions.ts";
import { DirtyDot, Mark, Slot } from "./Slot.tsx";
import { RemoteBadge } from "./Remote.tsx";
import { countRender } from "../perf.ts";
import { dragFiles, dragLink } from "../drags.ts";

/** SF Symbol for a window kind (from the core's window type registry). */
export const iconFor = (kind: string) => typeFor(kind)?.icon ?? "macwindow";

/** The file or folder a window shows, if any: what dragging its Mark drags. */
export function fileOf(row: SidebarRow): string | null {
  const p = row.pane ? row.pane.cwd : row.win ? stateStr(row.win, "path") : undefined;
  return p?.startsWith("/") ? p : null;
}

/** The web page a window shows, if any: dragging its Mark drags the link. */
const urlOf = (row: SidebarRow): string | null => {
  const u = row.win ? stateStr(row.win, "url") : undefined;
  return u && /^https?:/i.test(u) ? u : null;
};

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
  bare,
}: {
  row: SidebarRow;
  /** A sidebar's title bar: the name and status, no kind or place (docs/21-sidebars.md). */
  bare?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  title?: string;
}) {
  countRender("TileTitle");
  const f = useFields(row)!;
  // A status can be a button ("Updated 12s ago" refreshes); presses on it don't start a drag.
  const action = useWindowStatus(row.win?.id ?? null)?.action;
  const edit = useTitleEdit(row.win?.id ?? null);
  const menu = row.win && !bare ? viewFor(row.win.kind)?.titleMenu?.(row.win) : undefined;
  const file = fileOf(row);
  const url = file ? null : urlOf(row);
  return (
    <div className="tile-title" onPointerDown={onPointerDown} onContextMenu={onContextMenu} onDoubleClick={onDoubleClick} data-tip={title}>
      {file || url ? (
        <span
          className="mark-drag"
          draggable
          onPointerDown={(e) => e.stopPropagation()} // a file or link drag, not moving the window
          onDragStart={(e) => (file ? dragFiles(e, [file]) : dragLink(e, url!))}
        >
          <Mark light={f.light} icon={f.icon} />
        </span>
      ) : (
        <Mark light={f.light} icon={f.icon} />
      )}
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
        <Slot className="slot-kind" value={f.kind && !bare ? { text: f.kind } : undefined} />
        {/* A divider only after a field that's there. */}
        <Slot className="slot-place" value={f.place && !bare ? { text: f.place } : undefined} clipStart divider={!!f.kind && !bare} />
        <span
          className="tile-status"
          onPointerDown={action ? (e) => e.stopPropagation() : undefined}
          onClick={action ? (e) => (e.stopPropagation(), action.run()) : undefined}
        >
          <Slot className={`slot-status${action ? " actionable" : ""}`} value={f.status} divider={!bare && !!(f.kind || f.place)} title={action?.title} />
        </span>
      </span>
      {menu && (
        <button
          className="tile-menu"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => (e.stopPropagation(), void showContextMenu(menu.entries))}
        >
          {menu.label}
          <Symbol name="chevron.down" size={ICON.disclosure} />
        </button>
      )}
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
