# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`cmd`: a macOS app for running terminals and coding agents side by side, with web and file browsers, an editor and Magic widgets (Electron UI, a long-lived TypeScript core process, a CLI). Positioning and voice for user-facing copy: `docs/15-positioning.md`. Design research and rationale live in `docs/` (start at `docs/00-overview.md`). The README is user-facing (features, install, shortcuts, CLI); DEVELOPMENT.md covers building, packaging, internals and what is done or next.

## Commands

```sh
pnpm install                 # also runs scripts/postinstall.mjs: builds native procinfo, fixes node-pty, fetches electron
pnpm dev                     # Electron with HMR; starts a core if none is running
pnpm test                    # vitest, all packages
pnpm vitest run packages/core/test/osc.test.ts   # one file
pnpm vitest run -t "name"                        # one test by name
pnpm typecheck               # root tsc (packages/*) + desktop tsc
pnpm e2e                     # build, then Playwright drives the real app; screenshots in .cmd-dev/shots
pnpm tour <file.tour.ts>     # record a scripted demo video with real input (tours skill; needs the built app and screen access)
pnpm core                    # run the core directly
pnpm core:stop               # stop the core of $CMD_HOME, else the dev one; core:stop-all stops every non-release core
pnpm cmd <args>              # run the CLI from source
pnpm tokens                  # build packages/ui/tokens/*.tokens.json (DTCG) into tokens.css and tokens.gen.ts; --check fails when stale
pnpm design-debt             # lower apps/desktop/test/design-debt.json after removing literal colours/sizes from a stylesheet
pnpm ui                      # the @cmd/ui gallery in a browser (every component, every theme); `pnpm --filter @cmd/ui shots` screenshots it
pnpm workbench <story>       # one component from a *.story.tsx in the real app, to iterate on with the user (prototype skill)
pnpm release <ver|patch|minor>  # needs the version's CHANGELOG.md section (changelog skill); bump, tag v<ver>, push; CI publishes the GitHub release
```

`pnpm dev` and `pnpm dist` builds are "cmd dev" (red icon) with their own core and state, separate from the installed app, even when started from its terminals (instances: `packages/protocol/src/instance.ts`). From the main checkout that is `~/Library/Application Support/cmd-dev` (the user's dev instance); from a linked worktree it is `<worktree>/.cmd-dev` (see "Work style"). `CMD_HOME` overrides either (socket, SQLite, settings.json, core.pid and `logs/` go there). In the Agent Safehouse sandbox, Electron needs `CMD_NO_SANDBOX=1`.

There is no build step for core/CLI/protocol: they run as `.ts` directly on Node ≥ 22.18 (type stripping). This means `tsconfig.base.json` enforces `erasableSyntaxOnly` (no enums, namespaces, parameter properties) and `verbatimModuleSyntax` (use `import type`), and relative imports must include the `.ts` extension.

## Work style: one git worktree per task

Several agents build cmd at once. Nobody edits the main checkout (`~/src/cmd`): it stays on a clean `master` and is only where branches are merged and releases cut. Each task gets its own branch in a sibling worktree:

```sh
git -C ~/src/cmd worktree add ~/src/cmd-<topic> -b <topic> master
cd ~/src/cmd-<topic> && pnpm install   # node_modules and native helpers are per checkout; the pnpm store makes it quick
export CMD_HOME=$PWD/.cmd-dev           # the worktree's own instance (pnpm dev/core/core:stop default to it; pnpm cmd needs the export)
git worktree list                       # what is in flight
```

- Started in the main checkout with a code change to make? Create a worktree and work there (absolute paths), unless the user says otherwise.
- **A worktree is its own instance.** `pnpm dev`, `pnpm core` and `pnpm core:stop` run from a linked worktree default `CMD_HOME` to `<worktree>/.cmd-dev` (`worktreeHome()` in `instance.ts`), so each worktree has its own core, PTY host, state, logs and settings (settings start at defaults, since `configDir()` follows `CMD_HOME`), and never touches the main checkout's dev instance. Keep exporting `CMD_HOME` as above anyway: `pnpm cmd` doesn't default to it (without it the CLI talks to the core of the pane it runs in, usually the installed app's), and scripts you start inherit it. Never run `pnpm core:stop-all`: it stops every agent's cores, nor `pnpm dev` in the main checkout without the user asking: that is the user's own dev instance.
- Commit on your branch as you go. Before handing back: `git rebase master` (worktrees share refs, no fetch needed), then `pnpm typecheck && pnpm test`.
- Append-only registries conflict most: `Methods` in `rpc.ts`, `Handlers` in `core.ts`, `SETTINGS_SCHEMA`, `settings/layout.ts`, `shared/commands.ts`. On rebase keep both sides' entries.
- Merging, pushing and releasing happen only when the user asks, from the main checkout: `git merge --ff-only <topic>`, `pnpm release` there on `master`.
- A merge isn't done until its worktree is gone. Right after merging, in the main checkout:
  ```sh
  CMD_HOME=~/src/cmd-<topic>/.cmd-dev pnpm core:stop --terminals   # its core and PTY host
  git worktree remove ~/src/cmd-<topic>                            # deletes the dir, node_modules and .cmd-dev too
  git branch -d <topic>
  ```
  `git worktree remove` refuses if the worktree has uncommitted or untracked changes: that's work the merge didn't include, so look before reaching for `--force`. `git worktree prune` clears entries whose dir was deleted by hand.

## Architecture

```
apps/desktop (Electron: main / preload / renderer)  ──┐
packages/cli (`cmd`, hook entry point)              ──┼─ newline-delimited JSON-RPC 2.0 over a Unix socket ─→ packages/core
                                                      │   (types in packages/protocol)
```

- **The core owns all state** and is a detached process that outlives the UI. Electron main (`apps/desktop/src/main/index.ts`) connects to an existing core or spawns one. Logs: `~/Library/Logs/cmd` (release) or `~/Library/Logs/cmd-dev` (dev), else `$CMD_HOME/logs`; use `logger("scope")` from `@cmd/protocol/node`, not `console`. Crash reports: DEVELOPMENT.md, "Logs and crash reports". Closing or reloading the app never kills terminals.
- **Stale cores:** because the core outlives the app, after editing core code an old core may still be serving. `core.hello` returns a `build` hash (`sourceBuildId`) and the folder the core runs from (`root`), and the app restarts its core on launch when either isn't its own. Restarting a core is cheap: terminals keep running in the PTY host (below). When testing core changes manually, restart the core (`pnpm core:stop`).
- **PTY host and restore:** terminals (PTY + headless xterm) live in a separate, deliberately small process, `packages/core/src/terminals/host.ts` (entry `host-main.ts`, client `remote.ts`), that outlives the core; a core that starts takes over its terminals. Changing the host's messages means bumping `HOST_PROTOCOL` (a core replaces a host of another version, or one whose code folder is gone, e.g. a removed worktree: it can't start shells). Editing host code doesn't reach a running host: `pnpm core:stop --terminals`. New terminals failing with `posix_spawn failed: No such file or directory` in `ptyhost.log`: compare `<state dir>/ptyhost.root` with the checkout. Every pane is recorded in SQLite with its last screen; `restore.ts` reattaches running terminals at startup and resurrects lost ones (host died, reboot) under the same pane id, resuming agent sessions. Tests use in-process terminals (`LocalBackend`, from a `PtyFactory`).
- **`packages/protocol`** is the contract: `rpc.ts` (`Methods` map of every method's params/result, plus `CoreEvent`s), `model.ts` (Pane, Agent, AppWindow…), `settings.ts` (the settings schema, flat dotted keys), `node.ts` (`connect`, build ids), `instance.ts` (paths and env vars: `CMD_INSTANCE`/`CMD_HOME` pick the instance a process is, `CMD_SOCKET` only the core a client talks to). Adding an API method means: add it to `Methods`, implement the handler in `packages/core/src/core.ts` (the `Handlers` map is typed against `Methods`, so tsc flags missing ones), then expose it from the CLI and/or call it from the renderer.
- **Renderer ↔ core:** the preload (`apps/desktop/src/preload/index.ts`) opens the socket itself (renderer runs with `sandbox: false`) and reconnects automatically; the renderer uses it as `window.cmd` (`renderer/src/bridge.ts`).
- **Core internals** (`packages/core/src`):
  - `panes.ts`: panes over a `TermBackend` (`terminals/`: node-pty PTYs, each mirrored into an `@xterm/headless` terminal). Re-attaching a UI view or `pane.read` uses that real terminal state, not replayed raw output. `osc.ts` parses OSC 0/2/7/9/777/133. Panes get `CMD_PANE_ID`, `CMD_SOCKET`, etc. in their env, plus the shell integration in `packages/core/shell/` (zsh, bash, fish; `shells.ts` says how each is started).
  - `agents/`: detects agents (Claude, Codex) from the pane's foreground process (native helper `native/procinfo.c`, built into `native/build/procinfo` by postinstall; falls back to process names if missing) and from cmd's hook (`agents/hooks.ts`), which writes `$TMPDIR/cmd-agents/<pane id>/<Event>.json`. `tracker.ts` builds the agent tree (spawn/send/wait/kill, subagents as virtual children).
  - `windows/`: a **window type registry** (`types.ts`). Terminal, browser, files and text windows are `WindowType`s registered in `builtin.ts` through the same API plugins will use. The core stores each window's state as opaque JSON, so adding a type needs no protocol or storage change. `routing.ts` decides which type opens a path/URL (`open` in the shell, file tree, palette; user overrides via the `open.handlers` setting).
  - `search/`: transcript full-text search in SQLite, indexed in a worker. Agents are `TranscriptSource`s registered in `builtin.ts` (`sources.ts` is the registry). Each source knows where its transcripts live (`locate`), how to find a folder from a path that hooks report (`rootFor`), how to recognise and parse its files, and how to resume a session. A root's `env` (e.g. `CLAUDE_CONFIG_DIR`) is stored with every session and prepended to the resume command. Folders learned from live agents are kept in the index.
  - `store.ts` (SQLite), `settings.ts` (watches `settings.json`, live-applies), `watch.ts` (fs watches per connection, `fs.changed` events), `resources.ts` (process-tree CPU/memory).
  - `scheduler.ts` (docs/34): the core answers first; everything that reads the whole log, scans folders or runs git is a startup job (`Core.start()`, after `listen()`) or yields through `scheduler.yield()` every few hundred rows. A watchdog logs every block of the thread over 100 ms as `[lag] <ms> ms in <activity>` (also `core.info.stalls`, and the footer's core details): check it after changing the core, and run `scripts/perf/stress-core.mjs` (its header says how) after changing how the core reads or writes the log. Tests that construct a `Core` without `listen()` call `core.start()` and `await core.scheduler.idle()`.
- **App commands** (`apps/desktop/src/shared/commands.ts`): one list drives the macOS menu bar (main owns accelerators, so shortcuts beat the terminal), the command palette and context menus. The renderer implements `run`. Users remap via `keybindings.json` keyed by command id. Every shortcut must be a real menu item.
- **UI kit** (`packages/ui`, `@cmd/ui`): the design tokens (`tokens.css`), the themes (`themes/`, applied with `applyTheme`; the desktop picks one from settings in `renderer/src/theme.ts`), tooltips, scrollbars and every control: Button/IconButton/ButtonGroup, Switch/Checkbox/RadioGroup/Segmented/Tabs/Select, TextField/SearchField/TextArea/NumberField/SecretField, FormSection/FormRow, Callout/EmptyState/CodeBlock/KeyValue, Badge/StatusDot/Kbd/Progress/Spinner, Menu/Popover/Dialog/toast, and the window shell (Window/WindowBody/WindowFrame/WindowBar, which the app's tiles, sidebars and window sheets are drawn with). Variants are data attributes (`data-variant`, `data-size`, `data-tone`). Icons are SF Symbol names drawn through `<UIProvider icon={Symbol}>` (Lucide in the gallery).
- **Renderer** is React with xterm.js (WebGL) for terminals and CodeMirror 6 for text windows; state in `renderer/src/store.ts`.

## Tests

- Tests live in `packages/*/test` and `apps/*/test`. Core tests construct a `Core` directly with `dbPath: null`/`settingsPath: null` (in-memory) and either `fakeFactory()` from `packages/core/test/fake-pty.ts` or real PTYs for integration tests.
- `e2e/smoke.mjs` launches the built app against a throwaway `CMD_HOME` (`.cmd-dev/e2e`) with fixture transcripts (`CMD_TRANSCRIPTS_HOME`) and drives it through the real menu bar.

## Conventions

- Settings: add new keys to `SETTINGS_SCHEMA` in `packages/protocol/src/settings.ts` and place it in a page and section of the Settings window in `renderer/src/settings/layout.ts` (a test checks every key is placed once). The window (`renderer/src/settings/`, its own page `settings.html`) generates each row from the schema; `title`, `unit`, `placeholder`, `labels`, `code` and `control` are display hints. Settings must apply live: read them when acting, or, if a core consumer caches something derived from them, subscribe with `SettingsService.bind(keys, fn)`; the renderer gets `settings.updated`. Only when a change can't reach what is already running, set `applies` (`newTerminals`, `firstLaunch`) so the UI and CLI say so.
- Design tokens live in `packages/ui/tokens/*.tokens.json` (DTCG 2025.10, tied together by `cmd.resolver.json`); `tokens.css` and `tokens.gen.ts` are generated from them (`pnpm tokens`; a test fails when they are stale or when kit CSS reads a variable that is no token). Add or change a token there, with a `$description` that says when to use it.
- Stylesheets take colours, font sizes, radii and spacing from the tokens. `design-css.test.ts` counts the literals still left per file against `design-debt.json`: a new one fails (use or add a token), and one removed fails until `pnpm design-debt` locks in the lower count.
- UI: build views from `@cmd/ui` components and tokens, not new controls or literal colours/sizes. A control the kit lacks goes into the kit (with a gallery specimen in `packages/ui/gallery/Gallery.tsx`), not into a view's CSS.
- Motion: windows move through `TileMotion` (`renderer/src/motion.ts`), overlays leave with `usePresence` and list rows move with `useFlip` (`@cmd/ui`), all on one curve (`--glide`). Never animate a window's geometry from React or with a CSS transition. After changing anything that moves, appears or disappears, run `pnpm e2e:motion` (the `motion` skill; docs/37-motion.md).
- User-facing text (notifications, toasts, tooltips, menus, settings, errors, CLI messages): follow the `copywriting` skill (`.claude/skills/copywriting/SKILL.md`): friendly and compact.
- Comments at the top of each file explain its role; keep that pattern and the existing terse comment style.
