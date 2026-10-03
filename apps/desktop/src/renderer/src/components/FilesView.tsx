// File browser window: a tree (outline) rooted at the window's folder, like
// Finder's list view or an editor's explorer. Folders load lazily via the core's
// fs.list; expanded folders are remembered per window.
//
// Keys: ↑/↓ move · → expand / into · ← collapse / to parent (at the top: up a
// folder) · Return open file / toggle folder · ⌘↓ make folder the root ·
// ⌘↑ root up · type to select · Home/End/PageUp/PageDown.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppWindow, FileEntry } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { copy, newTerminalIn } from "../actions.ts";
import { showContextMenu } from "../context.ts";
import { formatBytes } from "../model.ts";
import { usePersisted } from "../store.ts";
import { Symbol } from "./Symbol.tsx";

const iconFor = (e: FileEntry) =>
  e.kind === "dir"
    ? "folder.fill"
    : /\.(png|jpe?g|gif|svg|webp|heic)$/i.test(e.name)
      ? "photo"
      : /\.(md|txt|json|ya?ml|toml|ts|tsx|js|swift|zig|rs|go|py|sh|css|html|c|h)$/i.test(e.name)
        ? "doc.text"
        : "doc";

function when(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

interface Row {
  entry: FileEntry;
  depth: number;
  /** Path of the folder row this row is inside (null at the top level). */
  parent: string | null;
}

export function FilesView({ win, focused }: { win: AppWindow; focused: boolean }) {
  const root = win.path ?? "/";
  /** Folder contents by path (lazy, refreshed on focus). */
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map());
  const [rootParent, setRootParent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = usePersisted<string[]>(`files.expanded.${win.id}`, []);
  const [showHidden, setShowHidden] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const cameFrom = useRef<string | null>(null);
  const typed = useRef({ text: "", at: 0 });

  const fetchDir = useCallback(async (dir: string) => {
    const l = await cmd.call("fs.list", { path: dir });
    setChildren((m) => new Map(m).set(dir, l.entries));
    return l;
  }, []);

  // Load the root and every expanded folder under it.
  const refresh = useCallback(() => {
    fetchDir(root).then(
      (l) => {
        setRootParent(l.parent);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
    for (const p of expanded) if (p.startsWith(root + "/")) void fetchDir(p).catch(() => {});
  }, [root, expanded, fetchDir]);
  useEffect(refresh, [root]); // eslint-disable-line react-hooks/exhaustive-deps

  // Becoming the selected window: refresh and take keyboard focus — unless a text
  // field elsewhere (palette, address bar) has it. xterm's hidden textarea doesn't
  // count: coming from a terminal must move focus here.
  useEffect(() => {
    if (!focused) return;
    refresh();
    const active = document.activeElement;
    const typing = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && !active.closest(".xterm");
    if (!typing) listRef.current?.focus();
  }, [focused]); // eslint-disable-line react-hooks/exhaustive-deps

  const isOpen = useCallback((p: string) => expanded.includes(p), [expanded]);

  // Visible rows, depth-first.
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number, parent: string | null) => {
      for (const e of children.get(dir) ?? []) {
        if (!showHidden && e.hidden) continue;
        out.push({ entry: e, depth, parent });
        if (e.kind === "dir" && isOpen(e.path)) walk(e.path, depth + 1, e.path);
      }
    };
    walk(root, 0, null);
    return out;
  }, [children, root, showHidden, isOpen]);

  // Keep a selection. After going up, the folder we came from wins as soon as the
  // new root's rows contain it (the root change arrives from the core a moment
  // later, so it stays pending until then); otherwise keep the current one, else
  // take the first row.
  useEffect(() => {
    if (!children.has(root)) return;
    if (cameFrom.current) {
      const back = rows.find((r) => r.entry.path === cameFrom.current);
      if (back) {
        cameFrom.current = null;
        if (sel !== back.entry.path) setSel(back.entry.path);
        return;
      }
    }
    if (sel && rows.some((r) => r.entry.path === sel)) return;
    setSel(rows[0]?.entry.path ?? null);
  }, [rows, children, root, sel]);

  useEffect(() => {
    if (!sel) return;
    listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const setOpen = (p: string, open: boolean) => {
    if (open) {
      if (!children.has(p)) void fetchDir(p).catch(() => {});
      setExpanded((x) => (x.includes(p) ? x : [...x, p].slice(-300)));
    } else {
      // Collapsing also forgets expanded folders below it.
      setExpanded((x) => x.filter((q) => q !== p && !q.startsWith(p + "/")));
    }
  };
  const toggle = (e: FileEntry) => setOpen(e.path, !isOpen(e.path));

  const setRoot = (p: string) => {
    setSel(null);
    void cmd.call("window.update", { id: win.id, path: p });
  };
  const rootUp = () => {
    if (!rootParent) return;
    cameFrom.current = root;
    setRoot(rootParent);
  };
  const openFile = (e: FileEntry) => cmd.openPath(e.path);
  const activate = (e: FileEntry) => (e.kind === "dir" ? toggle(e) : openFile(e));

  // Breadcrumbs: "~ › src › cmd" inside the home folder, "/ › etc" elsewhere.
  const crumbs = useMemo(() => {
    const home = /^\/Users\/[^/]+/.exec(root)?.[0];
    const base = home ?? "";
    const rest = root.slice(base.length).split("/").filter(Boolean);
    const out = [{ name: home ? "~" : "/", path: home ?? "/" }];
    rest.forEach((name, i) => out.push({ name, path: `${base}/${rest.slice(0, i + 1).join("/")}` }));
    return out;
  }, [root]);

  const onKey = (e: React.KeyboardEvent) => {
    const i = rows.findIndex((r) => r.entry.path === sel);
    const cur = rows[i];
    const pick = (j: number) => setSel(rows[Math.max(0, Math.min(rows.length - 1, j))]?.entry.path ?? null);
    let handled = true;
    if (e.metaKey && e.key === "ArrowUp") rootUp();
    else if (e.metaKey && e.key === "ArrowDown") cur && (cur.entry.kind === "dir" ? setRoot(cur.entry.path) : openFile(cur.entry));
    else if (e.metaKey || e.ctrlKey || e.altKey) handled = false; // app shortcuts (⌥⌘← etc.)
    else if (e.key === "ArrowDown") pick(i + 1);
    else if (e.key === "ArrowUp") pick(i < 0 ? 0 : i - 1);
    else if (e.key === "Home") pick(0);
    else if (e.key === "End") pick(rows.length - 1);
    else if (e.key === "PageDown") pick(i + 15);
    else if (e.key === "PageUp") pick(i - 15);
    else if (e.key === "ArrowRight") {
      if (cur?.entry.kind === "dir") {
        if (!isOpen(cur.entry.path)) setOpen(cur.entry.path, true);
        else if (rows[i + 1]?.parent === cur.entry.path) pick(i + 1); // into the first child
      }
    } else if (e.key === "ArrowLeft") {
      if (cur?.entry.kind === "dir" && isOpen(cur.entry.path)) setOpen(cur.entry.path, false);
      else if (cur?.parent) setSel(cur.parent);
      else rootUp();
    } else if (e.key === "Enter") cur && activate(cur.entry);
    else if (e.key === "Backspace") rootUp();
    else if (e.key.length === 1 && e.key !== " ") {
      // Type to select: first visible name starting with what was typed.
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 800 ? typed.current.text : "") + e.key.toLowerCase(), at: now };
      const hit = rows.find((r) => r.entry.name.toLowerCase().startsWith(typed.current.text));
      if (hit) setSel(hit.entry.path);
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const entryMenu = (e: FileEntry) =>
    void showContextMenu([
      ...(e.kind === "dir"
        ? [
            { label: isOpen(e.path) ? "Collapse" : "Expand", run: () => toggle(e) },
            { label: "Open as Root", run: () => setRoot(e.path) },
          ]
        : [{ label: "Open with Default App", run: () => openFile(e) }]),
      { label: "Show in Finder", run: () => cmd.openPath(e.kind === "dir" ? e.path : e.path.split("/").slice(0, -1).join("/") || "/") },
      "-",
      { label: "Copy Path", run: () => copy(e.path) },
      ...(e.kind === "dir" ? [{ label: "New Terminal Here", run: () => void newTerminalIn(e.path) }] : []),
    ]);

  return (
    <div className="files">
      <div className="window-toolbar">
        <button className="icon-btn" disabled={!rootParent} onClick={rootUp} title="Enclosing folder (⌘↑)">
          <Symbol name="chevron.up" size={13} />
        </button>
        <div className="crumbs" title={root}>
          {crumbs.map((c) => (
            <button key={c.path} className="crumb" onClick={() => setRoot(c.path)}>
              {c.name}
            </button>
          ))}
        </div>
        <button className={`icon-btn ${showHidden ? "on" : ""}`} onClick={() => setShowHidden((h) => !h)} title="Show hidden files">
          <Symbol name={showHidden ? "eye" : "eye.slash"} size={13} />
        </button>
        <button className="icon-btn" onClick={() => void newTerminalIn(root)} title="New terminal here">
          <Symbol name="terminal" size={13} />
        </button>
      </div>
      <div className="file-list" ref={listRef} tabIndex={0} onKeyDown={onKey} role="tree">
        {error && <div className="file-error">{error}</div>}
        {rows.map(({ entry: e, depth }) => {
          const dir = e.kind === "dir";
          const open = dir && isOpen(e.path);
          return (
            <div
              key={e.path}
              data-path={e.path}
              role="treeitem"
              aria-expanded={dir ? open : undefined}
              className={`file-row ${sel === e.path ? "sel" : ""} ${e.hidden ? "hidden-file" : ""}`}
              style={{ ["--depth" as string]: depth }}
              onMouseDown={() => setSel(e.path)}
              onDoubleClick={() => activate(e)}
              onContextMenu={(ev) => {
                ev.preventDefault();
                setSel(e.path);
                entryMenu(e);
              }}
            >
              {dir ? (
                <button
                  className={`twisty ${open ? "open" : ""}`}
                  tabIndex={-1}
                  aria-label={open ? "Collapse" : "Expand"}
                  onMouseDown={(ev) => ev.stopPropagation()}
                  onClick={() => toggle(e)}
                >
                  <Symbol name="chevron.right" size={9} />
                </button>
              ) : (
                <span className="twisty-space" />
              )}
              <Symbol name={iconFor(e)} size={13} className={dir ? "file-icon dir" : "file-icon"} />
              <span className="file-name">{e.name}</span>
              <span className="file-size">{dir ? "" : formatBytes(e.size)}</span>
              <span className="file-date">{when(e.mtime)}</span>
            </div>
          );
        })}
        {children.has(root) && rows.length === 0 && !error && <div className="file-error">Empty folder</div>}
      </div>
    </div>
  );
}
