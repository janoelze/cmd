// Image window view (docs/38-image-viewer.md): the picture, fit to the window
// or zoomed, and nothing else. Zoom with a pinch or ⌘+ ⌘− ⌘0 around the
// cursor; drag to pan; double-click flips between Fit and Actual Size; ← and →
// walk the folder's other images. Actual Size means one image pixel per device
// pixel, so a screenshot is sharp on a Retina display; past 200% pixels are
// drawn crisp, not smoothed. Chromium honours EXIF orientation and colour
// profiles on its own. The file is watched and shown again when it changes.

import { EmptyState, Button, Spinner, ToolbarButton, ToolbarMenu, ToolbarSeparator, ToolbarSpacer, ToolbarText, WindowToolbar } from "@cmd/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { copy } from "../actions.ts";
import { showContextMenu } from "../context.ts";
import { formatBytes } from "../model.ts";
import { onFsChanged } from "../store.ts";
import { fileUrl } from "../pdf/lib.ts";
import { registerWindowActions, setWindowStatus } from "../windowActions.ts";
import { stateStr, type WindowViewProps } from "./registry.ts";
import { copyImageFile } from "./image.tsx";
import "./image.css";

type Zoom = "fit" | number;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
/** The zoom menu, and the steps ⌘+ and ⌘− take. */
const ZOOMS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 16, 32, 64];
const MENU_ZOOMS = [0.25, 0.5, 1, 2, 4, 8];
const FORMAT: Record<string, string> = { jpg: "JPEG", jpeg: "JPEG", png: "PNG", gif: "GIF", webp: "WebP", avif: "AVIF", bmp: "BMP", ico: "ICO", svg: "SVG" };
/** From here up, pixels are drawn as squares. */
const CRISP_FROM = 2;

const extOf = (p: string) => p.split(".").pop()?.toLowerCase() ?? "";
const dirOf = (p: string) => p.split("/").slice(0, -1).join("/") || "/";
const clampZoom = (z: number) => Math.min(64, Math.max(0.01, z));
const pct = (z: number) => `${Math.round(z * 100)}%`;

/** Fit: the largest scale that shows the whole image, never past actual size. */
function fitScale(view: { w: number; h: number }, nat: { w: number; h: number }, density: number): number {
  if (!nat.w || !nat.h || !view.w || !view.h) return 1;
  return Math.min((view.w * density) / nat.w, (view.h * density) / nat.h, 1);
}

export function ImageView({ win, focused }: WindowViewProps) {
  const file = stateStr(win, "path") ?? "";
  const svg = /\.svg$/i.test(file);
  /** Device pixels per image pixel at Actual Size: an SVG's unit is a CSS pixel. */
  const density = svg ? 1 : window.devicePixelRatio || 1;

  const scroll = useRef<HTMLDivElement>(null);
  const imgEl = useRef<HTMLImageElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState({ w: 0, h: 0 });
  const [error, setError] = useState(false);
  const [stamp, setStamp] = useState(0);
  const saved = useRef<Zoom>(win.state.zoom === "fit" || typeof win.state.zoom === "number" ? (win.state.zoom as Zoom) : "fit");
  const [zoom, setZoom] = useState<Zoom>(saved.current);
  /** Where to keep the image still while the scale changes: a point of it (fraction) under a point of the view. */
  const anchor = useRef<{ fx: number; fy: number; cx: number; cy: number } | null>(null);
  const [siblings, setSiblings] = useState<FileEntry[]>([]);

  const src = useMemo(() => fileUrl(file), [file, stamp]);
  useEffect(() => void (setNat(null), setError(false)), [file]);

  // Live: shown again when the file changes.
  useEffect(() => {
    void cmd.call("fs.watch", { path: file }).catch(() => {});
    const off = onFsChanged((p) => p === file && setStamp(Date.now()));
    return () => {
      off();
      void cmd.call("fs.unwatch", { path: file }).catch(() => {});
    };
  }, [file]);

  // The folder's images, by name, for ← and →.
  useEffect(() => {
    let gone = false;
    cmd
      .call("fs.list", { path: dirOf(file) })
      .then((r) => !gone && setSiblings(r.entries.filter((e) => e.kind === "file" && IMAGE_EXT.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))))
      .catch(() => !gone && setSiblings([]));
    return () => void (gone = true);
  }, [file]);
  const index = siblings.findIndex((e) => e.path === file);
  const entry = index >= 0 ? siblings[index] : undefined;

  useEffect(() => {
    const el = scroll.current!;
    const ro = new ResizeObserver(() => setView({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setView({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const scale = zoom === "fit" ? fitScale(view, nat ?? { w: 0, h: 0 }, density) : zoom;
  const width = nat ? (nat.w * scale) / density : 0;
  const height = nat ? (nat.h * scale) / density : 0;

  // After the scale changed, scroll so the anchored point stays under the cursor.
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scroll.current;
    if (!a || !el) return;
    anchor.current = null;
    const left = Math.max(0, (el.clientWidth - width) / 2);
    const top = Math.max(0, (el.clientHeight - height) / 2);
    el.scrollLeft = a.fx * width + left - a.cx;
    el.scrollTop = a.fy * height + top - a.cy;
  }, [width, height]);

  const patch = useCallback((state: Record<string, unknown>) => void cmd.call("window.update", { id: win.id, state }).catch(() => {}), [win.id]);
  // The zoom is the window's, so it survives a reload; written a moment after it settles.
  useEffect(() => {
    if (zoom === saved.current) return;
    const t = setTimeout(() => ((saved.current = zoom), patch({ zoom })), 600);
    return () => clearTimeout(t);
  }, [zoom, patch]);
  // A zoom chosen elsewhere (the window's menu, the CLI).
  const stateZoom = win.state.zoom;
  useEffect(() => {
    if ((stateZoom !== "fit" && typeof stateZoom !== "number") || stateZoom === saved.current) return;
    saved.current = stateZoom;
    anchor.current = { fx: 0.5, fy: 0.5, cx: view.w / 2, cy: view.h / 2 };
    setZoom(stateZoom);
  }, [stateZoom, view.w, view.h]);

  /** Zoom to `next`, keeping the image still under `at` (a point in the window), else under the view's centre. */
  const zoomTo = useCallback(
    (next: Zoom, at?: { clientX: number; clientY: number }) => {
      const el = scroll.current;
      const img = imgEl.current;
      if (el && img) {
        const r = img.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        const cx = at ? at.clientX - er.left : er.width / 2;
        const cy = at ? at.clientY - er.top : er.height / 2;
        anchor.current = { fx: r.width ? (cx + er.left - r.left) / r.width : 0.5, fy: r.height ? (cy + er.top - r.top) / r.height : 0.5, cx, cy };
      }
      setZoom(next);
    },
    [],
  );
  const step = (d: 1 | -1, at?: { clientX: number; clientY: number }) => {
    const next = d > 0 ? ZOOMS.find((z) => z > scale * 1.001) : [...ZOOMS].reverse().find((z) => z < scale * 0.999);
    if (next !== undefined) zoomTo(next, at);
  };

  // A pinch arrives as a wheel with ctrlKey; a plain wheel pans.
  useEffect(() => {
    const el = scroll.current!;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomTo(clampZoom(scale * Math.exp(-e.deltaY / 100)), e);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [scale, zoomTo]);

  // Drag to pan when there is more than fits.
  const pannable = width > view.w || height > view.h;
  const [panning, setPanning] = useState(false);
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !pannable) return;
    const el = scroll.current!;
    const start = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    setPanning(true);
    const move = (m: MouseEvent) => ((el.scrollLeft = start.left - (m.clientX - start.x)), (el.scrollTop = start.top - (m.clientY - start.y)));
    const up = () => (setPanning(false), window.removeEventListener("mousemove", move), window.removeEventListener("mouseup", up));
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    e.preventDefault();
  };

  const go = (to: number) => {
    const e = siblings[to];
    if (e) patch({ path: e.path });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => go(index - 1),
      ArrowRight: () => go(index + 1),
      Home: () => go(0),
      End: () => go(siblings.length - 1),
    };
    const run = keys[e.key];
    if (run) (e.preventDefault(), run());
  };

  useEffect(() => {
    if (focused) scroll.current?.focus({ preventScroll: true });
  }, [focused]);
  useEffect(
    () =>
      registerWindowActions(win.id, {
        zoom: (d) => (d === 0 ? zoomTo(1) : step(d)),
        openExternally: () => cmd.openPath(file),
      }),
    [win.id, file, scale, zoomTo],
  );

  useEffect(() => {
    if (!nat || error) return setWindowStatus(win.id, null);
    setWindowStatus(win.id, { label: [`${nat.w.toLocaleString()} × ${nat.h.toLocaleString()}`, entry && formatBytes(entry.size), FORMAT[extOf(file)]].filter(Boolean).join(" · "), key: "info" });
  }, [win.id, nat, error, entry, file]);
  useEffect(() => () => setWindowStatus(win.id, null), [win.id]);

  const zoomMenu = () =>
    void showContextMenu([
      { label: "Fit", checked: zoom === "fit", run: () => zoomTo("fit") },
      { label: "Actual Size", checked: zoom === 1, run: () => zoomTo(1) },
      "-",
      ...MENU_ZOOMS.map((z) => ({ label: pct(z), checked: zoom === z, run: () => zoomTo(z) })),
    ]);
  const imageMenu = () =>
    void showContextMenu([
      { label: "Copy Image", run: () => void copyImageFile(file) },
      { label: "Copy Path", run: () => copy(file) },
      "-",
      { label: "Open with Default App", run: () => cmd.openPath(file) },
      { label: "Show in Finder", run: () => cmd.revealPath(file) },
    ]);

  return (
    <div className="im">
      <WindowToolbar label="Image">
        <ToolbarButton icon="chevron.left" label="Previous Image" shortcut="←" disabled={index <= 0} onClick={() => go(index - 1)} priority={2} />
        <ToolbarButton icon="chevron.right" label="Next Image" shortcut="→" disabled={index < 0 || index >= siblings.length - 1} onClick={() => go(index + 1)} priority={2} />
        {siblings.length > 1 && index >= 0 && <ToolbarText>{`${index + 1} of ${siblings.length}`}</ToolbarText>}
        <ToolbarSpacer />
        <ToolbarSeparator />
        <ToolbarButton icon="minus.magnifyingglass" label="Zoom Out" shortcut="⌘−" disabled={!nat} onClick={() => step(-1)} priority={1} />
        <ToolbarMenu label="Zoom" disabled={!nat} onClick={zoomMenu} priority={3}>
          {zoom === "fit" ? "Fit" : pct(zoom)}
        </ToolbarMenu>
        <ToolbarButton icon="plus.magnifyingglass" label="Zoom In" shortcut="⌘+" disabled={!nat} onClick={() => step(1)} priority={1} />
      </WindowToolbar>
      <div ref={scroll} className="im-scroll" tabIndex={-1} data-pan={pannable || undefined} data-panning={panning || undefined} onMouseDown={onMouseDown} onKeyDown={onKeyDown} onContextMenu={(e) => (e.preventDefault(), imageMenu())}>
        {error ? (
          <EmptyState icon="photo" title="Couldn't show this image" action={<Button onClick={() => cmd.openPath(file)}>Open with Default App</Button>}>
            It's a format that can't be shown here, like HEIC or TIFF, or the file is damaged or too large to decode.
          </EmptyState>
        ) : (
          <div className="im-stage">
            <img
              ref={imgEl}
              key={src}
              className="im-img"
              src={src}
              crossOrigin="anonymous"
              alt=""
              draggable={false}
              data-crisp={scale / density >= CRISP_FROM || undefined}
              style={nat ? { width, height } : { opacity: 0 }}
              onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              onError={() => setError(true)}
              onDoubleClick={(e) => zoomTo(zoom === 1 ? "fit" : 1, e)}
            />
            {!nat && (
              <div className="im-wait">
                <Spinner />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
