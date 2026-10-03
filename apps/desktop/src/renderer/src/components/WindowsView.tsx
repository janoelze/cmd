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
//  - canvas: windows placed freely in world coordinates (../canvas.ts) under a
//    pan/zoom camera; drag to move, corner to resize, cards when zoomed out,
//    minimap. The camera is a transform on the track, so terminals keep their
//    size in cells whatever the zoom.
//
// Windows are never remounted or reordered in the DOM, so terminals keep
// running and pointer capture is never lost.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PaneId } from "@cmd/protocol";
import { canvasLayout, focusLayout, gridLayout, stripLayout, type Layout, type Rect, type ViewMode } from "../layouts.ts";
import { arrangeTiles, moveInOrder, windowIdOf, type SidebarRow } from "../model.ts";
import { viewFor } from "../windows/registry.ts";
import { terminals } from "../terminals.ts";
import { useStore } from "../store.ts";
import {
  arrange,
  bounds,
  DOT,
  frame as frameWith,
  lerpCamera,
  MIN_H,
  MIN_W,
  reveal as revealWith,
  sized,
  snap as snapToGrid,
  zoomAt as zoomAtWith,
  zoomLimits,
  type Camera,
} from "../canvas.ts";
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
import { iconFor, TileTitle } from "./TileTitle.tsx";
import { Symbol } from "./Symbol.tsx";

const GUTTER = 8;
const DRAG_THRESHOLD = 4;
const SNAP_DELAY = 140; // ms after the last wheel event (trackpad momentum included)
const SCROLL_ANIM_MS = 260;
const EDGE_SCROLL_ZONE = 56; // px from the pane edge where dragging auto-scrolls the strip
const EDGE_SCROLL_MAX = 18; // px per frame
const CAMERA_ANIM_MS = 280;
const CAMERA_SAVE_MS = 400; // persist the camera once panning/zooming pauses
const CARD_LINES = 14;

/** Canvas commands from the menu/palette (see requestCanvas). */
export type CanvasRequest = "fit" | "window";
const canvasRequests = new Set<(r: CanvasRequest) => void>();
/** Frame all windows ("fit") or the selected one at full size ("window"). */
export function requestCanvas(r: CanvasRequest): void {
  for (const fn of canvasRequests) fn(r);
}

/** A row that has a window: a terminal (pane) or a browser/file window (win). */
type Row = SidebarRow;

const idOf = (r: Row) => windowIdOf(r)!;
const createdOf = (r: Row) => r.pane?.createdAt ?? r.win?.createdAt ?? 0;

interface Props {
  mode: ViewMode;
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
  /** Canvas: window rects in world coordinates, and the camera. */
  canvasRects: Record<PaneId, Rect>;
  onCanvasRects: (rects: Record<PaneId, Rect>) => void;
  camera: Camera;
  onCamera: (cam: Camera) => void;
  /** Canvas: a click on the background selects nothing. */
  onDeselect: () => void;
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
  const [sizing, setSizing] = useState<{ id: PaneId; rect: Rect; axes: "x" | "y" | "xy" } | null>(null); // canvas edge/corner resize
  const [panning, setPanning] = useState(false);

  // ── layout ─────────────────────────────────────────────
  const settled = arrangeTiles(
    p.order,
    p.rows.map((r) => ({ id: idOf(r), createdAt: createdOf(r) })),
  ).map((x) => x.id);
  const ids = preview ?? settled;
  const pxWidths = ids.map((id) =>
    resizing?.id === id ? resizing.w : widthFor(p.widths[id] ?? DEFAULT_FRACTION, vp.w || 1000, GUTTER),
  );
  // Canvas: stored rects, new windows placed next to the last selected one.
  const lastPlaced = useRef<PaneId | null>(null);
  if (selected && p.canvasRects[selected]) lastPlaced.current = selected;
  const arranged = mode === "canvas" ? arrange(ids, p.canvasRects, lastPlaced.current) : null;
  if (arranged && sizing) arranged.rects.set(sizing.id, sizing.rect);
  const lay: Layout =
    mode === "grid"
      ? gridLayout(ids, vp, GUTTER)
      : mode === "strip"
        ? stripLayout(ids, pxWidths, vp, GUTTER)
        : arranged
          ? canvasLayout(arranged.rects)
          : focusLayout(ids, selected, vp);
  const stripSlots: Slot[] = ids.map((id) => ({ x: lay.rects.get(id)!.x, w: lay.rects.get(id)!.w }));

  // ── strip scrolling ────────────────────────────────────
  const [offset, setOffsetState] = useState(0);
  const offsetRef = useRef(0);
  const anim = useRef<number | null>(null);
  const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureStart = useRef<number | null>(null);

  // ── canvas camera ──────────────────────────────────────
  // Zoom range and card threshold come from the canvas.* settings.
  const cfg = useStore().settings.settings;
  const lim = zoomLimits(cfg);
  const limRef = useRef(lim);
  limRef.current = lim;
  const zoomAt = (c: Camera, f: number, sx: number, sy: number) => zoomAtWith(c, f, sx, sy, limRef.current);
  const frame = (r: Rect, vp: { w: number; h: number }, maxZoom: number) => frameWith(r, vp, maxZoom, limRef.current);
  const reveal = (c: Camera, r: Rect, vp: { w: number; h: number }) => revealWith(c, r, vp, limRef.current);
  // Local state while it moves (no store round trip per frame); persisted when it pauses.
  const [cam, setCamState] = useState<Camera>(p.camera);
  const camRef = useRef(cam);
  const camAnim = useRef<number | null>(null);
  const camSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCamera = useRef(p.onCamera);
  onCamera.current = p.onCamera;

  const setCam = useCallback((c: Camera) => {
    camRef.current = c;
    setCamState(c);
    if (camSave.current) clearTimeout(camSave.current);
    camSave.current = setTimeout(() => onCamera.current(camRef.current), CAMERA_SAVE_MS);
  }, []);
  const stopCam = () => {
    if (camAnim.current) cancelAnimationFrame(camAnim.current), (camAnim.current = null);
  };
  const animateCam = useCallback(
    (target: Camera) => {
      stopCam();
      const from = camRef.current;
      const { vp } = live.current;
      const start = performance.now();
      const frame = (now: number) => {
        const t = Math.min(1, (now - start) / CAMERA_ANIM_MS);
        setCam(t < 1 ? lerpCamera(from, target, easeOut(t), vp) : target);
        camAnim.current = t < 1 ? requestAnimationFrame(frame) : null;
      };
      camAnim.current = requestAnimationFrame(frame);
    },
    [setCam],
  );
  const cards = mode === "canvas" && cam.zoom < lim.cards;
  // Changed limits pull the camera back into range, around the viewport centre.
  useEffect(() => {
    const c = camRef.current;
    const z = Math.max(lim.min, Math.min(lim.max, c.zoom));
    if (z !== c.zoom) setCam(zoomAtWith(c, z / c.zoom, live.current.vp.w / 2, live.current.vp.h / 2, lim));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lim.min, lim.max]);

  // Latest values for event handlers registered once.
  const live = useRef({ lay, ids, settled, vp, selected, stripSlots, mode, preview, drag });
  live.current = { lay, ids, settled, vp, selected, stripSlots, mode, preview, drag };

  // Windows placed for the first time are stored, so they stay put.
  useEffect(() => {
    if (arranged?.changed) p.onCanvasRects({ ...p.canvasRects, ...Object.fromEntries(arranged.rects) });
  });
  const saveRect = (id: PaneId, r: Rect) => {
    const all = live.current.lay.rects;
    p.onCanvasRects({ ...p.canvasRects, ...Object.fromEntries(all), [id]: sized(r) });
  };

  // Selecting a window from outside the canvas (sidebar, keys, a new window)
  // pans to it; clicking one on the canvas doesn't move the camera.
  const clickedSelect = useRef(false);
  useEffect(() => {
    if (mode !== "canvas" || !selected || !vp.w) return;
    if (clickedSelect.current) return void (clickedSelect.current = false);
    const r = live.current.lay.rects.get(selected);
    if (!r) return;
    const target = reveal(camRef.current, r, vp);
    if (target !== camRef.current) animateCam(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selected, vp.w > 0]);

  // Menu/palette: frame everything, or the selected window at full size.
  const [request, setRequest] = useState<{ r: CanvasRequest } | null>(null);
  useEffect(() => {
    const fn = (r: CanvasRequest) => setRequest({ r });
    canvasRequests.add(fn);
    return () => void canvasRequests.delete(fn);
  }, []);
  useEffect(() => {
    if (!request || mode !== "canvas" || !vp.w) return;
    setRequest(null);
    if (request.r === "fit") fitAll();
    else if (selected && lay.rects.get(selected)) animateCam(frame(lay.rects.get(selected)!, vp, 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, mode, vp.w]);
  const fitAll = () => {
    const b = bounds([...live.current.lay.rects.values()]);
    if (b) animateCam(frame(b, live.current.vp, 1));
  };

  // Mode switches glide the track too (scroll offset ⇄ camera).
  const [switching, setSwitching] = useState(false);
  const prevMode = useRef(mode);
  useEffect(() => {
    if (prevMode.current === mode) return;
    prevMode.current = mode;
    setSwitching(true);
    const t = setTimeout(() => setSwitching(false), 260);
    return () => clearTimeout(t);
  }, [mode]);

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
      if (live.current.mode === "canvas") return canvasWheel(e);
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
    // Canvas: pinch (or ⌘-scroll) zooms at the pointer. Scrolling over the
    // selected, live window scrolls it; anywhere else it pans.
    const canvasWheel = (e: WheelEvent) => {
      const r = el.getBoundingClientRect();
      const c = camRef.current;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        stopCam();
        setCam(zoomAt(c, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX - r.left, e.clientY - r.top));
        return;
      }
      const target = e.target as Element;
      const tile = target.closest?.(".tile");
      if (tile && tile.getAttribute("data-pane") === live.current.selected && c.zoom >= limRef.current.cards && !target.closest(".tile-title"))
        return;
      e.preventDefault();
      e.stopPropagation();
      stopCam();
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      setCam({ ...c, x: c.x + dx / c.zoom, y: c.y + dy / c.zoom });
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [setOffset, snap, setCam]);

  useEffect(
    () => () => {
      if (anim.current) cancelAnimationFrame(anim.current);
      if (snapTimer.current) clearTimeout(snapTimer.current);
      if (camAnim.current) cancelAnimationFrame(camAnim.current);
      if (camSave.current) clearTimeout(camSave.current), onCamera.current(camRef.current);
    },
    [],
  );

  // Canvas: drag the background (or anything, with the middle button) to pan;
  // click it to deselect; double-click it to frame everything.
  const onBackground = (e: React.SyntheticEvent) =>
    e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("windows-track");
  const startPan = (e: React.PointerEvent) => {
    if (mode !== "canvas" || !(e.button === 1 || (e.button === 0 && onBackground(e)))) return;
    e.preventDefault();
    hold();
    stopCam();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const start = camRef.current;
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return;
      if (!moved) setPanning(true);
      moved = true;
      setCam({ ...start, x: start.x - (ev.clientX - sx) / start.zoom, y: start.y - (ev.clientY - sy) / start.zoom });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setPanning(false);
      if (!moved && ev.type === "pointerup" && e.button === 0) p.onDeselect();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // Pages in browser windows (<webview>) swallow pointer events, so a gesture that
  // crosses one would stop dead. Turn them off the moment a press starts, before
  // the first move, until the button is released.
  const hold = () => {
    const root = rootRef.current;
    if (!root) return;
    root.classList.add("held");
    const off = () => {
      root.classList.remove("held");
      window.removeEventListener("pointerup", off, true);
      window.removeEventListener("pointercancel", off, true);
    };
    window.addEventListener("pointerup", off, true);
    window.addEventListener("pointercancel", off, true);
  };

  // A click inside a browser page reaches neither onMouseDown nor a focus event
  // here: the app's window just blurs while the <webview> becomes the active
  // element. Select the window it belongs to.
  useEffect(() => {
    const onBlur = () =>
      requestAnimationFrame(() => {
        const a = document.activeElement;
        const id = a?.tagName === "WEBVIEW" ? (a.closest(".tile") as HTMLElement | null)?.dataset.pane : undefined;
        if (!id || id === live.current.selected) return;
        if (live.current.mode === "canvas") clickedSelect.current = true;
        onSelect(id);
      });
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [onSelect]);

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
  // Canvas: pans in both directions the same way.
  useEffect(() => {
    if (!drag || (mode !== "strip" && mode !== "canvas")) return;
    const edge = (near: number, far: number) =>
      near < EDGE_SCROLL_ZONE
        ? -EDGE_SCROLL_MAX * (1 - Math.max(0, near) / EDGE_SCROLL_ZONE)
        : far < EDGE_SCROLL_ZONE
          ? EDGE_SCROLL_MAX * (1 - Math.max(0, far) / EDGE_SCROLL_ZONE)
          : 0;
    let raf = 0;
    const tick = () => {
      const d = live.current.drag;
      const root = rootRef.current;
      if (d && root) {
        const r = root.getBoundingClientRect();
        const vx = edge(d.x - r.left, r.right - d.x);
        if (mode === "strip" && vx) setOffset(offsetRef.current + vx);
        const vy = edge(d.y - r.top, r.bottom - d.y);
        const c = camRef.current;
        if (mode === "canvas" && (vx || vy)) setCam({ ...c, x: c.x + vx / c.zoom, y: c.y + vy / c.zoom });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [drag !== null, mode, setOffset, setCam]); // eslint-disable-line react-hooks/exhaustive-deps

  const startDrag = (e: React.PointerEvent, id: PaneId) => {
    if (e.button !== 0 || !live.current.lay.chrome) return;
    hold();
    const tile = (e.currentTarget as HTMLElement).closest(".tile") as HTMLElement | null;
    if (!tile) return;
    const t = tile.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const grabX = e.clientX - t.left;
    const grabY = e.clientY - t.top;
    const free = live.current.mode === "canvas";
    let started = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return;
        started = true;
        if (anim.current) cancelAnimationFrame(anim.current), (anim.current = null);
        stopCam();
        if (!free) setPreview(live.current.settled);
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
      const rect = live.current.lay.rects.get(id);
      const root = rootRef.current;
      if (free && commit && rect && root) {
        // Where the window was dropped, in world coordinates (grab offsets are on screen).
        const r = root.getBoundingClientRect();
        const c = camRef.current;
        saveRect(id, { ...rect, x: c.x + (ev.clientX - grabX - r.left) / c.zoom, y: c.y + (ev.clientY - grabY - r.top) / c.zoom });
      }
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
    hold();
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

  // ── resizing (canvas): bottom-right corner, both axes ──
  const startSizing = (e: React.PointerEvent, id: PaneId, start: Rect, axes: "x" | "y" | "xy") => {
    if (e.button !== 0) return;
    e.preventDefault();
    hold();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    const z = camRef.current.zoom;
    let rect = start;
    const move = (ev: PointerEvent) => {
      rect = {
        ...start,
        w: axes === "y" ? start.w : Math.max(MIN_W, snapToGrid(start.w + (ev.clientX - sx) / z)),
        h: axes === "x" ? start.h : Math.max(MIN_H, snapToGrid(start.h + (ev.clientY - sy) / z)),
      };
      setSizing({ id, rect, axes });
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      saveRect(id, rect);
      setSizing(null);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  // ── render ─────────────────────────────────────────────
  const rootRect = rootRef.current?.getBoundingClientRect();
  // Stable DOM order (creation), whatever the visual order.
  const stable = [...p.rows].sort((a, b) => createdOf(a) - createdOf(b));
  const canvas = mode === "canvas";
  // Canvas: where the dragged window will land (snapped to the dots).
  const dropAt =
    canvas && drag && rootRect && lay.rects.get(drag.id)
      ? sized({
          ...lay.rects.get(drag.id)!,
          x: cam.x + (drag.x - drag.grabX - rootRect.left) / cam.zoom,
          y: cam.y + (drag.y - drag.grabY - rootRect.top) / cam.zoom,
        })
      : undefined;
  const target = drag ? (canvas ? dropAt : lay.rects.get(drag.id)) : undefined;
  const z = cam.zoom;
  // Canvas background: a dot grid drawn in the track, in world px, so it shares the
  // windows' transform exactly. Drawn on screen instead, its tiles (DOT × zoom, a
  // fraction of a pixel) get rounded and drift off the window edges with distance.
  // It covers just the visible area, aligned to the grid; zoomed far out, every
  // fourth dot. Dots stay about 1px on screen whatever the zoom.
  let dotGrid: React.CSSProperties | undefined;
  if (canvas && vp.w) {
    const step = z < 0.35 ? DOT * 4 : DOT;
    const left = Math.floor(cam.x / step) * step - step;
    const top = Math.floor(cam.y / step) * step - step;
    const r = 1.1 / z;
    dotGrid = {
      left,
      top,
      width: Math.ceil((cam.x + vp.w / z - left) / step) * step + step,
      height: Math.ceil((cam.y + vp.h / z - top) / step) * step + step,
      // Each dot sits in the middle of its tile; shift by half a tile onto the grid line.
      backgroundImage: `radial-gradient(circle, rgb(255 255 255 / 0.1) ${r}px, transparent ${r + 0.6 / z}px)`,
      backgroundSize: `${step}px ${step}px`,
      backgroundPosition: `${-step / 2}px ${-step / 2}px`,
    };
  }

  return (
    <main
      ref={rootRef}
      className={`main windows mode-${mode} ${drag ? "dragging" : ""} ${resizing ? "resizing" : ""} ${sizing ? `sizing sizing-${sizing.axes}` : ""} ${panning ? "panning" : ""} ${switching ? "switching" : ""} ${cards ? "cards" : ""}`}
      onPointerDown={startPan}
      onDoubleClick={(e) => canvas && onBackground(e) && fitAll()}
    >
      <div
        className="windows-track"
        style={
          canvas
            ? ({ transform: `translate(${-cam.x * z}px, ${-cam.y * z}px) scale(${z})`, "--z": z } as React.CSSProperties)
            : { transform: `translateX(${-offset}px)` }
        }
      >
        {dotGrid && <div className="canvas-dots" style={dotGrid} />}
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
          let x = rect.x;
          let y = rect.y;
          if (lifted && rootRect && canvas) {
            x = cam.x + (drag.x - drag.grabX - rootRect.left) / z;
            y = cam.y + (drag.y - drag.grabY - rootRect.top) / z;
          } else if (lifted && rootRect) {
            x = drag.x - drag.grabX - rootRect.left + offset;
            y = drag.y - drag.grabY - rootRect.top;
          }
          const title = (
            <TileTitle
              row={r}
              onPointerDown={(e) => startDrag(e, id)}
              onDoubleClick={() => canvas && animateCam(frame(rect, vp, 1))}
              onContextMenu={(e) => {
                e.preventDefault();
                onSelect(id);
                p.onTitleMenu?.(r);
              }}
              title={canvas ? "Drag to move · double-click to zoom to this window" : "Drag to move"}
            />
          );
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
              onMouseDown={() => {
                if (canvas && id !== selected) clickedSelect.current = true;
                onSelect(id);
              }}
              // Focus moving into a window (e.g. by Tab) selects it too.
              onFocusCapture={() => {
                if (id === live.current.selected) return;
                if (canvas) clickedSelect.current = true;
                onSelect(id);
              }}
            >
              {/* The body clips the content; resize handles sit outside it, in the
                  gutter, so they never cover a scrollbar or the content's edge. */}
              <div className="tile-body">
                {/* Cards keep their title bar readable: it's drawn at screen size. */}
                {lay.chrome && (cards ? <div className="card-title" style={{ zoom: 1 / z }}>{title}</div> : title)}
                {cards ? (
                  <Card row={r} zoom={z} />
                ) : r.pane ? (
                  <TerminalView paneId={id} focused={id === selected} onMenu={p.onTerminalMenu} />
                ) : r.win ? (
                  <WindowContent win={r.win} focused={id === selected} />
                ) : null}
              </div>
              {lay.resizable && (
                <div
                  className="strip-resize"
                  title="Drag to resize · double-click to cycle widths"
                  onPointerDown={(e) => startResize(e, id, rect.w)}
                  onDoubleClick={() => p.onWidth(id, nextPreset(p.widths[id] ?? DEFAULT_FRACTION))}
                />
              )}
              {canvas &&
                (["x", "y", "xy"] as const).map((axes) => (
                  <div
                    key={axes}
                    className={`canvas-resize resize-${axes}`}
                    onPointerDown={(e) => startSizing(e, id, rect, axes)}
                  />
                ))}
            </div>
          );
        })}
      </div>
      {mode === "strip" && (
        <StripBar slots={stripSlots} total={lay.contentWidth} ids={ids} selected={selected} onSelect={onSelect} />
      )}
      {canvas && vp.w > 0 && (
        <Minimap
          rects={lay.rects}
          cam={cam}
          vp={vp}
          selected={selected}
          onCenter={(x, y) => (stopCam(), setCam({ ...camRef.current, x: x - vp.w / 2 / z, y: y - vp.h / 2 / z }))}
        />
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

/** A window drawn as a card when the canvas is zoomed out: no live renderer. */
function Card({ row, zoom }: { row: Row; zoom: number }) {
  const [, refresh] = useState(0);
  const paneId = row.pane?.id;
  useEffect(() => {
    if (!paneId) return;
    const t = setInterval(() => refresh((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [paneId]);
  if (paneId) return <pre className="canvas-card lines">{terminals.tail(paneId, CARD_LINES).join("\n")}</pre>;
  const win = row.win!;
  return (
    <div className="canvas-card info">
      <Symbol name={iconFor(win.kind)} size={Math.round(28 / zoom)} />
      <div className="canvas-card-detail">{viewFor(win.kind)?.detail?.(win) ?? win.title}</div>
    </div>
  );
}

/** Canvas overview: every window, the visible area; click or drag to move there. */
function Minimap(p: {
  rects: Map<string, Rect>;
  cam: Camera;
  vp: { w: number; h: number };
  selected: PaneId | null;
  onCenter: (x: number, y: number) => void;
}) {
  const W = 168;
  const H = 108;
  const view = { x: p.cam.x, y: p.cam.y, w: p.vp.w / p.cam.zoom, h: p.vp.h / p.cam.zoom };
  const b = bounds([...p.rects.values(), view])!;
  const s = Math.min(W / b.w, H / b.h);
  const ox = (W - b.w * s) / 2 - b.x * s;
  const oy = (H - b.h * s) / 2 - b.y * s;
  const box = (r: Rect) => ({ x: ox + r.x * s, y: oy + r.y * s, width: Math.max(1, r.w * s), height: Math.max(1, r.h * s) });
  // The scale is fixed for the whole gesture, so the map doesn't shift under the pointer.
  const go = (e: React.PointerEvent, el: Element, scale = { s, ox, oy }) => {
    const r = el.getBoundingClientRect();
    p.onCenter((e.clientX - r.left - scale.ox) / scale.s, (e.clientY - r.top - scale.oy) / scale.s);
  };
  return (
    <svg
      className="minimap"
      width={W}
      height={H}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const scale = { s, ox, oy };
        go(e, el, scale);
        const move = (ev: PointerEvent) => go(ev as unknown as React.PointerEvent, el, scale);
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {[...p.rects].map(([id, r]) => (
        <rect key={id} className={id === p.selected ? "sel" : ""} {...box(r)} />
      ))}
      <rect className="view" {...box(view)} />
    </svg>
  );
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
