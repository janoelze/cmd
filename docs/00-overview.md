# cmd: research overview and recommendation

**Status:** reference: the index of every design doc, and the first stack choice the app was scaffolded on.

Date: 2026-10-02. Goal: a personal "swiss army knife" app for macOS, built around a mature terminal core:
- agent-aware sidebar
- routines, monitors and plugins
- transcript search
- session restore
- full UI customization
- room for an **infinite-canvas** layout of terminals

The goal is to replace the `ghostty-agents` fork with something owned outright.

**2026-10-03:** scaffolded per this architecture: Electron + a TypeScript core process + CLI. See the [README](../README.md) for what works.

## Documents

Every doc says under its title what it is: **research**, a **proposal**, **partly built**, **built**, a living **reference**, or **superseded by** a later one. A new doc takes the next free number (`test/docs.test.ts` checks numbers, status lines and this index).

| # | Doc | Status | What's in it |
|---|---|---|---|
| 01 | [Prior work: ghostty-agents](01-prior-work-ghostty-agents.md) | research | Inventory of the fork's features and mechanisms, what ports as-is, its limitations |
| 02 | [Terminal foundations](02-terminal-foundations.md) | research | libghostty-vt, ghostty-web, restty, xterm.js, alacritty, SwiftTerm; PTYs; benchmarks; **canvas rendering** |
| 03 | [App shell options](03-app-shell-options.md) | research | Electron, Electrobun, Tauri, Wails, native Swift, GPUI, Flutter |
| 04 | [Prior art](04-prior-art.md) | research | Cmux, Superset, Conductor, Wave, Tabby, canvas terminals; plugin patterns |
| 05 | [Agent integration](05-agent-integration.md) | research | Claude and Codex on-disk formats, ways to detect state, resume commands, search index |
| 06 | [Plugins, routines, system](06-plugins-routines-system.md) | proposal | Plugin model, VPN/SSH/secrets, sudo, testing |
| 07 | [UI vision](07-ui-vision.md) | partly built | Sidebar, view modes, command palette, "Platinum, but playful" design language |
| 08 | [Host agents and sub-agents](08-host-agents.md) | built | How cmux does it (and what it lacks), agent-tree data model, host API, UI |
| 09 | [Window types](09-window-types.md) | built | Every window is a type with a core half (state, what it opens) and a UI half (view, title meta, menus); the registry, routing |
| 10 | [Window titles](10-window-titles.md) | built | One information architecture for the title bar, sidebar row, status bar and palette: which field goes where |
| 11 | [Workspaces](11-workspaces.md) | partly built | A workspace per folder: identity, placement, matching, the switcher and pickers, one workspace per app window, `cmd .` |
| 12 | [Magic widgets](12-magic-widgets.md) | superseded by 14 | V1: a request in, a live widget out; research, agent, security |
| 13 | [Remote access](13-remote-access.md) | partly built | Your workspaces from a phone's browser: Noise over WebCrypto, the relay, pairing with approval, devices, the policy table, the web client |
| 14 | [Magic widgets v2](14-magic-v2.md) | built | Widgets as typed apps: Deno data.ts, checked views, previews, revisions, health, the edit view; toward a store |
| 15 | [Positioning and voice](15-positioning.md) | reference | The story, the category (a software workbench), pillars, voice, copy bank, naming, visual direction |
| 16 | [Widgets](16-widgets.md) | built | Widgets apart from windows: the Widget Library, Magic as how you make one, built-in widgets, how they stay windows underneath |
| 17 | [AI providers and onboarding](17-ai.md) | partly built | One AI service for every feature: providers, tiers, models that pick themselves; the first-launch wizard |
| 18 | [Agent activity data](18-agent-activity.md) | superseded by 28 | What agents do, captured reliably: spooled hook events, one vocabulary across agents, state with causes, turns and the files they changed, discovered agent homes, hooks out of the box |
| 19 | [Reviewing real agent activity data](19-agent-activity-review.md) | partly built | Collect a few days of real sessions, export them, check state, interrupts, turns and files against them, turn findings into fixes and fixtures |
| 20 | [Session summaries](20-session-summaries.md) | built | Right-click an agent's title: what the session did, streamed into an editable Markdown file, pruned to fit, shaped to the kind of session |
| 21 | [Sidebars are windows](21-sidebars.md) | partly built | Any window docks left or right per workspace; today's sidebar becomes the Navigator widget; a top bar with the workspace switcher; window hosts so nothing remounts |
| 22 | [Drag and drop](22-drag-and-drop.md) | built | Files and links between Finder, terminals, file browsers and windows: native file drags out, one drop router in, window drop targets, `fs.transfer` |
| 23 | [The journal](23-journal.md) | built | What happened, as a work log: events kept 180 days (agents, commands, git, pages), threads by identity and links, days written by a model; `cmd journal`, the Journal widget |
| 24 | [Journal versions](24-journal-versions.md) | built | A version per layer (event schema, sources, threads, writer), stamped on the data; what a bump re-reads, rewrites or keeps; the runbook for a revision |
| 25 | [The data model, challenged](25-data-model-critique.md) | research | Four event logs and no event model: what cmd stores, where the same facts live several times, how derivation and retention differ per feature, what the next features would cost; the questions the requirements must answer |
| 26 | [Data requirements](26-data-requirements.md) | reference | What the data layer must do for the next year, against the vision (primitives below, intelligence above): twelve scenarios, requirements for facts, views, query, intelligence, operations and developer experience; non-requirements; what the plan decides |
| 27 | [Data models elsewhere](27-data-research.md) | research | What comparable systems do, from primary sources: event sourcing on SQLite (LiveStore, Linear), activity trackers (ActivityWatch, Atuin, Screenpipe), agent observability (OTel GenAI, Langfuse, LangSmith), the agents' own transcripts, memory layers (Graphiti, Letta), FTS5/JSONB/subscriptions, privacy; recurring patterns and anti-patterns with evidence |
| 28 | [The data layer: design and plan](28-data-plan.md) | built | One event log with one envelope, blobs, entities and links; views as versioned materialisations rebuilt by replay; one query shape with subscriptions and policy; a context builder; retention as a table; two files; seven phases from a spike to memory |
| 29 | [Memory and recall](29-memory.md) | proposal | Facts that expire instead of being deleted, with sources; editable blocks per project; `cmd recall`, an MCP tool and the briefing line; evals before shipping |
| 30 | [What the data model makes possible](30-data-capabilities.md) | reference | What cmd knows now (one log of agents, transcripts, commands with output, git, pages, your focus, model calls), what that won over the four old logs, features it makes possible from "a screen away" to memory, and examples to run today |
| 31 | [Context-aware notifications](31-context-notifications.md) | proposal | What cmd notifies about today, principles, 20 new notifications as rules over the event log (a failing command passes now, an agent changed a file you have open, two agents on one file, a stopped agent can go on, …), a rule engine in the core, a dry run over real history before anything ships |
| 32 | [Session names](32-session-names.md) | built | Names of 1–3 nouns in the person's words that tell agents apart in notifications ("Tours · done", not "cmd · done"); what a good name is, real sessions renamed by hand, renaming from the title bar, the worktree rule, a model for the rest with change-of-task detection and hysteresis, `session.name` events, a replay eval |
| 33 | [Search](33-search.md) | partly built | What find (⌘F) and session search (⇧⌘F) do today, one find bar for every window, ⇧⌘F over everything cmd remembers (sessions, commands and output, pages, files, notes) and over project files with ripgrep, a trigram index later as an accelerator that is never the source of truth |
| 34 | [Startup phases and the work scheduler](34-startup-scheduler.md) | built | The core answers before it rebuilds anything; startup jobs (indexes, imports, view rebuilds, the transcript reader, homes, journal, retention) run behind the socket in order and show in the footer ("Indexing sessions…"); long jobs yield on a budget (12 ms slices, 30% of wall time); a watchdog logs every block of the thread over 100 ms with what ran, kept in `core.info.stalls`; why (a 172 s "Connecting to core…" on a first launch), the frame-budget pattern from games and React, VS Code's phases, rules for new code, what's left (a worker for one-statement work, an e2e check) |
| 35 | [Repositories, worktrees and branches](35-checkouts.md) | built | What cmd knows about repositories, worktrees and branches and where it shows them (one reader, four shapes, four meanings of "project"); the rule: show where something is only where it differs from the workspace; checkouts on panes, agents and workspaces, chips by difference, worktrees grouped in the picker, removed folders, the CLI; managing worktrees stays out |
| 36 | [SQLite viewer](36-sqlite-viewer.md) | built | A window for `.sqlite` and `.db` files: tables and views, rows and structure, a read-only query |
| 37 | [Motion and visual stability](37-motion.md) | reference | How windows, sidebars and workspaces move: TileMotion, presence, FLIP, one curve; the per-frame harness that scores jumps and snaps |
| 38 | [Direct remote access](38-direct-remote-access.md) | built | Remote access without the hosted relay: Tailscale and your own URL as access modes, the relay one of them, a setup checklist |
| 39 | [Workspace Actions](39-workspace-actions.md) | built | A widget that finds how to run the project in its workspace (package.json, Make, just, Task, mise, Compose, scripts/ and more, parsed, never run), keeps it current as files change, describes actions with the fast tier, ranks them by the commands you ran, and runs them in the right place: own terminals for dev servers, a browser for their URL, confirmation for deploys |
| 40 | [Window design](40-window-design.md) | built | One layout language for every window: DTCG tokens, the kit's window pieces, rules for insets, bars, tables, charts and lists |
| 41 | [Testing](41-testing.md) | partly built | Why the e2e flaked in the first week and the plan: scenarios, shards, no fixed waits, where a behaviour's test belongs |
| 42 | [Windows](42-windows.md) | partly built | Running cmd on Windows: what's done, the phases left, the CI job as the scoreboard |
| 43 | [Performance and resource usage](43-performance.md) | partly built | An audit of idle, per-terminal and scrolling cost, the rule (looks the same, costs less) and a log of wins with numbers |
| 44 | [JSON viewer](44-json-viewer.md) | built | A window for `.json` and JSON Lines: a collapsible live tree, ⌘E to the text editor and back |
| 45 | [Image viewer](45-image-viewer.md) | built | A window for images: fit or zoomed, the folder's other images a key away, live reload |
| 46 | [Spacing system](46-spacing.md) | built | One 4px unit, a numeric scale, roles (inset, bar and page insets, row padding and gaps) that components read, size classes; the migration |
| 47 | [Motion feel](47-motion-feel.md) | proposal | Snappy and smooth on top of docs/37: speed across hand-offs, things from their cause, distance-aware springs, lists that move as one |
| 48 | [UI Workbench](48-workbench.md) | built | One place to see and work on every component: the UI Workbench replaces the `@cmd/ui` gallery, and its sidebar, variant matrices, playground, props tables, notes and tests are derived from the component sources and story files |
| 49 | [Stats](49-stats.md) | partly built | Usage numbers from the event log: a stats registry in the core (hour buckets in views.sqlite, kept current from dirty marks, rebuilt by version, one query and `cmd stats`), what cmd can show (agent time, waiting on you, failures, focus, tokens), a chart kit with Apple's discipline and a terminal's density (a mark grammar, scrubbing cursor, presets), the Stats widget, phases |
| 50 | [Boot work people can see](50-boot-work.md) | built | What the core does before it answers after an update (migrating, compacting): a boot report beside `core.pid` that the app and the CLI read, a sheet when it lasts, no fixed timeout while it moves, progress counts on startup jobs, a free-space check; no step registry or ledger, by decision |
| 51 | [Operator](51-operator.md) | partly built | An agent in a widget that runs the workspace through cmd's own methods while you watch: the operator task (tests, agents, waiting) end to end first, a dozen hand-written tools over an access table that is `never` by default, named actions before typed text, no file edits (agents do that), the loop in the core with structured history and a latency target, marks on the window acted on, Stop and Undo Turn, v1 guardrails (typed text always asks), chat pieces for the kit, phases; revised after a review |
| 53 | [Live Diff across worktrees](53-livediff-worktrees.md) | built | Live Diff for several agents in worktrees at once: clashes first (same lines of the base), a row per agent, files newest first, Areas; a file whole in a pane under the list (`FileDiff`, @codemirror/merge); `git.worktrees` against each branch's merge base, `git.fileVersions` |
| 54 | [Agent integration](54-agent-integration.md) | partly built | One switch so agents in cmd know they run in cmd: a SessionStart briefing through the hooks cmd already installs, and the Operator's tools as a `cmd mcp` stdio server registered in each agent home; replaces `agents.peers`; research on how hosts hand agents MCP and context, and the recipe that came out of it |
| 55 | [Approvals](55-approvals.md) | partly built | One sheet for every approval, opening at once with Allow on Return; what asks decided per category (open websites, type into terminals, act on pages…) as Ask / Allow / Never in Settings → Agents → Permissions; once / this session / always in this workspace; risky actions and the deny-list never auto-approved; research on how Claude Code, Codex, Gemini, Copilot, Cline, Warp, Zed, browsers and Android ask and remember |
| 56 | [Phone development](56-phone-development.md) | built | One fixed HTTPS origin for a real phone (`pnpm phone:serve`: Vite with hot reload behind Tailscale Serve on :5443) that reaches the installed app's core and a switchable dev core through `/c/release` and `/c/dev`; the phone's dev core in one fixed state dir, run from any worktree's code (`phone:core`), so you pair once; `phone:use`, `phone:pair`; what the release core needs (its direct listener runs only in a direct access mode), the limits of pairing it from dev code, and how the proxy keeps Origin, X-Forwarded-For and Tailscale-User-Login right |
| 58 | [Quick Commands](58-quick-commands.md) | partly built | Commands, prompts and links you save once and run from the palette, a menu, a hotkey or the CLI: in a new or the selected terminal, to an agent, or opened in a window; `{{variables}}` from what you're looking at (folder, file, selection, branch) and asked for when run, shell-quoted; kept in `~/.config/cmd/quick-commands.json`, project ones later as a Workspace Actions source; research on Raycast, Warp, Zed, VS Code and terminals |
| 59 | [Browser inspector](59-browser-inspector.md) | built | DevTools for browser windows as their own window beside the page, or inside the page's window: the DevTools front end inside Electron in a webview, talking CDP through a loopback bridge in main to the page's debugger; following the page when its webview is re-attached; Show Inspector (⌥⌘I), Open Inspector ▸ In New Window / In This Window, right-click › Inspect Element; the routes tried in a spike (Electron's detached DevTools, a native view, a webview host) and why they lost |

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
