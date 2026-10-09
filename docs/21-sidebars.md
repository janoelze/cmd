# Sidebars are windows

> Status (2026-10-05): built on branch `sidebars`: the top bar and footer, sidebars per workspace (Make Sidebar ▸ Left / Right, Move to Board, Show Left/Right Sidebar), the Navigator widget docked left in every workspace, "desk" renamed to "board". Not built: phase 5 (drag to dock, dock animations). Where the build differs from the plan below, see "As built" at the end. Builds on [16-widgets.md](16-widgets.md) (widgets are windows underneath), [11-workspaces.md](11-workspaces.md) (per-workspace layout in `workspace.view`) and [10-window-titles.md](10-window-titles.md) (one title bar for every window).

Some people want cmd to feel more like an IDE, with a file tree down the left. We could build a file-tree sidebar. Then someone wants the CI runs on the right, then a notes panel, and every one would be a special case. Instead, we embrace the window concept all the way: **any window can become a sidebar.**

Right-click a window's title bar → **Make Sidebar** → **Left** or **Right**. The window leaves the board and docks to that edge of the app window. It keeps its full height, you can drag its width, and it floats a little apart from the edge, like the sidebars in recent macOS. It is still the same window: same title bar, same menu, same state. Return it to the board and it goes back into the layout.

Sidebars belong to a workspace. One project might keep a file browser on the left and a CI widget on the right, while another keeps only the default left sidebar.

Today's sidebar becomes a built-in widget, the **Navigator** (working name), docked left by default in every workspace. With windows no longer running all the way to the top of the app window, there is room for a real **top bar**: a drag handle with the workspace switcher on the left, and room on the right for view switchers and actions later. At the bottom, the sidebar footer and the status bar become one full-width footer: the core's health on the left; Settings, What's New, Feedback and the rest on the right. The background turns into one continuous canvas that every window, docked or not, sits on.

## What people see

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●   ◆ cmd ▾   +                 (drag)                                   │  top bar
│ ╭───────────╮  ╭──────────────╮ ╭──────────────╮  ╭────────────────────────╮ │
│ │ Navigator │  │ zsh · ~/src  │ │ claude       │  │ CI runs                │ │
│ │ ───────── │  │              │ │              │  │ ───────                │ │
│ │ Needs you │  │              │ │              │  │ ✓ build #412           │ │
│ │ Agents    │  │    board     │ │              │  │ ✗ e2e   #411           │ │
│ │ Windows   │  │  (strip/grid │ │              │  │                        │ │
│ │ Widgets   │  │   /canvas)   │ │              │  │                        │ │
│ │ Recent    │  │              │ │              │  │                        │ │
│ ╰───────────╯  ╰──────────────╯ ╰──────────────╯  ╰────────────────────────╯ │
│ ● core   412 MB · 3%                       ▢ ⊞ ▥ ⧉  ⌘  ⚙  ✦  💬 │  footer
└──────────────────────────────────────────────────────────────────────────────┘
   left sidebar          the workspace: every other window       right sidebar
```

- **The backdrop** (`--bg`) fills the space between the top bar and the footer. The sidebars and the board's windows sit on it, inset by the gutter.
- **The top bar** (about 44 px; `--titlebar-h` today is 38) spans the full width and is the app window's drag region:
  - left: the traffic lights, then the **Workspace switcher** (moved from the bottom of the sidebar) and **+** (New…, the sidebar's + today);
  - the rest is drag space for now. The right side is where view switchers and actions could go later; that's an experiment for after this lands.
- **The footer** is one full-width bar, replacing the sidebar footer and the status bar, which share a row today:
  - left: the core's health (`CoreStatus`, as today: the light and its details), then the selected window's usage (memory, CPU; in Focus mode its title fields), as the status bar shows them now;
  - right: the view modes, Palette, Settings, What's New, Feedback and the remote indicator, the status bar's actions today.
  It belongs to no sidebar, so nothing in it moves when the left side is hidden, empty, or holds another window.
- **Sidebars** look like windows because they are windows: the same `TileTitle`, frame, radius and shadow. Each side holds one window. A sidebar's inner edge resizes it, and a double-click resets it. A sidebar keeps its width when you switch view modes.
- **The board** is everything else. Every layout (focus, grid, strip, canvas) gets the space between the sidebars as its viewport.

### Making and unmaking sidebars

| Where | What |
|---|---|
| Title bar menu of a board window | **Make Sidebar ▸ Left / Right**. If that side already holds a window, that window goes back to the board. |
| Title bar menu of a sidebar | **Move to Right Sidebar** (or Left), **Move to Board** |
| Window menu | The same items, for the selected window (every shortcut needs a real menu item) |
| View menu | **Show Left Sidebar** (⌃⌘S, the `view.sidebar` command today) and **Show Right Sidebar**: these hide and show a side, they don't close its window |
| ⌘W on a sidebar | Closes the window, the same as everywhere else. The side becomes empty. |

Later: drag a title bar to the left or right edge of the app window, and a drop zone shows where it will dock (phase 5).

### Naming

The labels follow the copywriting skill: Title Case for menu items, a verb first, 1–4 words, and no ellipsis, since every item acts at once.

- **Board** is the main area where windows sit in a layout (focus, grid, strip, canvas). It isn't "the desk".
- **Sidebar** is a window docked left or right. People say "the left sidebar", never "the dock", because the Dock is macOS's. `docks` stays an internal name.
- Menu items: **Make Sidebar ▸ Left / Right**, **Move to Left Sidebar**, **Move to Right Sidebar**, **Move to Board**, **Show Left Sidebar**, **Show Right Sidebar**.
- Tooltip on a sidebar's inner edge: "Drag to resize · double-click to reset", as the sidebar's edge says today.

"Desk" is already in the app and the docs, and should become "board" in the same change so the two words never ship side by side:
- `widget.remove` reads **Remove from Desk** (`shared/commands.ts`). It becomes **Remove from Board**.
- The first-removal toast: "Removed “…” from the desk. It's in your Widget Library." becomes "…from the board…".
- The copywriting skill's list of names ("Workspaces, the desk, agents…"), the comments in `WidgetLibrary.tsx` and the wording in [16-widgets.md](16-widgets.md).

### The Navigator

The Navigator is today's `Sidebar.tsx` turned into a window view: search (⇧⌘F), Needs you, Agents, Windows, Widgets, Recent. The workspace switcher and + move into the top bar and the core's health into the footer, so it keeps only what is about the workspace's windows.

- It is a built-in widget (`role: "widget"`), so it is in the Widget Library. Close it and you can put it back from there.
- Every new workspace starts with a Navigator docked left. Existing workspaces get one the first time they are shown, which is the migration (see Data).
- It doesn't list itself. It doesn't list other sidebars either, since they are always in view. Open question below.
- Since it is just a window, people can dock it on the right, or put it on the board next to their terminals.

## Under the hood

### Data: a workspace's sidebars are layout

Sidebars are per-workspace layout, like strip widths and the canvas camera, so they live in `workspace.view` through `useWorkspaceView`:

```ts
// Workspace.view["docks"]
interface Docks {
  left:  { id: WindowId | null; width: number | null; hidden: boolean };
  right: { id: WindowId | null; width: number | null; hidden: boolean };
}
```

- **No protocol or core storage change.** `Workspace.view` is already opaque, per key and debounced (`store.ts` → `workspace.update { view }`). A window's `workspaceId` already ties it to the workspace.
- `width: null` means the window type's default. `hidden` is the View-menu toggle. It replaces the global `sidebar.open` / `sidebar.width` UI state, which becomes the migration source.
- A side whose window has closed or moved to another workspace counts as empty. The renderer drops the stale id the next time it writes, the same way `arrangeTiles` drops closed panes.
- **Default and migration.** When a workspace is shown and has no `docks` key, the renderer creates a Navigator (`window.open { kind: "navigator" }`) and docks it left, carrying over `sidebar.open`/`sidebar.width`. A workspace is only ever shown in one app window at a time (11-workspaces.md, rule 4), so two app windows can't race to create two Navigators.

Why not a field in the window's state: that state belongs to the window's type, and docking is something the workspace's layout decides, like grid order. It would also make "Move to Workspace" carry a dock along into a workspace that has no room for it.

### Core

- A new window type `navigator` in `packages/core/src/windows/builtin.ts`: `role: "widget"`, an empty state, titled "Navigator". It is registered like `agents` and `diff`.
- Nothing else. The Navigator's data is the renderer store it already reads (`buildRows`, `search.*`).

### Layouts

`layouts.ts` stays pure. `WindowsView` computes the board viewport as the app window minus the top bar and the footer, and minus each visible sidebar (its width plus a gutter) and hands that to the layout. Docked ids leave the ids the layout sees. They are filtered out before `arrangeTiles`, so grid order and strip widths are kept for when a window returns to the board.

New in `layouts.ts`, also pure and tested: `dockRects(docks, vp, spacing, topBar)` → the rect for each sidebar, in screen coordinates.

- Board navigation (⌥⌘← / ⌥⌘→, ⌘[ / ⌘], ⌃⌘1–9) covers the board only. A sidebar is selected by clicking it, or later with a shortcut of its own (open question).
- Focus mode: sidebars stay visible, and the one board window fills the space between them.
- Canvas: the canvas runs under the sidebars, which float over it; framing, revealing and the minimap use the area between them (decided 2026-10-05).

### Rendering: never remount a window

This is the technical risk. `WindowsView` keeps every window mounted in a stable DOM order inside `.windows-track`. The canvas camera transforms that track and the strip is a native scroller, so a sidebar can't live inside it. A sidebar has to be outside the track, and moving a window there means **reparenting its DOM**:

- **Terminals** are fine: `terminals.ts` already lends the xterm element to whichever view attaches it.
- **Webviews** (Browser, Magic widgets) **reload when moved** in the DOM. A browser would lose its scroll position and form state, and a Magic widget would redraw.

Plan: **window hosts.** Generalise what `terminals.ts` does to every window. Each window's content (`WindowContent`/`TerminalView`) renders once, through a portal, into a host element that belongs to the window. Wherever the window is shown (a tile in the track, or a sidebar), there is an empty slot that adopts the host with `Element.moveBefore()`. That is Chromium's state-preserving move (Chrome 133+; Electron 44 ships Chromium 142), and it keeps iframes, and so webviews, alive. Focus, selection and pointer capture survive too.

**Phase 0 is a spike to prove this works:** a webview playing a video moves between two parents with `moveBefore` and doesn't reload. If it doesn't hold for `<webview>` (a guest view, not a plain iframe), the fallback is to accept a reload when a webview docks or undocks. It's a rare, deliberate action, and both types already restore from state (the browser its URL, Magic from the core). We'd still keep the hosts for terminals.

Docked tiles reuse the tile markup (`tile-body`, `TileTitle`, `tile-frame`). Their title bar drags to undock (phase 5); until then, dragging it does nothing.

### Window types and sidebars

`registerWindowView` gets optional hints:

```ts
dock?: { width?: number; minWidth?: number; maxWidth?: number }  // defaults 280 / 200 / 480 (SIDEBAR_WIDTH today)
```

Views also get `placement: "board" | "sidebar"` (context, not a prop on every view), so a view can adapt. Files could drop its toolbar labels, and the Navigator only ever renders docked-style rows. Every type can be docked, terminals included: an agent's terminal on the right is a reasonable thing to want.

### The app shell

`App.tsx`'s grid changes from "sidebar column spanning both rows + main + status row" to:

```
.app            grid: top bar / content / footer
  .topbar       drag region; workspace switcher, + (right side free for later)
  .stage        position: relative; the backdrop
    WindowsView (board + sidebar layer)
  .footer       full width: CoreStatus · usage …… view modes, Palette, Settings, What's New, Feedback
```

- `WorkspaceBar` moves into `.topbar` and drops down below it, not above (`placement`).
- `StatusBar` becomes the footer: it spans the whole width, and `CoreStatus` moves into its left end (out of `Sidebar.tsx`'s `.sidebar-status`). Its actions stay as they are. The shared-row CSS (`grid-column: 2`, `.sidebar-status` matching `--statusbar-h`) goes away, since there is one bar.
- `drag-strip` and `.app.no-sidebar` go away: the top bar is always there.
- **Windows (the OS):** `titleBarOverlay` draws the window controls top right, so the top bar reserves their width (`env(titlebar-area-width)`), and the right-hand actions sit to their left. On macOS the traffic lights stay at `trafficLightPosition`, vertically centred in the taller bar (y adjusted in `main/index.ts`).

### Settings

- `ui.sidebarRecent` stays, describing the Navigator (`ui.sidebarPadding` was retired: the inset is the `--sidebar-pad` token). Its wording changes, and so does its place in `settings/layout.ts` if a Navigator section makes sense.
- No new settings at first. Sidebar insets follow `ui.gutter`, and their look follows the window settings (radius, outline, shadow), because they are windows.

## Plan

One worktree per phase; each ends green (`pnpm typecheck && pnpm test`, e2e updated).

0. **Spike: window hosts.** `moveBefore` with a `<webview>` and an xterm host in Electron 44, plus a throwaway page and a note here with the result. It decides whether docking a webview reloads it.
1. **The top bar.** Add `.topbar`, move the workspace switcher and + into it, and centre the traffic lights. Make the status bar the full-width footer with `CoreStatus` at its left end. The old sidebar stays where it is, between the two bars. This change is visible but low-risk. e2e: the sidebar-footer/status-bar alignment check becomes a check that the footer spans the window with the core's health in it.
2. **Window hosts.** Portal plus host plus `moveBefore` (or the fallback) in `WindowsView`, with no visible change. This is where remount bugs would show up, so it gets its own phase.
3. **Sidebars.** `Workspace.view.docks`, the board viewport, `dockRects`, the sidebar layer, the resize edge, and the menus and commands (`window.dockLeft`, `window.dockRight`, `window.undock`, `view.sidebar` → left, `view.rightSidebar`). Rows are filtered out of board navigation. "Desk" becomes "board" everywhere it shows (see Naming). Tests: `dockRects` and the board viewport in `layouts.test.ts`; stale ids dropped.
4. **The Navigator.** The `navigator` core type, `Sidebar.tsx` → `components/Navigator.tsx` registered as a view, the default dock and migration, and removing the old shell slot. e2e: the sidebar search and Widgets checks run against the Navigator window.
5. **Polish.** Drag a title bar to an edge to dock and away from it to undock, dock/undock animations (the tile glides between its rects), `placement`-aware Files, README and CHANGELOG (changelog skill).

Merge the `windows` worktree first if it lands soon: it has uncommitted changes to `App.tsx`, `model.ts`, `styles.css` and `windows/builtin.tsx`, the same files phases 1–4 touch. The append-only registries (`shared/commands.ts`, `settings/layout.ts`, core `builtin.ts`) will conflict as usual. Keep both sides.

## Risks

- **Webview reloads** on dock and undock: phase 0 decides, and the fallback is acceptable.
- **Narrow app windows.** Two sidebars at 280 px leave the board little room. Today's rule (`innerWidth - 320`) becomes: the board keeps at least 320 px, and sidebars shrink to their `minWidth`, then the right one hides (and its toggle says so).
- **Shortcut habits.** ⌃⌘1–9 and ⌘[ / ⌘] today follow the sidebar's order. They keep following the Navigator's order, which is the same list.
- **An empty workspace** shows the Navigator next to an empty board, not the full-window "hello". The hello moves onto the board.
- **Pointer events during resize.** The existing `.sidebar-resizing` rule (no pointer events on xterm and embeds) moves to the sidebar edge.

## Open questions

- ~~**"Move to Workspace" next to "Move to Space…".**~~ Settled (2026-10-09): Spaces became workspaces and the main area became the board, so the menu reads "Move to Board" next to "Move to Workspace…".

- **Name.** "Navigator" (Xcode's left pane) or something plainer: "Sessions", "Overview"? This is a copywriting decision. Users will mostly just call it "the sidebar".
- **One window per side, or a stack?** Proposed: one, for now. A vertical stack (Navigator above Live Diff) is the obvious next ask, and `Docks` can grow `ids: WindowId[]` without a migration headache.
- **Should the Navigator list sidebars?** Proposed: no, they are always in view. But a hidden side's window would then be listed nowhere. List hidden ones?
- **What goes on the top bar's right side**, and whether anything moves up from the footer: to try once the top bar exists.
- **Keyboard focus for sidebars:** ⌃⌘← / ⌃⌘→ to focus the left or right sidebar?

## As built

- **Phase 0 result: `moveBefore` doesn't keep a `<webview>` alive.** In Electron 44 (Chromium 152) a moved webview reloads with `moveBefore` as with `appendChild`: Electron reattaches the guest. So phase 2 (window hosts) was dropped. Docking or undocking a browser window or Magic widget reloads it once, from its state; terminals reattach their xterm as they always did. Sidebars render in their own component (`components/Dock.tsx`), beside `WindowsView`, not inside it.
- **The top bar is 32 px**, not 44: its height is `TOPBAR_HEIGHT` in `shared/chrome.ts`, and main centres the traffic lights from it (`trafficLights()`), so the two can't drift. It has the footer's background and a separator on its bottom edge.
- **Sidebars are a grid column each** of `.stage` (`left | board | right`), so the board's view modes get the space between them without any change to `layouts.ts`. `dockWidths()` in `docks.ts` keeps 320 px for the board, narrowing the right side first.
- **Focus mode** keeps showing the window it showed when a sidebar is selected (`WindowsView` remembers the last selected board window).
- **The workspace switch slide** (store.ts `slideSidebar`) runs on the left sidebar's window body while it holds a Navigator: each workspace has its own Navigator window, so the old list element no longer survives the switch.
- **File browsers** drop their size and date columns below 420 px (a container query), so they work as a sidebar.
- `view.sidebar` is Show Left Sidebar (⌃⌘S); `view.rightSidebar`, `window.dockLeft`, `window.dockRight` and `window.undock` are new, in the View and Window menus. An empty left side shown again gets a new Navigator.
- **Canvas and strip run under the sidebars**: in those modes the board spans all three columns and the sidebars float over it (`.stage.canvas`). `WindowsView` gets the sidebars' widths as `insets` and works out Fit, Zoom to Window, reveal-on-select and the minimap for the area between them. The strip's maths stays in the visible area (its viewport is the space between the sidebars), and only its windows' rects move right by the left sidebar, so scrolled to an end its windows sit between the sidebars and in between they slide under them.
- **Strip page dots are in the footer's centre** (portalled into `.statusbar-centre`), so strip windows are as tall as the sidebars and the other modes' windows.
- **Resize edges, one rule for strip windows and sidebars**: each gap is split down the middle and each half belongs to the window whose edge it touches (plus 2px into its outline), so grabbing a window's edge always resizes that window. Strip windows have a left edge too: it grows the window leftwards, its right edge staying put while the strip scrolls. Hovering or dragging lights a line with a grip on that window's own edge (`.resize-edge`).
