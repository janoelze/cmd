import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PaneId } from "@cmd/protocol";
import { bucketOf, needsAttention } from "@cmd/protocol";
import { COMMANDS, prettyAccelerator, type CommandId } from "../../shared/commands.ts";
import { cmd } from "./bridge.ts";
import {
  selectPane,
  bindSelection,
  closePane,
  copy,
  newAgent,
  newTerminal,
  newTerminalIn,
  newBrowser,
  newFiles,
  openableTarget,
  openPath,
  resumeCommand,
  runAction,
  sessionId,
} from "./actions.ts";
import { showContextMenu } from "./context.ts";
import { useKeybindings } from "./keybindings.ts";
import { ago, arrangeTiles, buildRows, flatten, nextAfterClose, pushHistory, rowDetail, rowTitle, shortPath, windowIdOf, type SidebarRow } from "./model.ts";
import type { SearchHit, SearchStatus } from "@cmd/protocol";
import { getState, onAgentChange, onWindowFocus, usePersisted, useStore } from "./store.ts";
import { terminals } from "./terminals.ts";
import { DEFAULT_FRACTION, nextPreset } from "./strip.ts";
import { windowActions } from "./windowActions.ts";
import { builtinTools } from "./tools.ts";
import { MainView, type ViewMode } from "./components/MainView.tsx";
import { Palette, type PaletteItem } from "./components/Palette.tsx";
import { Sidebar, type SidebarTab } from "./components/Sidebar.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { StatusBar } from "./components/StatusBar.tsx";

function searchStatusLabel(s: SearchStatus | null): string {
  if (!s) return "";
  if (s.indexing && s.total) return `Indexing ${s.done.toLocaleString()} / ${s.total.toLocaleString()}…`;
  return `${s.sessions.toLocaleString()} session${s.sessions === 1 ? "" : "s"} indexed`;
}

/** Switch to a session if it is open in a terminal, otherwise resume it in a new one. */
async function openSession(h: SearchHit): Promise<void> {
  const live = [...getState().agents.values()].find(
    (a) => a.paneId && (a.native.claudeSessionId === h.sessionId || a.native.codexThreadId === h.sessionId),
  );
  if (live?.paneId) return selectPane(live.paneId);
  const agent = await cmd.call("agent.resume", { agent: h.agent, sessionId: h.sessionId, cwd: h.cwd, configDir: h.configDir });
  if (agent.paneId) selectPane(agent.paneId);
}

/** True when a text field (palette, settings) has focus, so Edit commands target it. */
const editingText = () => {
  const el = document.activeElement;
  return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.closest(".xterm");
};

export function App() {
  const s = useStore();
  const keys = useKeybindings();
  const cfg = s.settings.settings;
  // Remembered across restarts (stored in the core, see usePersisted).
  const [selected, setSelected] = usePersisted<PaneId | null>("selection.pane", null);
  // Most recently used terminals, for picking what to focus after one closes.
  const [history, setHistory] = usePersisted<PaneId[]>("selection.history", []);
  const [mode, setMode] = usePersisted<ViewMode>("view.mode", cfg["ui.defaultView"]);
  const [tab, setTab] = usePersisted<SidebarTab>("sidebar.tab", "sessions");
  const [sidebarOpen, setSidebarOpen] = usePersisted("sidebar.open", true);
  const [zoom, setZoom] = usePersisted("terminal.zoom", 0);
  const [recent, setRecent] = usePersisted<string[]>("palette.recent", []);
  // One spatial order shared by grid and strip.
  const [gridOrder, setGridOrder] = usePersisted<PaneId[]>("grid.order", []);
  // Strip widths as fractions of the pane (see strip.ts).
  const [stripWidths, setStripWidths] = usePersisted<Record<PaneId, number>>("strip.widths", {});
  const setStripWidth = (id: PaneId, fraction: number) =>
    setStripWidths((w) => {
      const alive = getState().panes;
      const next = Object.fromEntries(Object.entries(w).filter(([k]) => alive.has(k)));
      next[id] = fraction;
      return next;
    });
  // Transient: sheets don't reopen on launch.
  /** Palette open, with an optional initial query ("?" for session search). */
  const [palette, setPalette] = useState<false | string>(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => terminals.setZoom(zoom), [zoom]);

  const rows = useMemo(() => buildRows(s), [s]);
  const flat = useMemo(() => flatten(rows), [rows]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const select = useCallback((paneId: PaneId) => {
    setSelected(paneId);
    setHistory((h) => pushHistory(h, paneId));
    const agentId = getState().panes.get(paneId)?.agentId;
    if (agentId) void cmd.call("agent.markSeen", { agentId });
  }, []);

  useEffect(() => bindSelection(select, () => selectedRef.current), [select]);
  // Test hook for the e2e smoke test.
  useEffect(() => {
    (window as unknown as { __cmdSelect?: (id: PaneId) => void }).__cmdSelect = select;
  }, [select]);

  // The order terminals appear in for the current view: grid slots, or the sidebar.
  const viewOrder = useMemo(() => {
    const wins = flat
      .filter((r) => r.pane || r.win)
      .map((r) => ({ id: windowIdOf(r)!, createdAt: r.pane?.createdAt ?? r.win?.createdAt ?? 0 }));
    return mode === "grid" || mode === "strip" ? arrangeTiles(gridOrder, wins).map((p) => p.id) : wins.map((p) => p.id);
  }, [flat, mode, gridOrder]);
  const viewOrderBefore = useRef<PaneId[]>([]);

  // When the selected terminal goes away, focus the previously used one (see nextAfterClose).
  // Runs once the core's state, including the remembered selection, has arrived.
  useEffect(() => {
    if (!s.connected) return;
    if (selected && (s.panes.has(selected) || s.windows.has(selected))) return;
    const alive = new Set(viewOrder);
    const next = selected
      ? nextAfterClose(selected, history, viewOrderBefore.current, alive)
      : (history.find((id) => alive.has(id)) ?? viewOrder[0] ?? null);
    if (next !== selected) {
      if (next) select(next);
      else setSelected(null);
    }
  }, [s.connected, s.panes, viewOrder, selected, history, select]);

  // Remember this render's order for the next close (declared after the effect above, so it
  // still sees the order from before the terminal disappeared).
  useEffect(() => {
    viewOrderBefore.current = viewOrder;
  }, [viewOrder]);

  // Seeing an agent finish while it is selected counts as seen.
  useEffect(() => {
    const a = selected ? s.agents.get(s.panes.get(selected)?.agentId ?? "") : undefined;
    if (a && bucketOf(a) === "unseen" && document.hasFocus()) void cmd.call("agent.markSeen", { agentId: a.id });
  }, [s, selected]);

  // Dock badge.
  const attention = useMemo(() => [...s.agents.values()].filter(needsAttention).length, [s.agents]);
  useEffect(() => cmd.setBadge(cfg["notifications.dockBadge"] ? attention : 0), [attention, cfg]);

  // Notifications on transitions.
  useEffect(
    () =>
      onAgentChange((prev, next) => {
        const becameNeedy = next.state === "needs_input" && prev?.state !== "needs_input";
        const finished = next.state === "done" && prev?.state === "working";
        if (!becameNeedy && !finished) return;
        const c = getState().settings.settings;
        if ((becameNeedy && !c["notifications.needsInput"]) || (finished && !c["notifications.done"])) return;
        if (document.hasFocus() && next.paneId === selectedRef.current) return;
        const title = next.name ?? next.spawn.prompt ?? next.kind;
        const n = new Notification(becameNeedy ? `${title} needs you` : `${title} is done`, {
          body: becameNeedy ? (next.detail ?? "") : (next.lastMessage ?? "").slice(0, 200),
          silent: !becameNeedy,
        });
        n.onclick = () => {
          cmd.focusWindow();
          if (next.paneId) select(next.paneId);
        };
        if (becameNeedy && !document.hasFocus()) cmd.bounce();
      }),
    [select],
  );

  const selectRow = useCallback((r: SidebarRow) => {
    const id = windowIdOf(r);
    if (id) select(id);
  }, [select]);
  /** Rows with a window (terminal, browser, files), sidebar order. */
  const withPane = useMemo(() => flat.filter((r) => r.pane || r.win), [flat]);
  /** The selected terminal, if the selected window is one. */
  const current = selected ? s.panes.get(selected) : undefined;
  const currentRow = flat.find((r) => windowIdOf(r) === selected);
  const currentAgent = currentRow?.agent ?? null;

  // ⌥⌘← / ⌥⌘→ follow what you see: grid/strip order, else the sidebar.
  // The strip stops at its ends (like PaperWM); other views wrap around.
  const step = (d: number) => {
    if (viewOrder.length === 0) return;
    const i = viewOrder.indexOf(selected ?? "");
    const j = mode === "strip" ? Math.max(0, Math.min(viewOrder.length - 1, i + d)) : (i + d + viewOrder.length) % viewOrder.length;
    const next = viewOrder[j];
    if (next) select(next);
  };

  // ── commands ───────────────────────────────────────────
  // One handler per command id; the menu bar, palette and context menus all call these.
  const handlers: Record<CommandId, () => void> = {
    "app.settings": () => setSettingsOpen(true),
    "file.newTerminal": () => void newTerminal(),
    "file.newClaude": () => void newAgent("claude"),
    "file.newCodex": () => void newAgent("codex"),
    "file.newBrowser": () => void newBrowser(),
    "file.newFiles": () => void newFiles(),
    "file.close": () => {
      // ⌘W closes the frontmost thing: an open sheet, then the terminal, then the window.
      if (palette !== false) setPalette(false);
      else if (settingsOpen) setSettingsOpen(false);
      else if (selected) void closePane(selected);
      else cmd.closeWindow();
    },
    "file.closeWindow": () => cmd.closeWindow(),
    "file.save": () => void windowActions(selected)?.save?.(),
    "file.openSettingsFile": () => cmd.openSettingsFile(getState().settings.path),
    "edit.copy": () => {
      if (selected && !s.panes.has(selected)) return void document.execCommand("copy");
      if (editingText() || !selected || !terminals.copy(selected)) document.execCommand("copy");
    },
    "edit.selectAll": () => {
      if (editingText() || !selected) document.execCommand("selectAll");
      else terminals.selectAll(selected);
    },
    "edit.clear": () => selected && terminals.clear(selected),
    "view.palette": () => setPalette((p) => (p === false ? "" : false)),
    "view.search": () => setPalette("?"),
    "view.focus": () => setMode("focus"),
    "view.grid": () => setMode("grid"),
    "view.strip": () => setMode("strip"),
    "view.canvas": () => setMode("canvas"),
    "view.cycleWidth": () => {
      if (!selected) return;
      if (mode !== "strip") setMode("strip");
      setStripWidth(selected, nextPreset(stripWidths[selected] ?? DEFAULT_FRACTION));
    },
    "view.sidebar": () => setSidebarOpen((o) => !o),
    "view.sessions": () => (setSidebarOpen(true), setTab("sessions")),
    "view.tools": () => (setSidebarOpen(true), setTab("tools")),
    "view.zoomIn": () => setZoom((z) => Math.min(24, z + 1)),
    "view.zoomOut": () => setZoom((z) => Math.max(-6, z - 1)),
    "view.zoomReset": () => setZoom(0),
    "session.next": () => step(1),
    "session.prev": () => step(-1),
    "session.nextAttention": () => {
      const target = flat.find((r) => r.agent && needsAttention(r.agent) && r.pane);
      if (target?.pane) select(target.pane.id);
    },
    "session.copyResume": () => {
      const c = currentAgent && resumeCommand(currentAgent);
      if (c) copy(c);
    },
    "session.copyId": () => {
      const id = currentAgent && sessionId(currentAgent);
      if (id) copy(id);
    },
    "session.reveal": () => current && cmd.openPath(current.cwd),
    ...(Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`session.select${n}`, () => withPane[n - 1] && selectRow(withPane[n - 1]!)]),
    ) as Record<`session.select${number}`, () => void>),
    "help.docs": () => cmd.openDocs(),
  };
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const run = useCallback((id: string) => handlersRef.current[id as CommandId]?.(), []);

  useEffect(() => cmd.onCommand(run), [run]);
  useEffect(() => cmd.onOpenUrl((url) => void newBrowser(url)), []);
  useEffect(() => onWindowFocus((id) => select(id)), [select]);

  // Tell the menu bar what is checked/enabled.
  useEffect(() => {
    const hasPane = !!selected;
    cmd.setMenuState({
      checked: {
        "view.focus": mode === "focus",
        "view.grid": mode === "grid",
        "view.strip": mode === "strip",
        "view.canvas": mode === "canvas",
        "view.sidebar": sidebarOpen,
      },
      enabled: {
        "edit.clear": hasPane,
        "session.next": withPane.length > 1,
        "session.prev": withPane.length > 1,
        "session.copyResume": !!(currentAgent && resumeCommand(currentAgent)),
        "session.copyId": !!(currentAgent && sessionId(currentAgent)),
        "session.reveal": hasPane,
        "session.nextAttention": attention > 0,
      },
    });
  }, [mode, sidebarOpen, selected, withPane.length, currentAgent, attention]);

  // ── context menus ──────────────────────────────────────

  const rowMenu = (r: SidebarRow) => {
    const a = r.agent;
    const cwd = a?.cwd ?? r.pane?.cwd ?? r.win?.path ?? undefined;
    const resume = a && resumeCommand(a);
    const id = a && sessionId(a);
    void showContextMenu([
      ...(windowIdOf(r)
        ? [
            { label: "Show", run: () => select(windowIdOf(r)!) },
            { label: r.pane ? "Close Terminal" : "Close Window", run: () => void closePane(windowIdOf(r)!) },
            "-" as const,
          ]
        : []),
      ...(r.win?.kind === "browser" && r.win.url ? [{ label: "Open in Default Browser", run: () => cmd.openPath(r.win!.url!) }, { label: "Copy URL", run: () => copy(r.win!.url!) }, "-" as const] : []),
      ...(a
        ? [
            { label: "Copy Resume Command", run: () => resume && copy(resume), enabled: !!resume },
            { label: "Copy Session ID", run: () => id && copy(id), enabled: !!id },
            ...(a.native.transcriptPath ? [{ label: "Reveal Transcript", run: () => cmd.openPath(a.native.transcriptPath!) }] : []),
            "-" as const,
          ]
        : []),
      ...(cwd
        ? [
            { label: "New Terminal Here", run: () => void newTerminalIn(cwd) },
            { label: "Show Folder in Finder", run: () => cmd.openPath(cwd) },
            { label: "Copy Path", run: () => copy(cwd) },
          ]
        : []),
    ]);
  };

  const terminalMenu = (paneId: PaneId) => {
    select(paneId);
    void showContextMenu([
      { label: "Copy", run: () => terminals.copy(paneId), enabled: terminals.hasSelection(paneId) },
      { label: "Paste", run: () => void navigator.clipboard.readText().then((t) => terminals.paste(paneId, t)) },
      { label: "Select All", run: () => terminals.selectAll(paneId) },
      "-",
      { label: "Clear Buffer", run: () => terminals.clear(paneId) },
      "-",
      { label: "Close Terminal", run: () => void closePane(paneId) },
    ]);
  };

  // ── palette ────────────────────────────────────────────

  const stats = useMemo(() => {
    const agents = [...s.agents.values()];
    return {
      agents: agents.length,
      working: agents.filter((a) => a.state === "working").length,
      waiting: agents.filter((a) => a.state === "needs_input").length,
    };
  }, [s.agents]);

  // ?query in the palette: past agent sessions. Enter switches to a live one, else resumes it.
  const searchSessions = useCallback(async (text: string): Promise<PaletteItem[]> => {
    const hits = await cmd.call("search.query", { text, limit: 40 });
    const now = Date.now();
    return hits.map((h) => ({
      id: `h-${h.agent}-${h.sessionId}`,
      group: "History" as const,
      label: h.title || "(untitled session)",
      meta: [h.agent, h.cwd ? shortPath(h.cwd) : null, h.branch, h.updatedAt ? ago(h.updatedAt, now) : null, h.fuzzy ? "~" : null]
        .filter(Boolean)
        .join(" · "),
      snippet: h.snippet,
      run: () => void openSession(h),
    }));
  }, []);

  const remember = (id: string) => setRecent((r) => [id, ...r.filter((x) => x !== id)].slice(0, 20));
  const paletteItems: PaletteItem[] = [
    ...COMMANDS.filter((c) => !("paletteHidden" in c) && c.id !== "view.palette").map((c) => ({
      id: c.id,
      group: "Commands" as const,
      label: c.label.replace(/…$/, ""),
      hint: prettyAccelerator(keys.bindings[c.id]?.[0]),
      run: () => run(c.id),
    })),
    ...withPane.map((r) => ({
      id: `s-${r.key}`,
      group: "Sessions" as const,
      label: `${rowTitle(r)} — ${r.pane ? shortPath(r.pane.cwd) : rowDetail(r, Date.now())}`,
      run: () => select(windowIdOf(r)!),
    })),
    ...builtinTools.flatMap((t) =>
      t.controls.flatMap((c) =>
        c.type === "button"
          ? [{ id: `t-${t.id}-${c.id}`, group: "Tools" as const, label: `${t.title}: ${c.label}`, run: () => void runAction(c.action) }]
          : [],
      ),
    ),
  ];

  return (
    <div
      className={`app ${sidebarOpen ? "" : "no-sidebar"}`}
      style={{ ["--sidebar-w" as string]: `${cfg["ui.sidebarWidth"]}px` }}
    >
      {!sidebarOpen && <div className="drag-strip" />}
      {sidebarOpen && (
        <Sidebar
          tab={tab}
          onTab={setTab}
          rows={rows}
          selected={selected}
          onSelect={selectRow}
          onRowMenu={rowMenu}
          onNewTerminal={() => void newTerminal()}
          stats={stats}
          connected={s.connected}
          error={s.error}
        />
      )}
      <MainView
        mode={mode}
        rows={flat}
        selected={selected}
        onSelect={select}
        onTerminalMenu={terminalMenu}
        gridOrder={gridOrder}
        onGridReorder={setGridOrder}
        stripWidths={stripWidths}
        onStripWidth={setStripWidth}
      />
      <StatusBar mode={mode} row={currentRow} pane={current} run={run} />
      {palette !== false && (
        <Palette
          items={paletteItems}
          dynamic={(q) => {
            // Typing a URL or a path offers to open it in a window.
            const t = openableTarget(q);
            if (!t) return [];
            return [
              t.kind === "browser"
                ? { id: `open-url`, group: "Commands" as const, label: `Open ${t.value}`, hint: "browser", run: () => void newBrowser(t.value) }
                : { id: `open-path`, group: "Commands" as const, label: `Open ${t.value}`, hint: "path", run: () => void openPath(t.value) },
            ];
          }}
          recent={recent}
          onRun={remember}
          onClose={() => setPalette(false)}
          initialQuery={palette}
          search={searchSessions}
          searchStatus={searchStatusLabel(s.search)}
        />
      )}
      {settingsOpen && <SettingsView onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
