# Sidebars are windows

> Status (2026-10-05): proposal, nothing built. Branch `sidebars`. Builds on [16-widgets.md](16-widgets.md) (widgets are windows underneath), [11-spaces.md](11-spaces.md) (per-Space layout in `Space.view`) and [10-window-titles.md](10-window-titles.md) (one title bar for every window).

Some people want cmd to feel more like an IDE, with a file tree down the left. We could build a file-tree sidebar. Then someone wants the CI runs on the right, then a notes panel, and every one would be a special case. Instead, we embrace the window concept all the way: **any window can become a sidebar.**

Right-click a window's title bar → **Make Sidebar** → **Left** or **Right**. The window leaves the workspace and docks to that edge of the app window. It keeps its full height, you can drag its width, and it floats a little apart from the edge, like the sidebars in recent macOS. It is still the same window: same title bar, same menu, same state. Return it to the workspace and it goes back into the layout.

Sidebars belong to a Space. One project might keep a file browser on the left and a CI widget on the right, while another keeps only the default left sidebar.

Today's sidebar becomes a built-in widget, the **Navigator** (working name), docked left by default in every Space. With windows no longer running all the way to the top of the app window, there is room for a real **top bar**: a drag handle with the Space switcher on the left, and room on the right for view switchers and actions later. The bottom row stays as it is: the core's health bottom left, the status bar beside it. The background turns into one continuous canvas that every window, docked or not, sits on.

## What people see

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●   ◆ cmd ▾   +                 (drag)                                   │  top bar
│ ╭───────────╮  ╭──────────────╮ ╭──────────────╮  ╭────────────────────────╮ │
│ │ Navigator │  │ zsh · ~/src  │ │ claude       │  │ CI runs                │ │
│ │ ───────── │  │              │ │              │  │ ───────                │ │
│ │ Needs you │  │              │ │              │  │ ✓ build #412           │ │
│ │ Agents    │  │  workspace   │ │              │  │ ✗ e2e   #411           │ │
│ │ Windows   │  │  (strip/grid │ │              │  │                        │ │
│ │ Widgets   │  │   /canvas)   │ │              │  │                        │ │
│ │ Recent    │  │              │ │              │  │                        │ │
│ ╰───────────╯  ╰──────────────╯ ╰──────────────╯  ╰────────────────────────╯ │
│ ● core          412 MB · 3%                               ▢ ⊞ ▥ ⧉   ⌘  ⚙  │  bottom row, as today
└──────────────────────────────────────────────────────────────────────────────┘
   left sidebar          the workspace: every other window       right sidebar
```

- **The backdrop** (`--bg`) fills the space between the top bar and the bottom row. The sidebars and the workspace's windows sit on it, inset by the gutter.
- **The top bar** (about 44 px; `--titlebar-h` today is 38) spans the full width and is the app window's drag region:
  - left: the traffic lights, then the **Space switcher** (moved from the bottom of the sidebar) and **+** (New…, the sidebar's + today);
  - the rest is drag space for now. The right side is where view switchers and actions could go later; that's an experiment for after this lands.
- **The bottom row stays as it is.** The core's health (`CoreStatus`) keeps its place bottom left, where the sidebar footer is today, and the status bar (the selected window's usage, view modes, Palette, Settings) keeps the rest of the row. The only change is that the left cell no longer belongs to the sidebar: it is its own cell, so it stays put when the left side is hidden, empty, or holds another window.
- **Sidebars** look like windows because they are windows: the same `TileTitle`, frame, radius and shadow. Each side holds one window. A sidebar's inner edge resizes it, and a double-click resets it. A sidebar keeps its width when you switch view modes.
- **The workspace** is everything else. Every layout (focus, grid, strip, canvas) gets the space between the sidebars as its viewport.

### Making and unmaking sidebars

| Where | What |
|---|---|
| Title bar menu of a workspace window | **Make Sidebar ▸ Left / Right**. If that side already holds a window, that window goes back to the workspace. |
| Title bar menu of a sidebar | **Move to Right Sidebar** (or Left), **Move to Workspace** |
| Window menu | The same items, for the selected window (every shortcut needs a real menu item) |
| View menu | **Show Left Sidebar** (⌃⌘S, the `view.sidebar` command today) and **Show Right Sidebar**: these hide and show a side, they don't close its window |
| ⌘W on a sidebar | Closes the window, the same as everywhere else. The side becomes empty. |

Later: drag a title bar to the left or right edge of the app window, and a drop zone shows where it will dock (phase 5).

### Naming

The labels follow the copywriting skill: Title Case for menu items, a verb first, 1–4 words, and no ellipsis, since every item acts at once.

- **Workspace** is the main area where windows sit in a layout (focus, grid, strip, canvas). It isn't "the desk".
- **Sidebar** is a window docked left or right. People say "the left sidebar", never "the dock", because the Dock is macOS's. `docks` stays an internal name.
- Menu items: **Make Sidebar ▸ Left / Right**, **Move to Left Sidebar**, **Move to Right Sidebar**, **Move to Workspace**, **Show Left Sidebar**, **Show Right Sidebar**.
- Tooltip on a sidebar's inner edge: "Drag to resize · double-click to reset", as the sidebar's edge says today.

"Desk" is already in the app and the docs, and should become "workspace" in the same change so the two words never ship side by side:
- `widget.remove` reads **Remove from Desk** (`shared/commands.ts`). It becomes **Remove from Workspace**.
- The first-removal toast: "Removed “…” from the desk. It's in your Widget Library." becomes "…from the workspace…".
- The copywriting skill's list of names ("Spaces, the desk, agents…"), the comments in `WidgetLibrary.tsx` and the wording in [16-widgets.md](16-widgets.md).

### The Navigator

The Navigator is today's `Sidebar.tsx` turned into a window view: search (⇧⌘F), Needs you, Agents, Windows, Widgets, Recent. The Space switcher and + move into the top bar and the core's health into its own bottom-left cell, so it keeps only what is about the Space's windows.

- It is a built-in widget (`role: "widget"`), so it is in the Widget Library. Close it and you can put it back from there.
- Every new Space starts with a Navigator docked left. Existing Spaces get one the first time they are shown, which is the migration (see Data).
- It doesn't list itself. It doesn't list other sidebars either, since they are always in view. Open question below.
- Since it is just a window, people can dock it on the right, or put it on the workspace next to their terminals.

## Under the hood

### Data: a Space's sidebars are layout

Sidebars are per-Space layout, like strip widths and the canvas camera, so they live in `Space.view` through `useSpaceView`:

```ts
// Space.view["docks"]
interface Docks {
  left:  { id: WindowId | null; width: number | null; hidden: boolean };
  right: { id: WindowId | null; width: number | null; hidden: boolean };
}
```

- **No protocol or core storage change.** `Space.view` is already opaque, per key and debounced (`store.ts` → `space.update { view }`). A window's `spaceId` already ties it to the Space.
- `width: null` means the window type's default. `hidden` is the View-menu toggle. It replaces the global `sidebar.open` / `sidebar.width` UI state, which becomes the migration source.
- A side whose window has closed or moved to another Space counts as empty. The renderer drops the stale id the next time it writes, the same way `arrangeTiles` drops closed panes.
- **Default and migration.** When a Space is shown and has no `docks` key, the renderer creates a Navigator (`window.open { kind: "navigator" }`) and docks it left, carrying over `sidebar.open`/`sidebar.width`. A Space is only ever shown in one app window at a time (11-spaces.md, rule 4), so two app windows can't race to create two Navigators.

Why not a field in the window's state: that state belongs to the window's type, and docking is something the Space's layout decides, like grid order. It would also make "Move to Space" carry a dock along into a Space that has no room for it.

### Core

- A new window type `navigator` in `packages/core/src/windows/builtin.ts`: `role: "widget"`, an empty state, titled "Navigator". It is registered like `agents` and `diff`.
- Nothing else. The Navigator's data is the renderer store it already reads (`buildRows`, `search.*`).

### Layouts

`layouts.ts` stays pure. `WindowsView` computes the workspace viewport as the app window minus the top bar and the bottom row, and minus each visible sidebar (its width plus a gutter) and hands that to the layout. Docked ids leave the ids the layout sees. They are filtered out before `arrangeTiles`, so grid order and strip widths are kept for when a window returns to the workspace.

New in `layouts.ts`, also pure and tested: `dockRects(docks, vp, spacing, topBar)` → the rect for each sidebar, in screen coordinates.

- Workspace navigation (⌥⌘← / ⌥⌘→, ⌘[ / ⌘], ⌃⌘1–9) covers the workspace only. A sidebar is selected by clicking it, or later with a shortcut of its own (open question).
- Focus mode: sidebars stay visible, and the one workspace window fills the space between them.
- Canvas: the canvas ends at the sidebars. It doesn't run underneath them (open question).

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

Views also get `placement: "workspace" | "sidebar"` (context, not a prop on every view), so a view can adapt. Files could drop its toolbar labels, and the Navigator only ever renders docked-style rows. Every type can be docked, terminals included: an agent's terminal on the right is a reasonable thing to want.

### The app shell

`App.tsx`'s grid changes from "sidebar column spanning both rows + main + status row" to:

```
.app            grid: top bar / content / bottom row
  .topbar       drag region; Space switcher, + (right side free for later)
  .stage        position: relative; the backdrop
    WindowsView (workspace + sidebar layer)
  .bottom       CoreStatus (bottom left, as today) · StatusBar (unchanged)
```

- `SpaceBar` moves into `.topbar` and drops down below it, not above (`placement`).
- `StatusBar` stays as it is. `CoreStatus` keeps its bottom-left cell, now always at the width it has today (`--sidebar-w`'s default) rather than tracking the sidebar, so the two still share one row and one height. Whether the cell should follow the left sidebar's width instead is easy to try later.
- `drag-strip` and `.app.no-sidebar` go away: the top bar is always there.
- **Windows (the OS):** `titleBarOverlay` draws the window controls top right, so the top bar reserves their width (`env(titlebar-area-width)`), and the right-hand actions sit to their left. On macOS the traffic lights stay at `trafficLightPosition`, vertically centred in the taller bar (y adjusted in `main/index.ts`).

### Settings

- `ui.sidebarRecent` and `ui.sidebarPadding` stay, describing the Navigator. Their wording changes, and so does their place in `settings/layout.ts` if a Navigator section makes sense.
- No new settings at first. Sidebar insets follow `ui.gutter`, and their look follows the window settings (radius, outline, shadow), because they are windows.

## Plan

One worktree per phase; each ends green (`pnpm typecheck && pnpm test`, e2e updated).

0. **Spike: window hosts.** `moveBefore` with a `<webview>` and an xterm host in Electron 44, plus a throwaway page and a note here with the result. It decides whether docking a webview reloads it.
1. **The top bar.** Add `.topbar`, move the Space switcher and + into it, and centre the traffic lights. Give `CoreStatus` its own bottom-left cell. The old sidebar stays where it is, between the two bars. This change is visible but low-risk. e2e: the footer/status-bar alignment check stays and points at the new cell.
2. **Window hosts.** Portal plus host plus `moveBefore` (or the fallback) in `WindowsView`, with no visible change. This is where remount bugs would show up, so it gets its own phase.
3. **Sidebars.** `Space.view.docks`, the workspace viewport, `dockRects`, the sidebar layer, the resize edge, and the menus and commands (`window.dockLeft`, `window.dockRight`, `window.undock`, `view.sidebar` → left, `view.rightSidebar`). Rows are filtered out of workspace navigation. "Desk" becomes "workspace" everywhere it shows (see Naming). Tests: `dockRects` and the workspace viewport in `layouts.test.ts`; stale ids dropped.
4. **The Navigator.** The `navigator` core type, `Sidebar.tsx` → `components/Navigator.tsx` registered as a view, the default dock and migration, and removing the old shell slot. e2e: the sidebar search and Widgets checks run against the Navigator window.
5. **Polish.** Drag a title bar to an edge to dock and away from it to undock, dock/undock animations (the tile glides between its rects), `placement`-aware Files, README and CHANGELOG (changelog skill).

Merge the `windows` worktree first if it lands soon: it has uncommitted changes to `App.tsx`, `model.ts`, `styles.css` and `windows/builtin.tsx`, the same files phases 1–4 touch. The append-only registries (`shared/commands.ts`, `settings/layout.ts`, core `builtin.ts`) will conflict as usual. Keep both sides.

## Risks

- **Webview reloads** on dock and undock: phase 0 decides, and the fallback is acceptable.
- **Narrow app windows.** Two sidebars at 280 px leave little workspace. Today's rule (`innerWidth - 320`) becomes: the workspace keeps at least 320 px, and sidebars shrink to their `minWidth`, then the right one hides (and its toggle says so).
- **Shortcut habits.** ⌃⌘1–9 and ⌘[ / ⌘] today follow the sidebar's order. They keep following the Navigator's order, which is the same list.
- **An empty Space** shows the Navigator next to an empty workspace, not the full-window "hello". The hello moves into the workspace area.
- **Pointer events during resize.** The existing `.sidebar-resizing` rule (no pointer events on xterm and embeds) moves to the sidebar edge.

## Open questions

- **"Move to Workspace" next to "Move to Space…".** Both sit in the same title bar menu, and Spaces are what some people call workspaces, so the two can read as the same thing. Options: keep both (the ellipsis and the Spaces picker set them apart), or give sidebars their own group: **Sidebar ▸ Left / Right / None**, where None returns the window to the workspace.

- **Name.** "Navigator" (Xcode's left pane) or something plainer: "Sessions", "Overview"? This is a copywriting decision. Users will mostly just call it "the sidebar".
- **One window per side, or a stack?** Proposed: one, for now. A vertical stack (Navigator above Live Diff) is the obvious next ask, and `Docks` can grow `ids: WindowId[]` without a migration headache.
- **Should the Navigator list sidebars?** Proposed: no, they are always in view. But a hidden side's window would then be listed nowhere. List hidden ones?
- **Canvas under sidebars?** Overlaying would feel more "floating on the canvas" but hides windows behind sidebars. Proposed: no.
- **What goes on the top bar's right side**, and whether anything moves up from the bottom row: to try once the top bar exists.
- **Keyboard focus for sidebars:** ⌃⌘← / ⌃⌘→ to focus the left or right sidebar?
