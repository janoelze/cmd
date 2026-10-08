// JSON window view: a JSON, JSONC or JSON Lines file as a tree you fold, live —
// the file is watched and re-parsed in place, keeping what's open and selected
// (by JSON pointer). Only the rows on screen are drawn, so a 5 MB file is fine.
// ⌘E opens the editor at the selected row's line (and back, at the cursor's).
// A file that stops parsing (an agent halfway through writing it) keeps its last
// good tree under a banner. Find searches every key and value, folded or not.

import { Button, Callout, EmptyState, Twisty } from "@cmd/ui";
import type { FindResults } from "@cmd/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cmd } from "../bridge.ts";
import { copy } from "../actions.ts";
import { showContextMenu, type MenuEntry } from "../context.ts";
import { formatBytes } from "../model.ts";
import { onFsChanged } from "../store.ts";
import { registerWindowActions, setWindowStatus } from "../windowActions.ts";
import { findRegExp, useFind, type Findable } from "../find.tsx";
import { stateStr, type WindowViewProps } from "./registry.ts";
import { togglePreview } from "./preview.ts";
import { copyText, flavorOf, lineOf, lineStarts, nodeAt, nodeOnLine, parseJson, pathOf, pointerOf, preview, type JsonNode } from "./json-parse.ts";

/** Row height in px (styles.css .json-row). */
const ROW = 22;
/** Children shown per container before a "Show more" row. */
const CHUNK = 500;
/** Find stops counting here. */
const LIMIT = 5000;
/** Long strings are cut for display (the whole value is in the tooltip and Copy Value). */
const SHOWN = 400;

type Row = { node: JsonNode; depth: number } | { more: JsonNode; depth: number; rest: number };
type Hit = { node: JsonNode; field: "key" | "value"; start: number; end: number };

const isContainer = (n: JsonNode) => n.type === "object" || n.type === "array";
const keyText = (n: JsonNode) => (n.parent?.virtual ? String(n.line) : n.key === null ? "" : String(n.key));
const valueText = (n: JsonNode) => (n.children ? "" : (n.raw ?? "").slice(0, SHOWN));

/** The file as rows: what's open, in order. The root's own row only for a scalar. */
function flatten(root: JsonNode, open: Set<string>, limits: Map<string, number>): Row[] {
  const rows: Row[] = [];
  const walk = (n: JsonNode, depth: number) => {
    const kids = n.children!;
    const limit = limits.get(pointerOf(n)) ?? CHUNK;
    for (let i = 0; i < kids.length && i < limit; i++) {
      const c = kids[i]!;
      rows.push({ node: c, depth });
      if (c.children && open.has(pointerOf(c))) walk(c, depth + 1);
    }
    if (kids.length > limit) rows.push({ more: n, depth, rest: kids.length - limit });
  };
  if (root.children) walk(root, 0);
  else rows.push({ node: root, depth: 0 });
  return rows;
}

/** Containers below `n` (and `n`), for Expand All. */
function containers(n: JsonNode, out: string[] = [], cap = 20000): string[] {
  if (!n.children || out.length >= cap) return out;
  out.push(pointerOf(n));
  for (const c of n.children) containers(c, out, cap);
  return out;
}

/** Text with find matches marked. */
function marked(text: string, hits: Hit[] | undefined, current: Hit | null): ReactNode {
  if (!hits?.length) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const h of hits) {
    if (h.start >= text.length) break;
    out.push(text.slice(at, h.start));
    out.push(
      <mark key={h.start} className={h === current ? "json-hit current" : "json-hit"}>
        {text.slice(h.start, h.end)}
      </mark>,
    );
    at = h.end;
  }
  out.push(text.slice(at));
  return out;
}

export function JsonView({ win, focused }: WindowViewProps) {
  const file = stateStr(win, "path") ?? "";
  const flavor = flavorOf(file);
  const scroller = useRef<HTMLDivElement>(null);
  const [read, setRead] = useState<{ text: string; size: number; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await cmd.call("fs.read", { path: file });
      setRead({ text: r.text, size: r.size, truncated: r.truncated });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [file]);
  useEffect(() => void load(), [load]);

  // Live: re-parse when the file changes (open rows, selection and scroll are kept).
  useEffect(() => {
    void cmd.call("fs.watch", { path: file }).catch(() => {});
    const off = onFsChanged((p) => p === file && void load());
    return () => {
      off();
      void cmd.call("fs.unwatch", { path: file }).catch(() => {});
    };
  }, [file, load]);

  // A cut-off JSON Lines file is still its first lines; drop the partial last one.
  const text = read ? (read.truncated && flavor === "jsonl" ? read.text.slice(0, read.text.lastIndexOf("\n") + 1) : read.text) : null;
  const parsed = useMemo(() => {
    if (text === null || (read?.truncated && flavor !== "jsonl")) return null;
    const starts = lineStarts(text);
    return { ...parseJson(text, flavor, starts), starts };
  }, [text, flavor, read?.truncated]);
  // The last version that parsed, shown while the file doesn't (being written).
  const good = useRef<{ root: JsonNode; starts: number[]; invalid: number } | null>(null);
  if (parsed?.root) good.current = { root: parsed.root, starts: parsed.starts, invalid: parsed.invalid };
  useEffect(() => void (good.current = null), [file]);
  const shown = parsed ? good.current : null;
  const root = shown?.root ?? null;
  const stale = !!parsed && !parsed.root && !!good.current;

  // What's open and selected, by pointer, so a reload keeps them.
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [limits, setLimits] = useState<Map<string, number>>(() => new Map());
  const [sel, setSel] = useState<string | null>(null);
  const seeded = useRef<string | null>(null);
  if (root && seeded.current !== file) {
    // First view of a file: the top level open, and its children too when there are few.
    seeded.current = file;
    const first = new Set<string>([""]);
    if ((root.children?.length ?? 0) <= 30) for (const c of root.children ?? []) if (c.children) first.add(pointerOf(c));
    setOpen(first);
  }
  const rows = useMemo(() => (root ? flatten(root, open, limits) : []), [root, open, limits]);
  const selNode = useMemo(() => (root && sel !== null ? nodeAt(root, sel) : null), [root, sel]);
  const selIndex = useMemo(() => (selNode ? rows.findIndex((r) => "node" in r && r.node === selNode) : -1), [rows, selNode]);

  // Virtual rows: what's on screen, plus a margin.
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [root !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = Math.max(0, Math.floor(top / ROW) - 20);
  const last = Math.min(rows.length, Math.ceil((top + height) / ROW) + 20);

  const scrollTo = useCallback((i: number, center = false) => {
    const el = scroller.current;
    if (!el || i < 0) return;
    const y = i * ROW;
    if (center) el.scrollTop = y - el.clientHeight / 2 + ROW / 2;
    else if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW - el.clientHeight;
  }, []);
  // Scroll after the rows a change made exist (expanding to a find match, a reveal).
  const pending = useRef<{ node: JsonNode; center: boolean } | null>(null);
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    scrollTo(rows.findIndex((r) => "node" in r && r.node === p.node), p.center);
  }, [rows, scrollTo]);

  /** Select a node, opening everything above it. */
  const reveal = useCallback((n: JsonNode, center: boolean) => {
    setOpen((o) => {
      const missing: string[] = [];
      for (let p = n.parent; p; p = p.parent) if (!o.has(pointerOf(p))) missing.push(pointerOf(p));
      return missing.length ? new Set([...o, ...missing]) : o;
    });
    setLimits((l) => {
      let next = l;
      for (let c: JsonNode = n; c.parent; c = c.parent) {
        const i = c.parent.children!.indexOf(c);
        const ptr = pointerOf(c.parent);
        if (i >= (next.get(ptr) ?? CHUNK)) (next = next === l ? new Map(l) : next).set(ptr, Math.ceil((i + 1) / CHUNK) * CHUNK);
      }
      return next;
    });
    setSel(pointerOf(n));
    pending.current = { node: n, center };
  }, []);

  const toggle = useCallback((n: JsonNode, deep = false) => {
    const ptr = pointerOf(n);
    setOpen((o) => {
      const next = new Set(o);
      const opening = !o.has(ptr);
      for (const p of deep ? containers(n) : [ptr]) opening ? next.add(p) : next.delete(p);
      return next;
    });
  }, []);
  const setDeep = useCallback((n: JsonNode, opening: boolean) => {
    setOpen((o) => {
      const next = new Set(o);
      for (const p of containers(n)) opening ? next.add(p) : p !== "" && next.delete(p);
      return next;
    });
  }, []);

  const lineFor = useCallback((n: JsonNode) => n.line ?? (shown ? lineOf(shown.starts, n.from).line : 1), [shown]);
  /** ⌘E carries this line to the editor: the selected row's, else the first one on screen. */
  const currentLine = useCallback((): number | null => {
    if (selNode && !selNode.virtual) return lineFor(selNode);
    const r = rows[Math.floor((scroller.current?.scrollTop ?? 0) / ROW)];
    return r && "node" in r ? lineFor(r.node) : null;
  }, [selNode, rows, lineFor]);
  const edit = useCallback(
    (line?: number) => {
      if (line === undefined) return void togglePreview(win);
      void cmd.call("window.update", { id: win.id, kind: "text", state: { reveal: { line, column: null, text: null, at: Date.now() } } });
    },
    [win],
  );

  // Back from the editor: select the value on the line the cursor was on.
  const revealAt = (win.state.reveal as { line?: number; at?: number } | undefined) ?? null;
  const revealed = useRef(0);
  useEffect(() => {
    if (!shown || !revealAt?.line || !revealAt.at || revealAt.at === revealed.current) return;
    revealed.current = revealAt.at;
    const n = nodeOnLine(shown.root, shown.starts, revealAt.line);
    if (!n.virtual && n.parent) reveal(n, true);
  }, [shown, revealAt?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  // Find: over every key and value, folded or not.
  const [hits, setHits] = useState<{ all: Hit[]; byNode: Map<JsonNode, { key?: Hit[]; value?: Hit[] }>; index: number } | null>(null);
  const hitsRef = useRef(hits);
  hitsRef.current = hits;
  const findable = useMemo<Findable>(
    () => ({
      supports: { regex: true, caseSensitive: true, wholeWord: true },
      find: (query, o, step, report: (r: FindResults | null) => void) => {
        const r = good.current?.root;
        const re = query && r ? findRegExp(query, o) : null;
        if (!re || !r) return setHits(null), report(null);
        const prev = hitsRef.current;
        let all = prev?.all ?? [];
        let byNode = prev?.byNode ?? new Map();
        if (step === 0 || !prev) {
          all = [];
          byNode = new Map();
          const scan = (n: JsonNode) => {
            if (all.length >= LIMIT) return;
            if (n.parent) {
              for (const field of ["key", "value"] as const) {
                const s = field === "key" ? keyText(n) : n.type === "invalid" ? "" : valueText(n);
                if (!s) continue;
                re.lastIndex = 0;
                for (let m = re.exec(s); m && all.length < LIMIT; m = re.exec(s)) {
                  if (!m[0]) {
                    re.lastIndex++;
                    continue;
                  }
                  const h: Hit = { node: n, field, start: m.index, end: m.index + m[0].length };
                  all.push(h);
                  const e = byNode.get(n) ?? {};
                  (e[field] ??= []).push(h);
                  byNode.set(n, e);
                }
              }
            }
            for (const c of n.children ?? []) scan(c);
          };
          scan(r);
        }
        let index = prev && step !== 0 ? prev.index : -1;
        if (!all.length) index = -1;
        else if (step === 0) {
          // From the selection on.
          const from = selNode ? selNode.from : -1;
          index = Math.max(0, all.findIndex((h) => h.node.from >= from));
        } else index = (index + step + all.length) % all.length;
        setHits({ all, byNode, index });
        const h = all[index];
        if (h) reveal(h.node, true);
        report({ index, count: all.length, more: all.length >= LIMIT });
      },
      clear: () => setHits(null),
      selection: () => window.getSelection()?.toString() ?? "",
    }),
    [reveal, selNode],
  );
  const find = useFind(findable, { onClose: () => scroller.current?.focus() });
  const currentHit = hits && hits.index >= 0 ? (hits.all[hits.index] ?? null) : null;

  useEffect(
    () => registerWindowActions(win.id, { openExternally: () => cmd.openPath(file), find: find.request, line: currentLine }),
    [win.id, file, find.request, currentLine],
  );

  // Title bar: how much is in the file.
  useEffect(() => {
    if (!root || !read) return setWindowStatus(win.id, null);
    const n = root.children?.length ?? 1;
    const what = flavor === "jsonl" ? `${n.toLocaleString()} ${n === 1 ? "line" : "lines"}` : root.type === "object" ? `${n.toLocaleString()} ${n === 1 ? "key" : "keys"}` : root.type === "array" ? `${n.toLocaleString()} ${n === 1 ? "item" : "items"}` : root.type;
    const bad = shown?.invalid ? ` · ${shown.invalid.toLocaleString()} unreadable` : "";
    const size = read.truncated ? `first ${formatBytes(text?.length ?? 0)} of ${formatBytes(read.size)}` : formatBytes(read.size);
    setWindowStatus(win.id, { label: `${what}${bad} · ${size}`, key: "info" });
  }, [win.id, root, read, flavor, shown?.invalid, text?.length]);
  useEffect(() => () => setWindowStatus(win.id, null), [win.id]);

  useEffect(() => {
    if (focused) scroller.current?.focus();
  }, [focused, root !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowMenu = (n: JsonNode) => {
    const entries: MenuEntry[] = [];
    if (n.type !== "invalid") entries.push({ label: "Copy Value", run: () => copy(copyText(n)) });
    if (typeof n.key === "string") entries.push({ label: "Copy Key", run: () => copy(n.key as string) });
    if (!n.parent?.virtual || n.parent.parent) entries.push({ label: "Copy Path", run: () => copy(pathOf(n)) }, { label: "Copy JSON Pointer", run: () => copy(pointerOf(n)) });
    if (n.children?.length) entries.push("-", { label: "Expand All", run: () => setDeep(n, true) }, { label: "Collapse All", run: () => setDeep(n, false) });
    entries.push("-", { label: `Edit at Line ${lineFor(n).toLocaleString()}`, run: () => edit(lineFor(n)) });
    void showContextMenu(entries);
  };
  const listMenu = () =>
    root &&
    void showContextMenu([
      { label: "Expand All", run: () => setDeep(root, true) },
      { label: "Collapse All", run: () => setDeep(root, false) },
    ]);

  const move = (i: number) => {
    const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!r) return;
    const n = "node" in r ? r.node : r.more;
    setSel(pointerOf(n));
    scrollTo(rows.indexOf(r));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey) return;
    const n = selNode;
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 0) / ROW) - 1);
    const handled = () => e.preventDefault();
    switch (e.key) {
      case "ArrowDown":
        return handled(), move(selIndex + 1);
      case "ArrowUp":
        return handled(), move(selIndex < 0 ? 0 : selIndex - 1);
      case "PageDown":
        return handled(), move(selIndex + page);
      case "PageUp":
        return handled(), move(selIndex - page);
      case "Home":
        return handled(), move(0);
      case "End":
        return handled(), move(rows.length - 1);
      case "ArrowRight":
        if (!n?.children) return;
        handled();
        if (e.altKey) return setDeep(n, true);
        if (!open.has(pointerOf(n))) return toggle(n);
        return move(selIndex + 1);
      case "ArrowLeft":
        if (!n) return;
        handled();
        if (n.children && e.altKey) return setDeep(n, false);
        if (n.children && open.has(pointerOf(n))) return toggle(n);
        if (n.parent && n.parent.parent) return reveal(n.parent, false);
        return;
      case "Enter":
        if (!n) return;
        handled();
        if (n.children && !e.altKey) return toggle(n);
        return edit(lineFor(n));
    }
  };
  // ⌘C with nothing selected as text: the selected row's value.
  const onCopy = (e: React.ClipboardEvent) => {
    if (window.getSelection()?.toString() || !selNode || selNode.virtual || selNode.type === "invalid") return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", copyText(selNode));
  };

  const alt = useRef(false);
  const body = () => {
    if (error) return <EmptyState compact icon="exclamationmark.triangle.fill">{error}</EmptyState>;
    if (!read) return null;
    if (read.truncated && flavor !== "jsonl")
      return (
        <EmptyState
          icon="curlybraces"
          title="Too big for a tree"
          action={
            <>
              <Button size="sm" onClick={() => edit()}>
                Edit as Text
              </Button>
              <Button size="sm" onClick={() => cmd.openPath(file)}>
                Open with Default App
              </Button>
            </>
          }
        >
          {`This file is ${formatBytes(read.size)}; the tree shows files up to 5 MB.`}
        </EmptyState>
      );
    if (!root && parsed?.error) {
      const at = parsed.error;
      return (
        <EmptyState
          icon="exclamationmark.triangle.fill"
          title="This isn't valid JSON"
          action={
            <Button size="sm" onClick={() => edit(at.line)}>
              {`Edit at Line ${at.line.toLocaleString()}`}
            </Button>
          }
        >
          {`Line ${at.line.toLocaleString()}, column ${at.column}: ${at.message}.`}
        </EmptyState>
      );
    }
    if (!root) return null;
    return (
      <div className="json-rows" style={{ height: rows.length * ROW }}>
        <div style={{ transform: `translateY(${first * ROW}px)` }}>
          {rows.slice(first, last).map((r) => {
            if ("more" in r) {
              const ptr = pointerOf(r.more);
              return (
                <div key={`${ptr}…`} className="json-row json-more" style={{ ["--depth" as string]: r.depth }}>
                  <span className="json-twisty" />
                  <Button size="sm" variant="ghost" onClick={() => setLimits((l) => new Map(l).set(ptr, (l.get(ptr) ?? CHUNK) + CHUNK * 10))}>
                    {`Show ${Math.min(r.rest, CHUNK * 10).toLocaleString()} More`}
                  </Button>
                  <span className="json-dim">{`of ${r.rest.toLocaleString()}`}</span>
                </div>
              );
            }
            const n = r.node;
            const ptr = pointerOf(n);
            const isOpen = n.children ? open.has(ptr) : false;
            const h = hits?.byNode.get(n);
            const key = keyText(n);
            const index = typeof n.key === "number";
            const v = valueText(n);
            return (
              <div
                key={ptr}
                role="treeitem"
                aria-level={r.depth + 1}
                aria-selected={selNode === n}
                aria-expanded={n.children ? isOpen : undefined}
                className={`json-row ${selNode === n ? "sel" : ""}`}
                style={{ ["--depth" as string]: r.depth }}
                onMouseDown={(e) => ((alt.current = e.altKey), setSel(ptr))}
                onDoubleClick={() => (n.children ? toggle(n) : edit(lineFor(n)))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSel(ptr);
                  rowMenu(n);
                }}
              >
                <span className="json-twisty">{n.children?.length ? <Twisty open={isOpen} onToggle={() => toggle(n, alt.current)} /> : null}</span>
                {key && (
                  <span className={index ? "json-index" : "json-key"}>
                    {marked(key, h?.key, currentHit)}
                  </span>
                )}
                {key && !index && <span className="json-punct">:</span>}
                {n.children ? (
                  <span className="json-dim">
                    {isOpen ? (n.type === "object" ? `{${n.children.length}}` : `[${n.children.length}]`) : preview(n)}
                  </span>
                ) : n.type === "invalid" ? (
                  <>
                    <span className="json-invalid">{n.error}</span>
                    <span className="json-dim">{n.raw!.slice(0, SHOWN)}</span>
                  </>
                ) : (
                  <span className={`json-value json-${n.type}`} data-tip={n.raw!.length > 80 ? n.raw!.slice(0, 2000) : undefined}>
                    {marked(v, h?.value, currentHit)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <>
      {find.bar}
      {stale && parsed?.error && (
        <Callout banner tone="warning" compact actions={<Button size="sm" onClick={() => edit(parsed.error!.line)}>Edit</Button>}>
          {`The file changed and doesn't parse (line ${parsed.error.line.toLocaleString()}). Showing the last version that did.`}
        </Callout>
      )}
      <div
        className="json-scroll"
        ref={scroller}
        tabIndex={0}
        role="tree"
        aria-label={win.title}
        onScroll={(e) => setTop(e.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
        onCopy={onCopy}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains("json-rows")) return;
          e.preventDefault();
          listMenu();
        }}
      >
        {body()}
      </div>
    </>
  );
}
