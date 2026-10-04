import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PaneId, Space, SpaceId } from "@cmd/protocol";
import type { WebviewTag } from "electron";
import { bucketOf, needsAttention } from "@cmd/protocol";
import { COMMANDS, prettyAccelerator, type CommandId } from "../../shared/commands.ts";
import { cmd } from "./bridge.ts";
import { restartCore } from "./coreHealth.ts";
import {
  bindSelection,
  windowSelected,
  closePane,
  copy,
  newAgent,
  newTerminal,
  newTerminalIn,
  newBrowser,
  newMagic,
  newFiles,
  newText,
  openableTarget,
  openLink,
  openPath,
  openSession,
  copyResumeCommand,
  sessionId,
} from "./actions.ts";
import { showContextMenu } from "./context.ts";
import { useKeybindings } from "./keybindings.ts";
import { ago, arrangeTiles, buildRows, flatten, fieldsOf, inSpace, nextAfterClose, pushHistory, shortPath, spaceAttention, windowIdOf, type SidebarRow } from "./model.ts";
import { getState, onNotification, onWindowFocus, spaceOfWindow, usePersisted, useSpaceView, useStore } from "./store.ts";
import { terminals } from "./terminals.ts";
import { DEFAULT_FRACTION, nextPreset, withWidth } from "./strip.ts";
import { DEFAULT_CAMERA, type Camera } from "./canvas.ts";
import type { Rect } from "./layouts.ts";
import { windowActions } from "./windowActions.ts";
import { stateStr, viewFor } from "./windows/registry.ts";
import { toggleMarkdownEdit } from "./windows/markdown.tsx";
import { MainView, type ViewMode } from "./components/MainView.tsx";
import { requestCanvas } from "./components/WindowsView.tsx";
import { Feedback } from "./components/Feedback.tsx";
import { PairSheet, useRemoteNotifications } from "./components/Remote.tsx";
import { Palette, type PaletteItem } from "./components/Palette.tsx";
import { Sidebar, SIDEBAR_WIDTH, type SidebarRequest } from "./components/Sidebar.tsx";
import { SpaceBar } from "./components/SpaceBar.tsx";
import { SpaceIconPicker } from "./components/SpaceIcon.tsx";
import { closeSpace, showSpace, usePickers, type Picker } from "./spaces.tsx";
import { StatusBar } from "./components/StatusBar.tsx";

/** True when a text field (palette, settings) has focus, so Edit commands target it. */
const editingText = () => {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el.isContentEditable) return true; // CodeMirror (text windows)
  return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.closest(".xterm");
};

/** Copy / Select All in the focused browser page (its own WebContents), input, text window or Magic widget. */
const editNative = (op: "copy" | "selectAll") => {
  const el = document.activeElement;
  cmd.editNative(op, el?.tagName === "WEBVIEW" ? (el as WebviewTag).getWebContentsId() : undefined);
};

/** Visual bell: flash the window's outline (restarts if it's already flashing). */
function flashWindow(paneId: PaneId): void {
  const tile = document.querySelector<HTMLElement>(`.tile[data-pane="${CSS.escape(paneId)}"]`);
  if (!tile) return;
  tile.classList.remove("bell");
  void tile.offsetWidth; // restart the animation
  tile.classList.add("bell");
  // Only the tile's own animation: title-bar slots inside it animate too.
  const done = (e: AnimationEvent) => {
    if (e.target !== tile) return;
    tile.classList.remove("bell");
    tile.removeEventListener("animationend", done);
  };
  tile.addEventListener("animationend", done);
}

export function App() {
  /** Everything, every Space: attention, the Dock badge, cross-Space jumps. */
  const all = useStore();
  /** What this app window shows: its Space's terminals, agents and windows. */
  const s = useMemo(() => inSpace(all), [all]);
  useRemoteNotifications();
  const space = all.spaces.get(all.spaceId);
  const keys = useKeybindings();
  const cfg = s.settings.settings;
  // Per Space, remembered across restarts (stored in the core, see useSpaceView).
  const [selected, setSelected] = useSpaceView<PaneId | null>("selection.pane", null);
  // Most recently used terminals, for picking what to focus after one closes.
  const [history, setHistory] = useSpaceView<PaneId[]>("selection.history", []);
  const [mode, setMode] = useSpaceView<ViewMode>("view.mode", cfg["ui.defaultView"]);
  // The layout Toggle Focus returns to: the last mode other than focus, however focus was entered.
  const [layoutMode, setLayoutMode] = useSpaceView<ViewMode>("view.layoutMode", "grid");
  useEffect(() => {
    if (mode !== "focus" && mode !== layoutMode) setLayoutMode(mode);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sidebarOpen, setSidebarOpen] = usePersisted("sidebar.open", true);
  // null: the default width (double-click the sidebar's edge).
  const [sidebarWidth, setSidebarWidth] = usePersisted<number | null>("sidebar.width", null);
  const [sidebarRequest, setSidebarRequest] = useState<SidebarRequest | null>(null);
  const [zoom, setZoom] = usePersisted("terminal.zoom", 0);
  const [recent, setRecent] = usePersisted<string[]>("palette.recent", []);
  // One spatial order shared by grid and strip.
  const [gridOrder, setGridOrder] = useSpaceView<PaneId[]>("grid.order", []);
  // Strip widths as fractions of the pane (see strip.ts).
  const [stripWidths, setStripWidths] = useSpaceView<Record<PaneId, number>>("strip.widths", {});
  // Canvas: where each window sits (world px) and the camera (see canvas.ts).
  const [canvasRects, setCanvasRects] = useSpaceView<Record<PaneId, Rect>>("canvas.rects", {});
  const [camera, setCamera] = useSpaceView<Camera>("canvas.camera", DEFAULT_CAMERA);
  const setStripWidth = (id: PaneId, fraction: number) =>
    setStripWidths((w) => withWidth(w, id, fraction, getState()));
  // Transient: sheets don't reopen on launch.
  /** Palette open, with an optional initial query ("?" for session search). */
  const [palette, setPalette] = useState<false | string>(false);
  const [feedback, setFeedback] = useState(false);
  /** Space pickers (open/switch, move a window, rename); see spaces.tsx. */
  const [picker, setPicker] = useState<Picker | null>(null);

  // Spaces: the switcher's order, what waits in each, and the one shown before (Last Space).
  const openSpaces = useMemo(() => [...all.spaces.values()].sort((a, b) => a.order - b.order), [all.spaces]);
  const waiting = useMemo(() => spaceAttention(all), [all.agents, all.panes]);
  const lastSpace = useRef<SpaceId | null>(null);
  const shownSpace = useRef(all.spaceId);
  useEffect(() => {
    if (shownSpace.current !== all.spaceId) lastSpace.current = shownSpace.current;
    shownSpace.current = all.spaceId;
  }, [all.spaceId]);
  useEffect(() => void (document.title = space?.name ?? "cmd"), [space?.name]);

  useEffect(() => terminals.setZoom(zoom), [zoom]);

  const rows = useMemo(() => buildRows(s), [s]);
  const flat = useMemo(() => flatten(rows), [rows]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Set by a click on the empty canvas: "nothing selected" on purpose, so the
  // effect below doesn't pick a window again (until you leave the canvas).
  const deselected = useRef(false);
  const deselect = useCallback(() => {
    deselected.current = true;
    (document.activeElement as HTMLElement | null)?.blur();
    setSelected(null);
  }, []);

  const select = useCallback((paneId: PaneId) => {
    // In another Space: main shows that Space (here or in the window showing it) and selects it there.
    const target = spaceOfWindow(paneId);
    if (target && target !== getState().spaceId) return showSpace(target, { select: paneId });
    deselected.current = false;
    setSelected(paneId);
    setHistory((h) => pushHistory(h, paneId));
    const agentId = getState().panes.get(paneId)?.agentId;
    if (agentId) void cmd.call("agent.markSeen", { agentId });
  }, []);

  useEffect(() => bindSelection(select, () => selectedRef.current), [select]);
  useEffect(() => windowSelected(selected), [selected]);
  useEffect(() => void performance.mark("boot:app-mounted"), []);
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
    if (!selected && deselected.current && mode === "canvas") return;
    const alive = new Set(viewOrder);
    const next = selected
      ? nextAfterClose(selected, history, viewOrderBefore.current, alive)
      : (history.find((id) => alive.has(id)) ?? viewOrder[0] ?? null);
    if (next !== selected) {
      if (next) select(next);
      else setSelected(null);
    }
  }, [s.connected, s.panes, viewOrder, selected, history, select, mode]);

  // Remember this render's order for the next close (declared after the effect above, so it
  // still sees the order from before the terminal disappeared).
  useEffect(() => {
    viewOrderBefore.current = viewOrder;
  }, [viewOrder]);

  // Looking at a window (selected, app focused) counts as seeing it: an agent's
  // finished turn, a terminal's attention marker, its notification in Notification Center.
  const [appFocused, setAppFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setAppFocused(true);
    const off = () => setAppFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => (window.removeEventListener("focus", on), window.removeEventListener("blur", off));
  }, []);
  useEffect(() => {
    if (!selected || !appFocused) return;
    const pane = s.panes.get(selected);
    const a = pane ? s.agents.get(pane.agentId ?? "") : undefined;
    if (a && bucketOf(a) === "unseen") void cmd.call("agent.markSeen", { agentId: a.id });
    if (pane?.attention) void cmd.call("pane.clearAttention", { paneId: pane.id });
    cmd.closeNotification(selected);
  }, [s, selected, appFocused]);

  // Dock badge: agents and terminals waiting for you, in every Space.
  const attention = useMemo(
    () =>
      [...all.agents.values()].filter(needsAttention).length +
      [...all.panes.values()].filter((p) => p.attention && !p.agentId).length,
    [all.agents, all.panes],
  );
  useEffect(() => cmd.setBadge(cfg["notifications.dockBadge"] ? attention : 0), [attention, cfg]);

  // The Dock icon's progress bar: the average of the terminals reporting one (OSC 9;4).
  const progress = useMemo(() => {
    const bars = [...all.panes.values()].flatMap((p) => (p.progress ? [p.progress] : []));
    if (!bars.length) return -1;
    if (bars.every((b) => b.state === "indeterminate")) return 2; // >1: indeterminate
    const valued = bars.filter((b) => b.state !== "indeterminate");
    return valued.reduce((n, b) => n + b.value, 0) / valued.length / 100;
  }, [all.panes]);
  useEffect(() => cmd.setProgress(progress), [progress]);

  // Notifications: the core decides what's worth telling (packages/core/src/notifications.ts);
  // here, whether and how to show it, since only the UI knows focus and selection.
  useEffect(() => {
    const offClick = cmd.onNotificationClick((paneId) => select(paneId));
    const off = onNotification((n) => {
      const c = getState().settings.settings;
      if (n.source === "bell" && n.paneId && c["notifications.visualBell"]) flashWindow(n.paneId);
      if (!n.alert) return;
      const looking = document.hasFocus() && n.paneId !== null && n.paneId === selectedRef.current;
      if (c["notifications.when"] === "never" || (c["notifications.when"] === "background" && looking)) return;
      const sound = c["notifications.sound"];
      cmd.notify({
        tag: n.paneId ?? n.id,
        title: n.title,
        body: n.body,
        sound: n.urgent && sound !== "none" ? sound : null,
        paneId: n.paneId,
      });
      const bounce = c["notifications.bounceDock"];
      if (!document.hasFocus() && (bounce === "any" || (bounce === "needsInput" && n.urgent))) cmd.bounce();
    });
    return () => (off(), offClick());
  }, [select]);

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

  /** ⌃⌘[ / ⌃⌘]: the switcher's order, wrapping around. */
  const stepSpace = (d: number) => {
    const i = openSpaces.findIndex((x) => x.id === all.spaceId);
    const next = openSpaces[(i + d + openSpaces.length) % openSpaces.length];
    if (next && next.id !== all.spaceId) showSpace(next.id);
  };

  // ── commands ───────────────────────────────────────────
  // One handler per command id; the menu bar, palette and context menus all call these.
  const findIn = (r: "open" | "next" | "prev") => {
    if (!selected || editingText()) return;
    if (s.panes.has(selected)) terminals.requestFind(selected, r);
    else windowActions(selected)?.find?.(r);
  };
  const handlers: Record<CommandId, () => void> = {
    "app.settings": () => cmd.openSettings(),
    "app.checkUpdates": () => cmd.checkForUpdates(),
    "app.restartCore": () => void restartCore(),
    "app.remoteAccess": () => cmd.openSettings("remote"),
    "app.pairDevice": () => cmd.openSettings("remote/pair"),
    "app.disconnectRemote": () => void cmd.call("remote.disconnect", {}).catch(() => {}),
    "file.newTerminal": () => void newTerminal(),
    "file.newClaude": () => void newAgent("claude"),
    "file.newCodex": () => void newAgent("codex"),
    "file.newBrowser": () => void newBrowser(),
    "file.newFiles": () => void newFiles(),
    "file.newText": () => void newText(),
    "file.newMagic": () => void newMagic(),
    "view.magicChange": () => windowActions(selected)?.change?.(),
    "view.magicRefresh": () => windowActions(selected)?.refresh?.(),
    "view.magicStop": () => windowActions(selected)?.stop?.(),
    "file.close": () => {
      // ⌘W closes the frontmost thing: the palette, then the terminal, then the window.
      if (feedback) setFeedback(false);
      else if (picker) setPicker(null);
      else if (palette !== false) setPalette(false);
      else if (selected) void closePane(selected);
      else cmd.closeWindow();
    },
    "file.closeWindow": () => cmd.closeWindow(),
    "file.save": () => void windowActions(selected)?.save?.(),
    "file.openSettingsFile": () => cmd.openSettingsFile(getState().settings.path),
    // Terminals copy and select their own buffer; everything else (inputs, text and
    // files windows, browser pages, Magic widgets) gets the native command.
    "edit.copy": () => {
      if (editingText() || !selected || !s.panes.has(selected) || !terminals.copy(selected)) editNative("copy");
    },
    "edit.selectAll": () => {
      if (editingText() || !selected || !s.panes.has(selected)) editNative("selectAll");
      else terminals.selectAll(selected);
    },
    "edit.clear": () => selected && terminals.clear(selected),
    // Find in the terminal's scrollback, or in a text window (CodeMirror's panel).
    "edit.find": () => findIn("open"),
    "edit.findNext": () => findIn("next"),
    "edit.findPrev": () => findIn("prev"),
    "edit.copyLastOutput": () => selected && s.panes.has(selected) && terminals.copyLastOutput(selected),
    "terminal.prevPrompt": () => selected && terminals.jumpToPrompt(selected, -1),
    "terminal.nextPrompt": () => selected && terminals.jumpToPrompt(selected, 1),
    "view.palette": () => setPalette((p) => (p === false ? "" : false)),
    "view.search": () => (setSidebarOpen(true), setSidebarRequest({ kind: "search", at: Date.now() })),
    "view.focus": () => setMode("focus"),
    "view.grid": () => setMode("grid"),
    "view.strip": () => setMode("strip"),
    "view.canvas": () => setMode("canvas"),
    "view.toggleFocus": () => setMode(mode === "focus" ? layoutMode : "focus"),
    "view.canvasFit": () => (setMode("canvas"), requestCanvas("fit")),
    "view.canvasZoomWindow": () => (setMode("canvas"), requestCanvas("window")),
    "view.toggleEdit": () => {
      const w = selected ? s.windows.get(selected) : undefined;
      const own = windowActions(selected)?.toggleEdit;
      if (own) own();
      else if (w) toggleMarkdownEdit(w);
    },
    "view.cycleWidth": () => {
      if (!selected) return;
      if (mode !== "strip") setMode("strip");
      setStripWidth(selected, nextPreset(stripWidths[selected] ?? DEFAULT_FRACTION));
    },
    "view.sidebar": () => setSidebarOpen((o) => !o),
    "view.zoomIn": () => setZoom((z) => Math.min(24, z + 1)),
    "view.zoomOut": () => setZoom((z) => Math.max(-6, z - 1)),
    "view.zoomReset": () => setZoom(0),
    "session.next": () => step(1),
    "session.prev": () => step(-1),
    "session.nextAttention": () => {
      // This Space first, then the others (select switches Space).
      const wants = (r: SidebarRow) => r.pane && ((r.agent && needsAttention(r.agent)) || (!r.agent && r.pane.attention));
      const target = flat.find(wants) ?? flatten(buildRows(all)).find(wants);
      if (target?.pane) select(target.pane.id);
    },
    "session.copyResume": () => currentAgent && void copyResumeCommand(currentAgent),
    "session.copyId": () => {
      const id = currentAgent && sessionId(currentAgent);
      if (id) copy(id);
    },
    "session.reveal": () => current && cmd.openPath(current.cwd),
    ...(Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`session.select${n}`, () => withPane[n - 1] && selectRow(withPane[n - 1]!)]),
    ) as Record<`session.select${number}`, () => void>),
    "file.openSpace": () => setPicker({ kind: "space" }),
    "space.next": () => stepSpace(1),
    "space.prev": () => stepSpace(-1),
    "space.last": () => lastSpace.current && all.spaces.has(lastSpace.current) && showSpace(lastSpace.current),
    "space.moveWindow": () => selected && setPicker({ kind: "move", windowId: selected }),
    "space.rename": () => space && setPicker({ kind: "rename", space }),
    "space.icon": () => space && setPicker({ kind: "icon", space }),
    "space.reveal": () => space && cmd.openPath(space.root),
    "space.close": () => space && void closeSpace(space),
    ...(Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`space.select${n}`, () => openSpaces[n - 1] && showSpace(openSpaces[n - 1]!.id)]),
    ) as Record<`space.select${number}`, () => void>),
    "help.docs": () => cmd.openDocs(),
    "help.feedback": () => (setPalette(false), setFeedback(true)),
  };
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const run = useCallback((id: string) => handlersRef.current[id as CommandId]?.(), []);

  useEffect(() => cmd.onCommand(run), [run]);
  useEffect(() => cmd.onOpenUrl(openLink), []);
  // `open` in a terminal: follow it, unless it came from another Space while this window is in the background.
  useEffect(() => onWindowFocus((id) => (document.hasFocus() || spaceOfWindow(id) === getState().spaceId) && select(id)), [select]);

  // Tell the menu bar what is checked/enabled.
  const selectedIsPane = !!selected && s.panes.has(selected);
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
        "edit.copyLastOutput": selectedIsPane,
        "terminal.prevPrompt": selectedIsPane,
        "terminal.nextPrompt": selectedIsPane,
        "session.next": withPane.length > 1,
        "session.prev": withPane.length > 1,
        "session.copyResume": !!(currentAgent && sessionId(currentAgent)),
        "session.copyId": !!(currentAgent && sessionId(currentAgent)),
        "session.reveal": hasPane,
        "session.nextAttention": attention > 0,
        "space.next": openSpaces.length > 1,
        "space.prev": openSpaces.length > 1,
        "space.moveWindow": hasPane && openSpaces.length > 1,
        "space.close": !!space && !space.home,
        "space.rename": !!space,
        "space.icon": !!space,
      },
    });
  }, [mode, sidebarOpen, selected, selectedIsPane, withPane.length, currentAgent, attention, openSpaces.length, space]);

  // ── context menus ──────────────────────────────────────

  const rowMenu = (r: SidebarRow) => {
    const a = r.agent;
    const winPath = r.win && stateStr(r.win, "path");
    const cwd = a?.cwd ?? r.pane?.cwd ?? (r.win?.kind === "files" ? winPath : winPath?.split("/").slice(0, -1).join("/")) ?? undefined;
    const id = a && sessionId(a);
    const own = r.win ? (viewFor(r.win.kind)?.actions?.(r.win) ?? []) : [];
    void showContextMenu([
      ...(own.length ? [...own, "-" as const] : []),
      ...(windowIdOf(r)
        ? [
            { label: "Show", run: () => select(windowIdOf(r)!) },
            ...(r.pane ? [muteEntry(r.pane.id)] : []),
            { label: "Move to Space…", run: () => setPicker({ kind: "move", windowId: windowIdOf(r)! }), enabled: openSpaces.length > 1 },
            { label: r.pane ? "Close Terminal" : "Close Window", run: () => void closePane(windowIdOf(r)!) },
            "-" as const,
          ]
        : []),
      // Entries the window's type contributes (see windows/registry.ts).
      ...(r.win ? [...(viewFor(r.win.kind)?.menu?.(r.win) ?? []), "-" as const] : []),
      ...(a
        ? [
            { label: "Copy Resume Command", run: () => void copyResumeCommand(a), enabled: !!id },
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

  /** Right-click on a Space in the switcher. */
  const spaceMenu = (sp: Space) =>
    void showContextMenu([
      { label: "Show", run: () => showSpace(sp.id), enabled: sp.id !== all.spaceId },
      { label: "Open in New Window", run: () => showSpace(sp.id, { newWindow: true }), enabled: sp.id !== all.spaceId },
      "-",
      { label: "Rename…", run: () => setPicker({ kind: "rename", space: sp }) },
      { label: "Change Icon…", run: () => setPicker({ kind: "icon", space: sp }) },
      { label: "Show Folder in Finder", run: () => cmd.openPath(sp.root) },
      { label: "Copy Path", run: () => copy(sp.root) },
      "-",
      { label: "Close Space…", run: () => void closeSpace(sp), enabled: !sp.home },
    ]);

  const spaceBar = (
    <SpaceBar
      spaces={openSpaces}
      current={all.spaceId}
      attention={waiting}
      onShow={(id, opts) => showSpace(id, opts)}
      onMenu={spaceMenu}
      onPicker={() => setPicker({ kind: "space" })}
    />
  );
  const pickerProps = usePickers(picker, () => setPicker(null));

  /** The sidebar's + button. */
  const newMenu = () =>
    void showContextMenu(
      (["file.newTerminal", "file.newClaude", "file.newCodex", "-", "file.newBrowser", "file.newFiles", "file.newText", "file.newMagic"] as const).map((id) =>
        id === "-" ? id : { label: COMMANDS.find((c) => c.id === id)!.label, run: () => run(id) },
      ),
    );

  /** Per-terminal mute: no system notifications from it (its marker still shows). */
  const muteEntry = (paneId: PaneId) => {
    const muted = !!getState().panes.get(paneId)?.muted;
    return {
      label: muted ? "Unmute Notifications" : "Mute Notifications",
      run: () => void cmd.call("pane.setMuted", { paneId, muted: !muted }),
    };
  };

  const terminalMenu = (paneId: PaneId) => {
    select(paneId);
    void showContextMenu([
      { label: "Copy", run: () => terminals.copy(paneId), enabled: terminals.hasSelection(paneId) },
      { label: "Paste", run: () => void navigator.clipboard.readText().then((t) => terminals.paste(paneId, t)) },
      { label: "Select All", run: () => terminals.selectAll(paneId) },
      { label: "Copy Last Command Output", run: () => terminals.copyLastOutput(paneId) },
      { label: "Find…", run: () => terminals.requestFind(paneId, "open") },
      "-",
      { label: "Clear Buffer", run: () => terminals.clear(paneId) },
      {
        // For when a crashed program leaves modes on (mouse reporting, odd charsets).
        label: "Reset Terminal",
        run: () => {
          terminals.reset(paneId);
          void cmd.call("pane.reset", { paneId });
        },
      },
      "-",
      muteEntry(paneId),
      "-",
      { label: "Close Terminal", run: () => void closePane(paneId) },
    ]);
  };

  // ── palette ────────────────────────────────────────────

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
    ...withPane.map((r) => {
      const f = fieldsOf(r, undefined, Date.now());
      return {
        id: `s-${r.key}`,
        group: "Sessions" as const,
        label: f.place ? `${f.name} — ${f.place}` : f.name,
        run: () => select(windowIdOf(r)!),
      };
    }),
  ];

  return (
    <div
      className={`app ${sidebarOpen ? "" : "no-sidebar"} ${cfg["ui.unfocusedDesaturation"] > 0 ? "desaturate" : ""} focus-${cfg["ui.focusColor"]} title-tint-${cfg["ui.focusTitleBar"]} shadow-${cfg["ui.windowShadow"]}`}
      style={{
        ["--sidebar-w" as string]: `${sidebarWidth ?? SIDEBAR_WIDTH.default}px`,
        ["--window-radius" as string]: `${cfg["ui.windowRadius"]}px`,
        ["--gutter" as string]: `${cfg["ui.gutter"]}px`,
        ["--sidebar-pad" as string]: `${cfg["ui.sidebarPadding"]}px`,
        ["--pad-x" as string]: `${cfg["ui.paddingX"]}px`,
        ["--pad-y" as string]: `${cfg["ui.paddingY"]}px`,
        ["--window-dim-amount" as string]: `${cfg["ui.unfocusedDim"] / 100}`,
        ["--window-desaturate" as string]: `${cfg["ui.unfocusedDesaturation"] / 100}`,
        ["--window-outline" as string]: `${cfg["ui.windowOutline"]}px`,
        ["--window-edge-mix" as string]: `${cfg["ui.windowOutlineContrast"]}%`,
        ["--focus-outline" as string]: `${cfg["ui.focusOutline"]}px`,
        ["--focus-glow" as string]: `${cfg["ui.focusGlow"] / 50}`,
      }}
    >
      {!sidebarOpen && <div className="drag-strip">{spaceBar}</div>}
      {sidebarOpen && (
        <Sidebar
          spaceBar={spaceBar}
          rows={rows}
          selected={selected}
          onSelect={selectRow}
          onRowMenu={rowMenu}
          onClose={(r) => windowIdOf(r) && void closePane(windowIdOf(r)!)}
          onNew={newMenu}
          onNewTerminal={() => void newTerminal()}
          onWidth={setSidebarWidth}
          request={sidebarRequest}
          search={s.search}
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
        onTitleMenu={rowMenu}
        gridOrder={gridOrder}
        onGridReorder={setGridOrder}
        stripWidths={stripWidths}
        canvasRects={canvasRects}
        onCanvasRects={setCanvasRects}
        camera={camera}
        onCamera={setCamera}
        onDeselect={deselect}
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
              t.kind === "url"
                ? { id: `open-url`, group: "Commands" as const, label: `Open ${t.value}`, hint: "url", run: () => void openPath(t.value) }
                : { id: `open-path`, group: "Commands" as const, label: `Open ${t.value}`, hint: "path", run: () => void openPath(t.value) },
            ];
          }}
          recent={recent}
          onRun={remember}
          onClose={() => setPalette(false)}
          initialQuery={palette}
          search={searchSessions}
          searchStatus={s.search}
        />
      )}
      {pickerProps && picker && <Palette key={picker.kind} {...pickerProps} />}
      {picker?.kind === "icon" && <SpaceIconPicker space={all.spaces.get(picker.space.id) ?? picker.space} onClose={() => setPicker(null)} />}
      {feedback && <Feedback onClose={() => setFeedback(false)} />}
      {all.pairRequests[0] && <PairSheet key={all.pairRequests[0].requestId} request={all.pairRequests[0]} />}
    </div>
  );
}
