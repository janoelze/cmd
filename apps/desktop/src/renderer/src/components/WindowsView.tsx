// All windows of the main pane (terminals, browsers, file browsers), for every view mode. A layout
// (../layouts.ts) says where each window goes; this component renders them as
// absolutely positioned windows in a stable DOM order and owns the behaviour
// shared by all modes:
//
//  - moves animate with a CSS transition on transform (mode switches too),
//  - drag a window by its title bar: it follows the pointer, the others make
//    room live (insert-style), ghost outlines show where it can go,
//  - strip: free horizontal scrolling, reveal-on-select, resize by the right
//    edge, auto-scroll while dragging near an edge, pagination dots. The strip is a
//    native scroller (.windows-scroller), not a transform: Chromium scrolls it
//    on the compositor, with macOS momentum and the bounce at the ends, and
//    hands it the sideways scroll that embedded pages (their own process) and
//    other content don't use.
//  - canvas: windows placed freely in world coordinates (../canvas.ts) under a
//    pan/zoom camera; drag to move, edges/corner to resize, minimap. Windows stay
//    live at every zoom; the zoom range is capped by settings. The camera is a transform on the track, so terminals keep their
//    size in cells whatever the zoom.
//
// Windows are never remounted or reordered in the DOM, so terminals keep
// running and pointer capture is never lost.

import { EmptyState, PageDots } from "@cmd/ui";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { PaneId } from "@cmd/protocol";
import { canvasLayout, focusLayout, gridLayout, stripLayout, type Layout, type Rect, type Spacing, type ViewMode } from "../layouts.ts";
import { arrangeTiles, moveInOrder, needsYou, windowIdOf, type SidebarRow } from "../model.ts";
import { viewFor } from "../windows/registry.ts";
import { useStoreValue } from "../store.ts";
import {
  arrange,
  bounds,
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
  maxOffset,
  nextPreset,
  revealOffset,
  widthFor,
  type Slot,
} from "../strip.ts";
import { TerminalView } from "./TerminalView.tsx";
import { TileTitle } from "./TileTitle.tsx";
import { SlotMotion } from "./Slot.tsx";
import { countRender } from "../perf.ts";

const DRAG_THRESHOLD = 4;
const SCROLL_ANIM_MS = 260;
const EDGE_SCROLL_ZONE = 56; // px from the pane edge where dragging auto-scrolls the strip
const EDGE_SCROLL_MAX = 18; // px per frame
const OFFSET_SYNC_MS = 100; // the strip's scroll position reaches React this long after it rests
const CAMERA_ANIM_MS = 280;
const CAMERA_SAVE_MS = 400; // persist the camera once panning/zooming pauses
const MOTION_MIN_ZOOM = 0.5; // zoomed out further, title bars change without animating
const SETTLE_MS = 110; // a dropped window's glide into place (see .tile.settling)
const LIVE_RESIZE_MS = 150; // viewport changes this close together are a live resize (no gliding)

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
  countRender("WindowsView");
  const { mode, selected, onSelect } = p;
  const rootRef = useRef<HTMLElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const [preview, setPreview] = useState<PaneId[] | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [resizing, setResizing] = useState<{ id: PaneId; w: number } | null>(null);
  const [sizing, setSizing] = useState<{ id: PaneId; rect: Rect; axes: "x" | "y" | "xy" } | null>(null); // canvas edge/corner resize
  // Space around (ui.paddingX/Y) and between (ui.gutter) windows in grid and strip;
  // the canvas uses its dot grid.
  const padX = useStoreValue((s) => s.settings.settings["ui.paddingX"]);
  const padY = useStoreValue((s) => s.settings.settings["ui.paddingY"]);
  const gap = useStoreValue((s) => s.settings.settings["ui.gutter"]);
  const attention = useStoreValue((s) => s.settings.settings["ui.attentionOutline"]);
  const spacing: Spacing = { x: padX, y: padY, gap };
  const padRef = useRef(padX);
  padRef.current = padX;
  const [panning, setPanning] = useState(false);
  const [liveResize, setLiveResize] = useState(false);
  // Until the viewport is measured and holds still, windows take their places
  // without gliding (else at boot they glide out from a zero-size layout).
  const [entering, setEntering] = useState(true);
  // The window just dropped, while it glides into place (faster than other moves).
  const [settling, setSettling] = useState<PaneId | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── layout ─────────────────────────────────────────────
  const settled = arrangeTiles(
    p.order,
    p.rows.map((r) => ({ id: idOf(r), createdAt: createdOf(r) })),
  ).map((x) => x.id);
  const ids = preview ?? settled;
  // The workspace's own selection: a selected sidebar (docs/21-sidebars.md) leaves focus mode on the window it showed.
  const shownRef = useRef<PaneId | null>(null);
  if (selected && ids.includes(selected)) shownRef.current = selected;
  const pxWidths = ids.map((id) =>
    resizing?.id === id ? resizing.w : widthFor(p.widths[id] ?? DEFAULT_FRACTION, vp.w || 1000, padX),
  );
  // Canvas: stored rects, new windows placed next to the last selected one.
  const lastPlaced = useRef<PaneId | null>(null);
  if (selected && p.canvasRects[selected]) lastPlaced.current = selected;
  const arranged = mode === "canvas" ? arrange(ids, p.canvasRects, lastPlaced.current) : null;
  if (arranged && sizing) arranged.rects.set(sizing.id, sizing.rect);
  const lay: Layout =
    mode === "grid"
      ? gridLayout(ids, vp, spacing)
      : mode === "strip"
        ? stripLayout(ids, pxWidths, vp, spacing)
        : arranged
          ? canvasLayout(arranged.rects)
          : focusLayout(ids, shownRef.current, vp);
  const stripSlots: Slot[] = ids.map((id) => ({ x: lay.rects.get(id)!.x, w: lay.rects.get(id)!.w }));
  // The DOM keeps a stable order; the dots go in the strip's.
  const stripDots = ids.map((id, i) => ({ id, slot: stripSlots[i]! })).sort((a, b) => a.slot.x - b.slot.x);

  // ── strip scrolling ────────────────────────────────────
  // The scroller's scrollLeft is the truth; offsetRef follows it at once, the
  // state (title motion, the drop position) once it rests, every frame while
  // dragging. Re-rendering every window per scroll frame is what stutters.
  const [offset, setOffsetState] = useState(0);
  const offsetRef = useRef(0);
  const anim = useRef<number | null>(null);
  // Where the strip was scrolled when it was left, to come back to exactly there.
  const stripOffset = useRef(0);
  // …and which window was selected then: the same one isn't revealed again on return.
  const stripSelected = useRef<string | null>(null);
  const skipReveal = useRef(false);
  // Returning to the strip: the track glides to that offset as a transform, then hands it to the scroller.
  const [gliding, setGliding] = useState(false);
  const glidingRef = useRef(false);

  // ── canvas camera ──────────────────────────────────────
  // The zoom range comes from the canvas.* settings.
  const cfg = useStoreValue((s) => s.settings.settings);
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
  // Changed limits pull the camera back into range, around the viewport centre.
  useEffect(() => {
    const c = camRef.current;
    const z = Math.max(lim.min, Math.min(lim.max, c.zoom));
    if (z !== c.zoom) setCam(zoomAtWith(c, z / c.zoom, live.current.vp.w / 2, live.current.vp.h / 2, lim));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lim.min, lim.max]);

  // Latest values for event handlers registered once.
  const live = useRef({ lay, ids, settled, vp, selected, mode, preview, drag });
  live.current = { lay, ids, settled, vp, selected, mode, preview, drag };

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

  /** Scroll the strip (other modes: glide the track back to 0 after a switch). */
  const setOffset = useCallback((o: number) => {
    const { lay, vp, mode } = live.current;
    const max = mode === "strip" ? maxOffset(lay.contentWidth, vp.w) : 0;
    const v = Math.max(0, Math.min(max, o));
    // Kept unrounded: scrollLeft snaps to device pixels and would eat small trackpad deltas.
    offsetRef.current = v;
    if (mode === "strip" && !glidingRef.current) scrollerRef.current!.scrollLeft = v;
    else setOffsetState(v);
  }, []);

  // Leaving the strip: the scroll position moves to the track's transform (no
  // visible jump), which then glides to 0 with the switch. Coming back glides
  // the transform to where the strip was, then hands it back to the scroller.
  const prevScrollMode = useRef(mode);
  useLayoutEffect(() => {
    const was = prevScrollMode.current;
    prevScrollMode.current = mode;
    const sc = scrollerRef.current!;
    if (was === mode || (was !== "strip" && mode !== "strip")) return;
    if (mode === "strip") {
      // Set now so revealing the selection starts from it; the track follows in
      // the effect below, with the switch's transition.
      offsetRef.current = Math.min(stripOffset.current, maxOffset(lay.contentWidth, vp.w));
      skipReveal.current = selected === stripSelected.current;
      glidingRef.current = true;
      setGliding(true);
      return;
    }
    // Not scrollLeft: the track has already lost the strip's width, so the browser may have clamped it.
    const x = offsetRef.current;
    glidingRef.current = false;
    setGliding(false);
    stripOffset.current = x;
    stripSelected.current = selected;
    sc.scrollLeft = 0;
    offsetRef.current = x;
    setOffsetState(x);
  }, [mode]);
  useEffect(() => {
    if (!gliding) return;
    setOffsetState(offsetRef.current);
    const t = setTimeout(() => setGliding(false), 260); // once the switch is done
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gliding]);
  useLayoutEffect(() => {
    if (gliding || !glidingRef.current) return;
    // Same frame as dropping the transform, so nothing moves.
    glidingRef.current = false;
    scrollerRef.current!.scrollLeft = offsetRef.current;
  }, [gliding]);

  // Follow the scroller (wheel, embedded pages' bubbled scroll, focus, our own writes).
  useEffect(() => {
    const sc = scrollerRef.current!;
    let raf = 0;
    let rest: ReturnType<typeof setTimeout> | undefined;
    const sync = () => ((raf = 0), setOffsetState(offsetRef.current));
    const onScroll = () => {
      if (live.current.mode !== "strip") {
        // Only the strip scrolls; focus can still scroll a clipped box.
        if (sc.scrollLeft || sc.scrollTop) sc.scrollTo(0, 0);
        return;
      }
      if (sc.scrollTop) sc.scrollTop = 0;
      // Gliding back in, the track's transform holds the offset; the scroller stays at 0 (focus may scroll it).
      if (glidingRef.current) return void (sc.scrollLeft && (sc.scrollLeft = 0));
      // Not our own write (those leave offsetRef within a pixel): someone else scrolls.
      if (Math.abs(sc.scrollLeft - offsetRef.current) >= 1) {
        offsetRef.current = sc.scrollLeft;
        stopScroll();
      }
      if (live.current.drag) raf ||= requestAnimationFrame(sync);
      else clearTimeout(rest), (rest = setTimeout(sync, OFFSET_SYNC_MS));
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      sc.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
      clearTimeout(rest);
    };
  }, []);

  const stopScroll = () => {
    if (anim.current) cancelAnimationFrame(anim.current), (anim.current = null);
  };
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
    performance.mark("boot:tiles"); // first commit of the windows (boot benchmark)
    requestAnimationFrame(() => requestAnimationFrame(() => performance.mark("boot:tiles-painted")));
    const el = rootRef.current!;
    // A one-off change (sidebar) glides the windows into place; a live resize of
    // the app window moves them with it, or positions trail behind sizes.
    let last = 0;
    let done: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      const now = performance.now();
      if (now - last < LIVE_RESIZE_MS) setLiveResize(true);
      last = now;
      if (done) clearTimeout(done);
      done = setTimeout(() => setLiveResize(false), LIVE_RESIZE_MS);
      setVp({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setVp({ w: el.clientWidth, h: el.clientHeight });
    return () => {
      ro.disconnect();
      if (done) clearTimeout(done);
    };
  }, []);

  useEffect(() => {
    if (!entering || !vp.w) return;
    const t = setTimeout(() => setEntering(false), LIVE_RESIZE_MS);
    return () => clearTimeout(t);
  }, [entering, vp.w, vp.h]);

  // Keep the offset valid (other modes don't scroll; the strip may have shrunk).
  const maxOff = mode === "strip" ? maxOffset(lay.contentWidth, vp.w) : 0;
  useEffect(() => {
    if (offsetRef.current > maxOff) setOffset(maxOff);
  }, [maxOff, setOffset]);

  // Strip: resizing the app window scales the windows with it; the offset scales
  // too, so the same part of the strip stays in view (and the start stays at 0).
  const scaledFor = useRef({ w: 0, content: 0, mode });
  useLayoutEffect(() => {
    const was = scaledFor.current;
    scaledFor.current = { w: vp.w, content: lay.contentWidth, mode };
    if (mode !== "strip" || was.mode !== mode || glidingRef.current || !was.w || was.w === vp.w || !was.content) return;
    stopScroll();
    setOffset((offsetRef.current * lay.contentWidth) / was.content);
  });

  // Strip: selecting a window scrolls just enough to show it. Not when only the
  // viewport changed: a resize would scroll away from where the user scrolled to.
  const selIdx = ids.indexOf(selected ?? "");
  const selSlot = selIdx >= 0 ? stripSlots[selIdx] : undefined;
  const revealedFor = useRef({ w: 0, mode, selected });
  useEffect(() => {
    if (mode !== "strip" || !selSlot || !vp.w || drag) return;
    const was = revealedFor.current;
    revealedFor.current = { w: vp.w, mode, selected };
    if (skipReveal.current) return void (skipReveal.current = false);
    if (was.w && was.w !== vp.w && was.mode === mode && was.selected === selected) return;
    const target = revealOffset(offsetRef.current, selSlot, vp.w, padX, lay.contentWidth);
    if (Math.abs(target - offsetRef.current) > 0.5) animateTo(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selected, selSlot?.x, selSlot?.w, vp.w, lay.contentWidth]);

  // Strip: Chromium does the scrolling, over every kind of window: it latches a
  // gesture to the strip or to content under the pointer that scrolls that way
  // (long lines, wide tables), carries macOS momentum, bounces at the ends and
  // runs on the compositor. A trackpad swipe is railed to one axis (mostly
  // sideways: deltaY 0), so terminals' vertical scrollback doesn't take it.
  // Sideways events are only kept from the content's own wheel handling (xterm
  // would send them to the program); vertical ones pass through. Passive in the
  // strip, so a gesture never waits on this page's main thread.
  useEffect(() => {
    const el = rootRef.current!;
    const canvas = mode === "canvas";
    const onWheel = (e: WheelEvent) => {
      if (canvas) return canvasWheel(e);
      if (mode === "strip" && Math.abs(e.deltaX) > Math.abs(e.deltaY)) e.stopPropagation();
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
      if (tile && tile.getAttribute("data-pane") === live.current.selected && !target.closest(".tile-title"))
        return;
      e.preventDefault();
      e.stopPropagation();
      stopCam();
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      setCam({ ...c, x: c.x + dx / c.zoom, y: c.y + dy / c.zoom });
    };
    el.addEventListener("wheel", onWheel, { passive: !canvas, capture: true });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [mode, setCam]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      if (anim.current) cancelAnimationFrame(anim.current);
      if (camAnim.current) cancelAnimationFrame(camAnim.current);
      if (camSave.current) clearTimeout(camSave.current), onCamera.current(camRef.current);
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  // Canvas: drag the background (or anything, with the middle button) to pan;
  // click it to deselect; double-click it to frame everything.
  const onBackground = (e: React.SyntheticEvent) =>
    e.target === e.currentTarget || ["windows-track", "windows-scroller"].some((c) => (e.target as HTMLElement).classList.contains(c));
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

  // Embedded pages ([data-embed], ../embed.ts) swallow pointer events, so a gesture that
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
        if (mode === "strip" && vx) {
          // The lifted window is placed from the offset: render it in the same frame as the scroll.
          setOffset(offsetRef.current + vx);
          flushSync(() => setOffsetState(offsetRef.current));
        }
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
      setSettling(id);
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => setSettling(null), SETTLE_MS + 50);
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
      w = clampWidth(startW + ev.clientX - startX, live.current.vp.w, padRef.current);
      setResizing({ id, w });
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setResizing(null);
      p.onWidth(id, fractionFor(w, live.current.vp.w, padRef.current));
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
  // Only while dragging: reading layout during every render (e.g. per pane update
  // while terminals stream) forces a synchronous layout of whatever just changed.
  const rootRect = drag ? rootRef.current?.getBoundingClientRect() : undefined;
  // Stable DOM order (creation), whatever the visual order.
  const stable = [...p.rows].sort((a, b) => createdOf(a) - createdOf(b));
  const canvas = mode === "canvas";
  // The zoom as a CSS variable, for the resize handles (sized in screen px). Set on
  // them only: on the track it would be inherited by every element
  // of every window, and changing it each frame would restyle them all.
  const zVar = { "--z": cam.zoom } as React.CSSProperties;
  const z = cam.zoom;
  return (
    <main
      ref={rootRef}
      className={`main windows mode-${mode} ${drag ? "dragging" : ""} ${resizing ? "resizing" : ""} ${sizing ? `sizing sizing-${sizing.axes}` : ""} ${panning ? "panning" : ""} ${switching ? "switching" : ""} ${liveResize || entering ? "live-resize" : ""}`}
      onPointerDown={startPan}
      onDoubleClick={(e) => canvas && onBackground(e) && fitAll()}
    >
      <div className="windows-scroller" ref={scrollerRef}>
      <div
        className="windows-track"
        style={
          canvas
            ? { transform: `translate(${-cam.x * z}px, ${-cam.y * z}px) scale(${z})` }
            : mode === "strip"
              ? { width: lay.contentWidth, transform: gliding ? `translateX(${-offset}px)` : undefined }
              : { transform: `translateX(${-offset}px)` }
        }
      >
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
          // Title bars animate state changes only where you can see them: on screen,
          // and on the canvas only while the title is legible (docs/10-window-titles.md).
          const motion =
            !lay.hidden.has(id) &&
            (canvas
              ? z >= MOTION_MIN_ZOOM &&
                x + rect.w > cam.x && x < cam.x + vp.w / z && y + rect.h > cam.y && y < cam.y + vp.h / z
              : x + rect.w > offset && x < offset + vp.w);
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
              data-tip={canvas ? "Drag to move · double-click to zoom to this window" : "Drag to move"}
            />
          );
          return (
            <div
              key={id}
              data-pane={id}
              className={`tile kind-${r.win?.kind ?? "terminal"} ${id === selected ? "sel" : ""} ${lifted ? "lifted" : ""} ${settling === id ? "settling" : ""} ${lay.hidden.has(id) ? "hidden-tile" : ""} ${attention && needsYou(r) ? "needs" : ""}`}
              style={{
                transform: `translate(${x}px, ${y}px)`,
                width: rect.w,
                height: rect.h,
              }}
              // Right-clicks an embedded page reports (Magic widgets, embed.ts) open the title bar's menu.
              onContextMenu={(e) => {
                if (!(e.target instanceof Element && e.target.closest("[data-embed]"))) return;
                e.preventDefault();
                onSelect(id);
                p.onTitleMenu?.(r);
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
                {lay.chrome && <SlotMotion.Provider value={motion}>{title}</SlotMotion.Provider>}
                {r.pane ? (
                  <TerminalView paneId={id} focused={id === selected} onMenu={p.onTerminalMenu} />
                ) : r.win ? (
                  <WindowContent win={r.win} focused={id === selected} />
                ) : null}
              </div>
              {/* Outline rings, glow, shadow and dimming: a leaf, so the canvas zoom can be
                  set on it (screen-constant widths) without restyling the window's content. */}
              <div className="tile-frame" style={canvas ? zVar : undefined} />
              {lay.resizable && (
                <div
                  className="strip-resize"
                  data-tip="Drag to resize · double-click to cycle widths"
                  onPointerDown={(e) => startResize(e, id, rect.w)}
                  onDoubleClick={() => p.onWidth(id, nextPreset(p.widths[id] ?? DEFAULT_FRACTION))}
                />
              )}
              {canvas &&
                (["x", "y", "xy"] as const).map((axes) => (
                  <div
                    key={axes}
                    className={`canvas-resize resize-${axes}`}
                    style={zVar}
                    onPointerDown={(e) => startSizing(e, id, rect, axes)}
                  />
                ))}
            </div>
          );
        })}
      </div>
      </div>
      {mode === "strip" && (
        <StripDots
          scroller={scrollerRef}
          slots={stripDots.map((d) => d.slot)}
          total={lay.contentWidth}
          viewport={vp.w}
          selected={stripDots.findIndex((d) => d.id === selected)}
          onGo={(i) => {
            const { id, slot } = stripDots[i]!;
            if (id === selected) animateTo(revealOffset(offsetRef.current, slot, vp.w, padX, lay.contentWidth));
            else onSelect(id);
          }}
        />
      )}
      {canvas && cfg["canvas.minimap"] && vp.w > 0 && (
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

/**
 * A window's content from its registered view (see windows/registry.ts). Memoized,
 * so moving the canvas camera (a re-render per frame) doesn't re-render file lists,
 * editors and pages; only a changed window or focus does.
 */
export const WindowContent = memo(function WindowContent({ win, focused }: { win: import("@cmd/protocol").AppWindow; focused: boolean }) {
  const view = viewFor(win.kind);
  if (!view) return <EmptyState compact icon="exclamationmark.triangle.fill">No view registered for “{win.kind}” windows.</EmptyState>;
  return <view.View win={win} focused={focused} />;
});

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

/**
 * Strip pagination: a dot per window, the current one wider and lighter. The
 * current window is the selected one while at least half of it is in view (⌥⌘←
 * often moves to a window that is already visible, so nothing scrolls).
 * Otherwise it is the one under a point that moves from the view's left edge
 * (scrolled to the start) to its right edge (scrolled to the end), so every
 * window gets its turn. Click a dot to bring that window into view.
 */
function StripDots(p: {
  scroller: React.RefObject<HTMLDivElement | null>;
  slots: Slot[];
  total: number;
  viewport: number;
  selected: number;
  onGo: (index: number) => void;
}) {
  // Rendered only when the current dot changes, not on every scroll frame.
  const [cur, setCur] = useState(-1);
  const shown = !!p.viewport && p.total > p.viewport + 0.5;
  const edges = p.slots.map((s) => s.x + s.w).join();
  useLayoutEffect(() => {
    const sc = p.scroller.current;
    if (!sc || !shown) return;
    const place = () => {
      const sel = p.slots[p.selected];
      const max = p.total - p.viewport;
      const seen = sel ? Math.min(sel.x + sel.w, sc.scrollLeft + p.viewport) - Math.max(sel.x, sc.scrollLeft) : 0;
      const at = sc.scrollLeft + (max > 0 ? Math.min(1, Math.max(0, sc.scrollLeft / max)) : 0) * p.viewport;
      const i = sel && seen >= Math.min(sel.w, p.viewport) / 2 ? p.selected : p.slots.findIndex((s) => at < s.x + s.w);
      setCur(i < 0 ? p.slots.length - 1 : i);
    };
    place();
    sc.addEventListener("scroll", place, { passive: true });
    return () => sc.removeEventListener("scroll", place);
    // Not on every render: reading scrollLeft after each commit forced a layout.
  }, [shown, p.total, p.viewport, edges, p.selected, p.scroller]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!shown) return null;
  return (
    <div className="strip-dots" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <PageDots count={p.slots.length} current={cur} onSelect={p.onGo} size="sm" label="Windows" />
    </div>
  );
}
