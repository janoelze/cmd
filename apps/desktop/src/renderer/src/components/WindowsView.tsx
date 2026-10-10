// All windows of the main pane (terminals, browsers, file browsers), for every view mode. A layout
// (../layouts.ts) says where each window goes; this component renders them as
// absolutely positioned windows in a stable DOM order and owns the behaviour
// shared by all modes:
//
//  - moves glide: TileMotion (../motion.ts) springs each window's position and
//    size together and holds its content at one size meanwhile (mode switches,
//    ⌘↩, sidebars, reordering); the track glides on the same curve (--glide),
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

import { EmptyState, ErrorBoundary, GLIDE_MS, PageDots, tween, Window, WindowBody, WindowFrame } from "@cmd/ui";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import type { PaneId } from "@cmd/protocol";
import { canvasLayout, focusLayout, gridLayout, stripLayout, type Layout, type Rect, type Spacing, type ViewMode } from "../layouts.ts";
import { arrangeTiles, labelOf, moveInOrder, needsYou, windowIdOf, type SidebarRow } from "../model.ts";
import { viewFor } from "../windows/registry.ts";
import { brokenView, useBrokenView } from "../windows/break.ts";
import { useStoreValue } from "../store.ts";
import {
  arrange,
  bounds,
  fitLimits,
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
import { useFooterCentre } from "./StatusBar.tsx";
import { SlotMotion } from "./Slot.tsx";
import { countRender } from "../perf.ts";
import { arrived, departed, ghost, settledElsewhere, TileMotion, type TileTarget } from "../motion.ts";

const DRAG_THRESHOLD = 4;
const EDGE_SCROLL_ZONE = 56; // px from the pane edge where dragging auto-scrolls the strip
const EDGE_SCROLL_MAX = 18; // px per frame
const OFFSET_SYNC_MS = 100; // the strip's scroll position reaches React this long after it rests
const CAMERA_SAVE_MS = 400; // persist the camera once panning/zooming pauses
const MOTION_MIN_ZOOM = 0.5; // zoomed out further, title bars change without animating
const LIVE_RESIZE_MS = 150; // viewport changes this close together are a live resize (no gliding)

/** Canvas commands from the menu/palette (see requestCanvas). */
export type CanvasRequest = "fit" | "window";
const canvasRequests = new Set<(r: CanvasRequest) => void>();
/** Frame all windows ("fit") or the selected one at full size ("window"). */
export function requestCanvas(r: CanvasRequest): void {
  for (const fn of canvasRequests) fn(r);
}

const NO_INSETS = { left: 0, right: 0 };

/** A strip layout moved right by the left sidebar, with room for both (they cover its ends when scrolled). */
function underSidebars(lay: Layout, ins: { left: number; right: number }): Layout {
  if (!ins.left && !ins.right) return lay;
  const rects = new Map([...lay.rects].map(([id, r]) => [id, { ...r, x: r.x + ins.left }]));
  return { ...lay, rects, contentWidth: lay.contentWidth + ins.left + ins.right, dropIndex: (x, y) => lay.dropIndex(x - ins.left, y) };
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
  /**
   * Canvas and strip: px the sidebars cover at the left and right edges. Both run
   * under them; framing, revealing, the minimap and the strip's scroll range use
   * the area between.
   */
  insets: { left: number; right: number };
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

export function WindowsView(p: Props) {
  countRender("WindowsView");
  const { mode, selected, onSelect } = p;
  const rootRef = useRef<HTMLElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const [preview, setPreview] = useState<PaneId[] | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** Strip: the window being resized, its width so far, and which edge is held. */
  const [resizing, setResizing] = useState<{ id: PaneId; w: number; edge: "left" | "right" } | null>(null);
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
  /** How far the board moved on screen since TileMotion last heard (see the ResizeObserver). */
  const shiftRef = useRef({ x: 0, y: 0 });
  // Until the viewport is measured and holds still, windows take their places
  // without gliding (else at boot they glide out from a zero-size layout).
  const [entering, setEntering] = useState(true);

  // ── layout ─────────────────────────────────────────────
  const settled = arrangeTiles(
    p.order,
    p.rows.map((r) => ({ id: idOf(r), createdAt: createdOf(r) })),
  ).map((x) => x.id);
  const ids = preview ?? settled;
  // The board's own selection: a selected sidebar (docs/21-sidebars.md) leaves focus mode on the window it showed.
  const shownRef = useRef<PaneId | null>(null);
  if (selected && ids.includes(selected)) shownRef.current = selected;
  // Canvas and strip run under the sidebars (docs/21-sidebars.md). The strip's maths
  // stays in the visible area between them (its viewport is stripW, offsets mean the
  // same); only the windows' rects move right by the left sidebar.
  const under = mode === "canvas" || mode === "strip" ? p.insets : NO_INSETS;
  const stripW = Math.max(1, vp.w - under.left - under.right);
  const shift = mode === "strip" ? under.left : 0;
  const pxWidths = ids.map((id) =>
    resizing?.id === id ? resizing.w : widthFor(p.widths[id] ?? DEFAULT_FRACTION, vp.w ? stripW : 1000, padX),
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
        ? underSidebars(stripLayout(ids, pxWidths, { w: stripW, h: vp.h }, spacing), under)
        : arranged
          ? canvasLayout(arranged.rects)
          : focusLayout(ids, shownRef.current, vp, spacing);
  // In the strip's own coordinates (without the left sidebar's shift), like its offsets.
  const stripSlots: Slot[] = ids.map((id) => ({ x: lay.rects.get(id)!.x - shift, w: lay.rects.get(id)!.w }));
  const stripTotal = lay.contentWidth - (mode === "strip" ? under.left + under.right : 0);
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

  // ── canvas camera ──────────────────────────────────────
  // The zoom range comes from the canvas.* settings.
  const cfg = useStoreValue((s) => s.settings.settings);
  const lim = zoomLimits(cfg);
  const limRef = useRef(lim);
  limRef.current = lim;
  const zoomAt = (c: Camera, f: number, sx: number, sy: number) => zoomAtWith(c, f, sx, sy, limRef.current);
  // The canvas spans the sidebars too (docs/21-sidebars.md): cameras are worked out for
  // the visible area between them, then moved back to the whole view's origin.
  const insetRef = useRef(p.insets);
  insetRef.current = under;
  const shown = (vp: { w: number; h: number }) => ({ w: Math.max(1, vp.w - insetRef.current.left - insetRef.current.right), h: vp.h });
  const toShown = (c: Camera): Camera => ({ ...c, x: c.x + insetRef.current.left / c.zoom });
  const fromShown = (c: Camera): Camera => ({ ...c, x: c.x - insetRef.current.left / c.zoom });
  const frame = (r: Rect, vp: { w: number; h: number }, maxZoom: number, lim = limRef.current) => fromShown(frameWith(r, shown(vp), maxZoom, lim));
  const reveal = (c: Camera, r: Rect, vp: { w: number; h: number }) => {
    const from = toShown(c);
    const to = revealWith(from, r, shown(vp), limRef.current);
    return to === from ? c : fromShown(to);
  };
  // Local state while it moves (no store round trip per frame); persisted when it pauses.
  const [cam, setCamState] = useState<Camera>(p.camera);
  const camRef = useRef(cam);
  const camAnim = useRef<number | null>(null);
  const camSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCamera = useRef(p.onCamera);
  onCamera.current = p.onCamera;

  // The track's transform in each mode: screen = (tx, ty) + s × window coordinates.
  // The strip scrolls natively (its offset is the scroller's), the canvas has its camera.
  const trackOf = (m: ViewMode) =>
    m === "canvas"
      ? { tx: -camRef.current.x * camRef.current.zoom, ty: -camRef.current.y * camRef.current.zoom, s: camRef.current.zoom }
      : { tx: m === "strip" ? -offsetRef.current : 0, ty: 0, s: 1 };
  /** Where the track was before it jumps (see the motion effect). */
  const jumpFrom = useRef<{ tx: number; ty: number; s: number } | null>(null);
  /**
   * Note where the track is before it moves at once (not a pan or a glide), so windows
   * stay put on screen and glide on from there. Every instant move of the scroll or the
   * camera goes through jumpScroll / jumpCamera, which call this; a mode switch calls it
   * itself (below). Moving the track without it makes every window jump.
   */
  const jumpTrack = (m: ViewMode = live.current.mode) => void (jumpFrom.current ??= trackOf(m));
  // A mode switch is a jump: noted before any other effect moves the scroll or the camera.
  // Until its glide is done, whatever else moves the track for it (the viewport settling
  // under the sidebars, revealing the selection) jumps too, so the switch stays one glide.
  const jumpMode = useRef(mode);
  const switchingRef = useRef(false);
  const [switching, setSwitching] = useState(false);
  useLayoutEffect(() => {
    if (jumpMode.current === mode) return;
    jumpTrack(jumpMode.current);
    jumpMode.current = mode;
    switchingRef.current = true;
    setSwitching(true);
  });
  useEffect(() => {
    if (!switching) return;
    const t = setTimeout(() => ((switchingRef.current = false), setSwitching(false)), GLIDE_MS);
    return () => clearTimeout(t);
  }, [switching, mode]);

  const setCam = useCallback((c: Camera) => {
    camRef.current = c;
    setCamState(c);
    if (camSave.current) clearTimeout(camSave.current);
    camSave.current = setTimeout(() => onCamera.current(camRef.current), CAMERA_SAVE_MS);
  }, []);
  const stopCam = () => {
    if (camAnim.current) cancelAnimationFrame(camAnim.current), (camAnim.current = null);
  };
  // On the glides' clock, with the windows: a stalled frame pauses it with them.
  const animateCam = useCallback(
    (target: Camera) => {
      const from = camRef.current;
      const { vp } = live.current;
      tween(camAnim, (t) => setCam(t < 1 ? lerpCamera(from, target, t, vp) : target));
    },
    [setCam],
  );
  /** Put the camera somewhere at once: windows stay where they are on screen and glide on (see jumpTrack). */
  const jumpCamera = (c: Camera) => (jumpTrack(), stopCam(), setCam(c));
  // Changed limits pull the camera back into range, around the viewport centre.
  useEffect(() => {
    const c = camRef.current;
    const z = Math.max(lim.min, Math.min(lim.max, c.zoom));
    if (z !== c.zoom) setCam(zoomAtWith(c, z / c.zoom, live.current.vp.w / 2, live.current.vp.h / 2, lim));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lim.min, lim.max]);

  // Latest values for event handlers registered once.
  const live = useRef({ lay, ids, settled, vp, stripW, selected, mode, preview, drag });
  live.current = { lay, ids, settled, vp, stripW, selected, mode, preview, drag };

  // Windows placed for the first time are stored, so they stay put. The first
  // time on the canvas, the camera frames them all (not the default camera's corner).
  useEffect(() => {
    if (!arranged?.changed) return;
    const first = Object.keys(p.canvasRects).length === 0;
    p.onCanvasRects({ ...p.canvasRects, ...Object.fromEntries(arranged.rects) });
    // At once, not a second move after the switch's glide.
    if (first && vp.w) fitAll(true);
  });
  const saveRect = (id: PaneId, r: Rect) => {
    const all = live.current.lay.rects;
    p.onCanvasRects({ ...p.canvasRects, ...Object.fromEntries(all), [id]: sized(r) });
  };

  // Selecting a window from outside the canvas (sidebar, keys, a new window)
  // pans to it; clicking one on the canvas doesn't move the camera. Switching to
  // the canvas, the camera is put there at once: the switch's own glide brings
  // the windows (see the motion effect), not a second move after it.
  const clickedSelect = useRef(false);
  const camFor = useRef({ mode, selected, w: vp.w });
  useLayoutEffect(() => {
    const was = camFor.current;
    camFor.current = { mode, selected, w: vp.w };
    const entering = switchingRef.current;
    // Only the viewport changed: not a reason to pan, unless it's the switch settling.
    if (was.mode === mode && was.selected === selected && was.w && !entering) return;
    if (mode !== "canvas" || !selected || !vp.w) return;
    if (clickedSelect.current) return void (clickedSelect.current = false);
    const r = live.current.lay.rects.get(selected);
    if (!r) return;
    const target = reveal(camRef.current, r, vp);
    if (target === camRef.current) return;
    if (entering) jumpCamera(target);
    else animateCam(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selected, vp.w]);

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
  const fitAll = (now = false) => {
    const b = bounds([...live.current.lay.rects.values()]);
    if (!b) return;
    // As far out as it takes to show everything, past the minimum zoom if need be.
    const target = frame(b, live.current.vp, 1, fitLimits(limRef.current));
    if (now) jumpCamera(target);
    else animateCam(target);
  };

  /** Scroll the strip. */
  const setOffset = useCallback((o: number) => {
    const { lay, vp, mode } = live.current;
    // Never past the end, unless it's already there: gliding back from where a strip
    // that got shorter still holds it.
    const max = mode === "strip" ? Math.max(maxOffset(lay.contentWidth, vp.w), offsetRef.current) : 0;
    const v = Math.max(0, Math.min(max, o));
    // Kept unrounded: scrollLeft snaps to device pixels and would eat small trackpad deltas.
    offsetRef.current = v;
    if (mode === "strip") {
      const sc = scrollerRef.current!;
      sc.scrollLeft = v;
      // The browser clamps to what it thinks is scrollable (it can lag the layout while
      // windows move): keep what it took, or reveal would think it already scrolled there.
      if (Math.abs(sc.scrollLeft - v) > 1) offsetRef.current = sc.scrollLeft;
    } else setOffsetState(v);
  }, []);

  // Switching to or from the strip moves its scroll position at once: back to
  // where it was left, scrolled to show the selection if that changed meanwhile.
  // TileMotion carries every window from where it was on screen (the motion
  // effect below), so the switch is one glide, not a glide and then a scroll.
  const prevScrollMode = useRef(mode);
  useLayoutEffect(() => {
    const was = prevScrollMode.current;
    prevScrollMode.current = mode;
    const sc = scrollerRef.current!;
    if (was === mode || (was !== "strip" && mode !== "strip")) return;
    if (mode !== "strip") {
      stripOffset.current = offsetRef.current;
      stripSelected.current = selected;
      sc.scrollLeft = 0;
      offsetRef.current = 0;
      setOffsetState(0);
      return;
    }
    // Revealing the selection, if it changed meanwhile, is the effect below's (with the settled viewport).
    const o = Math.min(stripOffset.current, maxOffset(lay.contentWidth, vp.w));
    // scrollLeft is clamped to what the browser thinks is scrollable. Chromium keeps a
    // composited track's scrollable overflow from while it was transformed (the canvas)
    // until it changes: will-change off for a moment makes it the untransformed track.
    const track = sc.firstElementChild as HTMLElement;
    track.style.willChange = "auto";
    void sc.scrollWidth;
    sc.scrollLeft = o;
    track.style.willChange = "";
    offsetRef.current = Math.abs(sc.scrollLeft - o) > 1 ? sc.scrollLeft : o;
    setOffsetState(offsetRef.current);
  }, [mode]);

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
      const from = offsetRef.current;
      if (Math.abs(target - from) < 0.5) return stopScroll(), setOffset(target);
      tween(anim, (t) => setOffset(from + (target - from) * t));
    },
    [setOffset],
  );
  /**
   * Scroll the strip at once: windows stay where they are on screen and glide on (see
   * jumpTrack); rendered now, so TileMotion hears of it before the frame is painted.
   */
  const jumpScroll = (o: number) => {
    jumpTrack();
    stopScroll();
    setOffset(o);
    setOffsetState(offsetRef.current);
  };

  useLayoutEffect(() => {
    performance.mark("boot:tiles"); // first commit of the windows (boot benchmark)
    requestAnimationFrame(() => requestAnimationFrame(() => performance.mark("boot:tiles-painted")));
    const el = rootRef.current!;
    // A change inside the app (a sidebar) glides the windows into place; resizing
    // the app window moves them with it at once, as a Mac app's content does, live
    // or in one step (a window manager), or they'd trail behind the window's edge.
    let last = 0;
    let done: ReturnType<typeof setTimeout> | null = null;
    let win = { w: window.innerWidth, h: window.innerHeight };
    let at = el.getBoundingClientRect();
    const ro = new ResizeObserver(() => {
      const now = performance.now();
      const resized = window.innerWidth !== win.w || window.innerHeight !== win.h;
      win = { w: window.innerWidth, h: window.innerHeight };
      // Where the board moved on screen (layout is fresh here, so this costs nothing).
      const r = el.getBoundingClientRect();
      shiftRef.current = { x: shiftRef.current.x + at.left - r.left, y: shiftRef.current.y + at.top - r.top };
      at = r;
      if (done) clearTimeout(done);
      done = setTimeout(() => setLiveResize(false), LIVE_RESIZE_MS);
      // Before this frame is painted: the windows take the new size in the same frame
      // as the board (else for a frame they sit at the old place in the new box).
      flushSync(() => {
        if (resized || now - last < LIVE_RESIZE_MS) setLiveResize(true);
        setVp({ w: el.clientWidth, h: el.clientHeight });
      });
      last = now;
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

  // Keep the offset valid (other modes don't scroll; the strip may have shrunk). A
  // strip that got shorter (a window narrower, or closed) while scrolled near its end
  // keeps the room to hold its scroll (the track's width below), and the scroll glides
  // back with the windows: else the browser clamps it and everything jumps at once.
  const maxOff = mode === "strip" ? maxOffset(lay.contentWidth, vp.w) : 0;
  useLayoutEffect(() => {
    if (offsetRef.current <= maxOff + 0.5) return;
    if (mode === "strip" && !liveResize && !resizing) animateTo(maxOff);
    else setOffset(maxOff);
  }, [maxOff, setOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Strip: resizing the app window scales the windows with it; the offset scales
  // too, so the same part of the strip stays in view (and the start stays at 0).
  const scaledFor = useRef({ w: 0, content: 0, mode });
  useLayoutEffect(() => {
    const was = scaledFor.current;
    scaledFor.current = { w: vp.w, content: lay.contentWidth, mode };
    if (mode !== "strip" || was.mode !== mode || !was.w || was.w === vp.w || !was.content) return;
    jumpScroll((offsetRef.current * lay.contentWidth) / was.content);
  });

  // Strip: selecting a window scrolls just enough to show it. Not when only the
  // viewport changed: a resize would scroll away from where the user scrolled to.
  const selIdx = ids.indexOf(selected ?? "");
  const selSlot = selIdx >= 0 ? stripSlots[selIdx] : undefined;
  const revealedFor = useRef({ w: 0, mode, selected });
  // A layout effect: a jump must reach TileMotion before the frame is painted.
  useLayoutEffect(() => {
    // Not while a window is being resized: its width changes every frame, and its left
    // edge scrolls the strip itself.
    if (mode !== "strip" || !selSlot || !vp.w || drag || resizing) return;
    const was = revealedFor.current;
    revealedFor.current = { w: vp.w, mode, selected };
    const entering = switchingRef.current;
    // Back to the strip with the selection it was left with: exactly where it was.
    if (entering && selected === stripSelected.current) return;
    // A resized window keeps its scroll; but entering the strip changes the width too
    // (the board runs under the sidebars), and that reveal must use the new one.
    if (was.w && was.w !== vp.w && was.mode === mode && was.selected === selected && !entering) return;
    const target = revealOffset(offsetRef.current, selSlot, stripW, padX, stripTotal);
    if (Math.abs(target - offsetRef.current) <= 0.5) return;
    // Entering the strip, part of the switch's one glide; otherwise a scroll of its own.
    if (entering) jumpScroll(target);
    else animateTo(target);
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
        // From the visible edges: the sidebars cover the rest.
        const ins = insetRef.current;
        const vx = edge(d.x - r.left - ins.left, r.right - ins.right - d.x);
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
    };
    const up = (ev: PointerEvent) => end(ev, true);
    const cancel = (ev: PointerEvent) => end(ev, false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  // ── resizing (strip) ───────────────────────────────────
  // Both edges of every window. Each gap is split down the middle and each half
  // belongs to the window whose edge it touches, so grabbing a window's edge always
  // resizes that window. The left edge grows the window leftwards: its right edge
  // stays put and the strip scrolls by the change (at the very start it can't, so
  // the window grows rightwards).
  const startResize = (e: React.PointerEvent, id: PaneId, startW: number, edge: "left" | "right") => {
    if (e.button !== 0) return;
    e.preventDefault();
    hold();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startOffset = offsetRef.current;
    let w = startW;
    setResizing({ id, w, edge });
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      w = clampWidth(startW + (edge === "right" ? dx : -dx), live.current.stripW, padRef.current);
      flushSync(() => setResizing({ id, w, edge }));
      if (edge === "left") setOffset(startOffset + (w - startW));
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setResizing(null);
      p.onWidth(id, fractionFor(w, live.current.stripW, padRef.current));
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
  // Where each window goes, filled in while rendering them; TileMotion takes it from there.
  const targets = new Map<string, TileTarget>();
  const tileMotion = useRef<TileMotion | null>(null);
  tileMotion.current ??= new TileMotion();
  const motionMode = useRef(mode);
  useLayoutEffect(() => {
    const els = new Map<string, HTMLElement>();
    for (const el of rootRef.current!.querySelectorAll<HTMLElement>(":scope .windows-track > .tile[data-pane]")) els.set(el.dataset.pane!, el);
    const swap = motionMode.current === mode && mode === "focus";
    motionMode.current = mode;
    // Following the pointer or the app window's edge: no gliding. Windows pushed aside by a drag still glide.
    const instant = entering || liveResize || !!resizing || !!sizing || !vp.w;
    // The track jumped (a mode switch, the camera put somewhere at once) or the board
    // moved on screen (a sidebar): each window goes on from where it was on screen.
    const from = jumpFrom.current;
    const to = trackOf(mode);
    const shift = shiftRef.current;
    jumpFrom.current = null;
    shiftRef.current = { x: 0, y: 0 };
    const moved = from && (from.tx !== to.tx || from.ty !== to.ty || from.s !== to.s);
    const remap =
      moved || shift.x || shift.y
        ? (x: number, y: number, s: number) => {
            const f = from ?? to;
            return { x: (f.tx + f.s * x + shift.x - to.tx) / to.s, y: (f.ty + f.s * y + shift.y - to.ty) / to.s, s: (s * f.s) / to.s };
          }
        : undefined;
    // A window new here that just left a sidebar glides in from there (motion.ts).
    let root: DOMRect | undefined;
    const screenToLocal = (r: DOMRect) => {
      root ??= rootRef.current!.getBoundingClientRect();
      return { x: (r.left - root.left - to.tx) / to.s, y: (r.top - root.top - to.ty) / to.s, w: r.width / to.s, h: r.height / to.s };
    };
    for (const id of els.keys()) {
      if (tileMotion.current!.has(id)) continue;
      arrived(id, (r) => {
        const t = targets.get(id);
        if (t) t.from = screenToLocal(r);
      });
    }
    const track = rootRef.current!.querySelector(".windows-track")!;
    tileMotion.current!.update(els, targets, {
      instant,
      swap,
      remap,
      // A window that went: to a sidebar (which glides it there), or closed (it fades out).
      onGone: (id, el, at) => {
        root ??= rootRef.current!.getBoundingClientRect();
        const rect = new DOMRect(root.left + to.tx + to.s * at.x, root.top + to.ty + to.s * at.y, at.w * at.s * to.s, at.h * at.s * to.s);
        if (departed(id, rect) || instant || el.isConnected) return;
        // Taken nowhere by the end of this commit: closed.
        queueMicrotask(() => settledElsewhere(id) || ghost(el, track));
      },
    });
  });
  useEffect(() => () => tileMotion.current?.dispose(), []);
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
              ? { width: Math.max(lay.contentWidth, offsetRef.current + vp.w) }
              : undefined
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
          targets.set(id, { rect: { x, y, w: rect.w, h: rect.h }, hidden: lay.hidden.has(id), instant: lifted });
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
            <Window
              key={id}
              data-pane={id}
              label={labelOf(r)}
              selected={id === selected}
              attention={attention && needsYou(r)}
              className={`tile kind-${r.win?.kind ?? "terminal"} ${id === selected ? "sel" : ""} ${lifted ? "lifted" : ""} ${attention && needsYou(r) ? "needs" : ""}`}
              // Geometry (transform, width, height, opacity) is TileMotion's: see the layout effect above.
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
              <WindowBody className="tile-body">
                {lay.chrome && <SlotMotion.Provider value={motion}>{title}</SlotMotion.Provider>}
                {r.pane ? (
                  <TerminalView paneId={id} focused={id === selected} onMenu={p.onTerminalMenu} />
                ) : r.win ? (
                  <WindowContent win={r.win} focused={id === selected} />
                ) : null}
              </WindowBody>
              {/* Outline rings, glow, shadow and dimming: a leaf, so the canvas zoom can be
                  set on it (screen-constant widths) without restyling the window's content. */}
              <WindowFrame className="tile-frame" style={canvas ? zVar : undefined} />
              {lay.resizable &&
                (["left", "right"] as const).map((edge) => {
                  // Half the space beside this edge: the window's gutter, or the strip's padding at its ends.
                  const i = ids.indexOf(id);
                  const space = (edge === "left" ? i === 0 : i === ids.length - 1) ? padX : gap;
                  return (
                    <div
                      key={edge}
                      className={`resize-edge strip-resize ${resizing?.id === id && resizing.edge === edge ? "active" : ""}`}
                      data-edge={edge}
                      // A handle a script (or VoiceOver) finds inside the window: separator "Right edge".
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={edge === "left" ? "Left edge" : "Right edge"}
                      style={{ "--space": `${space}px` } as React.CSSProperties}
                      data-tip="Drag to resize · double-click to cycle widths"
                      onPointerDown={(e) => startResize(e, id, rect.w, edge)}
                      // Resizing doesn't select (that would scroll the strip to reveal it).
                      onMouseDown={(e) => e.stopPropagation()}
                      onDoubleClick={() => p.onWidth(id, nextPreset(p.widths[id] ?? DEFAULT_FRACTION))}
                    />
                  );
                })}
              {canvas &&
                (["x", "y", "xy"] as const).map((axes) => (
                  <div
                    key={axes}
                    className={`canvas-resize resize-${axes}`}
                    role="separator"
                    aria-orientation={axes === "y" ? "horizontal" : "vertical"}
                    aria-label={axes === "x" ? "Right edge" : axes === "y" ? "Bottom edge" : "Corner"}
                    style={zVar}
                    onPointerDown={(e) => startSizing(e, id, rect, axes)}
                  />
                ))}
            </Window>
          );
        })}
      </div>
      </div>
      {mode === "strip" && (
        <StripDots
          scroller={scrollerRef}
          slots={stripDots.map((d) => d.slot)}
          names={stripDots.map((d) => {
            const r = p.rows.find((x) => idOf(x) === d.id);
            return r ? labelOf(r) : d.id;
          })}
          total={stripTotal}
          viewport={stripW}
          selected={stripDots.findIndex((d) => d.id === selected)}
          onGo={(i) => {
            const { id, slot } = stripDots[i]!;
            if (id === selected) animateTo(revealOffset(offsetRef.current, slot, stripW, padX, stripTotal));
            else onSelect(id);
          }}
        />
      )}
      {canvas && cfg["canvas.minimap"] && vp.w > 0 && (
        <Minimap
          rects={lay.rects}
          cam={toShown(cam)}
          vp={shown(vp)}
          right={insetRef.current.right}
          selected={selected}
          onCenter={(x, y) => (stopCam(), setCam(fromShown({ ...camRef.current, x: x - shown(vp).w / 2 / z, y: y - vp.h / 2 / z })))}
        />
      )}
    </main>
  );
}

/**
 * A window's content from its registered view (see windows/registry.ts). Memoized,
 * so moving the canvas camera (a re-render per frame) doesn't re-render file lists,
 * editors and pages; only a changed window or focus does. Each view has its own
 * ErrorBoundary, so one that breaks can't blank the app window.
 */
export const WindowContent = memo(function WindowContent({ win, focused }: { win: import("@cmd/protocol").AppWindow; focused: boolean }) {
  const view = viewFor(win.kind);
  const broken = useBrokenView(win.id);
  if (!view) return <EmptyState compact icon="exclamationmark.triangle.fill">No view registered for “{win.kind}” windows.</EmptyState>;
  // A view that throws shows a fallback in its own tile; the rest of the window stays live.
  // Reload mounts the view again (a lazy view's chunk is fetched again too).
  return (
    <ErrorBoundary text="Your other windows keep running.">
      {broken ? brokenView() : <view.View win={win} focused={focused} />}
    </ErrorBoundary>
  );
});

/** Canvas overview: every window, the visible area; click or drag to move there. */
function Minimap(p: {
  rects: Map<string, Rect>;
  cam: Camera;
  vp: { w: number; h: number };
  /** px a right sidebar covers: the map sits left of it. */
  right: number;
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
      aria-label="Minimap"
      style={p.right ? { right: p.right + 10 } : undefined}
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
  /** Each dot's window, by name. */
  names: string[];
  total: number;
  viewport: number;
  selected: number;
  onGo: (index: number) => void;
}) {
  // Rendered only when the current dot changes, not on every scroll frame.
  const [cur, setCur] = useState(-1);
  // In the footer's centre (StatusBar), not under the windows.
  const footer = useFooterCentre();
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
  if (!shown || !footer) return null;
  return createPortal(
    <div className="strip-dots" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <PageDots count={p.slots.length} current={cur} onSelect={p.onGo} size="sm" label="Windows" names={p.names} />
    </div>,
    footer,
  );
}
