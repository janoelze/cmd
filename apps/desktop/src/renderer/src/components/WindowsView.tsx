// All windows of the main pane (terminals, browsers, file browsers), for every view mode. A layout
// (../layouts.ts) says where each window goes; this component renders them as
// absolutely positioned windows in a stable DOM order and owns the behaviour
// shared by all modes:
//
//  - moves animate with a CSS transition on transform (mode switches too),
//  - drag a window by its title bar: it follows the pointer, the others make
//    room live (insert-style), ghost outlines show where it can go,
//  - strip: horizontal scrolling with snapping, reveal-on-select, resize by the
//    right edge, auto-scroll while dragging near an edge, position bar.
//
// Windows are never remounted or reordered in the DOM, so terminals keep
// running and pointer capture is never lost.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PaneId } from "@cmd/protocol";
import { focusLayout, gridLayout, stripLayout, type Layout, type ViewMode } from "../layouts.ts";
import { arrangeTiles, moveInOrder, windowIdOf, type SidebarRow } from "../model.ts";
import { viewFor } from "../windows/registry.ts";
import {
  clampWidth,
  DEFAULT_FRACTION,
  fractionFor,
  fullyVisible,
  landedOn,
  maxOffset,
  nextPreset,
  revealOffset,
  snapPoints,
  snapTarget,
  widthFor,
  type Slot,
} from "../strip.ts";
import { TerminalView } from "./TerminalView.tsx";
import { TileTitle } from "./TileTitle.tsx";

const GUTTER = 8;
const DRAG_THRESHOLD = 4;
const SNAP_DELAY = 140; // ms after the last wheel event (trackpad momentum included)
const SCROLL_ANIM_MS = 260;
const EDGE_SCROLL_ZONE = 56; // px from the pane edge where dragging auto-scrolls the strip
const EDGE_SCROLL_MAX = 18; // px per frame

/** A row that has a window: a terminal (pane) or a browser/file window (win). */
type Row = SidebarRow;

const idOf = (r: Row) => windowIdOf(r)!;
const createdOf = (r: Row) => r.pane?.createdAt ?? r.win?.createdAt ?? 0;

interface Props {
  mode: Exclude<ViewMode, "canvas">;
  rows: Row[];
  order: PaneId[];
  onReorder: (order: PaneId[]) => void;
  widths: Record<PaneId, number>;
  onWidth: (id: PaneId, fraction: number) => void;
  selected: PaneId | null;
  onSelect: (paneId: PaneId) => void;
  onTerminalMenu: (paneId: PaneId) => void;
  /** Right-click on a window's title bar. */
  onTitleMenu?: (row: SidebarRow) => void;
}

interface Drag {
  id: PaneId;
  /** Pointer in viewport (client) coordinates. */
  x: number;
  y: number;
  /** Pointer offset inside the window when the drag started. */
  grabX: number;
  grabY: number;
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export function WindowsView(p: Props) {
  const { mode, selected, onSelect } = p;
  const rootRef = useRef<HTMLElement>(null);
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const [preview, setPreview] = useState<PaneId[] | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [resizing, setResizing] = useState<{ id: PaneId; w: number } | null>(null);

  // ── layout ─────────────────────────────────────────────
  const settled = arrangeTiles(
    p.order,
    p.rows.map((r) => ({ id: idOf(r), createdAt: createdOf(r) })),
  ).map((x) => x.id);
  const ids = preview ?? settled;
  const pxWidths = ids.map((id) =>
    resizing?.id === id ? resizing.w : widthFor(p.widths[id] ?? DEFAULT_FRACTION, vp.w || 1000, GUTTER),
  );
  const lay: Layout =
    mode === "grid"
      ? gridLayout(ids, vp, GUTTER)
      : mode === "strip"
        ? stripLayout(ids, pxWidths, vp, GUTTER)
        : focusLayout(ids, selected, vp);
  const stripSlots: Slot[] = ids.map((id) => ({ x: lay.rects.get(id)!.x, w: lay.rects.get(id)!.w }));

  // ── strip scrolling ────────────────────────────────────
  const [offset, setOffsetState] = useState(0);
  const offsetRef = useRef(0);
  const anim = useRef<number | null>(null);
  const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureStart = useRef<number | null>(null);

  // Latest values for event handlers registered once.
  const live = useRef({ lay, ids, settled, vp, selected, stripSlots, mode, preview, drag });
  live.current = { lay, ids, settled, vp, selected, stripSlots, mode, preview, drag };

  const setOffset = useCallback((o: number) => {
    const { lay, vp, mode } = live.current;
    const max = mode === "strip" ? maxOffset(lay.contentWidth, vp.w) : 0;
    const v = Math.max(0, Math.min(max, o));
    offsetRef.current = v;
    setOffsetState(v);
  }, []);

  const animateTo = useCallback(
    (target: number) => {
      if (anim.current) cancelAnimationFrame(anim.current);
      const from = offsetRef.current;
      if (Math.abs(target - from) < 0.5) return setOffset(target);
      const start = performance.now();
      const frame = (now: number) => {
        const t = Math.min(1, (now - start) / SCROLL_ANIM_MS);
        setOffset(from + (target - from) * easeOut(t));
        anim.current = t < 1 ? requestAnimationFrame(frame) : null;
      };
      anim.current = requestAnimationFrame(frame);
    },
    [setOffset],
  );

  useLayoutEffect(() => {
    const el = rootRef.current!;
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setVp({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Keep the offset valid (other modes don't scroll; the strip may have shrunk).
  const maxOff = mode === "strip" ? maxOffset(lay.contentWidth, vp.w) : 0;
  useEffect(() => {
    if (offsetRef.current > maxOff) setOffset(maxOff);
  }, [maxOff, setOffset]);

  // Strip: selecting a window scrolls just enough to show it.
  const selIdx = ids.indexOf(selected ?? "");
  const selSlot = selIdx >= 0 ? stripSlots[selIdx] : undefined;
  useEffect(() => {
    if (mode !== "strip" || !selSlot || !vp.w || gestureStart.current !== null || drag) return;
    const target = revealOffset(offsetRef.current, selSlot, vp.w, GUTTER, lay.contentWidth);
    if (Math.abs(target - offsetRef.current) > 0.5) animateTo(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selected, selSlot?.x, selSlot?.w, vp.w, lay.contentWidth]);

  // Strip: settle on a window edge when free scrolling stops; focus follows.
  const snap = useCallback(() => {
    const { lay, vp, stripSlots, ids, selected } = live.current;
    const startedAt = gestureStart.current ?? offsetRef.current;
    gestureStart.current = null;
    const moved = offsetRef.current - startedAt;
    const dir: -1 | 0 | 1 = Math.abs(moved) < 30 ? 0 : moved > 0 ? 1 : -1;
    const target = snapTarget(offsetRef.current, snapPoints(stripSlots, vp.w, GUTTER, lay.contentWidth), dir);
    animateTo(target);
    const sel = ids.indexOf(selected ?? "");
    if (sel >= 0 && fullyVisible(stripSlots[sel]!, target, vp.w)) return;
    const landed = ids[landedOn(stripSlots, target, vp.w, GUTTER, dir)];
    if (landed) onSelect(landed);
  }, [animateTo, onSelect]);

  // Strip: horizontal wheel/trackpad (capture phase: terminals never see sideways
  // scrolling; vertical scrolling passes through to their scrollback).
  useEffect(() => {
    const el = rootRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (live.current.mode !== "strip") return;
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      if (!dx || (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX))) return;
      e.preventDefault();
      e.stopPropagation();
      if (anim.current) cancelAnimationFrame(anim.current), (anim.current = null);
      if (gestureStart.current === null) gestureStart.current = offsetRef.current;
      setOffset(offsetRef.current + dx);
      if (snapTimer.current) clearTimeout(snapTimer.current);
      snapTimer.current = setTimeout(snap, SNAP_DELAY);
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [setOffset, snap]);

  useEffect(
    () => () => {
      if (anim.current) cancelAnimationFrame(anim.current);
      if (snapTimer.current) clearTimeout(snapTimer.current);
    },
    [],
  );

  // ── dragging windows (all modes with chrome) ───────────
  /** Re-evaluate where the dragged window would go, from the current pointer. */
  const updateDrop = useCallback(() => {
    const { drag, lay, preview, settled } = live.current;
    const root = rootRef.current;
    if (!drag || !root) return;
    const r = root.getBoundingClientRect();
    const idx = lay.dropIndex(drag.x - r.left + offsetRef.current, drag.y - r.top);
    const current = preview ?? settled;
    if (idx >= 0 && current.indexOf(drag.id) !== idx) setPreview(moveInOrder(current, drag.id, idx));
  }, []);
  useEffect(() => updateDrop(), [drag?.x, drag?.y, offset, updateDrop]);

  // Strip: auto-scroll while dragging near the left/right edge.
  useEffect(() => {
    if (!drag || mode !== "strip") return;
    let raf = 0;
    const tick = () => {
      const d = live.current.drag;
      const root = rootRef.current;
      if (d && root) {
        const r = root.getBoundingClientRect();
        const fromLeft = d.x - r.left;
        const fromRight = r.right - d.x;
        let v = 0;
        if (fromLeft < EDGE_SCROLL_ZONE) v = -EDGE_SCROLL_MAX * (1 - Math.max(0, fromLeft) / EDGE_SCROLL_ZONE);
        else if (fromRight < EDGE_SCROLL_ZONE) v = EDGE_SCROLL_MAX * (1 - Math.max(0, fromRight) / EDGE_SCROLL_ZONE);
        if (v) setOffset(offsetRef.current + v);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [drag !== null, mode, setOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  const startDrag = (e: React.PointerEvent, id: PaneId) => {
    if (e.button !== 0 || !live.current.lay.chrome) return;
    const tile = (e.currentTarget as HTMLElement).closest(".tile") as HTMLElement | null;
    if (!tile) return;
    const t = tile.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const grabX = e.clientX - t.left;
    const grabY = e.clientY - t.top;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return;
        started = true;
        if (anim.current) cancelAnimationFrame(anim.current), (anim.current = null);
        setPreview(live.current.settled);
      }
      setDrag({ id, x: ev.clientX, y: ev.clientY, grabX, grabY });
    };
    const end = (ev: PointerEvent, commit: boolean) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      if (!started) return;
      const final = live.current.preview;
      if (commit && final) p.onReorder(final);
      setDrag(null);
      setPreview(null);
    };
    const up = (ev: PointerEvent) => end(ev, true);
    const cancel = (ev: PointerEvent) => end(ev, false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  // ── resizing (strip) ───────────────────────────────────
  const startResize = (e: React.PointerEvent, id: PaneId, startW: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = clampWidth(startW + ev.clientX - startX, live.current.vp.w, GUTTER);
      setResizing({ id, w });
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setResizing(null);
      p.onWidth(id, fractionFor(w, live.current.vp.w, GUTTER));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  // ── render ─────────────────────────────────────────────
  const rootRect = rootRef.current?.getBoundingClientRect();
  // Stable DOM order (creation), whatever the visual order.
  const stable = [...p.rows].sort((a, b) => createdOf(a) - createdOf(b));
  const target = drag ? lay.rects.get(drag.id) : undefined;

  return (
    <main
      ref={rootRef}
      className={`main windows mode-${mode} ${drag ? "dragging" : ""} ${resizing ? "resizing" : ""}`}
    >
      <div className="windows-track" style={{ transform: `translateX(${-offset}px)` }}>
        {/* Slots: unassigned cells always show as inactive placeholders; while
            dragging, every slot shows as a ghost outline. */}
        {lay.slots.map((s, i) =>
          drag || i >= ids.length ? (
            <div
              key={`slot-${i}`}
              className={`ghost-slot ${i >= ids.length ? "spare" : ""} ${drag ? "" : "idle"}`}
              style={{ transform: `translate(${s.x}px, ${s.y}px)`, width: s.w, height: s.h }}
            />
          ) : null,
        )}
        {target && (
          <div
            className="ghost-slot target"
            style={{ transform: `translate(${target.x}px, ${target.y}px)`, width: target.w, height: target.h }}
          />
        )}
        {stable.map((r) => {
          const id = idOf(r);
          const rect = lay.rects.get(id);
          if (!rect) return null;
          const lifted = drag?.id === id;
          const x = lifted && rootRect ? drag.x - drag.grabX - rootRect.left + offset : rect.x;
          const y = lifted && rootRect ? drag.y - drag.grabY - rootRect.top : rect.y;
          return (
            <div
              key={id}
              data-pane={id}
              className={`tile kind-${r.win?.kind ?? "terminal"} ${id === selected ? "sel" : ""} ${lifted ? "lifted" : ""} ${lay.hidden.has(id) ? "hidden-tile" : ""}`}
              style={{
                transform: `translate(${x}px, ${y}px)${lifted ? " scale(1.015)" : ""}`,
                width: rect.w,
                height: rect.h,
              }}
              onMouseDown={() => onSelect(id)}
            >
              {lay.chrome && (
                <TileTitle
                  row={r}
                  onPointerDown={(e) => startDrag(e, id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onSelect(id);
                    p.onTitleMenu?.(r);
                  }}
                  title="Drag to move"
                />
              )}
              {r.pane ? (
                <TerminalView paneId={id} focused={id === selected} onMenu={p.onTerminalMenu} />
              ) : r.win ? (
                <WindowContent win={r.win} focused={id === selected} />
              ) : null}
              {lay.resizable && (
                <div
                  className="strip-resize"
                  title="Drag to resize · double-click to cycle widths"
                  onPointerDown={(e) => startResize(e, id, rect.w)}
                  onDoubleClick={() => p.onWidth(id, nextPreset(p.widths[id] ?? DEFAULT_FRACTION))}
                />
              )}
            </div>
          );
        })}
      </div>
      {mode === "strip" && (
        <StripBar slots={stripSlots} total={lay.contentWidth} ids={ids} selected={selected} onSelect={onSelect} />
      )}
    </main>
  );
}

/** A window's content from its registered view (see windows/registry.ts). */
function WindowContent({ win, focused }: { win: import("@cmd/protocol").AppWindow; focused: boolean }) {
  const view = viewFor(win.kind);
  if (!view) return <div className="file-error">No view registered for “{win.kind}” windows.</div>;
  return <view.View win={win} focused={focused} />;
}

/** Strip position bar: one segment per window, the focused one highlighted. Click to jump. */
function StripBar(p: { slots: Slot[]; total: number; ids: PaneId[]; selected: PaneId | null; onSelect: (id: PaneId) => void }) {
  // The bar is inset by the gutter like the windows; map the windows' span
  // (first left edge → last right edge) onto it so both ends line up.
  const inner = p.total - 2 * GUTTER;
  if (inner <= 0) return null;
  const pct = (v: number) => `${(v / inner) * 100}%`;
  return (
    <div className="strip-scrollbar" aria-hidden>
      {p.slots.map((s, i) => (
        <button
          key={p.ids[i]}
          className={`strip-seg ${p.ids[i] === p.selected ? "sel" : ""}`}
          style={{ left: pct(s.x - GUTTER), width: pct(s.w) }}
          onClick={() => p.onSelect(p.ids[i]!)}
          tabIndex={-1}
        />
      ))}
    </div>
  );
}
