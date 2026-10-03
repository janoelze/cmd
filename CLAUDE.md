# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`cmd`: a personal macOS terminal + coding-agent workbench (Electron UI, a long-lived TypeScript core process, a CLI). It replaces the `ghostty-agents` fork. Design research and rationale live in `docs/` (start at `docs/00-overview.md`). The README covers user-facing behaviour, the CLI, shortcuts and what is done or next.

## Commands

```sh
pnpm install                 # also runs scripts/postinstall.mjs: builds native procinfo, fixes node-pty, fetches electron
pnpm dev                     # Electron with HMR; starts a core if none is running
pnpm test                    # vitest, all packages
pnpm vitest run packages/core/test/osc.test.ts   # one file
pnpm vitest run -t "name"                        # one test by name
pnpm typecheck               # root tsc (packages/*) + desktop tsc
pnpm e2e                     # build, then Playwright drives the real app; screenshots in .cmd-dev/shots
pnpm core                    # run the core directly
pnpm cmd <args>              # run the CLI from source
```

Use an isolated state dir in dev so you don't touch the real core: `export CMD_HOME=$PWD/.cmd-dev` (socket, SQLite, settings.json, core.log, core.pid go there). In the Agent Safehouse sandbox, Electron needs `CMD_NO_SANDBOX=1`.

There is no build step for core/CLI/protocol: they run as `.ts` directly on Node ≥ 22.18 (type stripping). This means `tsconfig.base.json` enforces `erasableSyntaxOnly` (no enums, namespaces, parameter properties) and `verbatimModuleSyntax` (use `import type`), and relative imports must include the `.ts` extension.

## Architecture

```
apps/desktop (Electron: main / preload / renderer)  ──┐
packages/cli (`cmd`, hook entry point)              ──┼─ newline-delimited JSON-RPC 2.0 over a Unix socket ─→ packages/core
                                                      │   (types in packages/protocol)
```

- **The core owns all state** and is a detached process that outlives the UI. Electron main (`apps/desktop/src/main/index.ts`) connects to an existing core or spawns one (logging to `$CMD_HOME/core.log`). Closing or reloading the app never kills terminals.
- **Stale cores:** because the core outlives the app, after editing core code an old core may still be serving. `core.hello` returns a `build` hash (`sourceBuildId`), and the app prompts to restart a mismatched core. When testing core changes manually, restart the core.
- **`packages/protocol`** is the contract: `rpc.ts` (`Methods` map of every method's params/result, plus `CoreEvent`s), `model.ts` (Pane, Agent, AppWindow…), `settings.ts` (the settings schema, flat dotted keys), `node.ts` (paths, `connect`, env vars like `CMD_HOME`/`CMD_SOCKET`/`CMD_CONFIG_DIR`). Adding an API method means: add it to `Methods`, implement the handler in `packages/core/src/core.ts` (the `Handlers` map is typed against `Methods`, so tsc flags missing ones), then expose it from the CLI and/or call it from the renderer.
- **Renderer ↔ core:** the preload (`apps/desktop/src/preload/index.ts`) opens the socket itself (renderer runs with `sandbox: false`) and reconnects automatically; the renderer uses it as `window.cmd` (`renderer/src/bridge.ts`).
- **Core internals** (`packages/core/src`):
  - `panes.ts`: node-pty PTYs, each mirrored into an `@xterm/headless` terminal. Re-attaching a UI view or `pane.read` uses that real terminal state, not replayed raw output. `osc.ts` parses OSC 0/2/7/9/777/133. Panes get `CMD_PANE_ID`, `CMD_SOCKET`, etc. in their env, plus the zsh integration in `packages/core/shell/zsh/`.
  - `agents/`: detects agents (Claude, Codex) from the pane's foreground process (native helper `native/procinfo.c`, built into `native/build/procinfo` by postinstall; falls back to process names if missing) and from hook status files (`$TMPDIR/ghostty-agents/<pane id>/<Event>.json`, compatible with the fork's hook). `tracker.ts` builds the agent tree (spawn/send/wait/kill, subagents as virtual children).
  - `windows/`: a **window type registry** (`types.ts`). Terminal, browser, files and text windows are `WindowType`s registered in `builtin.ts` through the same API plugins will use. The core stores each window's state as opaque JSON, so adding a type needs no protocol or storage change. `routing.ts` decides which type opens a path/URL (`open` in the shell, file tree, palette; user overrides via the `open.handlers` setting).
  - `search/`: transcript full-text search over `~/.claude` (and archive dirs) in SQLite, indexed in a worker.
  - `store.ts` (SQLite), `settings.ts` (watches `settings.json`, live-applies), `watch.ts` (fs watches per connection, `fs.changed` events), `resources.ts` (process-tree CPU/memory).
- **App commands** (`apps/desktop/src/shared/commands.ts`): one list drives the macOS menu bar (main owns accelerators, so shortcuts beat the terminal), the command palette and context menus. The renderer implements `run`. Users remap via `keybindings.json` keyed by command id. Every shortcut must be a real menu item.
- **Renderer** is React with xterm.js (WebGL) for terminals and CodeMirror 6 for text windows; state in `renderer/src/store.ts`.

## Tests

- Tests live in `packages/*/test` and `apps/*/test`. Core tests construct a `Core` directly with `dbPath: null`/`settingsPath: null` (in-memory) and either `fakeFactory()` from `packages/core/test/fake-pty.ts` or real PTYs for integration tests.
- `e2e/smoke.mjs` launches the built app against a throwaway `CMD_HOME` (`.cmd-dev/e2e`) with fixture transcripts (`CMD_TRANSCRIPTS_HOME`) and drives it through the real menu bar.

## Conventions

- Settings: add new keys to `SETTINGS_SCHEMA` in `packages/protocol/src/settings.ts`. The settings panel generates a control for every key, so nothing else needs wiring.
- Comments at the top of each file explain its role; keep that pattern and the existing terse comment style.
