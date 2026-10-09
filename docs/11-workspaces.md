# Workspaces

> Named Spaces until 2026-10-09 ([15-positioning.md](15-positioning.md), "Naming in the product").

> Status (2026-10-03): decisions confirmed. Built: core and protocol (workspaces, placement, matching), the CLI (`cmd .`, `cmd workspace …`), the renderer (switcher, pickers, per-workspace layout) and Electron main (window ↔ workspace routing). Not yet: the CLI launching the app when it isn't running, per-workspace config, reordering workspaces in the switcher. No backwards compatibility: the store schema and `ui_state` keys change freely.

A **workspace** is a directory you work in, with everything you opened for it: its terminals, agents, browser/file/text windows and their layout. `cmd .` in any shell opens (or returns to) the workspace for that directory; ⌘O does the same from inside cmd. Workspaces keep running in the background; you switch between them in place, like Arc spaces or WezTerm workspaces, not by juggling app windows.

## What other tools do (research summary)

| Tool | Identity | Re-opening an open one | Background | Takeaway |
|---|---|---|---|---|
| VS Code | folder / `.code-workspace` file | `code .` focuses the window that has it; `-n` new, `-r` reuse | every window runs | Path identity is right; **window-per-project sprawl** is the top complaint (vscode#324309 asks for one window with a project sidebar). |
| Zed | worktree set | inconsistent: duplicates windows or mixes projects into the current one (discussion #61575) | yes | Make re-opening idempotent, always. |
| JetBrains | project dir | ask / this window / new window | per window | "Ask" dialogs are friction. |
| tmux + sesh / tmux-sessionizer | session name derived from the dir | **attach-or-create**, `switch-client` | yes, the server owns processes | The most-loved pattern: fuzzy picker over live sessions + frequent dirs, attach or create, `sesh last` to toggle back. |
| WezTerm | workspace name | `SwitchToWorkspace` creates if missing | yes (mux) | Workspaces switch in place inside one GUI window. |
| Kitty sessions, iTerm2 arrangements, Warp launch configs | a file | open twice = two copies | — | Snapshots/templates duplicate. Use templates only to seed a new workspace. |
| Zellij | session name | resurrects layout + cwd, asks before re-running commands | yes | Restore structure; never silently re-run commands. |
| Conductor, Claude Desktop | git worktree per workspace | — | yes | Agent tools map worktree → workspace, add per-workspace env (`CONDUCTOR_PORT` block), setup/archive scripts. Nested worktrees inside the repo pollute search and watchers. |
| Arc, PaperWM | named space | — | yes | One window, many contexts; per-space color/icon; numbered switching that never reshuffles (macOS "rearrange Spaces by recent use" breaks muscle memory). |

Sources: code.visualstudio.com/docs/configure/command-line · github.com/microsoft/vscode/issues/324309 · zed.dev/docs/windows-and-projects · github.com/zed-industries/zed/discussions/61575 · github.com/joshmedeski/sesh · github.com/ThePrimeagen/tmux-sessionizer · wezterm.org/recipes/workspaces.html · sw.kovidgoyal.net/kitty/sessions · zellij.dev/documentation/session-resurrection.html · conductor.build/docs/concepts/git-worktrees · code.claude.com/docs/en/worktrees · github.com/paperwm/PaperWM

## Behaviour

1. **A workspace is a live core object, not a snapshot.** It has an id, a **root** (canonical `realpath`), a display name (default: the root's basename, editable), and an icon (an SF Symbol, editable; default a folder, a house for Home). Panes, agents and windows each belong to exactly one workspace.
2. **Opening is attach-or-create by root.** `cmd .`, ⌘O, `cmd workspace open DIR`: if a workspace has that root, show it; otherwise create it. A path never yields two workspaces. The root is the exact directory (like `code .`); `--git-root` snaps to the repository root. A linked git worktree is its own directory, so it gets its own workspace.
3. **Home.** There is always a *Home* workspace rooted at `~`. It can't be closed and catches everything that has no better workspace. A fresh install is just Home, so cmd works as before until you open a folder.
4. **An app window shows one workspace at a time and switches in place.** Switching to a workspace that another app window already shows focuses that window instead. One workspace is never shown in two windows at once, because its layout (strip widths, canvas camera) is fitted to one viewport. ⌘⏎ in the picker, or "Open Workspace in New Window", opens a workspace in its own app window. File → New Window… (⇧⌘N) opens the picker for that. The setting `workspaces.ownWindow` makes it the rule: showing a workspace that no window shows opens a new window (switcher, ⌘O, ⌃1–9, `cmd .`), and closing a workspace closes its window. Windows and their placement per display setup come back on launch either way (`main/workspaces.ts`, `main/displays.ts`).
5. **Background workspaces keep running.** Their terminals and agents run as before, since the core already outlives the UI. Attention crosses workspace boundaries:
   - The workspace switcher shows needs-you and done-unseen markers per workspace.
   - ⌃⌘J ("next needing attention") switches workspace if it has to.
   - The Dock badge and notifications count every workspace.
   - Clicking a notification shows the workspace it came from.
6. **Defaults follow the workspace.**
   - A new terminal starts in the selected terminal's cwd if that is inside the root, otherwise in the root.
   - New Files windows open at the root.
   - New agents (`file.newClaude`) start in the root.
   - "Resume session" and recent sessions in the palette are scoped to transcripts whose cwd is under the root, with a "show all" escape.
7. **Membership of new things** is resolved in this order:
   1. an explicit `workspaceId`;
   2. the **calling pane's** Workspace (`cmd new`, `cmd spawn`, shell `open`, agent hooks, subagents);
   3. the workspace shown in the app window that asked (UI calls pass it);
   4. the workspace whose root is the **longest prefix** of the cwd or path (`cmd new` from an outside terminal);
   5. Home.
8. **Moving.** "Move to Workspace…" (context menu, palette, `cmd move`) moves a window into another workspace. Moving a terminal moves its agent tree with it.
9. **Lifecycle.**
   - **Close** kills the workspace's terminals and agents (with a confirmation listing what still runs) and removes its windows. The record stays as a *recent* Workspace, so reopening it brings back its name, icon and layout preferences.
   - **Forget** deletes the record.
   - Archive and setup scripts are left for later.
10. **Restart.** When the core restarts, workspaces, their windows and their terminals come back: terminals keep running in the PTY host, and those lost (host died, reboot) are resurrected under the same id, agents resumed (DEVELOPMENT.md, "Restore"). Commands are never re-run without asking.

### Path matching

A workspace's identity is its root, so matching has to treat every spelling of a folder as the same folder and never confuse neighbours. Implemented in `packages/core/src/workspaces/paths.ts`; tested on the real file system in `packages/core/test/workspaces.test.ts`.

- **Canonical paths.** `~` is expanded and relative paths resolve against the *caller's* cwd (the CLI sends it; the core's own cwd is meaningless). Then `fs.realpathSync.native` (realpath(3)) is applied. It follows symlinks (`~/p → ~/src/proj`, `/tmp → /private/tmp`, `/var → /private/var`) and returns the **on-disk spelling**: case on case-insensitive APFS (`~/SRC/CMD` → `~/src/cmd`) and Unicode form (an NFD `café` → the stored NFC one). The JS `fs.realpathSync` does neither, so it must not be used.
- **Missing parts.** Parts that don't exist (a deleted cwd, a file not created yet) are kept as written, NFC-normalized, below the deepest existing ancestor. Its symlinks still resolve.
- **Segments, not prefixes.** `~/src/cmd` contains `~/src/cmd/x`, never `~/src/cmd-old`.
- **Deepest open root wins.** Nested workspaces (`~/src/cmd` and `~/src/cmd/packages/core`) both work. Closed workspaces never match. Anything outside every root, `/tmp` included, goes to Home.
- **Opening needs an existing folder.** `cmd ./README.md` or `cmd ~/typo` is an error, not a workspace rooted at a file or at nothing. Opening the home folder returns Home.
- **Exact folder by default.** `--git-root` snaps to the nearest `.git` entry, a folder or a file, so a linked worktree or a submodule is its own root, as with `git rev-parse --show-toplevel`. Outside a repository it uses the folder itself.
- **Membership is sticky.** A terminal belongs to the workspace it was created in. `cd`-ing elsewhere doesn't move it; only "Move to Workspace" does. Matching is used once, when something is created.
- **The CLI's `cmd <arg>`.** A command name always wins (`cmd ./ls` for a folder called `ls`). `.`, `..`, `~` and anything starting with `/`, `./`, `../` or `~/` is a folder argument. A bare word is a folder argument only if such a folder exists.
- **Known limit.** Roots are canonicalized when a workspace is created. If a root folder is later renamed, opening the new path creates a new workspace.

### UI

```
┌ ● ● ●  [◆ cmd ② ▾]                    ─────────────  [Focus|Grid|Strip|Canvas] ┐
│ NEEDS YOU         │        main view: this workspace's windows only                 │
│ ● fix auth flow   │                                                             │
│ ◐ index rewrite   │                                                             │
│ ○ zsh  ~/src/cmd  │                                                             │
```

- **Workspace switcher** centered at the bottom of the sidebar (like Arc), or under the traffic lights when the sidebar is hidden (`components/WorkspaceBar.tsx`):
  - A full-width button with the shown workspace's icon and name; a count in the state colour when other workspaces need you or finished unseen.
  - Clicking it drops down a menu of the open workspaces in switcher order (icon, name, folder, ⌃1–9), the icon marked with a dot in the state colour when something in the workspace needs you or finished unseen, then "Open Workspace…" (⌘O). Arrow keys and type-ahead move, ⏎ shows, ⌘⏎ (or ⌘-click) opens in a new window. Right-click a workspace (or the button) for Rename, Change Icon, Show in Finder, Open in New Window, Close. Reordering is not built yet.
  - A menu rather than a dot per workspace, so it stays usable with many workspaces.
- **Icons:** each workspace has an SF Symbol. Change Icon… (Workspace menu, right-click, `cmd workspace icon [SPACE] SYMBOL`) opens a filterable grid; any SF Symbol name typed in full works too, and "Use the default" goes back to the folder (house for Home).
- **⌘O: Workspace picker** (fuzzy):
  - Lists open workspaces, then recent (closed) Workspaces, then cwds from recent transcripts and a typed path; "Browse…" opens the native folder dialog.
  - ⏎ shows the workspace in this window; ⌘⏎ opens it in a new app window.
  - This one picker both switches and opens, like sesh.
- **⌃1–9** switch by the switcher's order (as in Arc). ⌘1–9 stay for sessions. The order is user-chosen and never reshuffled by recency.
- **⌃⌘[ / ⌃⌘]** go to the previous or next workspace. **Last Workspace** (like `sesh last`) exists without a default shortcut.
- The sidebar, grid, strip and canvas show only the current workspace. The sidebar search gets a "all workspaces" toggle.
- The app window title is the workspace name, so the macOS Window menu and Mission Control are useful.
- New menu items, all real menu items as required:
  - File → Open Workspace… (⌘O)
  - A **Workspace** menu: Next, Previous, Last, Move Window to Workspace…, Rename Workspace…, Show Workspace Folder in Finder, Close Workspace…
  - "Move to Workspace…" in a window's context menu.

## Data model

### protocol (`model.ts`, `rpc.ts`)

```ts
export type WorkspaceId = string;

export interface Workspace {
  id: WorkspaceId;
  name: string;
  /** Canonical realpath; unique among workspaces. Home: os.homedir(). */
  root: string;
  home: boolean;
  /** SF Symbol name; null: the default (folder; house for Home). */
  icon: string | null;
  /** Position in the switcher (⌃1–9). */
  order: number;
  /** null = open; set = closed, kept as a recent workspace. */
  closedAt: number | null;
  createdAt: number;
  lastActiveAt: number;
  /** Layout and selection, owned by the UI, opaque to the core (like AppWindow.state). */
  view: Record<string, unknown>;
}

// Pane, Agent, AppWindow each gain:  workspaceId: WorkspaceId
```

Agents carry `workspaceId` themselves because virtual subagents have no pane; it is set from the pane (or the parent) when the agent is created, and updated on move.

New and changed methods:

```ts
"workspace.list":   { params: { closed?: boolean }; result: workspace[] };
/** Attach-or-create by root. show: ask the UI to show it (see workspace.show). */
"workspace.open":   { params: { path: string; gitRoot?: boolean; show?: boolean; newWindow?: boolean }; result: workspace };
"workspace.update": { params: { id: WorkspaceId; name?: string; order?: number; view?: Record<string, unknown> }; result: workspace };
"workspace.close":  { params: { id: WorkspaceId }; result: null };
"workspace.forget": { params: { id: WorkspaceId }; result: null };
"window.move":  { params: { id: WindowId; workspaceId: WorkspaceId }; result: AppWindow };

// pane.create, window.open, window.openTarget, agent.spawn, agent.resume gain workspaceId?: WorkspaceId
// (resolved by the rule above when omitted). View queries (data.view, data.subscribeView) take workspaceId?: WorkspaceId.
// events.subscribe's snapshot gains workspaces: workspace[].
```

Events: `workspace.updated`, `workspace.removed`, and `workspace.show { workspaceId, newWindow }`, which replaces most uses of `window.focus`. `window.focus` keeps working within a workspace; the UI switches workspace first when the window lives elsewhere.

No `CMD_WORKSPACE_ID` env var. A pane can be moved, so its env would go stale. Calls carry `callerPaneId` (the CLI sends `CMD_PANE_ID`), and the core looks up that pane's current workspace. `workspace.match { path }` answers "which workspace would this go to" without creating anything (`cmd workspace which`).

### core

- `workspaces.ts`: `WorkspaceManager` (EventEmitter like `WindowManager`):
  - `open(path)` does realpath, attach-or-create and assigns `order`.
  - `resolve({ workspaceId, paneId, cwd })` implements the membership rule.
  - `close` and `forget`.
  - Home is created on first start.
- `PaneManager.create`, `WindowManager.open` and `AgentTracker` take a resolved `workspaceId`. `terminalWindow(p)` copies `p.workspaceId`.
- `store.ts`:
  - Add a `spaces (id, root UNIQUE, doc)` table. `windows.doc` and `agents.doc` include `workspaceId`.
  - Drop the old url/path migration in `Store.windows()`.
  - `ui_state` stays, for global UI preferences only.
- `workspace.close` kills the workspace's panes (agent trees with them) and deletes its windows.

### renderer

- `State` gains `workspaces: Map<WorkspaceId, workspace>` and `workspaceId` (the workspace this app window shows).
- `buildRows`, the layout `ids` and palette sources filter by `workspaceId` in one place: a `useWorkspaceItems()` selector.
- Per-workspace layout moves out of global `ui_state` into `Workspace.view` via a `useWorkspaceView(key, fallback)` hook. It has the same debounce as `usePersisted` but writes with `workspace.update { view }`. The `view` patch merges per key so two keys don't race. Two details matter:
  - The core sends the whole view back on every change. The store re-applies values that haven't been echoed yet, and keeps the old object for every value that didn't change. Without that, a selection echo arriving mid-drag hands the layout a "new" grid order and strip widths.
  - The setter writes to the workspace shown *when it is called*, so callbacks created before a switch don't write into the previous workspace.
- `select(id)` of a window in another workspace asks main to show that workspace with the window selected. That covers notification clicks, ⌃⌘J across workspaces, and resuming a live session.

| Moves to `Workspace.view` | Stays global (`ui_state`) |
|---|---|
| `view.mode`, `grid.order`, `strip.widths`, `canvas.rects`, `canvas.camera`, `selection.pane`, `selection.history` | `sidebar.open`, `sidebar.width`, `sidebar.sections`, `sidebar.collapsed`, `terminal.zoom`, `palette.recent` |

### Electron main

- `main/workspaces.ts` (`WorkspaceWindows`). `windows.json` (`{ windows: [{ workspaceId, bounds }] }`) replaces the single `window.json`, so all app windows come back with their workspaces. New windows cascade from the focused one.
- A renderer learns its workspace from a `?space=` query parameter and reports switches over IPC (`workspace:shown`). Main thus knows which window shows which workspace.
- Main subscribes to `workspace.show` (`events.subscribe { types: ["workspace.show"] }`):
  - focus the window that shows that workspace;
  - otherwise switch the last-focused window to it;
  - with `newWindow`, or when no window is open, create a window.

### CLI

- `cmd .` / `cmd <dir>`: when the first argument is path-like (`.`, `..`, `/…`, `~…`, `./…`) or an existing directory that isn't a command name, it means `workspace.open { path, show: true }`. Flags: `-n` (new app window), `--git-root`.
  - **From an outside terminal:** if no core answers, or no UI is subscribed, the CLI launches the app (`open -b <bundle id>`), waits for the socket, then calls `workspace.open`. `core.hello` gains a `uis` count for this.
  - **From inside a cmd pane:** the same call switches that app window to the workspace. The calling terminal stays where it is.
- `cmd workspace ls | open DIR | close [ID] | rename NAME | icon SYMBOL`, and `cmd move <window> <space>`.
- The shell's `open .` stays as it is (a Files window in the current workspace), so `open .` gives you a window and `cmd .` gives you a workspace.

## Plan

1. **Core + protocol:** the `Workspace` type, `WorkspaceManager`, the store table, `workspaceId` on panes, windows and agents, the resolution rule, and the methods and events. Tests:
   - attach-or-create is idempotent (symlinks and trailing slashes resolve to one workspace);
   - longest-prefix resolution;
   - the caller pane wins over cwd;
   - close kills only that workspace's panes;
   - subagents inherit the workspace.
2. **Renderer:** filtering, `useWorkspaceView`, the switcher, the ⌘O picker, ⌃1–9 and prev/next, cross-workspace attention, Move to Workspace.
3. **Main:** window↔workspace binding, `windows.json`, `workspace.show` routing, "Open Workspace in New Window".
4. **CLI:** `cmd .`, `cmd workspace …`, launching the app. The e2e smoke test runs `cmd <fixture dir>` and checks the switcher.
5. **Later:**
   - Per-workspace config `<root>/.cmd/workspace.json` (env, startup windows, setting overrides through `SettingsService.bind`), untrusted until approved.
   - A `CMD_WORKSPACE_PORT` block for parallel dev servers.
   - Worktree workspaces grouped under their repo in the picker.
   - Agent resume on restore.

## Decisions (confirmed 2026-10-03)

1. One app window shows one workspace at a time and switches in place. The alternative was VS Code's window-per-workspace.
2. A workspace is never shown in two app windows at once.
3. A permanent Home workspace at `~`.
4. `cmd .` uses the exact directory, with `--git-root` opt-in (sesh snaps to the git root by default).
5. Closing a workspace kills its terminals; there is no "detach and keep running hidden" state besides simply switching away.
