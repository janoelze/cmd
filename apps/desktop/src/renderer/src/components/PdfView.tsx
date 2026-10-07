// The PDF window (core windows/builtin.ts pdfType): pdf.js's viewer components
// (continuous pages, selectable text, links, find) inside cmd's own chrome. A
// toolbar (sidebar, page, zoom), a find bar (⌘F), a sidebar of page thumbnails
// or the outline, the page in the title bar. The file is watched: when it
// changes (LaTeX, an agent writing it) it reloads where you were. Where you are
// (page, zoom, sidebar) is kept in the window's state. Loaded lazily with pdf.js.

import { Button, EmptyState, ListRow, Segmented, Spinner, TextField, ToolbarButton, ToolbarField, ToolbarGroup, ToolbarMenu, ToolbarSearchField, ToolbarSeparator, ToolbarSpacer, ToolbarText, Twisty, WindowToolbar } from "@cmd/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { cmd } from "../bridge.ts";
import { openPath } from "../actions.ts";
import { showContextMenu } from "../context.ts";
import { onFsChanged } from "../store.ts";
import { registerWindowActions, setWindowStatus } from "../windowActions.ts";
import type { WindowViewProps } from "../windows/registry.ts";
import { ASSETS, EventBus, fileUrl, LinkTarget, pdfjs, PDFFindController, PDFLinkService, PDFViewer } from "../pdf/lib.ts";
import "../pdf/pdf.css";

type Scale = "page-width" | "page-fit" | "auto" | number;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const zoomLabel = (scale: number, preset: Scale) =>
  preset === "page-width" ? "Fit Width" : preset === "page-fit" ? "Fit Page" : `${Math.round(scale * 100)}%`;

type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "password"; wrong: boolean } | { kind: "error"; message: string };

interface OutlineItem {
  title: string;
  dest: string | unknown[] | null;
  url: string | null;
  items: OutlineItem[];
}

export function PdfView({ win, focused }: WindowViewProps) {
  const file = typeof win.state.path === "string" ? win.state.path : "";
  const saved = useRef({ page: typeof win.state.page === "number" ? win.state.page : 1, scale: (win.state.scale as Scale | undefined) ?? "auto" });
  const sidebar = win.state.sidebar === "pages" || win.state.sidebar === "outline" ? win.state.sidebar : null;
  const dark = win.state.dark === true;
  const patch = useCallback((state: Record<string, unknown>) => void cmd.call("window.update", { id: win.id, state }).catch(() => {}), [win.id]);

  const container = useRef<HTMLDivElement>(null);
  const viewerEl = useRef<HTMLDivElement>(null);
  const parts = useRef<{ bus: EventBus; viewer: PDFViewer; links: PDFLinkService; find: PDFFindController } | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [page, setPage] = useState(saved.current.page);
  const [zoom, setZoom] = useState({ scale: 1, preset: saved.current.scale });
  const password = useRef<((p: string) => void) | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const [reloadedAt, setReloadedAt] = useState(0);
  /** The search showing, for reloads. */
  const findRef = useRef("");

  // The viewer, once per window.
  useEffect(() => {
    const bus = new EventBus();
    const links = new PDFLinkService({ eventBus: bus, externalLinkTarget: LinkTarget.BLANK });
    const find = new PDFFindController({ eventBus: bus, linkService: links });
    const viewer = new PDFViewer({ container: container.current!, viewer: viewerEl.current!, eventBus: bus, linkService: links, findController: find, removePageBorders: true });
    links.setViewer(viewer);
    parts.current = { bus, viewer, links, find };
    bus.on("pagechanging", (e: { pageNumber: number }) => setPage(e.pageNumber));
    bus.on("scalechanging", (e: { scale: number; presetValue?: string }) => setZoom({ scale: e.scale, preset: (e.presetValue as Scale | undefined) ?? e.scale }));
    return () => {
      viewer.setDocument(null as unknown as PDFDocumentProxy);
      parts.current = null;
    };
  }, []);

  // Loading, and reloading where you were when the file changes.
  const load = useCallback(
    async (reload: boolean) => {
      const p = parts.current;
      if (!p || !file) return;
      const at = reload ? { top: container.current!.scrollTop, left: container.current!.scrollLeft, preset: p.viewer.currentScaleValue } : null;
      if (!reload) setPhase({ kind: "loading" });
      let data: Uint8Array;
      try {
        const res = await fetch(fileUrl(file));
        if (!res.ok) throw new Error(res.status === 404 ? "The file isn't there any more." : `Couldn't read the file (${res.status}).`);
        data = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        if (!reload) setPhase({ kind: "error", message: e instanceof Error && !/fetch/i.test(e.message) ? e.message : "Couldn't read the file." });
        return;
      }
      const task = pdfjs.getDocument({ data, ...ASSETS });
      task.onPassword = (update: (p: string) => void, reason: number) => {
        password.current = update;
        setPhase({ kind: "password", wrong: reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD });
      };
      let next: PDFDocumentProxy;
      try {
        next = await task.promise;
      } catch (e) {
        // A file caught mid-write: the next change event loads it again.
        if (!reload) setPhase({ kind: "error", message: e instanceof Error && e.name === "InvalidPDFException" ? "This isn't a PDF cmd can read." : "Couldn't open this PDF." });
        return;
      }
      if (parts.current !== p) return void next.loadingTask.destroy();
      const once = () => {
        p.bus.off("pagesinit", once);
        if (at) {
          p.viewer.currentScaleValue = at.preset;
          container.current!.scrollTop = at.top;
          container.current!.scrollLeft = at.left;
        } else {
          p.viewer.currentScaleValue = String(saved.current.scale);
          if (saved.current.page > 1) p.viewer.currentPageNumber = Math.min(saved.current.page, next.numPages);
        }
      };
      p.bus.on("pagesinit", once);
      // A search that was showing finds its matches in the new text too.
      if (reload && findRef.current) p.bus.on("pagesinit", function again() {
        p.bus.off("pagesinit", again);
        p.bus.dispatch("find", { source: null, type: "", query: findRef.current, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false });
      });
      p.viewer.setDocument(next);
      p.links.setDocument(next, null);
      void docRef.current?.loadingTask.destroy();
      docRef.current = next;
      setDoc(next);
      setPhase({ kind: "ready" });
      if (reload) setReloadedAt(Date.now());
    },
    [file],
  );

  useEffect(() => void load(false), [load]);
  useEffect(() => {
    if (!file) return;
    void cmd.call("fs.watch", { path: file }).catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onFsChanged((p) => {
      if (p !== file) return;
      // Writers save in bursts; wait for the last.
      clearTimeout(timer);
      timer = setTimeout(() => void load(true), 300);
    });
    return () => {
      off();
      clearTimeout(timer);
      void cmd.call("fs.unwatch", { path: file }).catch(() => {});
    };
  }, [file, load]);
  useEffect(() => () => void docRef.current?.loadingTask.destroy(), []);

  // Where you are: the title bar ("Reloaded" for a moment after a reload), and the window's state (debounced).
  const pages = doc?.numPages ?? 0;
  useEffect(() => {
    if (phase.kind !== "ready" || !pages) return setWindowStatus(win.id, null);
    if (Date.now() - reloadedAt < 2000) {
      setWindowStatus(win.id, { label: "Reloaded", key: "reloaded" });
      const t = setTimeout(() => setReloadedAt(0), 2000);
      return () => clearTimeout(t);
    }
    setWindowStatus(win.id, { label: `Page ${page} of ${pages}`, key: "page" });
  }, [page, pages, phase.kind, win.id, reloadedAt]);
  useEffect(() => () => setWindowStatus(win.id, null), [win.id]);
  useEffect(() => {
    if (phase.kind !== "ready" || page === saved.current.page) return;
    const t = setTimeout(() => ((saved.current.page = page), patch({ page })), 600);
    return () => clearTimeout(t);
  }, [page, phase.kind, patch]);
  useEffect(() => {
    if (phase.kind !== "ready" || zoom.preset === saved.current.scale) return;
    const t = setTimeout(() => ((saved.current.scale = zoom.preset), patch({ scale: zoom.preset })), 600);
    return () => clearTimeout(t);
  }, [zoom.preset, phase.kind, patch]);

  // Zoom: the toolbar, ⌘+ ⌘− ⌘0 while selected, and pinching the trackpad.
  const setScale = (v: Scale) => parts.current && (parts.current.viewer.currentScaleValue = String(v));
  const zoomBy = (d: 1 | -1) => (d > 0 ? parts.current?.viewer.increaseScale() : parts.current?.viewer.decreaseScale());
  useEffect(() => {
    const el = container.current!;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !parts.current) return; // a pinch arrives as a wheel with ctrlKey
      e.preventDefault();
      parts.current.viewer.updateScale({ scaleFactor: Math.exp(-e.deltaY / 100), origin: [e.clientX, e.clientY], drawingDelay: 300 });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);
  // Fit Width / Fit Page / Auto follow the space they have: the window, the sidebar opening.
  useEffect(() => {
    const el = container.current!;
    let last = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const v = parts.current?.viewer;
      if (!v || !v.pagesCount || el.clientWidth === last) return;
      last = el.clientWidth;
      const preset = v.currentScaleValue;
      if (preset === "page-width" || preset === "page-fit" || preset === "auto") v.currentScaleValue = preset;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A zoom chosen elsewhere (the window's state changed by a menu or the CLI).
  const stateScale = win.state.scale as Scale | undefined;
  useEffect(() => {
    if (stateScale === undefined || phase.kind !== "ready" || stateScale === saved.current.scale) return;
    saved.current.scale = stateScale;
    setScale(stateScale);
  }, [stateScale, phase.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomMenu = () =>
    void showContextMenu([
      { label: "Fit Width", checked: zoom.preset === "page-width", run: () => setScale("page-width") },
      { label: "Fit Page", checked: zoom.preset === "page-fit", run: () => setScale("page-fit") },
      "-",
      ...ZOOMS.map((z) => ({ label: `${z * 100}%`, checked: zoom.preset === z, run: () => setScale(z) })),
    ]);

  // Find (⌘F ⌘G ⇧⌘G).
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ current: number; total: number } | null>(null);
  findRef.current = finding ? query : "";
  const findField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const bus = parts.current?.bus;
    if (!bus) return;
    const counts = (e: { matchesCount: { current: number; total: number } }) => setMatches(e.matchesCount);
    bus.on("updatefindmatchescount", counts);
    bus.on("updatefindcontrolstate", counts);
    return () => (bus.off("updatefindmatchescount", counts), bus.off("updatefindcontrolstate", counts));
  }, []);
  const search = useCallback((type: "" | "again", findPrevious = false, text = query) => {
    parts.current?.bus.dispatch("find", { source: null, type, query: text, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious, matchDiacritics: false });
  }, [query]);
  const closeFind = () => {
    setFinding(false);
    setMatches(null);
    parts.current?.bus.dispatch("find", { source: null, type: "", query: "", highlightAll: false });
    container.current?.focus();
  };

  useEffect(
    () =>
      registerWindowActions(win.id, {
        openExternally: () => cmd.openPath(file),
        find: (r) => {
          if (r === "open" || !query) {
            setFinding(true);
            requestAnimationFrame(() => (findField.current?.focus(), findField.current?.select()));
          } else search("again", r === "prev");
        },
        zoom: (d) => (d === 0 ? setScale(1) : zoomBy(d)),
      }),
    [win.id, file, query, search],
  );
  useEffect(() => {
    if (focused && !finding) container.current?.focus({ preventScroll: true });
  }, [focused, finding]);

  // Links to the web or files open in cmd (a browser window), not in the app's own page.
  useEffect(() => {
    const el = container.current!;
    const click = (e: MouseEvent) => {
      const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.getAttribute("href")!.startsWith("#")) return;
      e.preventDefault();
      void openPath(a.href);
    };
    el.addEventListener("click", click, true);
    return () => el.removeEventListener("click", click, true);
  }, []);

  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const goToPage = (n: number) => parts.current && pages && (parts.current.viewer.currentPageNumber = Math.max(1, Math.min(pages, n)));

  return (
    <div className="pdf">
      <WindowToolbar label="PDF">
        <ToolbarButton icon="sidebar.left" label={sidebar ? "Hide Sidebar" : "Show Sidebar"} pressed={!!sidebar} onClick={() => patch({ sidebar: sidebar ? null : "pages" })} priority={2} />
        <ToolbarField
          aria-label="Page"
          align="center"
          minWidth={36}
          maxWidth={44}
          value={pageDraft ?? String(page)}
          disabled={!pages}
          onChange={(e) => setPageDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setPageDraft(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const n = Number(pageDraft);
              if (Number.isFinite(n)) goToPage(n);
              setPageDraft(null);
              container.current?.focus();
            } else if (e.key === "Escape") (setPageDraft(null), container.current?.focus());
          }}
        />
        <ToolbarText priority={0}>of {pages || "–"}</ToolbarText>
        <ToolbarSpacer />
        <ToolbarGroup>
          <ToolbarButton icon="minus.magnifyingglass" label="Zoom Out" shortcut="⌘−" disabled={!pages} onClick={() => zoomBy(-1)} priority={1} />
          <ToolbarMenu label="Zoom" disabled={!pages} onClick={zoomMenu} priority={3}>
            {zoomLabel(zoom.scale, zoom.preset)}
          </ToolbarMenu>
          <ToolbarButton icon="plus.magnifyingglass" label="Zoom In" shortcut="⌘+" disabled={!pages} onClick={() => zoomBy(1)} priority={1} />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarButton icon="magnifyingglass" label="Find" shortcut="⌘F" disabled={!pages} pressed={finding} onClick={() => (finding ? closeFind() : (setFinding(true), requestAnimationFrame(() => findField.current?.focus())))} />
      </WindowToolbar>
      {finding && (
        <WindowToolbar label="Find in PDF">
          <ToolbarSearchField
            ref={findField}
            value={query}
            placeholder="Find in PDF"
            count={matches ? (matches.total ? `${matches.current} of ${matches.total}` : "No matches") : undefined}
            onChange={(v) => {
              setQuery(v);
              search("", false, v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.preventDefault(), search("again", e.shiftKey));
              else if (e.key === "Escape") (e.preventDefault(), closeFind());
            }}
          />
          <ToolbarGroup>
            <ToolbarButton icon="chevron.up" label="Previous" shortcut="⇧⌘G" disabled={!matches?.total} onClick={() => search("again", true)} />
            <ToolbarButton icon="chevron.down" label="Next" shortcut="⌘G" disabled={!matches?.total} onClick={() => search("again")} />
          </ToolbarGroup>
          <ToolbarButton label="Done" onClick={closeFind} />
        </WindowToolbar>
      )}
      <div className="pdf-main">
        {sidebar && doc && phase.kind === "ready" && (
          <PdfSidebar doc={doc} tab={sidebar} page={page} onTab={(t) => patch({ sidebar: t })} onPage={goToPage} onDest={(d) => void parts.current?.links.goToDestination(d as string)} />
        )}
        <div className="pdf-stage">
          <div ref={container} className={`pdf-scroll${dark ? " pdf-dark" : ""}`} tabIndex={-1} hidden={phase.kind !== "ready"}>
            <div ref={viewerEl} className="pdfViewer" />
          </div>
          {phase.kind === "loading" && (
            <div className="pdf-cover">
              <Spinner />
            </div>
          )}
          {phase.kind === "error" && (
            <EmptyState icon="doc.richtext" title="Couldn't show this PDF" action={<Button onClick={() => cmd.openPath(file)}>Open with Default App</Button>}>
              {phase.message}
            </EmptyState>
          )}
          {phase.kind === "password" && <PasswordPrompt wrong={phase.wrong} onSubmit={(p) => (setPhase({ kind: "loading" }), password.current?.(p))} />}
        </div>
      </div>
    </div>
  );
}

function PasswordPrompt({ wrong, onSubmit }: { wrong: boolean; onSubmit: (p: string) => void }) {
  const [text, setText] = useState("");
  return (
    <EmptyState icon="lock" title="This PDF is locked" action={<Button variant="primary" disabled={!text} onClick={() => onSubmit(text)}>Open</Button>}>
      {wrong ? "That password didn't work. Try again." : "Enter its password to open it."}
      <TextField
        className="pdf-password"
        type="password"
        autoFocus
        value={text}
        onChange={setText}
        onKeyDown={(e) => e.key === "Enter" && text && onSubmit(text)}
      />
    </EmptyState>
  );
}

// ── sidebar: page thumbnails, the outline ─────────────────

const THUMB_WIDTH = 120;

function PdfSidebar(p: { doc: PDFDocumentProxy; tab: "pages" | "outline"; page: number; onTab: (t: "pages" | "outline") => void; onPage: (n: number) => void; onDest: (d: unknown) => void }) {
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);
  useEffect(() => {
    let stale = false;
    p.doc.getOutline().then((o) => !stale && setOutline((o as OutlineItem[] | null) ?? []), () => !stale && setOutline([]));
    return () => void (stale = true);
  }, [p.doc]);
  const hasOutline = !!outline?.length;
  const tab = hasOutline ? p.tab : "pages";
  return (
    <div className="pdf-sidebar">
      {hasOutline && (
        <div className="pdf-sidebar-tabs">
          <Segmented size="sm" value={tab} options={[{ value: "pages", label: "Pages" }, { value: "outline", label: "Outline" }]} onChange={p.onTab} />
        </div>
      )}
      {tab === "pages" ? <Thumbnails doc={p.doc} page={p.page} onPage={p.onPage} /> : <Outline items={outline ?? []} onDest={p.onDest} />}
    </div>
  );
}

function Thumbnails({ doc, page, onPage }: { doc: PDFDocumentProxy; page: number; onPage: (n: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const numbers = useMemo(() => Array.from({ length: doc.numPages }, (_, i) => i + 1), [doc]);
  // The first page's shape stands in for every page until each is drawn.
  const [ratio, setRatio] = useState(1.294);
  useEffect(() => {
    void doc.getPage(1).then((pg) => {
      const v = pg.getViewport({ scale: 1 });
      setRatio(v.height / v.width);
    });
  }, [doc]);
  useEffect(() => {
    list.current?.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: "nearest" });
  }, [page]);
  return (
    <div className="pdf-thumbs" ref={list}>
      {numbers.map((n) => (
        <Thumbnail key={n} doc={doc} n={n} ratio={ratio} current={n === page} root={list} onClick={() => onPage(n)} />
      ))}
    </div>
  );
}

function Thumbnail({ doc, n, ratio, current, root, onClick }: { doc: PDFDocumentProxy; n: number; ratio: number; current: boolean; root: React.RefObject<HTMLDivElement | null>; onClick: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const el = canvas.current!;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    const io = new IntersectionObserver(
      async ([e]) => {
        if (!e?.isIntersecting || task) return;
        io.disconnect();
        const pg = await doc.getPage(n);
        const dpr = window.devicePixelRatio || 1;
        const viewport = pg.getViewport({ scale: (THUMB_WIDTH * dpr) / pg.getViewport({ scale: 1 }).width });
        el.width = Math.floor(viewport.width);
        el.height = Math.floor(viewport.height);
        task = pg.render({ canvas: el, viewport });
        task.promise.then(() => setDrawn(true), () => {});
      },
      { root: root.current, rootMargin: "300px" },
    );
    io.observe(el);
    return () => (io.disconnect(), task?.cancel());
  }, [doc, n, root]);
  return (
    <button className={`pdf-thumb${current ? " current" : ""}`} data-page={n} aria-label={`Page ${n}`} aria-current={current || undefined} onClick={onClick}>
      <canvas ref={canvas} style={{ width: THUMB_WIDTH, height: drawn ? undefined : THUMB_WIDTH * ratio }} />
      <span className="pdf-thumb-n">{n}</span>
    </button>
  );
}

function Outline({ items, onDest }: { items: OutlineItem[]; onDest: (d: unknown) => void }) {
  return (
    <div className="pdf-outline">
      {items.map((it, i) => (
        <OutlineRow key={i} item={it} depth={0} onDest={onDest} />
      ))}
    </div>
  );
}

function OutlineRow({ item, depth, onDest }: { item: OutlineItem; depth: number; onDest: (d: unknown) => void }) {
  const [open, setOpen] = useState(depth === 0 && item.items.length > 0 && item.items.length <= 12);
  const kids = item.items.length > 0;
  return (
    <>
      <ListRow
        depth={depth}
        lead={kids ? <Twisty open={open} onToggle={() => setOpen(!open)} /> : <span className="ui-twisty" />}
        title={item.title}
        tip={item.title.length > 30 ? item.title : undefined}
        onClick={() => (item.url ? void openPath(item.url) : item.dest && onDest(item.dest))}
      />
      {open && item.items.map((c, i) => <OutlineRow key={i} item={c} depth={depth + 1} onDest={onDest} />)}
    </>
  );
}
