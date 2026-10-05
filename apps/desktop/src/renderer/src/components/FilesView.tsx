// File browser window: a tree (outline) rooted at the window's folder, like
// Finder's list view or an editor's explorer. Folders load lazily via the core's
// fs.list; expanded folders are remembered per window. Inside a git work tree,
// rows show their change state (git.status) and the toolbar the branch; the
// branch button switches to a flat list of the changes.
//
// Keys: ↑/↓ move · → expand / into · ← collapse / to parent (at the top: up a
// folder) · Return open file / toggle folder · ⌘↓ make folder the root ·
// ⌘↑ root up · type to select · Home/End/PageUp/PageDown · F2 rename ·
// ⌘D duplicate · ⌘⌫ move to Trash · ⇧⌘N new folder. They are the list's own
// (no menu items): nothing else in the app uses them, and ⌘⌫ must stay text editing's.
//
// As a sidebar (docs/21-sidebars.md) it reads like an editor's explorer: no toolbar,
// a folder header instead (its name opens the folders above; the branch toggles
// changes only; New File, New Folder, Collapse All and More on hover), denser rows
// with indent guides.
//
// Bookmarks: folders and files you keep coming back to, shared by every file browser
// (UI state). Right-click to add one; the bookmark button (or, as a sidebar, the
// folder's name) lists them: a folder becomes the root, a file opens.

import { Callout, EmptyState, IconButton } from "@cmd/ui";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AppWindow, FileEntry, GitFile, GitFileState, GitStatus } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { copy, newTerminalIn, openPath, selectPane } from "../actions.ts";
import { showContextMenu, type MenuEntry } from "../context.ts";
import { formatBytes, shortPath } from "../model.ts";
import { onFsChanged, usePersisted, useStoreValue } from "../store.ts";
import { ICON, Symbol } from "./Symbol.tsx";
import { PlacementContext } from "../windows/registry.ts";
import { useWholePixelWidth } from "../pixels.ts";

const iconFor = (e: FileEntry) =>
  e.kind === "dir"
    ? "folder.fill"
    : /\.(png|jpe?g|gif|svg|webp|heic)$/i.test(e.name)
      ? "photo"
      : /\.(md|txt|json|ya?ml|toml|ts|tsx|js|swift|zig|rs|go|py|sh|css|html|c|h)$/i.test(e.name)
        ? "doc.text"
        : "doc";

// Formatters are built once: toLocale*String with options builds one per call,
// which costs more than the rest of rendering a row.
const TIME = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
const DATE = new Intl.DateTimeFormat([], { day: "numeric", month: "short", year: "numeric" });

function when(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? TIME.format(d) : DATE.format(d);
}

interface Row {
  entry: FileEntry;
  depth: number;
  /** Path of the folder row this row is inside (null at the top level). */
  parent: string | null;
  /** Changes list: the path shown (relative to the root); size and date are unknown. */
  label?: string;
}

const GIT_LETTER: Record<GitFileState, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", ignored: "", conflict: "!" };
const GIT_WORD: Record<GitFileState, string> = {
  modified: "Modified", added: "Added", deleted: "Deleted", renamed: "Renamed", untracked: "Untracked", ignored: "Ignored", conflict: "Conflict",
};
/** Which state a folder shows for what is inside it. */
const GIT_RANK: Record<GitFileState, number> = { ignored: 0, added: 1, untracked: 1, modified: 2, renamed: 2, deleted: 2, conflict: 3 };
/** How often git state is re-read while the app is in front (changes deep in collapsed folders aren't watched). */
const GIT_POLL_MS = 5000;

/** A bookmarked folder or file. */
interface Bookmark {
  path: string;
  dir: boolean;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const relTo = (base: string, p: string) => (p === base ? "." : p.startsWith(base + "/") ? p.slice(base.length + 1) : p);

export function FilesView({ win, focused }: { win: AppWindow; focused: boolean }) {
  const root = typeof win.state.path === "string" ? win.state.path : "/";
  /** Folder contents by path (lazy, refreshed on focus). */
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map());
  const [rootParent, setRootParent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = usePersisted<string[]>(`files.expanded.${win.id}`, []);
  const [showHidden, setShowHidden] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const gitOn = useStoreValue((s) => s.settings.settings["files.git"]);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [changesOnly, setChangesOnly] = usePersisted<boolean>(`files.changes.${win.id}`, false);
  const gitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The row being renamed in place. */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The last file operation's failure, shown above the list until the next one. */
  const [opError, setOpError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const docked = useContext(PlacementContext) === "sidebar";
  const [bookmarks, setBookmarks] = usePersisted<Bookmark[]>("files.bookmarks", []);
  const isBookmarked = (p: string) => bookmarks.some((b) => b.path === p);
  const toggleBookmark = (path: string, dir: boolean) =>
    setBookmarks((bs) => (bs.some((b) => b.path === path) ? bs.filter((b) => b.path !== path) : [...bs, { path, dir }]));
  /** Menu entries for the bookmarks, then adding or removing this folder. */
  const bookmarkEntries = (): MenuEntry[] => [
    ...(bookmarks.length
      ? bookmarks.map((b) => ({
          label: `${b.path.split("/").pop() || "/"} — ${shortPath(parentOf(b.path))}`,
          checked: b.path === root,
          run: () => (b.dir ? setRoot(b.path) : void openPath(b.path)),
        }))
      : [{ label: "No Bookmarks", enabled: false, run: () => {} }]),
    "-",
    { label: isBookmarked(root) ? "Remove This Folder from Bookmarks" : "Bookmark This Folder", run: () => toggleBookmark(root, true) },
  ];
  const headLabel = useRef<HTMLSpanElement>(null);
  useWholePixelWidth(headLabel); // the chevron and branch after it stay crisp
  const cameFrom = useRef<string | null>(null);
  const typed = useRef({ text: "", at: 0 });

  const fetchDir = useCallback(async (dir: string) => {
    const l = await cmd.call("fs.list", { path: dir });
    setChildren((m) => new Map(m).set(dir, l.entries));
    return l;
  }, []);

  // Git state for the root, debounced: file events come in bursts.
  const rootNow = useRef(root);
  rootNow.current = root;
  const refreshGit = useCallback(() => {
    clearTimeout(gitTimer.current);
    gitTimer.current = setTimeout(() => {
      const asked = rootNow.current;
      if (!gitOn) return setGit(null);
      cmd.call("git.status", { path: asked }).then(
        // Polling mostly finds nothing new: keep the same object so rows don't re-render.
        (g) => rootNow.current === asked && setGit((prev) => (JSON.stringify(prev) === JSON.stringify(g) ? prev : g)),
        () => rootNow.current === asked && setGit(null),
      );
    }, 150);
  }, [gitOn]);
  useEffect(() => () => clearTimeout(gitTimer.current), []);
  useEffect(refreshGit, [root, gitOn]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stage, commit and checkout change the index, HEAD and HEAD's log; edits deep
  // in folders that aren't watched are caught by polling while the app is in front.
  const gitDir = git?.gitDir;
  useEffect(() => {
    if (!gitDir) return;
    const files = ["index", "HEAD", "logs/HEAD"].map((f) => `${gitDir}/${f}`);
    for (const f of files) void cmd.call("fs.watch", { path: f }).catch(() => {});
    const off = onFsChanged((p) => files.includes(p) && refreshGit());
    // Two git processes per poll: not while another app is in front; catch up when cmd is again.
    const poll = setInterval(() => document.hasFocus() && refreshGit(), GIT_POLL_MS);
    window.addEventListener("focus", refreshGit);
    return () => {
      off();
      clearInterval(poll);
      window.removeEventListener("focus", refreshGit);
      for (const f of files) void cmd.call("fs.unwatch", { path: f }).catch(() => {});
    };
  }, [gitDir, refreshGit]);

  // Load the root and every expanded folder under it.
  const refresh = useCallback(() => {
    refreshGit();
    fetchDir(root).then(
      (l) => {
        setRootParent(l.parent);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
    for (const p of expanded) if (p.startsWith(root + "/")) void fetchDir(p).catch(() => {});
  }, [root, expanded, fetchDir, refreshGit]);
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

  // Live: watch the root and expanded folders; refresh a folder when it changes.
  const watched = useMemo(() => [root, ...expanded.filter((p) => p.startsWith(root + "/"))], [root, expanded]);
  useEffect(() => {
    for (const p of watched) void cmd.call("fs.watch", { path: p }).catch(() => {});
    const off = onFsChanged((p) => {
      if (!watched.includes(p)) return;
      void fetchDir(p).catch(() => {});
      refreshGit();
    });
    return () => {
      off();
      for (const p of watched) void cmd.call("fs.unwatch", { path: p }).catch(() => {});
    };
  }, [watched, fetchDir, refreshGit]);

  // A path's own git state, or that of the untracked or ignored folder it is in.
  const gitOf = useCallback(
    (p: string): GitFile | undefined => {
      if (!git) return undefined;
      const own = git.files[p];
      if (own) return own;
      for (let d = p.slice(0, p.lastIndexOf("/")); d.length > git.root.length; d = d.slice(0, d.lastIndexOf("/"))) {
        const f = git.files[d];
        if (f && (f.state === "untracked" || f.state === "ignored")) return f;
      }
      return undefined;
    },
    [git],
  );
  // Folders containing changes, with the strongest state inside (ignored files don't count).
  const gitInside = useMemo(() => {
    const out = new Map<string, GitFileState>();
    if (!git) return out;
    for (const [p, f] of Object.entries(git.files)) {
      if (f.state === "ignored") continue;
      const state = f.state === "added" || f.state === "untracked" || f.state === "conflict" ? f.state : "modified";
      for (let d = p.slice(0, p.lastIndexOf("/")); d.length >= root.length && d.startsWith(root); d = d.slice(0, d.lastIndexOf("/"))) {
        const cur = out.get(d);
        if (cur && GIT_RANK[cur] >= GIT_RANK[state]) break; // ancestors already have at least this
        out.set(d, state);
      }
    }
    return out;
  }, [git, root]);
  const changes = useMemo(
    () =>
      git
        ? Object.entries(git.files)
            .filter(([p, f]) => f.state !== "ignored" && p.startsWith(root + "/"))
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        : [],
    [git, root],
  );

  // Visible rows, depth-first; or the changes, flat.
  const showChanges = changesOnly && !!git;
  const rows = useMemo(() => {
    const out: Row[] = [];
    if (showChanges) {
      for (const [p] of changes) {
        const name = p.slice(p.lastIndexOf("/") + 1);
        const entry: FileEntry = { name, path: p, kind: "file", size: 0, mtime: 0, hidden: name.startsWith(".") };
        out.push({ entry, depth: 0, parent: null, label: relTo(root, p) });
      }
      return out;
    }
    const walk = (dir: string, depth: number, parent: string | null) => {
      for (const e of children.get(dir) ?? []) {
        if (!showHidden && e.hidden) continue;
        out.push({ entry: e, depth, parent });
        if (e.kind === "dir" && isOpen(e.path)) walk(e.path, depth + 1, e.path);
      }
    };
    walk(root, 0, null);
    return out;
  }, [children, root, showHidden, isOpen, showChanges, changes]);

  // Keep a selection. After going up, the folder we came from wins as soon as the
  // new root's rows contain it (the root change arrives from the core a moment
  // later, so it stays pending until then); otherwise keep the current one, else
  // take the first row.
  useEffect(() => {
    if (!children.has(root) && !showChanges) return;
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
  }, [rows, children, root, sel, showChanges]);

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
    void cmd.call("window.update", { id: win.id, state: { path: p } });
  };
  const rootUp = () => {
    if (!rootParent) return;
    cameFrom.current = root;
    setRoot(rootParent);
  };
  // Files open in the window that suits them (text, browser), else their default app.
  const openFile = (e: FileEntry) =>
    void cmd.call("window.openTarget", { target: e.path, spaceId: win.spaceId }).then((w) => {
      if (w) selectPane(w.id);
      else cmd.openPath(e.path);
    });
  const activate = (e: FileEntry) => (e.kind === "dir" ? toggle(e) : gitOf(e.path)?.state === "deleted" ? showDiff(e) : openFile(e));

  // The diff in a new terminal at the repository root (git's pager); untracked files against nothing.
  const showDiff = (e: FileEntry) => {
    if (!git) return;
    const rel = shellQuote(relTo(git.root, e.path));
    const command = gitOf(e.path)?.state === "untracked" ? `git diff --no-index -- /dev/null ${rel}` : `git diff HEAD -- ${rel}`;
    void cmd.call("pane.create", { cwd: git.root, command, spaceId: win.spaceId }).then((p) => selectPane(p.id));
  };

  // ── file operations: each re-lists the folder it touched and selects the result ──
  const op = async (run: () => Promise<string | null>, folder: string) => {
    setOpError(null);
    try {
      const made = await run();
      await fetchDir(folder).catch(() => {});
      refreshGit();
      return made;
    } catch (err) {
      setOpError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      return null;
    }
  };
  /** Where new items go: into the selected folder, else next to the selected file. */
  const targetDir = () => {
    const cur = rows.find((r) => r.entry.path === sel);
    if (!cur || showChanges) return root;
    return cur.entry.kind === "dir" ? cur.entry.path : (cur.parent ?? root);
  };
  const create = async (kind: "file" | "dir", dir = targetDir()) => {
    if (dir !== root) setOpen(dir, true);
    const made = await op(() => cmd.call("fs.create", { dir, kind }), dir);
    if (made) (setSel(made), setRenaming(made));
  };
  const duplicate = async (e: FileEntry) => {
    const made = await op(() => cmd.call("fs.duplicate", { path: e.path }), parentOf(e.path));
    if (made) setSel(made);
  };
  const rename = async (e: FileEntry, name: string) => {
    setRenaming(null);
    listRef.current?.focus();
    if (!name.trim() || name === e.name) return;
    const made = await op(() => cmd.call("fs.rename", { path: e.path, name }), parentOf(e.path));
    if (!made) return;
    // A renamed folder keeps its expanded subfolders open.
    if (e.kind === "dir") setExpanded((x) => x.map((q) => (q === e.path || q.startsWith(e.path + "/") ? made + q.slice(e.path.length) : q)));
    setSel(made);
  };
  const trash = async (e: FileEntry) => {
    // Recoverable, but easy to do by accident (⌘⌫ in the list): ask first.
    const ok = await cmd.confirm({
      message: `Move “${e.name}” to the Trash?`,
      detail: e.kind === "dir" ? "The folder and everything in it go to the Trash. You can put them back from there." : "You can put it back from the Trash.",
      confirm: "Move to Trash",
    });
    if (!ok) return;
    const i = rows.findIndex((r) => r.entry.path === e.path);
    const next = rows.slice(i + 1).find((r) => !r.entry.path.startsWith(e.path + "/")) ?? rows[i - 1];
    if (e.kind === "dir") setOpen(e.path, false);
    const done = await op(() => cmd.trashPath(e.path).then(() => e.path), parentOf(e.path));
    if (done && next) setSel(next.entry.path);
  };

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
    if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "n") void create("dir");
    else if (e.metaKey && e.key === "d") cur && void duplicate(cur.entry);
    else if (e.metaKey && e.key === "Backspace") cur && void trash(cur.entry);
    else if (e.key === "F2") cur && setRenaming(cur.entry.path);
    else if (e.metaKey && e.key === "ArrowUp") rootUp();
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
        : [
            { label: "Open", run: () => openFile(e) },
            { label: "Open with Default App", run: () => cmd.openPath(e.path) },
          ]),
      { label: "Show in Finder", run: () => cmd.revealPath(e.path) },
      { label: isBookmarked(e.path) ? "Remove from Bookmarks" : "Add to Bookmarks", run: () => toggleBookmark(e.path, e.kind === "dir") },
      "-",
      { label: "Rename… (F2)", run: () => setRenaming(e.path) },
      { label: "Duplicate (⌘D)", run: () => void duplicate(e) },
      { label: "Move to Trash (⌘⌫)", run: () => void trash(e) },
      "-",
      { label: "New File", run: () => void create("file", e.kind === "dir" ? e.path : parentOf(e.path)) },
      { label: "New Folder (⇧⌘N)", run: () => void create("dir", e.kind === "dir" ? e.path : parentOf(e.path)) },
      "-",
      { label: "Copy Path", run: () => copy(e.path) },
      { label: "Copy Relative Path", run: () => copy(relTo(git?.root ?? root, e.path)) },
      ...(e.kind === "dir" ? [{ label: "New Terminal Here", run: () => void newTerminalIn(e.path) }] : []),
      ...(git && e.kind !== "dir" && gitOf(e.path) && gitOf(e.path)!.state !== "ignored" ? ["-" as const, { label: "Show Diff", run: () => showDiff(e) }] : []),
    ]);

  // Right-click on the list's empty space: new items at the top level.
  const listMenu = () =>
    void showContextMenu([
      { label: "New File", run: () => void create("file", root) },
      { label: "New Folder", run: () => void create("dir", root) },
      "-",
      { label: "New Terminal Here", run: () => void newTerminalIn(root) },
    ]);

  const branchLabel = git ? (git.branch ?? (git.head ? `detached ${git.head}` : "no commits")) : "";
  const branchTitle = git
    ? [
        `${branchLabel}${git.upstream ? ` → ${git.upstream}` : ""}`,
        git.ahead || git.behind ? `${git.ahead} ahead, ${git.behind} behind` : "",
        `${changes.length}${git.truncated ? "+" : ""} changed`,
        showChanges ? "Click to show all files" : "Click to show only changes",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const anyOpen = expanded.some((p) => p.startsWith(root + "/"));
  const collapseAll = () => setExpanded((x) => x.filter((p) => !p.startsWith(root + "/")));
  // The header's folder name: the folders above, nearest first (what the crumbs and ⌘↑ do).
  const folderMenu = () =>
    void showContextMenu([
      { label: "Bookmarks", submenu: bookmarkEntries() },
      "-",
      ...crumbs
        .slice(0, -1)
        .reverse()
        .map((c) => ({ label: c.name || "/", run: () => setRoot(c.path) })),
      ...(crumbs.length > 1 ? ["-" as const] : []),
      { label: "Show in Finder", run: () => cmd.revealPath(root) },
      { label: "Copy Path", run: () => copy(root) },
    ]);
  const moreMenu = () =>
    void showContextMenu([
      { label: "Show Hidden Files", checked: showHidden, run: () => setShowHidden((h) => !h) },
      ...(git ? [{ label: "Changes Only", checked: showChanges, run: () => setChangesOnly((c) => !c) }] : []),
      "-",
      { label: "New Terminal Here", run: () => void newTerminalIn(root) },
      { label: "Show in Finder", run: () => cmd.revealPath(root) },
    ]);

  return (
    <div className={`files${docked ? " in-sidebar" : ""}`}>
      {docked ? (
        <div className="files-head">
          <button className="files-head-name" onClick={folderMenu} data-tip={root}>
            <span ref={headLabel} className="files-head-label">{crumbs.at(-1)?.name || root}</span>
            <Symbol name="chevron.down" size={ICON.disclosure} />
          </button>
          {git && (
            <button className={`files-head-branch ${showChanges ? "on" : ""}`} onClick={() => setChangesOnly((c) => !c)} data-tip={branchTitle}>
              <Symbol name="arrow.triangle.branch" size={ICON.small} />
              {changes.length > 0 && <span className="git-count">{changes.length}{git.truncated ? "+" : ""}</span>}
            </button>
          )}
          <div className="files-head-actions">
            <IconButton size="sm" icon="doc.badge.plus" label="New File" onClick={() => void create("file", root)} />
            <IconButton size="sm" icon="folder.badge.plus" label="New Folder" shortcut="⇧⌘N" onClick={() => void create("dir", root)} />
            <IconButton size="sm" icon="rectangle.compress.vertical" label="Collapse All" disabled={!anyOpen} onClick={collapseAll} />
            <IconButton size="sm" icon="ellipsis" label="More" onClick={moreMenu} />
          </div>
        </div>
      ) : (
      <div className="window-toolbar">
        <IconButton icon="chevron.up" label="Enclosing Folder" shortcut="⌘↑" disabled={!rootParent} onClick={rootUp} />
        <div className="crumbs" data-tip={root}>
          {crumbs.map((c) => (
            <button key={c.path} className="crumb" onClick={() => setRoot(c.path)}>
              {c.name}
            </button>
          ))}
        </div>
        {git && (
          <button className={`git-branch ${showChanges ? "on" : ""}`} onClick={() => setChangesOnly((c) => !c)} data-tip={branchTitle}>
            <Symbol name="arrow.triangle.branch" size={ICON.toolbar} />
            <span className="git-branch-name">{branchLabel}</span>
            {git.ahead > 0 && <span className="git-ab">↑{git.ahead}</span>}
            {git.behind > 0 && <span className="git-ab">↓{git.behind}</span>}
            {changes.length > 0 && <span className="git-count">{changes.length}{git.truncated ? "+" : ""}</span>}
          </button>
        )}
        <IconButton
          icon={isBookmarked(root) ? "bookmark.fill" : "bookmark"}
          label="Bookmarks"
          onClick={() => void showContextMenu(bookmarkEntries())}
        />
        <IconButton
          icon={showHidden ? "eye" : "eye.slash"}
          label={showHidden ? "Hide Hidden Files" : "Show Hidden Files"}
          pressed={showHidden}
          onClick={() => setShowHidden((h) => !h)}
        />
        <IconButton icon="terminal" label="New Terminal Here" onClick={() => void newTerminalIn(root)} />
      </div>
      )}
      <div
        className="file-list"
        ref={listRef}
        tabIndex={0}
        onKeyDown={onKey}
        role="tree"
        onContextMenu={(ev) => {
          if (ev.target !== ev.currentTarget) return;
          ev.preventDefault();
          listMenu();
        }}
      >
        {error && <EmptyState compact icon="exclamationmark.triangle.fill">{error}</EmptyState>}
        {opError && (
          <Callout compact tone="danger" className="file-op-error" onDismiss={() => setOpError(null)}>
            {opError}
          </Callout>
        )}
        {rows.map(({ entry: e, depth, label }) => {
          const dir = e.kind === "dir";
          const open = dir && isOpen(e.path);
          const g = gitOf(e.path);
          const inside = dir ? gitInside.get(e.path) : undefined;
          const tone = g?.state ?? inside;
          return (
            <div
              key={e.path}
              data-path={e.path}
              role="treeitem"
              aria-expanded={dir ? open : undefined}
              className={`file-row ${sel === e.path ? "sel" : ""} ${e.hidden ? "hidden-file" : ""} ${tone ? `git-${tone}` : ""}`}
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
                  <Symbol name="chevron.right" size={ICON.disclosure} />
                </button>
              ) : (
                <span className="twisty-space" />
              )}
              <Symbol name={iconFor(e)} size={ICON.row} className={dir ? "file-icon dir" : "file-icon"} />
              {renaming === e.path ? (
                <RenameField entry={e} onDone={(name) => void rename(e, name)} />
              ) : (
                <span className="file-name">{label ?? e.name}</span>
              )}
              <span className="git-mark" data-tip={g ? `${GIT_WORD[g.state]}${g.staged ? " (staged)" : ""}` : inside ? "Contains changes" : undefined}>
                {g ? GIT_LETTER[g.state] : inside ? "•" : ""}
              </span>
              <span className="file-size">{dir || label !== undefined ? "" : formatBytes(e.size)}</span>
              <span className="file-date">{when(e.mtime)}</span>
            </div>
          );
        })}
        {showChanges
          ? rows.length === 0 && <EmptyState compact>No changes</EmptyState>
          : children.has(root) && rows.length === 0 && !error && <EmptyState compact>Empty folder</EmptyState>}
      </div>
    </div>
  );
}

/** The name as an input: the name without its extension selected, like Finder. Return or leaving it renames, Escape doesn't. */
function RenameField({ entry, onDone }: { entry: FileEntry; onDone: (name: string) => void }) {
  const done = useRef(false);
  const finish = (name: string) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      className="file-rename"
      defaultValue={entry.name}
      autoFocus
      spellCheck={false}
      onFocus={(ev) => {
        const dot = entry.kind === "dir" ? -1 : entry.name.lastIndexOf(".");
        ev.currentTarget.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
      }}
      onKeyDown={(ev) => {
        ev.stopPropagation(); // not the list's keys
        if (ev.key === "Enter") finish(ev.currentTarget.value);
        else if (ev.key === "Escape") finish(entry.name);
      }}
      onBlur={(ev) => finish(ev.currentTarget.value)}
      onMouseDown={(ev) => ev.stopPropagation()}
      onDoubleClick={(ev) => ev.stopPropagation()}
    />
  );
}
