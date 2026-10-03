<p align="center">
  <img src="apps/desktop/build/icon.png" width="128" alt="cmd app icon">
</p>

<h1 align="center">cmd</h1>

<p align="center">
  A personal terminal + coding-agent workbench for macOS.
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero-dark.png">
  <img alt="cmd in the grid layout: agents grouped by what needs you in the sidebar, three Claude sessions, htop, an editor and a browser window" src="docs/screenshots/hero-light.png">
</picture>

Agents are grouped by what needs you. The canvas lays windows out freely; the palette searches every past session.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/canvas-dark.png">
  <img alt="The canvas view with a minimap" src="docs/screenshots/canvas-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/search-dark.png">
  <img alt="Session search in the command palette" src="docs/screenshots/search-light.png">
</picture>

## Layout

```
packages/protocol   shared types: data model, JSON-RPC API, settings schema, sidebar ordering
packages/core       the core process: PTYs (node-pty), agent tree, hooks, SQLite, settings, Unix socket
packages/cli        `cmd` — the same API from any shell, hook entry point, host-agent commands
apps/desktop        Electron UI (React + xterm.js), a client of the core
e2e/                Playwright smoke test driving the real app
```

The core is a separate, long-lived process. The UI connects over a Unix socket and can reload or quit without killing terminals. The core and CLI run TypeScript directly on Node ≥ 22.18, so there is no build step.

## Develop

```sh
pnpm install
pnpm dev                     # Electron with HMR; starts a core if none is running
pnpm test                    # vitest: unit + real-PTY integration tests
pnpm typecheck
pnpm e2e                     # build, launch the app via Playwright, screenshots in .cmd-dev/shots
```

Run against an isolated dev state instead of your real one:

```sh
export CMD_HOME=$PWD/.cmd-dev     # socket, SQLite and settings.json go here
pnpm core                         # or let `pnpm dev` start it
pnpm cmd ls
pnpm core:stop                    # stop the core of $CMD_HOME
```

Cores are detached and outlive the app, so after dev sessions they pile up, each holding its terminals' PTYs (macOS allows 511 in total). `pnpm core:stop-all` stops every cmd core on the machine, your real one included. `pnpm e2e` cleans up its own.

Inside the Agent Safehouse sandbox, Electron needs `CMD_NO_SANDBOX=1`.

## Packaging and releases

`pnpm dist` builds `apps/desktop/dist/cmd-<version>-arm64.{dmg,zip}`. The app ships the core's TypeScript source in `Contents/Resources/runtime` (staged by `scripts/stage-runtime.mjs`) and runs it with Electron's own Node, so no system `node` is needed.

CI (`.github/workflows/build.yml`) typechecks, tests and packages every push. `pnpm release 0.2.0` (or `patch`/`minor`/`major`) bumps the version, tags `v0.2.0` and pushes; CI builds the tag and publishes a GitHub release with the .dmg and .zip (a version with a `-`, like `0.2.0-beta.1`, is a prerelease). Signing and notarization run when the `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` secrets exist; without them the app is ad-hoc signed, and you open it the first time with right-click → Open.

## CLI

```sh
cmd ls                               # panes and agents as a tree
cmd new -- htop                      # open a pane running a command
cmd spawn claude "fix the tests"     # start an agent; inside an agent it becomes a child
cmd send <agent> "also update docs"
cmd read <agent> --lines 40
cmd wait <agent…> --any --timeout 50
cmd kill <agent> --tree
cmd notify "deploy finished"         # a notification; inside cmd it marks this terminal
cmd events                           # NDJSON stream
cmd settings                         # list; `set KEY VALUE`, `reset KEY`, `path`
cmd hooks claude                     # print the hook config to merge into ~/.claude/settings.json
```

Link it onto your PATH with `ln -s $PWD/packages/cli/bin/cmd ~/bin/cmd`.

### Agent detection and hooks

The core detects agents in two ways, both ported from the ghostty-agents fork.

- **Foreground process.** A small native helper (`packages/core/native/procinfo.c`, built by `pnpm install`) reads each terminal's foreground process with its full argv. Agents are found even behind wrappers such as `bash …/safehouse … claude`, `sandbox-exec … claude` and `node …/codex`. The process start time is used to ignore stale hook status.
- **Hook status files.** Every pane is started with `GHOSTTY_AGENTS_SURFACE_ID=<pane id>`, so the hook already installed by the fork (`~/.claude/hooks/ghostty-agents-status.sh`) works unchanged. It writes `$TMPDIR/ghostty-agents/<pane id>/<Event>.json`, and the core watches that directory. The fork's `.zshrc` patch already passes the variable through safehouse.
  - State comes from the newest session only, and files older than the agent process are ignored.
  - The last prompt becomes the title fallback.
  - The current tool is shown only if its call came after the last prompt.

`cmd hook <kind>` (talks to the socket; `cmd hooks claude` prints its config) remains an alternative for agents without the shell hook.

### Notifications

One path for every source (`packages/core/src/notifications.ts`): agents needing input or finishing a turn, terminal bells (`\a`), notifications programs ask for with escape codes (OSC 9, OSC 777, kitty's OSC 99), commands that ran longer than `notifications.longCommand` seconds (from the shell integration's OSC 133 marks), and `cmd notify`. A terminal that wants you gets an attention marker in its title bar and sidebar row, and counts toward the Dock badge, until you look at it. Whether a system notification shows, its sound and the Dock bounce are `notifications.*` settings; right-click a terminal to mute it.

## Settings

The schema is `packages/protocol/src/settings.ts`, with flat dotted keys. User values go in `~/.config/cmd/settings.json` (comments allowed), or in `$CMD_HOME` in dev. The core watches the file, so edits apply live. Three ways to change a setting: ⌘, in the app, `cmd settings set`, or editing the file. Every setting applies at once, including to running shells (`open` rules) and search (the indexer restarts). The exceptions are tagged in the UI and CLI: `shell.program`, `shell.login` and `shell.integration` affect new terminals only, and `ui.defaultView` only the first launch.

## Shortcuts

Every shortcut is a real menu-bar item. Remap any of them in `~/.config/cmd/keybindings.json` (map a command id to a shortcut, a list, or `null`). The file is watched, and the full list with ids is under Settings → Keyboard Shortcuts.

| | |
|---|---|
| ⌘N (⌘T) | new terminal (in the current folder) |
| ⌥⌘N | new Claude session |
| ⌘W | close the frontmost thing: the palette, then the terminal (asks if something is running), then the window |
| ⇧⌘W | close window (terminals keep running in the core) |
| ⌥⌘← / ⌥⌘→ (⇧⌘[ / ⇧⌘]) | previous / next session |
| ⌘1–9 | select session |
| ⌃⌘J | next session needing attention |
| ⌘K | command palette (`>` commands, `@` sessions, `#` tools) |
| ⌘, | settings |
| ⌘C / ⌘V / ⌘A | copy / paste / select all, in the terminal or a text field |
| ⌥⌘K | clear buffer |
| ⌘+ / ⌘− / ⌘0 | terminal text size (this session only) |
| ⌥⌘1/2/3/4 | focus / grid / strip / canvas |
| ⇧⌘1 / ⇧⌘2 | canvas: zoom to fit all / to the selected window |
| ⌃⌘S | show/hide sidebar |
| ⇧⌘F | search the sidebar: open windows and past sessions |
| ⌥⌘R | show folder in Finder |

On the canvas, drag a title bar to move a window and its right or bottom edge or corner to resize it. Pinch or ⌘-scroll to zoom, and scroll or drag the background to pan. Scrolling over the selected window scrolls that window instead. Windows stay live at every zoom; `canvas.minZoom`/`canvas.maxZoom` set the range (30–150% by default). Double-click a title bar to zoom to that window, or the background to fit everything. Click or drag the minimap to move around (`canvas.minimap` hides it).

The sidebar groups what is open into Needs you, Agents and Windows (attention first, then recency), then Recent past sessions from the transcript index and the Tools. Its search field filters the open windows and searches the index as you type: ↑/↓ and Return open a result (a past session resumes in a new terminal, or switches to it if it is open), Esc clears. Drag the sidebar's right edge to resize it; double-click the edge for the default width.

Right-click a sidebar row or a terminal for context menus: copy resume command / session id, reveal transcript, new terminal here, and so on. The window remembers its size and position, and the Dock menu has New Terminal / New Claude Session.

## Status

**Done**
- Core: PTYs, OSC 0/2/7/9/777/133 parsing, launch commands typed once the shell is ready
- Agents: detected from the foreground process, state from Claude/Codex hooks, Claude subagents as virtual children
- Host API: spawn, send, read, wait, kill (`--tree`)
- Settings and SQLite persistence
- UI: sidebar grouped by attention with search and recent sessions, focus, grid, strip and canvas views, palette, settings panel, notifications, Dock badge

**Next**
- Transcript search (port the fork's FTS5 index)
- Restore agents on relaunch
- Plugin host (routines and monitors in the core)
- Port the fork's argv inspection, to see through wrappers
- A headless VT for `pane.read` (instead of stripping ANSI)
- Codex hook install
- Packaging
