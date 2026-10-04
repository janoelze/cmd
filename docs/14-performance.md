# Performance and resource usage

> Status (2026-10-04): audit done; first round of fixes on the `perf` branch (see Wins). The rule: the UI looks and behaves the same; it only costs less. Wins are logged at the bottom with before/after numbers.

The aim is a workbench that costs close to nothing while idle, stays cheap per open terminal and agent, and never stutters while scrolling, typing or streaming output.

## How it is measured

**Headless bench**, `scripts/perf/bench.ts`. It runs a real core and PTY host in a throwaway `CMD_HOME` and drives them over the socket the way one app window does. It measures the core and the host from outside with the procinfo helper, because `ps` isn't available in the sandbox. Results go to `.cmd-dev/perf/results.jsonl`, tagged with the commit and `--label`.

```sh
node --no-warnings scripts/perf/bench.ts idle   --panes 10 --seconds 15 --label before
node --no-warnings scripts/perf/bench.ts flood                          # 29 MB of coloured text through `cat`
node --no-warnings scripts/perf/bench.ts memory --panes 6               # full scrollback per terminal
node --no-warnings scripts/perf/bench.ts search                         # transcript index: cold, then warm
```

The scenarios:

| Scenario | What it does | What it reports |
|---|---|---|
| `idle` | N shells at their prompt, with search off | CPU % and memory of the core and host, events per second |
| `flood` | `cat` of a 29 MB file in one pane | MB/s end to end, and CPU seconds per MB for the core and host |
| `memory` | N panes printing 12,000 lines each (past the 10,000-line scrollback) | host memory per terminal |
| `search` | a first index of the real transcripts, then a start with the index built | time, CPU and peak memory |

**Still to add.** The bench doesn't cover these yet:
- **Renderer frame timing.** A Playwright run of the built app that floods a pane, scrolls the scrollback and pans the canvas, recording `long-animation-frame` entries and frame times. It also records `app.getAppMetrics()` at idle with N terminals.
- **Dev-only render counters.** Store events per type per second, and React `<Profiler>` commits per second for `App`, `Sidebar` and `WindowsView`, exposed as `window.__cmdPerf`.
- **Core counters in `core.info`.** Broadcasts and bytes per event type, SQLite writes per method, process spawns per binary, and screen saves (saved or skipped, ms, bytes).
- **Startup marks on one clock.** `boot:*` marks turned into absolute times so main and renderer can be compared, plus the first paint of the selected terminal.

## Baseline (2026-10-04, master 590ae6d, M-series Mac)

| Measure | Value |
|---|---|
| Idle, 10 shells, search off | core 0.5 % CPU / 55 MB; host 0.5 % / 62 MB |
| Flood | 54 MB/s; the host is CPU-bound (0.020 s/MB); the core uses 0.011 s/MB |
| Memory per full terminal | about 26 MB in the PTY host, and the renderer holds a second copy per window |
| Search, cold index | 13.6 s, 12.4 CPU s, **1.59 GB peak core memory, 481 MB kept afterwards** |
| Search, warm start | 0.5 s, 75 MB |

The headless idle number leaves out agents, Magic windows and file windows, which is where most idle cost comes from (see below).

## Findings

Ordered by expected win. Risk means the risk of a visible change in behaviour. ✅ means done (see the log).

### Core and PTY host

1. ✅ **Agents were rewritten to SQLite and broadcast every 2 s.** The status backstop re-applied every agent's status, and `#update` counted any passed field as a change. Each idle agent meant one WAL commit plus one `agent.updated` to every UI (which re-renders the whole window, see renderer 1) every 2 s.
2. ✅ (while no UI is connected) **Magic data windows run their command forever,** whether or not any window shows them. A 2 s source is about 1,800 sandboxed process spawns an hour. Fix: tick only while a connection follows the window, and refresh at once when it shows again if the data is stale.
3. ✅ (memory) **Transcript indexing re-reads whole files.** A live 5–8 MB transcript is fully re-parsed and its FTS rows re-inserted up to every 30 s, by every instance. Fix: index appended bytes only, keeping a full re-parse for files that shrank. A cold index peaks at 1.6 GB and keeps 481 MB.
4. ✅ **Screens are serialized and stored every 10 s per busy terminal.** An agent's spinner keeps a pane dirty. Fix: skip identical screens, write them in one transaction, and use `synchronous=NORMAL` (safe with WAL).
5. ✅ (while no UI is connected) **Resource sampling scans the whole process table every 2 s**, also with no UI connected, and broadcasts a full `Pane` for small changes. Fix: sample only while a UI is subscribed, and build the ppid index once per scan in `procinfo.c`.
6. ✅ (quiet terminals: 5 s) **Foreground polling runs every 500 ms per terminal**, one helper round trip each. Fix: batch all panes into one request, and poll a pane fast only after output.
7. ✅ (background) **Git status costs two process spawns every 5 s per Files window.** Fix: cache `rev-parse` per root and coalesce concurrent calls.
8. **The PTY host is the throughput bottleneck.** Every chunk is parsed by the headless xterm, then JSON-encoded, then parsed and re-encoded by the core. To be profiled.
9. **Smaller items.** `pane.read` converts the whole buffer for 50 lines. SQLite statements are re-prepared on every call. `logRemote` prunes on every insert. `lineSplitter` rescans the whole buffer per chunk, which hurts multi-MB snapshots.

### Renderer

1. ✅ (invisible updates) **One store event re-renders the whole window.** `App` subscribes to everything. `inSpace` builds three new Maps per change, and `buildRows` builds new rows, so the Sidebar, every tile, `TileTitle` and `Slot` re-render. Triggers include every OSC title change (agent spinners), every 2 s usage sample per busy pane and every hook event. Fix: memoised `inSpace` and rows, `memo` on the heavy components, and notifications coalesced per frame.
2. ✅ **IPC on every store change.** `closeNotification` runs on every update, and `setMenuState` on every agent event. Fix: narrower effect dependencies.
3. **Canvas pan and drag re-render every title on every frame**, and `TerminalView`'s `memo` never holds because `onMenu` is a new closure each render.
4. **Layout thrash.** `StripScrollbar` reads layout after every commit. `Slot` interleaves reads and writes. The tooltip runs a rAF loop with `getBoundingClientRect`.
5. **Hidden work.** Focus mode hides tiles with `visibility:hidden`, so their terminals likely keep rendering. `DotMatrix` runs a 30 fps rAF loop off screen. The Files git poll runs while the app is in the background.
6. **Every window mirrors every pane of every Space.** Each holds an xterm (about 12 B per cell) and snapshots every pane at startup. *Needs a decision: switching to a Space would then wait for a snapshot.*
7. **Settings changes re-apply everything**: they refit every terminal and restyle `:root` on any key.

### Electron main and startup

1. ✅ **SF Symbols render with `spawnSync` on the main thread**: about 480 ms cold, 30–40 ms per batch warm, before first paint. Fix: async, cached on disk per macOS version.
2. **No V8 code cache for the renderer**, because it loads over `file://` (813 KB of JS compiled per window). Fix: a privileged `app://` scheme. *Needs care: `localStorage` moves with the origin.*
3. **The runtime copy after an update blocks main** for 250–500 ms. Fix: async copy.
4. **`events.subscribe` with `types` still returns the whole snapshot**, to four long-lived main-process connections and the Settings window.
5. **Smaller items.** The updater bundle (570 KB) loads at ready, 30 s before it's needed. Editors are preloaded in every window. The preload calls `sendSync` for the socket path. Spellcheck is on. Off-screen browser windows run unthrottled.

### Open questions

- **The terminal renderer defaults to DOM.** WebGL is much cheaper when scrolling and streaming, but glyphs rasterize slightly differently, so switching the default is a visible change. Measure it first.
- **No flow control between the PTY and xterm.** `docs/02` calls for it. A `cat` of a huge file floods the renderer's write buffer.

## Wins

Measured with the bench and `e2e/perf.mjs` on the same machine. "UI" rows are the app window with 4 terminals.

| # | Change | Before | After |
|---|---|---|---|
| 1 | Agents: save and broadcast only real changes | each agent: 1 SQLite write + 1 broadcast + a full re-render every 2 s while idle | only when its status changes |
| 2 | Store: cached prepared statements, `synchronous=NORMAL`; screens: skip identical ones, one transaction per save | a statement compiled per write, an fsync per commit, one commit per screen | compiled once, one commit per save round |
| 3 | Magic refreshes and resource sampling wait while no UI is connected | a 2 s Magic source: ~1,800 sandboxed spawns an hour with the app closed; a process-table scan every 2 s | none until a UI connects (then Magic refreshes at once) |
| 4 | Foreground lookup of quiet terminals every 5 s instead of 500 ms | idle core, 10 shells: 0.47 % CPU | 0.37 % |
| 5 | SF Symbols render asynchronously, shared in-flight runs, cached on disk | `spawnSync` on the main thread, ~0.5 s cold, 30–40 ms per batch, before first paint | off the main thread; later launches read the cache |
| 6 | Renderer: no re-render for changes nothing shows (spinner glyphs in titles, usage of unselected panes); `TerminalView` memo holds; effects send IPC only on real changes | UI, 4 spinning terminals: 686 renders/s, main thread 91 ms/s, script 29 ms/s | 18 renders/s, 50 ms/s, 6 ms/s |
| 7 | Search reads transcripts in 1 MB chunks instead of whole | cold index peak 1,623 MB, 484 MB kept by the core afterwards | peak 229 MB, 110 MB afterwards (same speed, identical documents) |
| 8 | Magic's dot matrix animates only on screen; StripScrollbar and the sidebar's hover order no longer run DOM work after every render | a 30 fps canvas loop in off-screen tiles; a forced layout per render | none off screen |
| 9 | Files windows poll git only while cmd is in front | two git processes every 5 s per Files window, also in the background | none in the background; one refresh on focus |
| 10 | The updater bundle loads 5 s after launch | 570 KB parsed on the main thread during the first window's load | after it |

Already fine: no frame over 33 ms while flooding (25 MB through `cat`) or scrolling 10,000 lines of scrollback (p95 frame 9 ms at 120 Hz); the core serializes each broadcast once for all connections.
