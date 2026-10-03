<p align="center">
  <img src="apps/desktop/build/icon.png" width="128" alt="cmd app icon">
</p>

<h1 align="center">cmd</h1>

<p align="center">
  A terminal for working with coding agents, on macOS.
</p>

<p align="center">
  <a href="https://github.com/janoelze/cmd/releases/latest">Download</a> ·
  <a href="#features">Features</a> ·
  <a href="#keyboard-shortcuts">Shortcuts</a> ·
  <a href="#cli">CLI</a> ·
  <a href="DEVELOPMENT.md">Development</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero-dark.png">
  <img alt="cmd in the grid layout: agents grouped by what needs you in the sidebar, three Claude sessions, htop, an editor and a browser window" src="docs/screenshots/hero-light.png">
</picture>

Run Claude Code, Codex and your shells side by side, and see at a glance which agent is waiting for you. Lay out terminals, editors and browser windows in a grid, a scrolling strip inspired by PaperWM, or on an infinite canvas. Terminals live in a background process, so quitting or reloading the app never kills them.

## Features

- **Knows your agents.** Claude Code, Codex, Gemini, Aider and others are detected on their own, even behind wrappers and sandboxes. The sidebar puts agents waiting for input first, then the ones working, then the ones done; subagents show as children.
- **Terminals that outlive the app.** A long-lived core process owns every terminal. Close the window or restart the app: your sessions are still there.
- **Four layouts.** Focus on one window, tile them in a grid, scroll through a horizontal strip of windows inspired by [PaperWM](https://github.com/paperwm/PaperWM), or arrange them freely on a zoomable canvas with a minimap.
- **Every past session, searchable.** Typo-tolerant full-text search over your Claude Code and Codex transcripts, from the palette or the sidebar. Return resumes a session in a new terminal.
- **More than terminals.** Browser, file tree, text editor and Markdown windows sit next to your terminals. `open README.md` in the shell opens it in cmd.
- **Notifications that lead somewhere.** An agent waiting, a bell, a long command finishing, an OSC 9/777/99 notification or `cmd notify`: the terminal is marked until you look at it, and counts toward the Dock badge.
- **Keyboard first.** Every action is in the menu bar and the command palette (⌘K), and every shortcut can be remapped.
- **Scriptable.** The `cmd` CLI spawns, messages, waits on and stops agents, so an agent can run other agents.
- **16 themes**, light and dark, following the system or not.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/canvas-dark.png">
  <img alt="The canvas view with a minimap" src="docs/screenshots/canvas-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/search-dark.png">
  <img alt="Session search in the command palette" src="docs/screenshots/search-light.png">
</picture>

## Install

Download the `.dmg` from the [latest release](https://github.com/janoelze/cmd/releases/latest) (Apple Silicon) and move cmd to Applications. If macOS refuses to open it the first time, right-click the app and choose Open.

**Agent state.** cmd sees that an agent is running from its process alone. To also see what it is doing (working, waiting for input, done, which tool it runs), add cmd's hook to the agent: `cmd hooks claude` (or `codex`) prints the snippet to merge into `~/.claude/settings.json` (or `~/.codex/hooks.json`). Hooks of the ghostty-agents fork work unchanged.

## Getting started

| | |
|---|---|
| ⌘N | new terminal |
| ⌥⌘N | new Claude session |
| ⌘K | command palette: type to find anything, `>` commands, `@` sessions, `?` past sessions |
| ⌥⌘1 / 2 / 3 / 4 | focus / grid / strip / canvas |
| ⌃⌘J | jump to the next session that needs you |
| ⌘, | settings |

## Keyboard shortcuts

Every shortcut is a real menu-bar item. Remap any of them in `~/.config/cmd/keybindings.json` (map a command id to a shortcut, a list, or `null`); the full list with ids is under Settings → Keyboard Shortcuts.

| | |
|---|---|
| ⌘N (⌘T) | new terminal (in the current folder) |
| ⌥⌘N | new Claude session |
| ⌘W | close the frontmost thing: the palette, then the terminal (asks if something is running), then the window |
| ⇧⌘W | close window (terminals keep running) |
| ⌥⌘← / ⌥⌘→ (⇧⌘[ / ⇧⌘]) | previous / next session |
| ⌘1–9 | select session |
| ⌃⌘J | next session needing attention |
| ⌘K | command palette (`>` commands, `@` sessions) |
| ⌘, | settings |
| ⌘C / ⌘V / ⌘A | copy / paste / select all, in the terminal or a text field |
| ⌥⌘K | clear buffer |
| ⌘+ / ⌘− / ⌘0 | terminal text size (this session only) |
| ⌥⌘1/2/3/4 | focus / grid / strip / canvas |
| ⇧⌘1 / ⇧⌘2 | canvas: zoom to fit all / to the selected window |
| ⌃⌘S | show/hide sidebar |
| ⇧⌘F | search the sidebar: open windows and past sessions |
| ⌥⌘R | show folder in Finder |

**Canvas.** Drag a title bar to move a window, and an edge or corner to resize it. Pinch or ⌘-scroll to zoom; scroll or drag the background to pan. Double-click a title bar to zoom to that window, or the background to fit everything. Click or drag the minimap to move around.

**Sidebar.** Open windows are grouped into Needs you, Agents and Windows, followed by your recent past sessions. Type in its search field to filter windows and search past sessions; Return opens the result. Right-click a row or a terminal for more: copy the resume command, reveal the transcript, new terminal here.

## CLI

```sh
cmd ls                               # terminals and agents as a tree
cmd new -- htop                      # open a terminal running a command
cmd spawn claude "fix the tests"     # start an agent; inside an agent it becomes a child
cmd send <agent> "also update docs"
cmd read <agent> --lines 40
cmd wait <agent…> --any --timeout 50
cmd kill <agent> --tree
cmd notify "deploy finished"         # a notification; inside cmd it marks this terminal
cmd events                           # NDJSON event stream
cmd settings                         # list; `set KEY VALUE`, `reset KEY`, `path`
cmd hooks claude                     # print the hook config for ~/.claude/settings.json
```

The CLI is not bundled with the app yet. Run it from a checkout (see [DEVELOPMENT.md](DEVELOPMENT.md)) and link it onto your PATH: `ln -s $PWD/packages/cli/bin/cmd ~/bin/cmd`.

## Configuration

Settings live in `~/.config/cmd/settings.json` (comments allowed). Change them in the Settings window (⌘,), with `cmd settings set`, or in the file; changes apply immediately. The few that only affect new terminals (`shell.program`, `shell.login`, `shell.integration`) are marked as such.

Notifications (which sources show a system notification, sound, Dock bounce) are under `notifications.*`; right-click a terminal to mute it.

## How it works

cmd is an Electron app in front of a separate core process that owns the terminals, the agent tree, settings and the transcript index. The app, the `cmd` CLI and agent hooks all talk to the core over a Unix socket. Design notes are in [`docs/`](docs/00-overview.md); building and contributing are in [DEVELOPMENT.md](DEVELOPMENT.md).
