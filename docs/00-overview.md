# cmd: research overview and recommendation

Date: 2026-10-02. Goal: a personal "swiss army knife" app for macOS, built around a mature terminal core:
- agent-aware sidebar
- routines, monitors and plugins
- transcript search
- session restore
- full UI customization
- room for an **infinite-canvas** layout of terminals

The goal is to replace the `ghostty-agents` fork with something owned outright.

**Status (2026-10-03):** scaffolded per this architecture: Electron + a TypeScript core process + CLI. See the [README](../README.md) for what works.

## Documents
| # | Doc | What's in it |
|---|---|---|
| 01 | [Prior work: ghostty-agents](01-prior-work-ghostty-agents.md) | Inventory of the fork's features and mechanisms, what ports as-is, its limitations |
| 02 | [Terminal foundations](02-terminal-foundations.md) | libghostty-vt, ghostty-web, restty, xterm.js, alacritty, SwiftTerm; PTYs; benchmarks; **canvas rendering** |
| 03 | [App shell options](03-app-shell-options.md) | Electron, Electrobun, Tauri, Wails, native Swift, GPUI, Flutter |
| 04 | [Prior art](04-prior-art.md) | cmux, Superset, Conductor, Wave, Tabby, canvas terminals; plugin patterns |
| 05 | [Agent integration](05-agent-integration.md) | Claude and Codex on-disk formats, ways to detect state, resume commands, search index |
| 06 | [Plugins, routines, system](06-plugins-routines-system.md) | Plugin model, VPN/SSH/secrets, sudo, testing |
| 07 | [UI vision](07-ui-vision.md) | Sidebar, view modes, command palette, "Platinum, but playful" design language |
| 08 | [Host agents and sub-agents](08-host-agents.md) | How cmux does it (and what it lacks), agent-tree data model, host API, UI |
| 12 | [Magic widgets](12-magic-widgets.md) | v1: a request in, a live widget out; research, agent, security |
| 14 | [Magic widgets v2](14-magic-v2.md) | Widgets as typed apps: Deno data.ts, checked views, previews, revisions, health, the edit view; toward a store |
| 15 | [Positioning and voice](15-positioning.md) | The story, the category (a software workbench), pillars, voice, copy bank, naming, visual direction |

## Key findings
1. **Nothing has to be invented for agent awareness.** Every tool in this space combines three things:
   - a **process scan** (foreground PID → argv)
   - **agent hooks** (Claude *and now Codex* both have rich hook systems)
   - **terminal escape sequences**: OSC 9/777/99 notifications, title spinners

   The fork already has the first two and a good SQLite FTS5 index, and its logic ports directly.
   - **New since the fork:** Codex hooks (`~/.codex/hooks.json`) close the "Codex = Running" gap.
   - **New since the fork:** `~/.claude/sessions/<pid>.json` gives busy/idle with no setup at all.
2. **The terminal engine is the real decision, and the infinite canvas sharpens it.**
   - xterm.js is the mature, testable TS option, but it uses one WebGL context per terminal. Browsers allow about 16, and zoomed WebGL terminals blur.
   - The libghostty-vt core (WASM/Node bindings; restty and gespenst wrap it) allows *one shared renderer for every terminal*, which is the right design for a canvas. It is still alpha.
   - **Answer: put the engine behind an interface. Start on xterm.js and move to libghostty-vt plus a shared renderer when the canvas needs it.**
3. **Shells: Electron wins on testability and predictability.**
   - It has Playwright support for Electron and the same Chromium everywhere (WebGL in WKWebView is buggy for xterm.js).
   - It runs node-pty in a utility process, and it is the stack Superset, Wave, Tabby and most canvas terminals use.
   - Electrobun is the lighter TS alternative but young. Tauri needs Rust and has poor end-to-end testing on macOS. Native Swift/libghostty (cmux) gives the best feel but fights "TypeScript, testable, mod it fast".
4. **The pattern the extensible tools share** (cmux, Wave, Kitty): a **core process that owns sessions**, plus a **socket API and CLI**, plus UIs as clients. Restore, testability, plugins and scriptable routines all follow from it.

## Recommended architecture

```
┌──────────────────────────── Electron app ────────────────────────────┐
│ Renderer (React/Solid + TS)                                           │
│  ├─ Sidebar: Agents · Terminals · SSH · Routines   (plugin sections)  │
│  ├─ Layouts: tabs/splits  ⇄  infinite canvas (pan/zoom, LOD, minimap) │
│  ├─ TerminalView  (xterm.js WebGL pool → later: shared GPU renderer)  │
│  └─ Theme tokens + user CSS + layout config (fully customizable)      │
└──────────────▲───────────────────────────────────────────────────────┘
               │ typed RPC (MessagePort / Unix socket), backpressure
┌──────────────┴──────────── core (Node utilityProcess / daemon) ──────┐
│ SessionManager: node-pty, headless VT state per session, OSC parsing  │
│   (7 cwd · 0/2 title · 9/777/99 notify · 133 prompt marks)            │
│ AgentTracker: process scan + hook socket + ~/.claude/sessions + OSC   │
│ Indexer: FSEvents tail → SQLite FTS5 (+ trigram) over transcripts     │
│ Plugin host: manifest plugins (routines, monitors, sections, adapters)│
│ Store: SQLite (layout, sessions, seen-state, plugin KV), Keychain     │
└──────────────▲───────────────────────────────────────────────────────┘
               │ same API
          `cmd` CLI  (cmd hook <event>, cmd run vpn.up, cmd open, cmd notify)
```

### Design rules
- **The core owns all state.** The UI can reload or crash and terminals keep running. This matters because the UI will be hot-reloaded constantly.
  - "Restore on relaunch" here means relaunching the *app*. Shell processes still die when the app quits unless the core keeps running as a daemon (LaunchAgent).
  - Recommendation: a daemon that survives UI restarts, plus **resume via `claude --resume` / `codex resume`** for real restarts. Optionally tmux for shells that must survive anything.
- **Hooks report to the core over its socket** (`cmd hook` or Claude's `type:"http"` hooks), not to temp files.
  - The pane id goes in an environment variable (`CMD_PANE_ID`), and safehouse needs `--env-pass=CMD_PANE_ID`.
  - Launch Claude with `--session-id <uuid>` when the app starts it, so the id is known before the first hook fires.
- **Agents are adapters.** Each one provides detection, a state mapping, a parser and resume. Claude and Codex first.
- **Plugins return UI as data**, run outside the renderer and are hot-reloaded per plugin.
- **Customization:**
  - design tokens (CSS variables) and an optional user stylesheet
  - keybindings as config
  - layout and sidebar sections from config
  - plugins for anything deeper
  - config in a TS or TOML file under `~/.config/cmd/`, watched live

### Testing strategy
| Layer | Tool |
|---|---|
| Core logic: state mapping, parsers, index, plugins | Vitest, against recorded fixtures (sample JSONL and hook payloads) |
| Terminal sessions | Fake PTY + `@xterm/headless`. Golden tests on escape-sequence handling (OSC 7/133/9) |
| Core API | Run the core headlessly and drive it over the socket via the CLI |
| UI | Playwright `_electron`, with screenshot tests per theme and visual checks of canvas zoom |

## Suggested roadmap
1. **Core and terminal tabs:** Electron app, `utilityProcess` core with node-pty, xterm.js, a sidebar with terminal tabs, OSC 7/0/2/133, SQLite store, `cmd` CLI and socket.
2. **Agents:** port the fork's process detection and state mapping. Add a hook installer for Claude and Codex, the `~/.claude/sessions` fallback, notifications, Dock badge, ⌃⌘J "next needing attention", and grouping by project and branch.
3. **Search:** port the FTS5 index and ranking. Add the archive folder, Codex `threads`, trigram and facets.
4. **Restore:** persist layout plus `(pane → agent, sessionId, cwd, configDir)` and resume on launch. Run the core as a LaunchAgent so UI restarts don't kill shells.
5. **Plugins:** manifest, worker host, routines and monitors, status bar. First plugins: VPN (WireGuard and Tunnelblick), SSH hosts from `~/.ssh/config`, Keychain secrets.
6. **Canvas:** React Flow or a custom canvas, LOD cards, a WebGL context pool, re-render on zoom settle. Then evaluate restty or gespenst, or write your own shared renderer on libghostty-vt.

## Open decisions for you
- **Electron vs Electrobun.** The recommendation is Electron now and keeping the shell thin. Revisit Electrobun in 2027.
- **Should terminals outlive the app?** Options: a core daemon (LaunchAgent), tmux, or resume-only.
- **UI framework:** React has the biggest canvas ecosystem (React Flow, tldraw). Solid is faster with fewer libraries.
- **Should agents run inside the sandbox wrapper?** Keep the fork's approach of typing commands into the user's shell so `safehouse` keeps applying.
- **Name:** the folder is `cmd`, which collides with the Windows shell name and the macOS ⌘ key. Fine for a personal tool.

## Security note
`~/src/private-vpn/status.sh` contains a hardcoded root password used with `sshpass`. Consider rotating it, and moving it to the Keychain or switching to key-based auth when that routine is migrated.
