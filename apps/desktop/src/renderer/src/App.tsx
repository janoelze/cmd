import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GLIDE_MS, Presence, Toaster, toast, usePresentValue } from "@cmd/ui";
import type { ActionsList, PaneId, Workspace, WorkspaceId } from "@cmd/protocol";
import { listActions, rerunLastAction, runAction, showActions } from "./workspaceActions.ts";
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
  openLink,
  openPath,
  openFileAt,
  contextCwd,
  openSession,
  copyResumeCommand,
  sessionId,
  summarizeSession,
} from "./actions.ts";
import { aiStatus, useAiStatus } from "./ai/status.ts";
import { showContextMenu, type MenuEntry } from "./context.ts";
import { useKeybindings } from "./keybindings.ts";
import { ago, arrangeTiles, buildRows, flatten, fieldsOf, inWorkspace, isWidget, nextAfterClose, pushHistory, setCmdNames, shortPath, workspaceAttention, wantsYou, windowAttention, windowIdOf, type SidebarRow } from "./model.ts";
import { getWorkspaceView, getState, onNotification, onWindowFocus, setWorkspaceView, setUsageShown, workspaceOfWindow, usePersisted, useWorkspaceView, useStore } from "./store.ts";
import { terminals } from "./terminals.ts";
import { DoneBatch, Looks } from "./notify.ts";
import { DEFAULT_FRACTION, MIN_WIDTH, nextPreset, stepFraction, withWidth } from "./strip.ts";
import { DEFAULT_CAMERA, type Camera } from "./canvas.ts";
import type { Rect } from "./layouts.ts";
import { useWindowActions, windowActions } from "./windowActions.ts";
import type { FindRequest } from "./find.tsx";
import { stateStr, viewFor } from "./windows/registry.ts";
import { togglePreview } from "./windows/preview.ts";
import { MainView, type ViewMode } from "./components/MainView.tsx";
import { requestCanvas } from "./components/WindowsView.tsx";
import { Feedback } from "./components/Feedback.tsx";
import { TaskManager } from "./components/TaskManager.tsx";
import { WidgetLibrary } from "./components/WidgetLibrary.tsx";
import { NewPicker } from "./components/NewPicker.tsx";
import { openItems } from "./newItems.ts";
import { APP_VERSION, RELEASES, releasesSince, WhatsNew } from "./components/WhatsNew.tsx";
import { closeSetup, Onboarding, showSetup, stepsAtLaunch, useSetup } from "./onboarding/Onboarding.tsx";
import { compareVersions, type Release } from "../../shared/changelog.ts";
import { PairSheet, useRemoteNotifications } from "./components/Remote.tsx";
import { SitePermissionSheet } from "./components/SitePermissionSheet.tsx";
import { Palette, SEARCH_PREFIX as SEARCH, type PaletteItem } from "./components/Palette.tsx";
import { NavigatorContext, type NavigatorData } from "./components/Navigator.tsx";
import { Dock } from "./components/Dock.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { dock, dockedIds, dockWidths, DOCK_WIDTH, liveDocks, MIN_BOARD, readDocks, sideOf, SIDES, undock, type Docks, type Side } from "./docks.ts";
import { WorkspaceBar } from "./components/WorkspaceBar.tsx";
import { WorkspaceIconPicker } from "./components/WorkspaceIcon.tsx";
import { closeWorkspace, showWorkspace, usePickers, type Picker } from "./workspaces.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { countRender } from "./perf.ts";

/** True when a text field (palette, settings) has focus, so Edit commands target it. */
/** What the palette's search matches besides past sessions: what's open. */
const SEARCH_GROUPS = ["Sessions"];

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
  countRender("App");
  /** Everything, every workspace: attention, the Dock badge, cross-workspace jumps. */
  const all = useStore();
  // Before any row is drawn: whether an unnamed agent waits for cmd's name (model.ts).
  const naming = !!useAiStatus()?.ready;
  setCmdNames(naming && all.settings.settings["agents.names.ai"]);
  /** What this app window shows: its workspace's terminals, agents and windows. */
  const s = useMemo(() => inWorkspace(all), [all]);
  useRemoteNotifications();
  const workspace = all.workspaces.get(all.workspaceId);
  const keys = useKeybindings();
  const cfg = s.settings.settings;
  // Per workspace, remembered across restarts (stored in the core, see useWorkspaceView).
  const [selected, setSelected] = useWorkspaceView<PaneId | null>("selection.pane", null);
  // Most recently used terminals, for picking what to focus after one closes.
  const [history, setHistory] = useWorkspaceView<PaneId[]>("selection.history", []);
  const [mode, setMode] = useWorkspaceView<ViewMode>("view.mode", cfg["ui.defaultView"]);
  // The layout Toggle Focus returns to: the last mode other than focus, however focus was entered.
  const [layoutMode, setLayoutMode] = useWorkspaceView<ViewMode>("view.layoutMode", "grid");
  useEffect(() => {
    if (mode !== "focus" && mode !== layoutMode) setLayoutMode(mode);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  // The sidebar before sidebars were windows: carried over into each workspace's first Navigator.
  const [sidebarOpen] = usePersisted("sidebar.open", true);
  const [sidebarWidth] = usePersisted<number | null>("sidebar.width", null);
  const [zoom, setZoom] = usePersisted("terminal.zoom", 0);
  const [recent, setRecent] = usePersisted<string[]>("palette.recent", []);
  // One spatial order shared by grid and strip.
  const [gridOrder, setGridOrder] = useWorkspaceView<PaneId[]>("grid.order", []);
  // Strip widths as fractions of the pane (see strip.ts).
  const [stripWidths, setStripWidths] = useWorkspaceView<Record<PaneId, number>>("strip.widths", {});
  // Canvas: where each window sits (world px) and the camera (see canvas.ts).
  const [canvasRects, setCanvasRects] = useWorkspaceView<Record<PaneId, Rect>>("canvas.rects", {});
  const [camera, setCamera] = useWorkspaceView<Camera>("canvas.camera", DEFAULT_CAMERA);
  const setStripWidth = (id: PaneId, fraction: number) =>
    setStripWidths((w) => withWidth(w, id, fraction, getState()));
  // Transient: sheets don't reopen on launch.
  /** Palette open, with an optional initial query ("?" for session search). */
  const [palette, setPalette] = useState<false | string>(false);
  // The workspace's Workspace Actions, read when the palette opens (its Actions group).
  const [paletteActions, setPaletteActions] = useState<ActionsList | null>(null);
  useEffect(() => {
    if (palette === false) return;
    let live = true;
    void listActions(getState().workspaceId).then((l) => live && setPaletteActions(l));
    return () => void (live = false);
  }, [palette === false]);
  const [feedback, setFeedback] = useState(false);
  const [taskManager, setTaskManager] = useState(false);
  /** The Widget Library sheet (docs/16-widgets.md). */
  const [library, setLibrary] = useState(false);
  /** The releases the What's New sheet shows, when it's open. */
  const [whatsNew, setWhatsNew] = useState<Release[] | null>(null);
  const setup = useSetup();
  /** What's New waits for onboarding to close. */
  const whatsNewLater = useRef<Release[] | null>(null);
  const endSetup = () => {
    closeSetup();
    if (whatsNewLater.current) setWhatsNew(whatsNewLater.current), (whatsNewLater.current = null);
  };
  /** Workspace pickers (open/switch, move a window, rename); see workspaces.tsx. */
  const [picker, setPicker] = useState<Picker | null>(null);
  /** Sidebars sliding in or out after View → Show Sidebar (one hidden is kept until it's out of sight). */
  const [sliding, setSliding] = useState<Partial<Record<Side, { dir: "in" | "out"; row?: SidebarRow; width?: number }>>>({});
  const slideTimers = useRef<Partial<Record<Side, ReturnType<typeof setTimeout>>>>({});

  // Workspaces: the switcher's order, what waits in each, and the one shown before (Last Workspace).
  const openWorkspaces = useMemo(() => [...all.workspaces.values()].sort((a, b) => a.order - b.order), [all.workspaces]);
  const waiting = useMemo(() => workspaceAttention(all), [all.agents, all.panes]);
  const lastWorkspace = useRef<WorkspaceId | null>(null);
  const shownWorkspace = useRef(all.workspaceId);
  useEffect(() => {
    if (shownWorkspace.current !== all.workspaceId) lastWorkspace.current = shownWorkspace.current;
    shownWorkspace.current = all.workspaceId;
  }, [all.workspaceId]);
  useEffect(() => void (document.title = workspace?.name ?? "cmd"), [workspace?.name]);

  useEffect(() => terminals.setZoom(zoom), [zoom]);

  // Sidebars (docs/21-sidebars.md): docked windows, per workspace. Unset until the
  // Workspace's first Navigator is made (below); sides whose window is gone are empty.
  const [storedDocks, setStoredDocks] = useWorkspaceView<Docks | null>("docks", null);
  const docks = useMemo(
    () => liveDocks(readDocks(storedDocks), (id) => s.panes.has(id) || s.windows.has(id)),
    [storedDocks, s.panes, s.windows],
  );
  const docked = useMemo(() => dockedIds(docks), [docks]);
  /** Change this workspace's sidebars (from what's live, so stale ids drop out). */
  const setDocks = (f: (d: Docks) => Docks) => setStoredDocks(f(docks));
  useFirstNavigator(all.workspaceId, !!workspace && s.connected, storedDocks === null, { hidden: !sidebarOpen, width: sidebarWidth });
  const winWidth = useWindowWidth();
  const widths = dockWidths(docks, winWidth);

  // Every row of the workspace (the Navigator's, Dock badge…), and the board's: without sidebars.
  const allRows = useMemo(() => buildRows(s), [s]);
  // A workspace's first Navigator is docked once its window.open returns, which can be a
  // render after the window itself arrives: until the workspace has sidebars, a Navigator
  // isn't a board window (it would show full size for a frame, then jump left).
  const unsetDocks = storedDocks === null;
  const rows = useMemo(
    () => allRows.filter((r) => !docked.has(windowIdOf(r) ?? "") && !(unsetDocks && r.win?.kind === "navigator")),
    [allRows, docked, unsetDocks],
  );
  const flat = useMemo(() => flatten(rows), [rows]);
  const allFlat = useMemo(() => flatten(allRows), [allRows]);
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
    // In another workspace: main shows that workspace (here or in the window showing it) and selects it there.
    const target = workspaceOfWindow(paneId);
    if (target && target !== getState().workspaceId) return showWorkspace(target, { select: paneId });
    deselected.current = false;
    setSelected(paneId);
    setHistory((h) => pushHistory(h, paneId));
    const agentId = getState().panes.get(paneId)?.agentId;
    if (agentId) void cmd.call("agent.markSeen", { agentId });
  }, []);

  useEffect(() => bindSelection(select, () => selectedRef.current), [select]);
  useEffect(() => windowSelected(selected), [selected]);
  useEffect(() => setUsageShown(selected), [selected]);
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
  // What you look at and when you looked away, for notifications (notify.ts):
  // an agent you watched finish isn't news, and one you look at leaves the next sum.
  const [looks] = useState(() => new Looks());
  const [doneBatch] = useState(() => new DoneBatch());
  useEffect(() => {
    looks.look(appFocused ? selected : null);
    if (appFocused && selected) doneBatch.seen(selected);
  }, [selected, appFocused]); // eslint-disable-line react-hooks/exhaustive-deps
  // Only what it reads: on every store change this sent IPC (closeNotification) and repeated RPCs.
  const selectedPane = selected ? s.panes.get(selected) : undefined;
  const selectedAgent = selectedPane ? s.agents.get(selectedPane.agentId ?? "") : undefined;
  const selectedUnseen = !!selectedAgent && bucketOf(selectedAgent) === "unseen";
  const selectedAttention = !!selectedPane?.attention;
  const selectedWindowAttention = !!windowAttention(selected ? s.windows.get(selected) : null);
  useEffect(() => {
    if (!selected || !appFocused) return;
    if (selectedUnseen && selectedAgent) void cmd.call("agent.markSeen", { agentId: selectedAgent.id });
    if (selectedAttention) void cmd.call("pane.clearAttention", { paneId: selected });
    if (selectedWindowAttention) void cmd.call("window.clearAttention", { id: selected });
    cmd.closeNotification(selected);
  }, [selected, appFocused, selectedUnseen, selectedAttention, selectedWindowAttention]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dock badge: agents, terminals and other windows (widgets) waiting for you, in every workspace.
  const attention = useMemo(
    () =>
      [...all.agents.values()].filter(needsAttention).length +
      [...all.panes.values()].filter((p) => p.attention && !p.agentId).length +
      [...all.windows.values()].filter((w) => windowAttention(w)).length,
    [all.agents, all.panes, all.windows],
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
      // The window it's about: a terminal, or another window (a widget).
      const from = n.paneId ?? n.windowId ?? null;
      const looking = document.hasFocus() && from !== null && from === selectedRef.current;
      // An agent that finished while you watched it, or just after you looked away: you saw it.
      const saw = looking || (n.done !== undefined && from !== null && looks.saw(from, n.at));
      if (c["notifications.when"] === "never" || (c["notifications.when"] === "background" && saw)) return;
      // Agents that finish close together: one notification for all of them.
      const shown = n.done !== undefined && from !== null
        ? doneBatch.add({ tag: from, name: n.done, title: n.title, body: n.body, at: n.at })
        : { tag: from ?? n.id, title: n.title, body: n.body, replaces: [] };
      for (const tag of shown.replaces) cmd.closeNotification(tag);
      const sound = c["notifications.sound"];
      cmd.notify({
        tag: shown.tag,
        title: shown.title,
        body: shown.body,
        sound: n.urgent && sound !== "none" ? sound : null,
        paneId: from,
      });
      const bounce = c["notifications.bounceDock"];
      if (!document.hasFocus() && (bounce === "any" || (bounce === "needsInput" && n.urgent))) cmd.bounce();
    });
    // Posted, but macOS won't show it (main says so once per launch).
    const offBlocked = cmd.onNotifyBlocked((access) =>
      toast(access === "off" ? "macOS has cmd's notifications turned off" : "macOS shows cmd's notifications without a banner", {
        tone: "warning",
        duration: 10_000,
        action: { label: "Open System Settings", run: () => cmd.openNotifySettings() },
      }),
    );
    // A site was allowed the camera or microphone, but macOS won't give it to cmd (main: web-session.ts).
    const offMedia = cmd.onMediaBlocked((devices) =>
      toast(`macOS has cmd's ${devices.includes("camera") ? (devices.includes("microphone") ? "camera and microphone" : "camera") : "microphone"} turned off`, {
        tone: "warning",
        duration: 10_000,
        action: { label: "Open System Settings", run: () => cmd.openMediaSettings(devices[0]!) },
      }),
    );
    return () => (off(), offClick(), offBlocked(), offMedia());
  }, [select, looks, doneBatch]);

  /** The terminal a row lives in: its own, or for a subagent (no window of its own) its host's. */
  const homeOf = useCallback((r: SidebarRow): string | null => {
    const own = windowIdOf(r);
    if (own) return own;
    let at = r.agent;
    while (at && !at.paneId && at.parentId) at = s.agents.get(at.parentId) ?? null;
    return at?.paneId ?? null;
  }, [s.agents]);

  const selectRow = useCallback((r: SidebarRow) => {
    const id = homeOf(r);
    if (id) select(id);
  }, [select, homeOf]);
  /** Rows with a window (terminal, browser, files), sidebar order. */
  const withPane = useMemo(() => flat.filter((r) => r.pane || r.win), [flat]);
  /** The selected terminal, if the selected window is one. */
  const current = selected ? s.panes.get(selected) : undefined;
  const currentRow = allFlat.find((r) => windowIdOf(r) === selected);
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
  const stepWorkspace = (d: number) => {
    const i = openWorkspaces.findIndex((x) => x.id === all.workspaceId);
    const next = openWorkspaces[(i + d + openWorkspaces.length) % openWorkspaces.length];
    if (next && next.id !== all.workspaceId) showWorkspace(next.id);
  };

  // ── commands ───────────────────────────────────────────
  // One handler per command id; the menu bar, palette and context menus all call these.
  // In a field of the window's own (its find bar, a text window's editor) the window finds; in a sheet or the palette nothing does.
  const findIn = (r: FindRequest) => {
    if (!selected || (editingText() && document.activeElement?.closest("[role=dialog], .palette-backdrop"))) return;
    if (s.panes.has(selected)) terminals.requestFind(selected, r);
    else windowActions(selected)?.find?.(r);
  };
  // ⌥⌘+ / ⌥⌘−: the selected window's strip width in steps (the floor roughly MIN_WIDTH, so ⌥⌘+ always shows).
  const stepWidth = (dir: 1 | -1) => {
    if (!selected) return;
    if (mode !== "strip") setMode("strip");
    setStripWidth(selected, stepFraction(stripWidths[selected] ?? DEFAULT_FRACTION, dir, MIN_WIDTH / window.innerWidth));
  };
  const handlers: Record<CommandId, () => void> = {
    "app.settings": () => cmd.openSettings(),
    "app.setup": () => (setPalette(false), showSetup()),
    "app.checkUpdates": () => cmd.checkForUpdates(),
    "app.restartCore": () => void restartCore(),
    "app.remoteAccess": () => cmd.openSettings("remote"),
    "app.pairDevice": () => cmd.openSettings("remote/pair"),
    "app.disconnectRemote": () => void cmd.call("remote.disconnect", {}).catch(() => {}),
    "file.new": () => (setPalette(false), setLibrary(false), setPicker((p) => (p?.kind === "new" ? null : { kind: "new" }))),
    "file.newTerminal": () => void newTerminal(),
    "file.newClaude": () => void newAgent("claude"),
    "file.newCodex": () => void newAgent("codex"),
    "file.newBrowser": () => void newBrowser(),
    "file.newFiles": () => void newFiles(),
    "file.newText": () => void newText(),
    "file.newMagic": () => (setLibrary(false), void newMagic()),
    "widget.library": () => (setPalette(false), setLibrary((l) => !l)),
    "actions.show": () => (setPalette(false), void showActions()),
    "actions.rerun": () => void rerunLastAction().then((ran) => void (ran || showActions())),
    "widget.remove": () => {
      if (selected && isWidget(s.windows.get(selected))) void closePane(selected);
    },
    "view.magicChange": () => windowActions(selected)?.change?.(),
    "view.magicRefresh": () => windowActions(selected)?.refresh?.(),
    "view.magicStop": () => windowActions(selected)?.stop?.(),
    "file.close": () => {
      // ⌘W closes the frontmost thing: the palette, then the terminal, then the window.
      if (feedback) setFeedback(false);
      else if (taskManager) setTaskManager(false);
      else if (setup) endSetup();
      else if (library) setLibrary(false);
      else if (whatsNew) setWhatsNew(null);
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
    "edit.findReplace": () => findIn("replace"),
    "edit.findSelection": () => findIn("selection"),
    "edit.copyLastOutput": () => selected && s.panes.has(selected) && terminals.copyLastOutput(selected),
    "terminal.prevPrompt": () => selected && terminals.jumpToPrompt(selected, -1),
    "terminal.nextPrompt": () => selected && terminals.jumpToPrompt(selected, 1),
    "view.palette": () => setPalette((p) => (p === false ? "" : false)),
    // The palette in search mode (docs/33): `?` typed for you; backspace it for commands.
    "view.search": () => setPalette((p) => (p === SEARCH ? false : SEARCH)),
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
      else if (w) togglePreview(w);
    },
    "view.cycleWidth": () => {
      if (!selected) return;
      if (mode !== "strip") setMode("strip");
      setStripWidth(selected, nextPreset(stripWidths[selected] ?? DEFAULT_FRACTION));
    },
    "view.widen": () => stepWidth(1),
    "view.narrow": () => stepWidth(-1),
    "view.sidebar": () => toggleSide("left"),
    "view.rightSidebar": () => toggleSide("right"),
    "window.dockLeft": () => selected && setDocks((d) => dock(d, selected, "left")),
    "window.dockRight": () => selected && setDocks((d) => dock(d, selected, "right")),
    "window.undock": () => selected && setDocks((d) => undock(d, selected)),
    "window.screenshotSize": () => cmd.setWindowSize(1500, 900),
    // A window that zooms its own content (a PDF) takes ⌘+ ⌘− ⌘0 while selected.
    "view.zoomIn": () => (windowActions(selected)?.zoom ? windowActions(selected)!.zoom!(1) : setZoom((z) => Math.min(24, z + 1))),
    "view.zoomOut": () => (windowActions(selected)?.zoom ? windowActions(selected)!.zoom!(-1) : setZoom((z) => Math.max(-6, z - 1))),
    "view.zoomReset": () => (windowActions(selected)?.zoom ? windowActions(selected)!.zoom!(0) : setZoom(0)),
    "session.next": () => step(1),
    "session.prev": () => step(-1),
    "session.nextAttention": () => {
      // This workspace first, then the others (select switches workspace).
      const target = allFlat.find(wantsYou) ?? flatten(buildRows(all)).find(wantsYou);
      const id = target && windowIdOf(target);
      if (id) select(id);
    },
    "session.copyResume": () => currentAgent && void copyResumeCommand(currentAgent),
    "session.summarize": () => currentAgent && void summarizeSession(currentAgent),
    "session.rename": () => currentAgent && setPicker({ kind: "renameAgent", agent: currentAgent }),
    "session.copyId": () => {
      const id = currentAgent && sessionId(currentAgent);
      if (id) copy(id);
    },
    "session.reveal": () => current && cmd.openPath(current.cwd, { from: "user" }),
    ...(Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`session.select${n}`, () => withPane[n - 1] && selectRow(withPane[n - 1]!)]),
    ) as Record<`session.select${number}`, () => void>),
    "file.openWorkspace": () => setPicker({ kind: "workspace" }),
    "file.newWindow": () => setPicker({ kind: "workspace", newWindow: true }),
    "workspace.next": () => stepWorkspace(1),
    "workspace.prev": () => stepWorkspace(-1),
    "workspace.last": () => lastWorkspace.current && all.workspaces.has(lastWorkspace.current) && showWorkspace(lastWorkspace.current),
    "workspace.moveWindow": () => selected && setPicker({ kind: "move", windowId: selected }),
    "workspace.rename": () => workspace && setPicker({ kind: "rename", workspace }),
    "workspace.icon": () => workspace && setPicker({ kind: "icon", workspace }),
    "workspace.reveal": () => workspace && cmd.openPath(workspace.root, { from: "user" }),
    "workspace.close": () => workspace && void closeWorkspace(workspace),
    ...(Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`workspace.select${n}`, () => openWorkspaces[n - 1] && showWorkspace(openWorkspaces[n - 1]!.id)]),
    ) as Record<`workspace.select${number}`, () => void>),
    "help.docs": () => cmd.openDocs(),
    "help.feedback": () => (setPalette(false), setFeedback(true)),
    "app.taskManager": () => (setPalette(false), setTaskManager(true)),
    "help.whatsNew": () => (setPalette(false), setWhatsNew(RELEASES.filter((r) => compareVersions(r.version, APP_VERSION) <= 0))),
  };
  /** View → Show Left/Right Sidebar: hide or show a side; an empty left side gets a Navigator. */
  function toggleSide(side: Side) {
    const id = docks[side].id;
    if (id) {
      const row = allFlat.find((r) => windowIdOf(r) === id);
      // It slides out (kept until it's gone) or in.
      if (row && !docks[side].hidden) setSliding((m) => ({ ...m, [side]: { dir: "out", row, width: widths[side] } }));
      else setSliding((m) => ({ ...m, [side]: { dir: "in" } }));
      clearTimeout(slideTimers.current[side]);
      slideTimers.current[side] = setTimeout(() => setSliding(({ [side]: _, ...m }) => m), GLIDE_MS);
      setDocks((d) => ({ ...d, [side]: { ...d[side], hidden: !d[side].hidden } }));
    } else if (side === "left") void openNavigator(all.workspaceId, "left");
  }
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  // Every app command that runs is a fact in the log (user.command): which, and from where.
  const run = useCallback((id: string, via: "palette" | "menu" | "shortcut" | "cli" | "other" = "other") => {
    handlersRef.current[id as CommandId]?.();
    void cmd.call("data.record", { event: { id: `command:${Date.now()}:${id}`, at: Date.now(), type: "user.command", source: "user", data: { command: id, via } } }).catch(() => {});
  }, []);

  useEffect(() => cmd.onCommand((id) => run(id, "menu")), [run]);
  useEffect(() => cmd.onOpenUrl(openLink), []);
  // Once, in the first window after a launch: onboarding steps this Mac hasn't
  // seen, then (after an update) what changed since the version it last ran as.
  useEffect(() => {
    void Promise.all([cmd.onboarding().then(stepsAtLaunch), cmd.whatsNew()]).then(([steps, claim]) => {
      const since = claim && releasesSince(claim.after);
      if (steps.length) (whatsNewLater.current = since?.length ? since : null), showSetup(steps);
      else if (since?.length) setWhatsNew(since);
    });
  }, []);
  // `open` in a terminal: follow it, unless it came from another workspace while this window is in the background.
  useEffect(() => onWindowFocus((id) => (document.hasFocus() || workspaceOfWindow(id) === getState().workspaceId) && select(id)), [select]);

  // Tell the menu bar what is checked/enabled (only when that changes: it's IPC and native menu work).
  const selectedIsPane = !!selected && s.panes.has(selected);
  const selectedIsWidget = !!selected && isWidget(s.windows.get(selected));
  const selectedSide = sideOf(docks, selected);
  const hasSession = !!(currentAgent && sessionId(currentAgent));
  const aiReady = !!useAiStatus()?.ready;
  const selectedActions = useWindowActions(selected);
  const canFind = selectedIsPane || !!selectedActions?.find;
  useEffect(() => {
    const hasPane = !!selected;
    cmd.setMenuState({
      checked: {
        "view.focus": mode === "focus",
        "view.grid": mode === "grid",
        "view.strip": mode === "strip",
        "view.canvas": mode === "canvas",
        "view.sidebar": !!docks.left.id && !docks.left.hidden,
        "view.rightSidebar": !!docks.right.id && !docks.right.hidden,
      },
      enabled: {
        "edit.clear": hasPane,
        "edit.find": canFind,
        "edit.findNext": canFind,
        "edit.findPrev": canFind,
        "edit.findSelection": canFind,
        "edit.findReplace": canFind && !selectedIsPane,
        "edit.copyLastOutput": selectedIsPane,
        "terminal.prevPrompt": selectedIsPane,
        "terminal.nextPrompt": selectedIsPane,
        "session.next": withPane.length > 1,
        "session.prev": withPane.length > 1,
        "session.copyResume": hasSession,
        "session.copyId": hasSession,
        "session.rename": !!currentAgent,
        // Live: ai.updated re-renders when a key is added or stops working.
        "session.summarize": hasSession && aiReady,
        "session.reveal": hasPane,
        "session.nextAttention": attention > 0,
        "workspace.next": openWorkspaces.length > 1,
        "workspace.prev": openWorkspaces.length > 1,
        "workspace.moveWindow": hasPane && openWorkspaces.length > 1,
        "workspace.close": !!workspace && !workspace.home,
        "workspace.rename": !!workspace,
        "workspace.icon": !!workspace,
        "widget.remove": selectedIsWidget,
        "view.rightSidebar": !!docks.right.id,
        "window.dockLeft": hasPane && selectedSide !== "left",
        "window.dockRight": hasPane && selectedSide !== "right",
        "window.undock": !!selectedSide,
      },
    });
  }, [mode, docks, selectedSide, selected, selectedIsPane, canFind, selectedIsWidget, withPane.length, hasSession, aiReady, attention > 0, openWorkspaces.length, !!workspace, !!workspace?.home, !!currentAgent]); // eslint-disable-line react-hooks/exhaustive-deps

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
            ...sidebarEntries(windowIdOf(r)!),
            { label: "Move to Workspace…", run: () => setPicker({ kind: "move", windowId: windowIdOf(r)! }), enabled: openWorkspaces.length > 1 },
            { label: r.pane ? "Close Terminal" : "Close Window", run: () => void closePane(windowIdOf(r)!) },
            "-" as const,
          ]
        : a
          ? [
              // A subagent, or a host whose terminal is gone: no window of its own.
              ...(homeOf(r) ? [{ label: "Show Host", run: () => select(homeOf(r)!) }] : []),
              { label: "Remove", run: () => void cmd.call("agent.kill", { agentId: a.id }) },
              "-" as const,
            ]
          : []),
      // Entries the window's type contributes (see windows/registry.ts).
      ...(r.win ? [...(viewFor(r.win.kind)?.menu?.(r.win) ?? []), "-" as const] : []),
      ...(a
        ? [
            { label: "Rename…", run: () => setPicker({ kind: "renameAgent", agent: a }) },
            { label: "Copy Resume Command", run: () => void copyResumeCommand(a), enabled: !!id },
            { label: "Copy Session ID", run: () => id && copy(id), enabled: !!id },
            // Only with an AI provider set up; read when the menu opens, so a key added since counts.
            ...(aiStatus()?.ready ? [{ label: "Summarize Session", run: () => void summarizeSession(a), enabled: !!id }] : []),
            ...(a.native.transcriptPath ? [{ label: "Reveal Transcript", run: () => cmd.openPath(a.native.transcriptPath!, { from: "user" }) }] : []),
            "-" as const,
          ]
        : []),
      ...(cwd
        ? [
            { label: "New Terminal Here", run: () => void newTerminalIn(cwd) },
            { label: "Show Folder in Finder", run: () => cmd.openPath(cwd, { from: "user" }) },
            { label: "Copy Path", run: () => copy(cwd) },
          ]
        : []),
    ]);
  };

  /** Make Sidebar ▸ Left / Right on the board; on a sidebar, the other side or back (docs/21-sidebars.md). */
  const sidebarEntries = (id: string): MenuEntry[] => {
    const side = sideOf(docks, id);
    if (!side) {
      return [
        {
          label: "Make Sidebar",
          submenu: SIDES.map((sd) => ({ label: sd === "left" ? "Left" : "Right", run: () => setDocks((d) => dock(d, id, sd)) })),
        },
      ];
    }
    const other: Side = side === "left" ? "right" : "left";
    return [
      { label: other === "left" ? "Move to Left Sidebar" : "Move to Right Sidebar", run: () => setDocks((d) => dock(d, id, other)) },
      { label: "Move to Board", run: () => setDocks((d) => undock(d, id)) },
    ];
  };

  /** Right-click on a workspace in the switcher. */
  const workspaceMenu = (sp: Workspace) =>
    void showContextMenu([
      { label: "Show", run: () => showWorkspace(sp.id), enabled: sp.id !== all.workspaceId },
      { label: "Open in New Window", run: () => showWorkspace(sp.id, { newWindow: true }), enabled: sp.id !== all.workspaceId },
      "-",
      { label: "Rename…", run: () => setPicker({ kind: "rename", workspace: sp }) },
      { label: "Change Icon…", run: () => setPicker({ kind: "icon", workspace: sp }) },
      { label: "Show Folder in Finder", run: () => cmd.openPath(sp.root, { from: "user" }) },
      { label: "Copy Path", run: () => copy(sp.root) },
      "-",
      { label: "Close Workspace…", run: () => void closeWorkspace(sp), enabled: !sp.home },
    ]);

  const workspaceBar = (
    <WorkspaceBar
      workspaces={openWorkspaces}
      current={all.workspaceId}
      attention={waiting}
      onShow={(id, opts) => showWorkspace(id, opts)}
      onMenu={workspaceMenu}
      onPicker={() => setPicker({ kind: "workspace" })}
    />
  );
  const pickerProps = usePickers(picker, () => setPicker(null));
  // The palette and pickers fade out when they close (the last query and items stay meanwhile).
  const shownPalette = usePresentValue(palette, palette !== false);
  const shownPicker = usePresentValue(pickerProps && picker ? { kind: picker.kind, props: pickerProps } : null, !!(pickerProps && picker));

  /** Per-terminal mute: no system notifications from it (its marker still shows). */
  const muteEntry = (paneId: PaneId) => {
    const muted = !!getState().panes.get(paneId)?.muted;
    return {
      label: muted ? "Unmute Notifications" : "Mute Notifications",
      run: () => void cmd.call("pane.setMuted", { paneId, muted: !muted }),
    };
  };

  const terminalMenuImpl = (paneId: PaneId) => {
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
  // Stable, so the memoized TerminalViews don't re-render with every App render.
  const terminalMenuRef = useRef(terminalMenuImpl);
  terminalMenuRef.current = terminalMenuImpl;
  const terminalMenu = useCallback((paneId: PaneId) => terminalMenuRef.current(paneId), []);

  // ── palette ────────────────────────────────────────────

  // ?query in the palette (docs/33): the workspace's files (live from disk), past
  // agent sessions, commands and what they printed, pages and files opened in cmd.
  // Open windows come from the palette's own items (SEARCH_GROUPS).
  const searchAll = useCallback(async (text: string, show: (items: PaletteItem[]) => void): Promise<PaletteItem[]> => {
    const st = getState();
    const workspace = st.workspaces.get(st.workspaceId);
    const now = Date.now();
    const cwd = contextCwd() ?? null;
    const meta = (...parts: (string | number | null | false | undefined)[]) => parts.filter(Boolean).join(" · ");
    const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
    const dirIn = (p: string, root: string) => {
      const rel = p.startsWith(root + "/") ? p.slice(root.length + 1) : shortPath(p);
      return rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : base(root);
    };
    // Each source shows as soon as it answers, always in this order: file names come
    // from a cached list, lines from reading the files, history and sessions from the index.
    const parts: { names: PaletteItem[]; lines: PaletteItem[]; sessions: PaletteItem[]; history: PaletteItem[] } = { names: [], lines: [], sessions: [], history: [] };
    const named = new Set<string>();
    // A file found by its name isn't listed again among the files opened in cmd.
    const all = () => [...parts.names, ...parts.lines, ...parts.sessions, ...parts.history.filter((it) => !(it.id.startsWith("o-") && named.has(it.id.slice(2))))];
    const part = <T,>(key: keyof typeof parts, p: Promise<T>, map: (r: T) => PaletteItem[]) =>
      p.then(
        (r) => ((parts[key] = map(r)), show(all())),
        () => {},
      );
    await Promise.all([
      part("names", cmd.call("search.files", { text, workspaceId: st.workspaceId, cwd, limit: 8, part: "names" }), (r) =>
        r.hits.map((h) => (named.add(h.path), { id: `f-${h.path}`, group: "Files", icon: "doc", label: base(h.path), meta: dirIn(h.path, h.root), run: () => void openPath(h.path, "user") })),
      ),
      part("lines", cmd.call("search.files", { text, workspaceId: st.workspaceId, cwd, limit: 20, part: "lines" }), (r) =>
        r.hits.map((h) => ({ id: `l-${h.path}:${h.line}`, group: "Files", icon: "text.alignleft", label: `${base(h.path)}:${h.line}`, meta: dirIn(h.path, h.root), snippet: h.text, run: () => void openFileAt(h.path, h.line!, h.column, text.trim()) })),
      ),
      part("sessions", cmd.call("search.query", { text, limit: 8 }), (hits) =>
        hits.map((h) => ({
          id: `h-${h.agent}-${h.sessionId}`,
          group: "Past sessions",
          icon: "clock.arrow.circlepath",
          label: h.title || "(untitled session)",
          meta: meta(h.agent, h.cwd && shortPath(h.cwd), h.branch, h.updatedAt && ago(h.updatedAt, now), h.fuzzy && "~"),
          snippet: h.snippet,
          run: () => void openSession(h),
        })),
      ),
      // Home holds what happened anywhere; another workspace what happened in it.
      part("history", cmd.call("search.history", { text, workspaceId: workspace?.home ? null : st.workspaceId, limit: 5 }), (hits) =>
        hits.flatMap((h): PaletteItem[] => {
          if (h.kind === "command")
            return [{
              id: `c-${h.command}-${h.cwd}`,
              group: "Commands",
              icon: "terminal",
              label: h.command,
              meta: meta(h.cwd && shortPath(h.cwd), h.exitCode ? `exit ${h.exitCode}` : null, h.runs > 1 && `${h.runs}×`, ago(h.at, now)),
              snippet: h.snippet,
              // Its terminal if that is still open, else a new one in its folder.
              run: () => (h.paneId && getState().panes.has(h.paneId) ? select(h.paneId) : void newTerminalIn(h.cwd ?? "~")),
            }];
          if (h.kind === "page") {
            const host = /^https?:\/\/([^/]+)/.exec(h.url)?.[1] ?? h.url;
            return [{ id: `p-${h.url}`, group: "Pages", icon: "globe", label: h.title || h.url, meta: meta(host, ago(h.at, now)), run: () => openLink(h.url) }];
          }
          return [{ id: `o-${h.path}`, group: "Opened files", icon: "doc", label: base(h.path), meta: meta(shortPath(h.path.slice(0, h.path.lastIndexOf("/"))), ago(h.at, now)), run: () => void openPath(h.path, "user") }];
        }),
      ),
    ]);
    return all();
  }, []);

  const remember = (id: string) => setRecent((r) => [id, ...r.filter((x) => x !== id)].slice(0, 20));
  const paletteItems: PaletteItem[] = [
    ...COMMANDS.filter((c) => !("paletteHidden" in c) && c.id !== "view.palette").map((c) => ({
      id: c.id,
      group: "Commands" as const,
      label: c.label.replace(/…$/, ""),
      hint: prettyAccelerator(keys.bindings[c.id]?.[0]),
      run: () => run(c.id, "palette"),
    })),
    // Risky ones (deploys) are left to the widget, which asks first.
    ...(paletteActions && paletteActions.root === getState().workspaces.get(getState().workspaceId)?.root ? [...paletteActions.actions.filter((a) => !a.hidden), ...paletteActions.history] : [])
      .filter((a) => !a.risky)
      .map((a) => ({
        id: `a-${a.id}`,
        group: "Actions",
        icon: "play",
        label: a.package ? `${a.name} (${a.package})` : a.name,
        meta: a.description ?? a.command,
        run: () => void runAction(paletteActions!.root, a, getState().workspaceId).catch(() => {}),
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

  // Every Navigator window shows this (components/Navigator.tsx).
  const navigatorData: NavigatorData = {
    workspaceId: all.workspaceId,
    rows,
    selected,
    onSelect: selectRow,
    onRowMenu: rowMenu,
    onClose: (r) => windowIdOf(r) && void closePane(windowIdOf(r)!),
    onNewTerminal: () => void newTerminal(),
    search: s.search,
  };

  return (
    <div
      className={`app ${cfg["ui.unfocusedDesaturation"] > 0 ? "desaturate" : ""} title-tint-${cfg["ui.focusTitleBar"]}`}
      style={{
        ["--dock-left-w" as string]: `${widths.left || DOCK_WIDTH.default}px`,
        ["--gutter" as string]: `${cfg["ui.gutter"]}px`,
        ["--pad-x" as string]: `${cfg["ui.paddingX"]}px`,
        ["--pad-y" as string]: `${cfg["ui.paddingY"]}px`,
        ["--window-dim-amount" as string]: `${cfg["ui.unfocusedDim"] / 100}`,
        ["--window-desaturate" as string]: `${cfg["ui.unfocusedDesaturation"] / 100}`,
      }}
    >
      <TopBar workspaceBar={workspaceBar} mode={mode} run={run} onNew={() => run("file.new")} />
      <NavigatorContext.Provider value={navigatorData}>
        {/* Canvas and strip run under the sidebars (docs/21-sidebars.md). */}
        <div className={`stage${mode === "canvas" || mode === "strip" ? " under" : ""}`}>
          {SIDES.map((side) => {
            const slide = sliding[side];
            // Hidden just now: still there while it slides out, if its window is nowhere else.
            const leaving = docks[side].hidden && slide?.dir === "out" && slide.row && !flat.some((r) => windowIdOf(r) === windowIdOf(slide.row!)) ? slide : undefined;
            const row = leaving?.row ?? (docks[side].hidden ? undefined : allFlat.find((r) => windowIdOf(r) === docks[side].id));
            return row ? (
              <Dock
                key={side}
                side={side}
                row={row}
                sliding={leaving ? "out" : slide?.dir === "in" ? "in" : undefined}
                width={leaving?.width ?? widths[side]}
                maxWidth={Math.max(DOCK_WIDTH.min, Math.min(DOCK_WIDTH.max, winWidth - MIN_BOARD - widths[side === "left" ? "right" : "left"]))}
                selected={selected === docks[side].id}
                attention={attention > 0}
                onSelect={select}
                onTitleMenu={rowMenu}
                onTerminalMenu={terminalMenu}
                onWidth={(px) => setDocks((d) => ({ ...d, [side]: { ...d[side], width: px } }))}
              />
            ) : null;
          })}
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
            insets={widths}
          />
        </div>
      </NavigatorContext.Provider>
      <StatusBar pane={current} run={run} connected={s.connected} error={s.error} />
      {shownPalette.value !== undefined && shownPalette.value !== false && (
        <Palette
          closing={shownPalette.closing}
          label="Command Palette"
          items={paletteItems}
          // Typing a URL or a path offers to open it in a window.
          dynamic={(q) => openItems(q, "Commands")}
          recent={recent}
          onRun={remember}
          onClose={() => setPalette(false)}
          key={shownPalette.value === SEARCH ? "search" : "commands"}
          initialQuery={shownPalette.value}
          search={searchAll}
          searchGroups={SEARCH_GROUPS}
          searchStatus={s.search}
        />
      )}
      {shownPicker.value && <Palette key={shownPicker.value.kind} {...shownPicker.value.props} closing={shownPicker.closing} />}
      {/* Sheets stay mounted while they fade out, and not at all once closed (Presence). */}
      <Presence when={picker?.kind === "new"}>{(_, open) => <NewPicker run={run} onClose={() => setPicker(null)} closing={!open} />}</Presence>
      <Presence when={picker?.kind === "icon" && picker.workspace}>
        {(w, open) => <WorkspaceIconPicker open={open} workspace={all.workspaces.get(w.id) ?? w} onClose={() => setPicker(null)} />}
      </Presence>
      <Presence when={library}>{(_, open) => <WidgetLibrary open={open} onClose={() => setLibrary(false)} />}</Presence>
      <Toaster />
      <Presence when={feedback}>{(_, open) => <Feedback open={open} onClose={() => setFeedback(false)} />}</Presence>
      <Presence when={taskManager}>{(_, open) => <TaskManager open={open} onClose={() => setTaskManager(false)} />}</Presence>
      <Presence when={setup}>{(ids, open) => <Onboarding key={ids.join()} open={open} ids={ids} onClose={endSetup} />}</Presence>
      <Presence when={whatsNew}>{(releases, open) => <WhatsNew open={open} releases={releases} onClose={() => setWhatsNew(null)} onLink={(url) => (setWhatsNew(null), openLink(url))} />}</Presence>
      <Presence when={all.pairRequests[0]}>{(request, open) => <PairSheet key={request.requestId} open={open} request={request} />}</Presence>
      <SitePermissionSheet />
    </div>
  );
}

/** A Navigator docked to `side` of a workspace (docs/21-sidebars.md); `carry` is the side's earlier width and visibility. */
async function openNavigator(workspaceId: WorkspaceId, side: Side, carry?: { hidden: boolean; width: number | null }): Promise<void> {
  const w = await cmd.call("window.open", { kind: "navigator", workspaceId });
  const d = readDocks(getWorkspaceView(workspaceId, "docks", null));
  const next = dock(d, w.id, side);
  setWorkspaceView(workspaceId, "docks", carry ? { ...next, [side]: { ...next[side], ...carry } } : next);
}

/** Workspaces being given their first Navigator, so a re-render doesn't make two. */
const making = new Set<WorkspaceId>();

/**
 * Every workspace starts with a Navigator docked left, which is also the migration
 * from the old sidebar (its width and whether it was shown carry over). Once
 * a workspace has sidebars (even none), it's left alone.
 */
function useFirstNavigator(workspaceId: WorkspaceId, ready: boolean, unset: boolean, carry: { hidden: boolean; width: number | null }): void {
  useEffect(() => {
    if (!ready || !unset || making.has(workspaceId)) return;
    making.add(workspaceId);
    openNavigator(workspaceId, "left", carry).catch(() => {
      // An older core without the Navigator type: no sidebars rather than asking again.
      setWorkspaceView(workspaceId, "docks", {});
    });
  }, [workspaceId, ready, unset]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The app window's width, for fitting the sidebars. */
function useWindowWidth(): number {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}
