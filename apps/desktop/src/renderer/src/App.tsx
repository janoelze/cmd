import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PaneId } from "@cmd/protocol";
import { bucketOf, needsAttention } from "@cmd/protocol";
import { COMMANDS, prettyAccelerator, type CommandId } from "../../shared/commands.ts";
import { cmd } from "./bridge.ts";
import {
  bindSelection,
  closePane,
  copy,
  newAgent,
  newTerminal,
  newTerminalIn,
  resumeCommand,
  runAction,
  sessionId,
} from "./actions.ts";
import { showContextMenu } from "./context.ts";
import { useKeybindings } from "./keybindings.ts";
import { arrangeTiles, buildRows, flatten, nextAfterClose, pushHistory, rowTitle, shortPath, type SidebarRow } from "./model.ts";
import { getState, onAgentChange, usePersisted, useStore } from "./store.ts";
import { terminals } from "./terminals.ts";
import { DEFAULT_FRACTION, nextPreset } from "./strip.ts";
import { builtinTools } from "./tools.ts";
import { MainView, type ViewMode } from "./components/MainView.tsx";
import { Palette, type PaletteItem } from "./components/Palette.tsx";
import { Sidebar, type SidebarTab } from "./components/Sidebar.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { StatusBar } from "./components/StatusBar.tsx";

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
  const [palette, setPalette] = useState(false);
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
    const panes = flat.filter((r) => r.pane).map((r) => r.pane!);
    return mode === "grid" || mode === "strip" ? arrangeTiles(gridOrder, panes).map((p) => p.id) : panes.map((p) => p.id);
  }, [flat, mode, gridOrder]);
  const viewOrderBefore = useRef<PaneId[]>([]);

  // When the selected terminal goes away, focus the previously used one (see nextAfterClose).
  // Runs once the core's state, including the remembered selection, has arrived.
  useEffect(() => {
    if (!s.connected) return;
    if (selected && s.panes.has(selected)) return;
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

  const selectRow = useCallback((r: SidebarRow) => r.pane && select(r.pane.id), [select]);
  const withPane = useMemo(() => flat.filter((r) => r.pane), [flat]);
  const current = selected ? s.panes.get(selected) : undefined;
  const currentRow = flat.find((r) => r.pane?.id === selected);
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
    "file.close": () => {
      // ⌘W closes the frontmost thing: an open sheet, then the terminal, then the window.
      if (palette) setPalette(false);
      else if (settingsOpen) setSettingsOpen(false);
      else if (selected) void closePane(selected);
      else cmd.closeWindow();
    },
    "file.closeWindow": () => cmd.closeWindow(),
    "file.openSettingsFile": () => cmd.openSettingsFile(getState().settings.path),
    "edit.copy": () => {
      if (editingText() || !selected || !terminals.copy(selected)) document.execCommand("copy");
    },
    "edit.selectAll": () => {
      if (editingText() || !selected) document.execCommand("selectAll");
      else terminals.selectAll(selected);
    },
    "edit.clear": () => selected && terminals.clear(selected),
    "view.palette": () => setPalette((p) => !p),
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
    const cwd = a?.cwd ?? r.pane?.cwd;
    const resume = a && resumeCommand(a);
    const id = a && sessionId(a);
    void showContextMenu([
      ...(r.pane ? [{ label: "Show", run: () => select(r.pane!.id) }, { label: "Close Terminal", run: () => void closePane(r.pane!.id) }, "-" as const] : []),
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
      label: `${rowTitle(r)} — ${shortPath(r.pane!.cwd)}`,
      run: () => select(r.pane!.id),
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
      {palette && <Palette items={paletteItems} recent={recent} onRun={remember} onClose={() => setPalette(false)} />}
      {settingsOpen && <SettingsView onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
