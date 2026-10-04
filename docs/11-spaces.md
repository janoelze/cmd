# Spaces

> Status (2026-10-03): decisions confirmed. Built: core and protocol (Spaces, placement, matching), the CLI (`cmd .`, `cmd space …`), the renderer (switcher, pickers, per-Space layout) and Electron main (window ↔ Space routing). Not yet: the CLI launching the app when it isn't running, per-Space config, reordering Spaces in the switcher. No backwards compatibility: the store schema and `ui_state` keys change freely.

A **Space** is a directory you work in, with everything you opened for it: its terminals, agents, browser/file/text windows and their layout. `cmd .` in any shell opens (or returns to) the Space for that directory; ⌘O does the same from inside cmd. Spaces keep running in the background; you switch between them in place, like Arc spaces or WezTerm workspaces, not by juggling app windows.

## What other tools do (research summary)

| Tool | Identity | Re-opening an open one | Background | Takeaway |
|---|---|---|---|---|
| VS Code | folder / `.code-workspace` file | `code .` focuses the window that has it; `-n` new, `-r` reuse | every window runs | Path identity is right; **window-per-project sprawl** is the top complaint (vscode#324309 asks for one window with a project sidebar). |
| Zed | worktree set | inconsistent: duplicates windows or mixes projects into the current one (discussion #61575) | yes | Make re-opening idempotent, always. |
| JetBrains | project dir | ask / this window / new window | per window | "Ask" dialogs are friction. |
| tmux + sesh / tmux-sessionizer | session name derived from the dir | **attach-or-create**, `switch-client` | yes, the server owns processes | The most-loved pattern: fuzzy picker over live sessions + frequent dirs, attach or create, `sesh last` to toggle back. |
| WezTerm | workspace name | `SwitchToWorkspace` creates if missing | yes (mux) | Workspaces switch in place inside one GUI window. |
| Kitty sessions, iTerm2 arrangements, Warp launch configs | a file | open twice = two copies | — | Snapshots/templates duplicate. Use templates only to seed a new Space. |
| Zellij | session name | resurrects layout + cwd, asks before re-running commands | yes | Restore structure; never silently re-run commands. |
| Conductor, Claude Desktop | git worktree per workspace | — | yes | Agent tools map worktree → workspace, add per-workspace env (`CONDUCTOR_PORT` block), setup/archive scripts. Nested worktrees inside the repo pollute search and watchers. |
| Arc, PaperWM | named space | — | yes | One window, many contexts; per-space color/icon; numbered switching that never reshuffles (macOS "rearrange Spaces by recent use" breaks muscle memory). |

Sources: code.visualstudio.com/docs/configure/command-line · github.com/microsoft/vscode/issues/324309 · zed.dev/docs/windows-and-projects · github.com/zed-industries/zed/discussions/61575 · github.com/joshmedeski/sesh · github.com/ThePrimeagen/tmux-sessionizer · wezterm.org/recipes/workspaces.html · sw.kovidgoyal.net/kitty/sessions · zellij.dev/documentation/session-resurrection.html · conductor.build/docs/concepts/git-worktrees · code.claude.com/docs/en/worktrees · github.com/paperwm/PaperWM

## Behaviour

1. **A Space is a live core object, not a snapshot.** It has an id, a **root** (canonical `realpath`), a display name (default: the root's basename, editable) and a hue (the existing `projectHue`). Panes, agents and windows each belong to exactly one Space.
2. **Opening is attach-or-create by root.** `cmd .`, ⌘O, `cmd space open DIR`: if a Space has that root, show it; otherwise create it. A path never yields two Spaces. The root is the exact directory (like `code .`); `--git-root` snaps to the repository root. A linked git worktree is its own directory, so it gets its own Space.
3. **Home.** There is always a *Home* Space rooted at `~`. It can't be closed and catches everything that has no better Space. A fresh install is just Home, so cmd works as before until you open a folder.
4. **An app window shows one Space at a time and switches in place.** Switching to a Space that another app window already shows focuses that window instead. One Space is never shown in two windows at once, because its layout (strip widths, canvas camera) is fitted to one viewport. ⌘⏎ in the picker, or "Open Space in New Window", opens a Space in its own app window.
5. **Background Spaces keep running.** Their terminals and agents run as before, since the core already outlives the UI. Attention crosses Space boundaries:
   - The Space switcher shows needs-you and done-unseen markers per Space.
   - ⌃⌘J ("next needing attention") switches Space if it has to.
   - The Dock badge and notifications count every Space.
   - Clicking a notification shows the Space it came from.
6. **Defaults follow the Space.**
   - A new terminal starts in the selected terminal's cwd if that is inside the root, otherwise in the root.
   - New Files windows open at the root.
   - New agents (`file.newClaude`) start in the root.
   - "Resume session" and recent sessions in the palette are scoped to transcripts whose cwd is under the root, with a "show all" escape.
7. **Membership of new things** is resolved in this order:
   1. an explicit `spaceId`;
   2. the **calling pane's** Space (`cmd new`, `cmd spawn`, shell `open`, agent hooks, subagents);
   3. the Space shown in the app window that asked (UI calls pass it);
   4. the Space whose root is the **longest prefix** of the cwd or path (`cmd new` from an outside terminal);
   5. Home.
8. **Moving.** "Move to Space…" (context menu, palette, `cmd move`) moves a window into another Space. Moving a terminal moves its agent tree with it.
9. **Lifecycle.**
   - **Close** kills the Space's terminals and agents (with a confirmation listing what still runs) and removes its windows. The record stays as a *recent* Space, so reopening it brings back its name, hue and layout preferences.
   - **Forget** deletes the record.
   - Archive and setup scripts are left for later.
10. **Restart.** When the core restarts, Spaces, their windows and their terminals come back: terminals keep running in the PTY host, and those lost (host died, reboot) are resurrected under the same id, agents resumed (DEVELOPMENT.md, "Restore"). Commands are never re-run without asking.

### Path matching

A Space's identity is its root, so matching has to treat every spelling of a folder as the same folder and never confuse neighbours. Implemented in `packages/core/src/spaces/paths.ts`; tested on the real file system in `packages/core/test/spaces.test.ts`.

- **Canonical paths.** `~` is expanded and relative paths resolve against the *caller's* cwd (the CLI sends it; the core's own cwd is meaningless). Then `fs.realpathSync.native` (realpath(3)) is applied. It follows symlinks (`~/p → ~/src/proj`, `/tmp → /private/tmp`, `/var → /private/var`) and returns the **on-disk spelling**: case on case-insensitive APFS (`~/SRC/CMD` → `~/src/cmd`) and Unicode form (an NFD `café` → the stored NFC one). The JS `fs.realpathSync` does neither, so it must not be used.
- **Missing parts.** Parts that don't exist (a deleted cwd, a file not created yet) are kept as written, NFC-normalized, below the deepest existing ancestor. Its symlinks still resolve.
- **Segments, not prefixes.** `~/src/cmd` contains `~/src/cmd/x`, never `~/src/cmd-old`.
- **Deepest open root wins.** Nested Spaces (`~/src/cmd` and `~/src/cmd/packages/core`) both work. Closed Spaces never match. Anything outside every root, `/tmp` included, goes to Home.
- **Opening needs an existing folder.** `cmd ./README.md` or `cmd ~/typo` is an error, not a Space rooted at a file or at nothing. Opening the home folder returns Home.
- **Exact folder by default.** `--git-root` snaps to the nearest `.git` entry, a folder or a file, so a linked worktree or a submodule is its own root, as with `git rev-parse --show-toplevel`. Outside a repository it uses the folder itself.
- **Membership is sticky.** A terminal belongs to the Space it was created in. `cd`-ing elsewhere doesn't move it; only "Move to Space" does. Matching is used once, when something is created.
- **The CLI's `cmd <arg>`.** A command name always wins (`cmd ./ls` for a folder called `ls`). `.`, `..`, `~` and anything starting with `/`, `./`, `../` or `~/` is a folder argument. A bare word is a folder argument only if such a folder exists.
- **Known limit.** Roots are canonicalized when a Space is created. If a root folder is later renamed, opening the new path creates a new Space.

### UI

```
┌ ● ● ●  [◆ cmd ▾]  · api •  · home     ─────────────  [Focus|Grid|Strip|Canvas] ┐
│ NEEDS YOU         │        main view: this Space's windows only                 │
│ ● fix auth flow   │                                                             │
│ ◐ index rewrite   │                                                             │
│ ○ zsh  ~/src/cmd  │                                                             │
```

- **Space switcher** centered at the bottom of the sidebar (like Arc), or under the traffic lights when the sidebar is hidden (`components/SpaceBar.tsx`):
  - The shown Space appears as its name on a hue chip; clicking it opens the picker.
  - Other open Spaces are hue dots, ringed in the state colour when something in them needs you or finished unseen. Right-click for Rename, Show in Finder, Open in New Window, Close. Reordering is not built yet.
- **⌘O: Space picker** (fuzzy):
  - Lists open Spaces, then recent (closed) Spaces, then cwds from recent transcripts and a typed path; "Browse…" opens the native folder dialog.
  - ⏎ shows the Space in this window; ⌘⏎ opens it in a new app window.
  - This one picker both switches and opens, like sesh.
- **⌃1–9** switch by the switcher's order (as in Arc). ⌘1–9 stay for sessions. The order is user-chosen and never reshuffled by recency.
- **⌃⌘[ / ⌃⌘]** go to the previous or next Space. **Last Space** (like `sesh last`) exists without a default shortcut.
- The sidebar, grid, strip and canvas show only the current Space. The sidebar search gets a "all Spaces" toggle.
- The app window title is the Space name, so the macOS Window menu and Mission Control are useful.
- New menu items, all real menu items as required:
  - File → Open Space… (⌘O)
  - A **Space** menu: Next, Previous, Last, Move Window to Space…, Rename Space…, Show Space Folder in Finder, Close Space…
  - "Move to Space…" in a window's context menu.

## Data model

### protocol (`model.ts`, `rpc.ts`)

```ts
export type SpaceId = string;

export interface Space {
  id: SpaceId;
  name: string;
  /** Canonical realpath; unique among Spaces. Home: os.homedir(). */
  root: string;
  home: boolean;
  hue: number;
  /** Position in the switcher (⌃1–9). */
  order: number;
  /** null = open; set = closed, kept as a recent Space. */
  closedAt: number | null;
  createdAt: number;
  lastActiveAt: number;
  /** Layout and selection, owned by the UI, opaque to the core (like AppWindow.state). */
  view: Record<string, unknown>;
}

// Pane, Agent, AppWindow each gain:  spaceId: SpaceId
```

Agents carry `spaceId` themselves because virtual subagents have no pane; it is set from the pane (or the parent) when the agent is created, and updated on move.

New and changed methods:

```ts
"space.list":   { params: { closed?: boolean }; result: Space[] };
/** Attach-or-create by root. show: ask the UI to show it (see space.show). */
"space.open":   { params: { path: string; gitRoot?: boolean; show?: boolean; newWindow?: boolean }; result: Space };
"space.update": { params: { id: SpaceId; name?: string; order?: number; view?: Record<string, unknown> }; result: Space };
"space.close":  { params: { id: SpaceId }; result: null };
"space.forget": { params: { id: SpaceId }; result: null };
"window.move":  { params: { id: WindowId; spaceId: SpaceId }; result: AppWindow };

// pane.create, window.open, window.openTarget, agent.spawn, agent.resume gain spaceId?: SpaceId
// (resolved by the rule above when omitted). search.recent gains under?: string.
// events.subscribe's snapshot gains spaces: Space[].
```

Events: `space.updated`, `space.removed`, and `space.show { spaceId, newWindow }`, which replaces most uses of `window.focus`. `window.focus` keeps working within a Space; the UI switches Space first when the window lives elsewhere.

No `CMD_SPACE_ID` env var. A pane can be moved, so its env would go stale. Calls carry `callerPaneId` (the CLI sends `CMD_PANE_ID`), and the core looks up that pane's current Space. `space.match { path }` answers "which Space would this go to" without creating anything (`cmd space which`).

### core

- `spaces.ts`: `SpaceManager` (EventEmitter like `WindowManager`):
  - `open(path)` does realpath, attach-or-create and assigns `order`.
  - `resolve({ spaceId, paneId, cwd })` implements the membership rule.
  - `close` and `forget`.
  - Home is created on first start.
- `PaneManager.create`, `WindowManager.open` and `AgentTracker` take a resolved `spaceId`. `terminalWindow(p)` copies `p.spaceId`.
- `store.ts`:
  - Add a `spaces (id, root UNIQUE, doc)` table. `windows.doc` and `agents.doc` include `spaceId`.
  - Drop the old url/path migration in `Store.windows()`.
  - `ui_state` stays, for global UI preferences only.
- `space.close` kills the Space's panes (agent trees with them) and deletes its windows.

### renderer

- `State` gains `spaces: Map<SpaceId, Space>` and `spaceId` (the Space this app window shows).
- `buildRows`, the layout `ids` and palette sources filter by `spaceId` in one place: a `useSpaceItems()` selector.
- Per-Space layout moves out of global `ui_state` into `Space.view` via a `useSpaceView(key, fallback)` hook. It has the same debounce as `usePersisted` but writes with `space.update { view }`. The `view` patch merges per key so two keys don't race. Two details matter:
  - The core sends the whole view back on every change. The store re-applies values that haven't been echoed yet, and keeps the old object for every value that didn't change. Without that, a selection echo arriving mid-drag hands the layout a "new" grid order and strip widths.
  - The setter writes to the Space shown *when it is called*, so callbacks created before a switch don't write into the previous Space.
- `select(id)` of a window in another Space asks main to show that Space with the window selected. That covers notification clicks, ⌃⌘J across Spaces, and resuming a live session.

| Moves to `Space.view` | Stays global (`ui_state`) |
|---|---|
| `view.mode`, `grid.order`, `strip.widths`, `canvas.rects`, `canvas.camera`, `selection.pane`, `selection.history` | `sidebar.open`, `sidebar.width`, `sidebar.sections`, `sidebar.collapsed`, `terminal.zoom`, `palette.recent` |

### Electron main

- `main/spaces.ts` (`SpaceWindows`). `windows.json` (`{ windows: [{ spaceId, bounds }] }`) replaces the single `window.json`, so all app windows come back with their Spaces. New windows cascade from the focused one.
- A renderer learns its Space from a `?space=` query parameter and reports switches over IPC (`space:shown`). Main thus knows which window shows which Space.
- Main subscribes to `space.show` (`events.subscribe { types: ["space.show"] }`):
  - focus the window that shows that Space;
  - otherwise switch the last-focused window to it;
  - with `newWindow`, or when no window is open, create a window.

### CLI

- `cmd .` / `cmd <dir>`: when the first argument is path-like (`.`, `..`, `/…`, `~…`, `./…`) or an existing directory that isn't a command name, it means `space.open { path, show: true }`. Flags: `-n` (new app window), `--git-root`.
  - **From an outside terminal:** if no core answers, or no UI is subscribed, the CLI launches the app (`open -b <bundle id>`), waits for the socket, then calls `space.open`. `core.hello` gains a `uis` count for this.
  - **From inside a cmd pane:** the same call switches that app window to the Space. The calling terminal stays where it is.
- `cmd space ls | open DIR | close [ID] | rename NAME`, and `cmd move <window> <space>`.
- The shell's `open .` stays as it is (a Files window in the current Space), so `open .` gives you a window and `cmd .` gives you a Space.

## Plan

1. **Core + protocol:** the `Space` type, `SpaceManager`, the store table, `spaceId` on panes, windows and agents, the resolution rule, and the methods and events. Tests:
   - attach-or-create is idempotent (symlinks and trailing slashes resolve to one Space);
   - longest-prefix resolution;
   - the caller pane wins over cwd;
   - close kills only that Space's panes;
   - subagents inherit the Space.
2. **Renderer:** filtering, `useSpaceView`, the switcher, the ⌘O picker, ⌃1–9 and prev/next, cross-Space attention, Move to Space.
3. **Main:** window↔Space binding, `windows.json`, `space.show` routing, "Open Space in New Window".
4. **CLI:** `cmd .`, `cmd space …`, launching the app. The e2e smoke test runs `cmd <fixture dir>` and checks the switcher.
5. **Later:**
   - Per-Space config `<root>/.cmd/space.json` (env, startup windows, setting overrides through `SettingsService.bind`), untrusted until approved.
   - A `CMD_SPACE_PORT` block for parallel dev servers.
   - Worktree Spaces grouped under their repo in the picker.
   - Agent resume on restore.

## Decisions (confirmed 2026-10-03)

1. One app window shows one Space at a time and switches in place. The alternative was VS Code's window-per-Space.
2. A Space is never shown in two app windows at once.
3. A permanent Home Space at `~`.
4. `cmd .` uses the exact directory, with `--git-root` opt-in (sesh snaps to the git root by default).
5. Closing a Space kills its terminals; there is no "detach and keep running hidden" state besides simply switching away.
