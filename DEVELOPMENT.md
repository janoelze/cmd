# Developing cmd

Research and design notes live in [`docs/`](docs/00-overview.md), starting with the overview.

## Layout

```
packages/protocol   shared types: data model, JSON-RPC API, settings schema, sidebar ordering
packages/core       the core process: PTYs (node-pty), agent tree, hooks, SQLite, settings, Unix socket
packages/cli        `cmd` — the same API from any shell, hook entry point, host-agent commands
apps/desktop        Electron UI (React + xterm.js), a client of the core
e2e/                Playwright smoke test driving the real app
scripts/            postinstall, packaging, releases, icons, README screenshots
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

## README screenshots

`pnpm shots` builds the app and renders `docs/screenshots/<scene>-<light|dark>.png` (hero, canvas, search) against a throwaway core, with fake agents and a fake htop so the shots are repeatable and private. `node scripts/readme-shots/screenshots.mjs hero` re-shoots one scene without building.

## Packaging and releases

`pnpm dist` builds `apps/desktop/dist/cmd-<version>-arm64.{dmg,zip}`. The app ships the core's TypeScript source in `Contents/Resources/runtime` (staged by `scripts/stage-runtime.mjs`) and runs it with Electron's own Node, so no system `node` is needed.

CI (`.github/workflows/build.yml`) typechecks, tests and packages every push. `pnpm release 0.2.0` (or `patch`/`minor`/`major`) bumps the version, tags `v0.2.0` and pushes; CI builds the tag and publishes a GitHub release with the .dmg and .zip (a version with a `-`, like `0.2.0-beta.1`, is a prerelease). Signing and notarization run when the `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` secrets exist; without them the app is ad-hoc signed, and you open it the first time with right-click → Open.

## Agent detection and hooks

The core detects agents in two ways, both ported from the ghostty-agents fork.

- **Foreground process.** A small native helper (`packages/core/native/procinfo.c`, built by `pnpm install`) reads each terminal's foreground process with its full argv. Agents are found even behind wrappers such as `bash …/safehouse … claude`, `sandbox-exec … claude` and `node …/codex`. The process start time is used to ignore stale hook status.
- **Hook status files.** Every pane is started with `GHOSTTY_AGENTS_SURFACE_ID=<pane id>`, so the hook already installed by the fork (`~/.claude/hooks/ghostty-agents-status.sh`) works unchanged. It writes `$TMPDIR/ghostty-agents/<pane id>/<Event>.json`, and the core watches that directory. The fork's `.zshrc` patch already passes the variable through safehouse.
  - State comes from the newest session only, and files older than the agent process are ignored.
  - The last prompt becomes the title fallback.
  - The current tool is shown only if its call came after the last prompt.

`cmd hook <kind>` (talks to the socket; `cmd hooks claude` prints its config) remains an alternative for agents without the shell hook.

## Notifications

One path for every source (`packages/core/src/notifications.ts`): agents needing input or finishing a turn, terminal bells (`\a`), notifications programs ask for with escape codes (OSC 9, OSC 777, kitty's OSC 99), commands that ran longer than `notifications.longCommand` seconds (from the shell integration's OSC 133 marks), and `cmd notify`. A terminal that wants you gets an attention marker in its title bar and sidebar row, and counts toward the Dock badge, until you look at it.

## Settings

The schema is `packages/protocol/src/settings.ts`, with flat dotted keys. User values go in `~/.config/cmd/settings.json`, or in `$CMD_HOME` in dev. The core watches the file, so edits apply live, including to running shells (`open` rules) and search (the indexer restarts). The exceptions are tagged in the UI and CLI: `shell.program`, `shell.login` and `shell.integration` affect new terminals only, and `ui.defaultView` only the first launch.

## Status

**Done**
- Core: PTYs mirrored into headless terminals, OSC 0/2/7/9/777/133 parsing, launch commands typed once the shell is ready
- Agents: detected from the foreground process's full argv (through wrappers), state from Claude/Codex hooks, Claude subagents as virtual children
- Host API: spawn, send, read, wait, kill (`--tree`)
- Transcript search (SQLite, indexed in a worker), resume from the palette and sidebar
- Settings and SQLite persistence
- UI: sidebar grouped by attention with search and recent sessions, focus, grid, strip and canvas views, browser, file, text and Markdown windows, palette, settings window, themes, notifications, Dock badge
- Packaging, CI and GitHub releases

**Next**
- Restore agents on relaunch
- Plugin host (routines and monitors in the core)
- Codex hook install
- Bundle the CLI with the app
