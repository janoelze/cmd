# cmd

A personal terminal + coding-agent workbench for macOS. Research and design live in [`docs/`](docs/00-overview.md).

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
```

Inside the Agent Safehouse sandbox, Electron needs `CMD_NO_SANDBOX=1`.

## CLI

```sh
cmd ls                               # panes and agents as a tree
cmd new -- htop                      # open a pane running a command
cmd spawn claude "fix the tests"     # start an agent; inside an agent it becomes a child
cmd send <agent> "also update docs"
cmd read <agent> --lines 40
cmd wait <agent…> --any --timeout 50
cmd kill <agent> --tree
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

## Settings

The schema is `packages/protocol/src/settings.ts`, with flat dotted keys. User values go in `~/.config/cmd/settings.json` (comments allowed), or in `$CMD_HOME` in dev. The core watches the file, so edits apply live. Three ways to change a setting: ⌘, in the app, `cmd settings set`, or editing the file.

## Shortcuts

Every shortcut is a real menu-bar item. Remap any of them in `~/.config/cmd/keybindings.json` (map a command id to a shortcut, a list, or `null`). The file is watched, and the full list with ids is under Settings → Keyboard Shortcuts.

| | |
|---|---|
| ⌘N (⌘T) | new terminal (in the current folder) |
| ⌥⌘N | new Claude session |
| ⌘W | close the frontmost thing: palette/settings, then the terminal (asks if something is running), then the window |
| ⇧⌘W | close window (terminals keep running in the core) |
| ⌥⌘← / ⌥⌘→ (⇧⌘[ / ⇧⌘]) | previous / next session |
| ⌘1–9 | select session |
| ⌃⌘J | next session needing attention |
| ⌘K | command palette (`>` commands, `@` sessions, `#` tools) |
| ⌘, | settings |
| ⌘C / ⌘V / ⌘A | copy / paste / select all, in the terminal or a text field |
| ⌥⌘K | clear buffer |
| ⌘+ / ⌘− / ⌘0 | terminal text size (this session only) |
| ⌥⌘1/2/3 | focus / grid / canvas |
| ⌃⌘S | show/hide sidebar · ⌃⌘1 / ⌃⌘2 sessions / tools |
| ⌥⌘R | show folder in Finder |

Right-click a sidebar row or a terminal for context menus: copy resume command / session id, reveal transcript, new terminal here, and so on. The window remembers its size and position, and the Dock menu has New Terminal / New Claude Session.

## Status

**Done**
- Core: PTYs, OSC 0/2/7/9/777/133 parsing, launch commands typed once the shell is ready
- Agents: detected from the foreground process, state from Claude/Codex hooks, Claude subagents as virtual children
- Host API: spawn, send, read, wait, kill (`--tree`)
- Settings and SQLite persistence
- UI: Sessions/Tools sidebar sorted by attention, focus and grid views, palette, settings panel, notifications, Dock badge

**Next**
- Transcript search (port the fork's FTS5 index)
- Restore agents on relaunch
- Plugin host (routines and monitors in the core)
- Port the fork's argv inspection, to see through wrappers
- A headless VT for `pane.read` (instead of stripping ANSI)
- Codex hook install
- Canvas view
- Packaging
