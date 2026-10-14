// The app window's shell: the top bar, the board with its sidebars, the status bar, and the
// sheets over them. What it shows comes from the store (board/board.ts lays the workspace
// out); what it does lives with what it serves: commands in shell/commands/ and beside window
// types, the selection in lib/selection.ts, sheets in sheets.ts, notifications, menus, palette.

import { useEffect, useMemo, useState } from "react";
import { Presence, Toaster, usePresentValue } from "@cmd/ui";
import type { PaneId } from "@cmd/protocol";
import { closePane, newTerminal, openLink } from "../lib/actions.ts";
import { useAiStatus } from "../ai/status.ts";
import { useKeybindings } from "../lib/keybindings.ts";
import { setCmdNames, windowIdOf, workspaceAttention } from "../lib/model.ts";
import { select, deselect } from "../lib/selection.ts";
import { getState, setWorkspaceView, usePersisted, useStore, useWorkspaceView } from "../lib/store.ts";
import { countRender } from "../lib/perf.ts";
import { terminals } from "../windows/terminal/terminals.ts";
import { NavigatorContext, type NavigatorData } from "../windows/navigator/Navigator.tsx";
import { Onboarding } from "../onboarding/Onboarding.tsx";
import { PairSheet, useRemoteNotifications } from "../components/Remote.tsx";
import { boardOf } from "./board/board.ts";
import { Dock } from "./board/Dock.tsx";
import { dockWidths, DOCK_WIDTH, MIN_BOARD, SIDES } from "./board/docks.ts";
import { MainView } from "./board/MainView.tsx";
import { anySideShown, useFirstNavigator, useSliding } from "./board/sidebars.ts";
import { setDocks, setStripWidth } from "./board/view.ts";
import { reopenClosed, useRememberClosed } from "./closed.ts";
import { commandContext, runCommand, MenuStateSync, useWindowShortcuts } from "./commands/registry.ts";
import { Feedback } from "./Feedback.tsx";
import { useLaunch } from "./launch.ts";
import { homeOf, rowMenu, terminalMenu, workspaceMenu } from "./menus.ts";
import { NewPicker } from "./NewPicker.tsx";
import { openItems } from "./newItems.ts";
import { useDock, useNotifications } from "./notifications.ts";
import { Palette, SEARCH_PREFIX } from "./Palette.tsx";
import { actionItems, commandItems, lineItems, searchAll, SEARCH_GROUPS, usePaletteActions, windowItems } from "./palette.ts";
import { useSelectionFollows } from "./selection.ts";
import { closeSheet, openSheet, useSheet } from "./sheets.ts";
import { BootSheet, useBootReport } from "./BootSheet.tsx";
import { SitePermissionSheet } from "./SitePermissionSheet.tsx";
import { Approvals } from "./Approvals.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { TaskManager } from "./TaskManager.tsx";
import { TopBar } from "./TopBar.tsx";
import { WhatsNew } from "./WhatsNew.tsx";
import { WidgetLibrary } from "./WidgetLibrary.tsx";
import { WorkspaceBar } from "./WorkspaceBar.tsx";
import { WorkspaceIconPicker } from "./WorkspaceIcon.tsx";
import { showWorkspace, usePickers } from "./workspaces.tsx";

const run = (id: string) => runCommand(id, "other");
/** A layout key of the shown workspace's view. */
const setView = (key: string, value: unknown) => setWorkspaceView(getState().workspaceId, key, value);

/** The Navigator's row actions: the same functions every render, so its rows (memoised) stay put. */
const navigatorActions: Pick<NavigatorData, "onSelect" | "onRowMenu" | "onClose" | "onNewTerminal" | "onReopen"> = {
  onSelect: (r) => {
    const id = homeOf(r);
    if (id) select(id);
  },
  onRowMenu: rowMenu,
  onClose: (r) => windowIdOf(r) && void closePane(windowIdOf(r)!),
  onNewTerminal: () => void newTerminal(),
  onReopen: (id) => reopenClosed(id),
};

export function App() {
  countRender("App");
  /** Everything, every workspace: attention, the Dock badge, cross-workspace jumps. */
  const all = useStore();
  // Before any row is drawn: whether an unnamed agent waits for cmd's name (model.ts).
  setCmdNames(!!useAiStatus()?.ready && all.settings.settings["agents.names.ai"]);
  const board = boardOf(all);
  const s = board.shown;
  const cfg = s.settings.settings;
  const workspace = all.workspaces.get(all.workspaceId);
  const keys = useKeybindings();
  const [selected] = useWorkspaceView<PaneId | null>("selection.pane", null);
  const sheet = useSheet();
  const boot = useBootReport(s.connected);
  const sliding = useSliding();
  // The sidebar before sidebars were windows: carried over into each workspace's first Navigator.
  const [sidebarOpen] = usePersisted("sidebar.open", true);
  const [sidebarWidth] = usePersisted<number | null>("sidebar.width", null);
  const [zoom] = usePersisted("terminal.zoom", 0);
  const [recent, setRecent] = usePersisted<string[]>("palette.recent", []);
  useEffect(() => terminals.setZoom(zoom), [zoom]);

  useRemoteNotifications();
  useLaunch(workspace?.name ?? "cmd");
  useSelectionFollows(board, selected, s.connected);
  useRememberClosed(board, s.connected);
  useNotifications(selected, s);
  useDock();
  useWindowShortcuts();
  useFirstNavigator(all.workspaceId, !!workspace && s.connected, board.storedDocks === null, { hidden: !sidebarOpen, width: sidebarWidth });
  const winWidth = useWindowWidth();
  const widths = dockWidths(board.docks, winWidth);
  const waiting = useMemo(() => workspaceAttention(all), [all.agents, all.panes]); // eslint-disable-line react-hooks/exhaustive-deps

  // The palette and pickers fade out when they close (the last query and items stay meanwhile).
  const palette: string | false = sheet?.kind === "palette" ? sheet.query : false;
  const picker = sheet?.kind === "picker" ? sheet.picker : null;
  const paletteActions = usePaletteActions(palette !== false);
  const pickerProps = usePickers(picker, closeSheet);
  const shownPalette = usePresentValue(palette, palette !== false);
  const shownPicker = usePresentValue(pickerProps && picker ? { kind: picker.kind, props: pickerProps } : null, !!(pickerProps && picker));
  const ctx = commandContext({}, all);
  const attention = ctx.attention;
  const paletteItems = shownPalette.value === false || shownPalette.value === undefined ? [] : [...commandItems(ctx, keys.bindings), ...actionItems(paletteActions, ctx), ...windowItems(ctx)];

  // Every Navigator window shows this (windows/navigator/Navigator.tsx).
  const navigatorData: NavigatorData = {
    workspaceId: all.workspaceId,
    rows: board.rows,
    selected,
    ...navigatorActions,
    search: s.search,
  };

  return (
    <div
      className={`app ${cfg["ui.unfocusedDesaturation"] > 0 ? "desaturate" : ""}${cfg["ui.dimBrowsers"] ? "" : " undim-browsers"} title-tint-${cfg["ui.focusTitleBar"]}`}
      style={{
        ["--dock-left-w" as string]: `${widths.left || DOCK_WIDTH.default}px`,
        ["--gutter" as string]: `${cfg["ui.gutter"]}px`,
        ["--pad-x" as string]: `${cfg["ui.paddingX"]}px`,
        ["--pad-y" as string]: `${cfg["ui.paddingY"]}px`,
        ["--window-dim-amount" as string]: `${cfg["ui.unfocusedDim"] / 100}`,
        ["--window-desaturate" as string]: `${cfg["ui.unfocusedDesaturation"] / 100}`,
      }}
    >
      <TopBar
        workspaceBar={<WorkspaceBar workspaces={ctx.workspaces} current={all.workspaceId} attention={waiting} onShow={showWorkspace} onMenu={workspaceMenu} onPicker={() => openSheet({ kind: "picker", picker: { kind: "workspace" } })} />}
        mode={board.mode}
        sidebars={anySideShown(board.docks)}
        run={run}
        onNew={() => run("file.new")}
      />
      <NavigatorContext.Provider value={navigatorData}>
        {/* Canvas and strip run under the sidebars (docs/21-sidebars.md). */}
        <div className={`stage${board.mode === "canvas" || board.mode === "strip" ? " under" : ""}`}>
          {SIDES.map((side) => {
            const slide = sliding[side];
            const docked = board.docks[side];
            // Hidden just now: still there while it slides out, if its window is nowhere else.
            const leaving = docked.hidden && slide?.dir === "out" && slide.row && !board.flat.some((r) => windowIdOf(r) === windowIdOf(slide.row!)) ? slide : undefined;
            const row = leaving?.row ?? (docked.hidden ? undefined : board.allFlat.find((r) => windowIdOf(r) === docked.id));
            return row ? (
              <Dock
                key={side}
                side={side}
                row={row}
                sliding={leaving ? "out" : slide?.dir === "in" ? "in" : undefined}
                width={leaving?.width ?? widths[side]}
                maxWidth={Math.max(DOCK_WIDTH.min, Math.min(DOCK_WIDTH.max, winWidth - MIN_BOARD - widths[side === "left" ? "right" : "left"]))}
                selected={selected === docked.id}
                attention={attention > 0}
                onSelect={select}
                onTitleMenu={rowMenu}
                onTerminalMenu={terminalMenu}
                onWidth={(px) => setDocks((d) => ({ ...d, [side]: { ...d[side], width: px } }))}
              />
            ) : null;
          })}
          <MainView
            mode={board.mode}
            rows={board.flat}
            selected={selected}
            onSelect={select}
            onTerminalMenu={terminalMenu}
            onTitleMenu={rowMenu}
            gridOrder={board.gridOrder}
            onGridReorder={(order) => setView("grid.order", order)}
            stripWidths={board.stripWidths}
            canvasRects={board.canvasRects}
            onCanvasRects={(rects) => setView("canvas.rects", rects)}
            camera={board.camera}
            onCamera={(camera) => setView("canvas.camera", camera)}
            onDeselect={deselect}
            onStripWidth={setStripWidth}
            insets={widths}
          />
        </div>
      </NavigatorContext.Provider>
      <StatusBar pane={selected ? s.panes.get(selected) : undefined} run={run} connected={s.connected} error={s.error} />
      {shownPalette.value !== undefined && shownPalette.value !== false && (
        <Palette
          closing={shownPalette.closing}
          label="Command Palette"
          items={paletteItems}
          // Typing a URL or a path offers to open it in a window; ":12" goes to a line in a text window.
          dynamic={(q) => [...lineItems(q, ctx), ...openItems(q, "Commands")]}
          recent={recent}
          onRun={(id) => setRecent((r) => [id, ...r.filter((x) => x !== id)].slice(0, 20))}
          onClose={closeSheet}
          key={shownPalette.value === SEARCH_PREFIX ? "search" : "commands"}
          initialQuery={shownPalette.value}
          search={searchAll}
          searchGroups={SEARCH_GROUPS}
          searchStatus={s.search}
        />
      )}
      {shownPicker.value && <Palette key={shownPicker.value.kind} {...shownPicker.value.props} closing={shownPicker.closing} />}
      {/* Sheets stay mounted while they fade out, and not at all once closed (Presence). */}
      <Presence when={picker?.kind === "new"}>{(_, open) => <NewPicker run={run} onClose={closeSheet} closing={!open} />}</Presence>
      <Presence when={picker?.kind === "icon" && picker.workspace}>{(w, open) => <WorkspaceIconPicker open={open} workspace={all.workspaces.get(w.id) ?? w} onClose={closeSheet} />}</Presence>
      <Presence when={sheet?.kind === "library"}>{(_, open) => <WidgetLibrary open={open} onClose={closeSheet} />}</Presence>
      <Toaster />
      <Presence when={sheet?.kind === "feedback"}>{(_, open) => <Feedback open={open} onClose={closeSheet} />}</Presence>
      <Presence when={sheet?.kind === "taskManager"}>{(_, open) => <TaskManager open={open} onClose={closeSheet} />}</Presence>
      <Presence when={sheet?.kind === "setup" && sheet.ids}>{(ids, open) => <Onboarding key={ids.join()} open={open} ids={ids} onClose={closeSheet} />}</Presence>
      <Presence when={sheet?.kind === "whatsNew" && sheet.releases}>{(releases, open) => <WhatsNew open={open} releases={releases} onClose={closeSheet} onLink={(url) => (closeSheet(), openLink(url))} />}</Presence>
      <Presence when={boot}>{(report, open) => <BootSheet open={open} report={report} />}</Presence>
      <Presence when={all.pairRequests[0]}>{(request, open) => <PairSheet key={request.requestId} open={open} request={request} />}</Presence>
      <MenuStateSync />
      <SitePermissionSheet />
      <Approvals />
    </div>
  );
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
