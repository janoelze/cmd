# 01 Process model and lifecycle

**Score: 7/10** · reviewed 2026-10-10 against commit ddb7832 · scope: how Electron main, the core and the PTY host start, find each other, outlive each other and get replaced (lock, pid files, build/root/stateDir checks, HOST_PROTOCOL, runtime copies, coreHealth, stop-core).

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 5/10 | The supervisor logic is 314 lines of module-level state inside a 1,046-line `main/index.ts` that also does IPC, SF Symbols and notifications; four main-process modules each own a core connection and a reconnect loop. |
| Correctness & robustness | 7/10 | Lock, pid, build, root, stateDir and HOST_PROTOCOL rules hold up against every skew scenario asked about; the gaps are pid-file trust where `ps` is unavailable, orphaned hosts after a state dir is removed, and two unguarded `JSON.parse` calls on the host link. |
| Performance | 7/10 | Core spawned before `app.whenReady`, window loads in parallel, warm connect in ~25 ms; but the first launch after an update copies 3,063 files synchronously on the main thread before ready (643 ms measured) and a build-mismatch restart serialises stop → spawn (109–1,003 ms in the user's log). |
| Security | n/a | Sockets are 0600 and the host accepts any same-user connection as the new owner; the detached core needs the `runAsNode` fuse on (see the security doc). |
| Testability & tests | 6/10 | 16 tests cover the lock (incl. SIGKILL), instances and host takeover/replacement; nothing in `main/index.ts` is testable because it runs at import time and reaches for Electron. |
| Extensibility | 7/10 | Adding a process (a plugin host) means copying the host's pattern by hand: no shared "child that outlives us" helper, no registry of what runs. |
| Code health | 7/10 | Files carry clear top comments and the invariants are written down; `HOST_PROTOCOL` equality and `VERSION = "0.0.1"` are the stale corners. |

## What this system is

cmd runs as three processes that deliberately outlive each other in reverse order of how often they change. **Electron main** (`apps/desktop/src/main/index.ts`, 1,046 lines; the lifecycle part is lines 138–451) decides which instance it is (`enterInstance`, `packages/protocol/src/instance.ts`, 135 lines), spawns the **core** as a detached child of Electron-as-Node (`spawnCore`, line 317: `detached: true`, `ELECTRON_RUN_AS_NODE=1`, stdio to `core.out.log`) and makes sure the one answering on the socket is its own and runs its code (`ensureCore` → `checkCoreBuild`: `core.hello` returns `build`, `root`, `stateDir`, `pid`). The core (`packages/core/src/main.ts`, 123 lines) takes an exclusive SQLite lock on `$CMD_HOME/core.lock` (`lock.ts`, 25 lines: `PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE`, released by the kernel on any exit), writes `core.pid`, then connects to or starts the **PTY host** (`terminals/remote.ts` 352 lines, `host.ts` 222, `host-main.ts` 53): a small detached process that owns the PTYs and headless xterms and serves them over `ptyhost.sock`, handing itself to whichever core says `hello` last (`host.ts:116-135`), exiting 10 s after it has neither a core nor a terminal. The core rejects a host of another `HOST_PROTOCOL` or whose code folder is gone and replaces it (`remote.ts:290-313`); `restore.ts` (184 lines) then reattaches the host's terminals and resurrects the rest under the same pane ids (the screen and agent semantics are doc 04's).

Packaged apps run the core not from the bundle but from `$CMD_HOME/runtime/<build>` (`coreRoot`, `index.ts:190-214`), a copy of `Contents/Resources/runtime` staged by `scripts/stage-runtime.mjs` and booted once in CI by `scripts/check-runtime.mjs`, so an auto-update (`updater.ts`, 190 lines; electron-updater, install on quit) can replace the bundle under a running core and host without either loading mixed files. `crash.ts` (318 lines) reports what any of the three processes recorded through `protocol/src/log.ts` (279 lines: per-process log files, crash JSON, machine id). `scripts/stop-core.mjs` (100 lines) is the only tool that finds and stops cores and hosts, by pid file or by `ps` command line. The renderer learns the core's state from the preload's connect loop (`core-checked` gate, then 20 ms → 500 ms backoff) and from `coreHealth.ts` (123 lines), which polls `core.info` and `core.processes` every 5 s per visible window. Design docs followed: docs/14 (startup numbers), docs/34 (answer first, startup jobs; its "Not built" §2 names the app's wait as unfinished), docs/35 (worktrees as instances); DEVELOPMENT.md "Develop", "Updates", "Logs and crash reports".

The questions asked of this review, answered briefly: the three-process split is the right shape and it works in production (the user's release PTY host pid 55006 ran 4.4 days across 18 core restarts, `core.log` 2026-10-04 → 10-09; VS Code's pty host and Zed's RFC go the same way, 00-research §6; Electron's `UtilityProcess` cannot be used because it dies with the app). The takeover rules are sound against the four skew cases: an auto-update (build hash differs → restart, symmetric so downgrade is covered too), a removed worktree (`root` and `hostCodeGone`, commit e6112c3), release + dev on one Mac (separate `$TMPDIR/cmd{,-dev}` sockets, state dirs, `stateDir` in hello, `PANE_ENV` dropped), and a crashed core (lock freed by the kernel, host keeps terminals, `restore` reattaches). Nothing in the lifecycle depends on the app's name or location except `app.getName() === "cmd dev"` (`index.ts:51`, from Info.plist, not the file name) and `stop-core.mjs`'s `ps` regexes; the runtime copy lives under `$CMD_HOME`, so moving the bundle is harmless. What remains is below.

## What is good

- **The right invariant in the right place.** `lock.ts` decides "is a core running" (the kernel frees it on SIGKILL; `lock.test.ts` proves it with a child process), the socket decides "can I talk to one", `core.hello` decides "is it mine and current". Three questions, three mechanisms, each with a one-paragraph top comment saying why. Other systems should copy this: the socket is not the truth.
- **Self-identification over discovery.** `core.hello` reports `build`, `root`, `stateDir`; the host's hello reports `protocol`, `root`, `instance`, `terms`. The app and core never guess from `ps`; `enterInstance` drops inherited pane context so a dev build started inside the installed app's terminal cannot adopt its core (`instance.test.ts`, 6 tests).
- **Atomic socket binding** (`core.ts:1206-1221`): bind under a temp name, `chmod 0600`, `rename` into place, remember the inode, and `#checkSocket` puts it back if a temp-dir cleaner removes it. The `verbatimSymlinks` temp-dir-then-rename pattern is reused for the runtime copy.
- **Takeover is explicit on both sides.** The host tells the previous core `{ev:"replaced"}` so it steps aside instead of fighting back (`host.ts:117-122`, `main.ts:85`); `ptyhost.test.ts` covers hand-over, "won't take it back", protocol mismatch and code-gone (8 tests, all passing in 0.76 s with the other two files).
- **Startup overlaps the right things.** The core is spawned at import time when no pid is alive (`index.ts:381`), the window loads while `ensureCore` runs, and the preload waits only for `core-checked` so no page call ever lands on a core about to be restarted (e840ac5). Warm start reaches "connected" at ~545 ms (docs/14).
- **Failure has an exit.** `coreFailed` offers Try Again / Check for Updates / Show Log, and knows a downloaded update may fix it; a core that exits is reported with the tail of both its logs; "already running" is recognised from its output.

## Issues

### AR1-01-01 · Let the successor core wait on the lock instead of the app re-spawning every 10 s

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/lock.ts:16`, `packages/core/src/main.ts:48-53`, `apps/desktop/src/main/index.ts:164-181`, `apps/desktop/src/main/index.ts:390-421`

**Problem.** A core that finds the lock taken exits at once ("already running"), so the app has to serialise a restart: SIGTERM the old core, poll its pid every 50 ms for up to 10 s, SIGKILL, poll 2 s more, then spawn (`stopCore`, `index.ts:257-280`). When two launches race, or a core is still shutting down, the app's loop re-spawns a core every 10 s while `lastSpawn.state === "locked"` (`waitForCore`, line 417), each of which exits again. docs/34 "Not built" §2 already says these spawns "can go". The user sees the window on "Connecting to core…" for the whole stop-then-start gap after every update.

**Evidence.** `acquireLock` opens with `{ timeout: 0 }` and returns null immediately. In the user's release `main.log`, eight build-mismatch restarts on 2026-10-09 show gaps between "restarting it" and "started a core" of 377, 600, 812, 775, 809, 713, 1,003 and 109 ms, before the new core's own ~200–365 ms boot. Three "already running" exits are in the release log, and the 2026-10-04 cascade in `ptyhost.log` (11 "a new core took over" lines in 24 ms, each SIGTERMing its predecessor) is what the lock was added to stop the day after (9ced48a, 68d973c). Three pieces of state track one fact: `coreSpawned`, `lastSpawn.state`, `coreProcessAlive()`.

**Proposal.** Make the lock a queue, not a gate. `acquireLock(file, { waitMs })` retries the `BEGIN EXCLUSIVE` every 50 ms up to `waitMs` (SQLite's own `timeout` option does the same with a busy handler); `main.ts` passes 15 s when started with `--succeed` (or always: a core that is really stuck is the app's SIGKILL case anyway). The app then does a restart in one step: `SIGTERM old; spawnCore()`, and the successor starts the instant the lock is freed. Delete the `locked` state, the 10 s re-spawn and the "already running" output sniffing (`index.ts:351-353`). Give the core's `shutdown()` a deadline (5 s, then log and `process.exit(0)`), so a handoff is bounded even when `#ingest.close()` or `#searchSwap` hangs. VS Code's server does the equivalent: a new server takes the port once the old one releases it, the client never arbitrates (00-research §1).

**Success criteria.**
- [ ] `lock.test.ts` has a test where a second `acquireLock(file, { waitMs: 2000 })` resolves within 100 ms of the holder exiting.
- [ ] `grep -n "locked" apps/desktop/src/main/*.ts` returns nothing; `SpawnState` has no `locked` member.
- [ ] A build-mismatch restart (old core answering, new app) reaches `boot:core-reachable` within 600 ms of `boot:app-ready` on `e2e/startup.mjs`'s warm scenario (today: stop gap + boot).
- [ ] `main.ts` shutdown exits within 5 s whatever `core.close()` awaits (a test with a stubbed never-resolving closer).

### AR1-01-02 · Take the runtime copy and old-copy deletion off the main thread and out of the pre-ready path

- **Status:** open
- **Severity:** medium
- **Effort:** S
- **Where:** `apps/desktop/src/main/index.ts:190-214`, `apps/desktop/src/main/index.ts:336`, `apps/desktop/src/main/index.ts:381`

**Problem.** `coreRoot()` runs inside `spawnCore()`, which runs at module load (line 381) before `app.whenReady`. On the first launch after an update it copies the whole runtime synchronously (`fs.cpSync`) and then synchronously deletes copies older than the newest three; every launch also does a `readdirSync`/`statSync` sweep and hashes 175 source files. All of it blocks the main thread before the first window can be created.

**Evidence.** `/Applications/cmd.app/Contents/Resources/runtime` is 41 MB in 3,063 files; measured on the user's Mac (same APFS volume as the state dir): `cpSync` 643 ms, `rmSync` of one old copy 161 ms; cloning (`COPYFILE_FICLONE_FORCE`) still takes 406 ms, so the cost is per-file syscalls, not bytes. docs/14 "Electron main" §3 already lists this at 250–500 ms. `$HOME/Library/Application Support/cmd/runtime` holds two 40 MB copies today. `sourceBuildId(repoRoot)` is called from four places (`index.ts:113,169,193,723`), 4.3 ms each in source; cheap, but the hash of a packaged runtime never changes and could be a file.

**Proposal.** Keep the copy (it is the right answer to "an update replaces the bundle under the host": the host reads `spawn-helper`, the shell integration and the CLI per shell, so a single-file bundle would not remove the need), but do it right: `stage-runtime.mjs` writes `.runtime/build-id` and `coreRoot` reads it instead of hashing; the copy becomes `await fs.promises.cp(...)` (or a `cp -cR` child) inside `ensureCore`, which is already async and already runs while the window loads; deletions of old copies and the `utimes` touch move to a `setTimeout(..., 10_000)` after `boot:ready-to-show`. Only the lookup of an existing `runtime/<build>` stays synchronous for the pre-ready spawn.

**Success criteria.**
- [ ] No synchronous `fs.cpSync`/`fs.rmSync` of a directory in `apps/desktop/src/main/index.ts` (grep returns nothing).
- [ ] `e2e/startup.mjs` with an empty `$CMD_HOME/runtime` shows `boot:app-ready` within 50 ms of a run with the copy present.
- [ ] `sourceBuildId(` appears once in `main/index.ts`, and packaged builds read `build-id` (a test for `stage-runtime.mjs` output exists).
- [ ] `scripts/check-runtime.mjs` still passes.

### AR1-01-03 · Extract a testable core supervisor from `main/index.ts`

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `apps/desktop/src/main/index.ts:138-451`, `apps/desktop/src/main/index.ts:381-388`, `apps/desktop/src/main/index.ts:1015-1018`

**Problem.** The lifecycle (canConnect, ownCore, checkCoreBuild, coreRoot, ptyHostRoot, stopCore, restartCore, spawnCore, ensureCore, waitForCore, coreFailed) is 314 lines of free functions over module-level mutable state (`coreSpawned`, `lastSpawn`, `coreChecked`, `updaterStarted`) in a file that also holds IPC handlers, the SF Symbols cache, notifications and webview policy. It has no tests and cannot get any: importing the module spawns a core (line 381) and touches `app`. Every lifecycle fix of the last week (59140b0, 68d973c, a5e2551, e840ac5, e6112c3) was verified by hand.

**Evidence.** `index.ts` is 1,046 lines with 87 commits in 90 days, the hottest file in scope by a factor of 3.6 over `main.ts` (24). `ls apps/desktop/test` lists 36 test files and none exercises the lifecycle. Three liveness predicates coexist (`canConnect`, `coreProcessAlive`, `lastSpawn?.state`), and `ensureCore` calls `checkCoreBuild` twice in different states (lines 391 and 396).

**Proposal.** `apps/desktop/src/main/core-supervisor.ts`: a class with injected `spawn`, `connect`, `now` and `fs`, states `absent → starting → checking → up | restarting | failed`, a `status` event the preload gets instead of the `core-checked` promise, and the one core link of AR1-01-06. `index.ts` keeps `new CoreSupervisor({ socketPath, coreRoot, devBuild }).start()` and the dialog in `coreFailed`. Unit tests drive it with a fake core that answers `core.hello` with chosen `build`/`root`/`stateDir`. This is VS Code's lifecycle-service shape that docs/34 already borrowed for the core (phases with explicit transitions).

**Success criteria.**
- [ ] `apps/desktop/src/main/index.ts` under 750 lines; no `spawn(` call outside `core-supervisor.ts`.
- [ ] `apps/desktop/test/core-supervisor.test.ts` with at least six cases: own and current core (no restart), build mismatch, root mismatch, foreign `stateDir` (left alone), busy-starting core, spawn failure → `failed`.
- [ ] Importing `core-supervisor.ts` has no side effects (a test imports it with no Electron mock).
- [ ] One place in the renderer/preload learns core status (`core-status` event), `ipcMain.handle("core-checked")` is gone.

### AR1-01-04 · A host whose state dir or socket disappears becomes an unreachable orphan

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/terminals/host.ts:192-196`, `packages/core/src/terminals/host-main.ts:40-43`, `packages/core/src/terminals/remote.ts:257-259`, `scripts/stop-core.mjs:44-83`

**Problem.** The host exits only when it has no core and no terminals for 10 s. Its socket, pid file and `ptyhost.root` live in the state dir; in a linked worktree that is `<worktree>/.cmd-dev`, which `git worktree remove` deletes. A host with shells sitting at a prompt then runs indefinitely with no socket to reach it: no core can adopt its terminals, the Task Manager cannot see it, and only a `ps` scan finds it. `hostCodeGone` covers the *code* folder (the host cannot spawn), not the *state* folder (nobody can find the host). CLAUDE.md asks people to remember `core:stop --terminals` before removing a worktree, and DEVELOPMENT.md documents hosts "piling up" against the 511-PTY limit.

**Evidence.** `host.ts` has no equivalent of the core's `#checkSocket` (`core.ts:1251-1265`): a removed `ptyhost.sock` is never re-bound. `stop-core.mjs --all` is the only reaper and depends on `ps -axo command` matching `/packages\/core\/src\/(main|terminals\/host-main)\.ts/` (line 44); in the user's own sandbox `ps` is refused ("operation not permitted", observed during this review), so the reaper cannot run where the user develops. Each orphaned host holds its shells' PTYs and 15 MB per full terminal (docs/14 win 11).

**Proposal.** Two small things in the host, one registry. (1) The host stats its socket path and its state dir every 5 s: socket gone → re-bind (copy of the core's temp-name-and-rename bind); state dir gone → log, SIGHUP its shells, exit after a 30 s grace. (2) Every host and core writes `$TMPDIR/cmd-processes/<pid>.json` `{ role, instance, home, socket, root, startedAt }` on start and removes it on clean exit; `stop-core.mjs`, `core.processes` and the Task Manager read that folder and verify each entry by connecting (hello) rather than by `ps`. Stale entries (pid dead) are pruned by whoever reads. This replaces path-shape regexes with a registry that survives app renames and bundled runtimes.

**Success criteria.**
- [ ] `ptyhost.test.ts`: a host whose socket file is unlinked answers again within 10 s; a host whose state dir is removed exits within 60 s and its shells are gone.
- [ ] `node scripts/stop-core.mjs --all` works with `ps` unavailable (test stubs `execFileSync` to throw) and finds a running test host through the registry.
- [ ] The Task Manager lists every host of the user, with its state dir and terminal count.
- [ ] CLAUDE.md's "stop the host before `git worktree remove`" step is deleted because it is no longer needed.

### AR1-01-05 · Pid files are trusted where the lock is the truth, and `stop-core` can kill a reused pid

- **Status:** open
- **Severity:** medium
- **Effort:** S
- **Where:** `scripts/stop-core.mjs:56-63`, `apps/desktop/src/main/index.ts:369-376`, `apps/desktop/src/main/index.ts:414`, `apps/desktop/src/main/index.ts:217-224`, `packages/core/src/terminals/host-main.ts:19-25`

**Problem.** `core.pid` and `ptyhost.pid` survive SIGKILL and reboots (removed only in the clean shutdown paths), and after a reboot low pids are reused. `looksLikeCore(pid)` checks the command line with `ps` and, when `ps` fails, falls back to "the pid is alive": in the sandbox where `ps` is denied, `pnpm core:stop` sends SIGTERM (then SIGKILL after 3 s) to whatever process now holds that pid. In the app, `coreProcessAlive()` with a reused pid skips the early spawn, and `waitForCore` treats "alive" as "busy starting" for up to 10 minutes (`CORE_BUSY_MS`) if the spawned core then fails, instead of showing `coreFailed`. `ptyHostRoot()` keeps a 40 MB runtime copy alive for a pid that is not a host.

**Evidence.** `lock.ts:1-6` states the rule: "this, not the socket, decides"; yet `index.ts` never consults the lock. `alive()` in `stop-core.mjs:16-23` returns true on `EPERM`, i.e. for any process the user cannot signal. The `ps` failure path was exercised during this review (`ps` refused in Agent Safehouse, the user's default environment). `instance.ts:123-130` (`isOwnCore`) also falls back to the pid file for pre-`stateDir` cores.

**Proposal.** Use the lock as the liveness oracle everywhere: `lock.ts` gains `isLocked(file): boolean` (try `BEGIN EXCLUSIVE` on a throwaway handle, roll back) and `index.ts` replaces `coreProcessAlive()` with it; a pid file is then only a hint for *which* pid to signal. `stop-core.mjs` verifies before signalling: connect to the socket and compare `core.hello.pid` (hosts: the hello too), else if `ps` is missing refuse with a message instead of guessing; both pid files gain a start time (`{ pid, startedAt }`) so a procinfo-backed check can compare where available. `waitForCore`'s "busy" branch requires `isLocked()`, not a live pid.

**Success criteria.**
- [ ] `lock.test.ts`: `isLocked` is true while a child holds the lock and false after it is killed.
- [ ] `grep -n "coreProcessAlive" apps/desktop/src/main` returns nothing.
- [ ] `stop-core.mjs` has a test: with `ps` throwing and a pid file naming the test's own pid, it signals nothing and prints why.
- [ ] After `kill -9` of a core and a reboot-like pid file (pid of a live unrelated process), the app shows `coreFailed` within `CORE_START_MS` + 5 s when the new core fails, not after 10 minutes.

### AR1-01-06 · One core link in main instead of four reconnect loops

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `apps/desktop/src/main/crash.ts:124-146`, `apps/desktop/src/main/updater.ts:120-135`, `apps/desktop/src/main/workspaces.ts:267-289`, `apps/desktop/src/main/preview.ts:64-88`

**Problem.** Four modules each open their own socket to the core, subscribe to events, read settings and reconnect on close with their own interval (250, 500, 1,000, 1,000 ms). Each receives the full `events.subscribe` snapshot on every (re)connect, and each restart of the core produces four reconnect storms. Any future main-process consumer (a plugin host, the supervisor's own health) copies the pattern a fifth time.

**Evidence.** `grep -n "await connect(socketPath" apps/desktop/src/main/*.ts` lists 7 sites: 4 long-lived loops plus `checkCoreBuild`, `countLaunch`, `restartCore`. docs/14 "Electron main" §4 names the four long-lived connections and the whole snapshot they get. The four loops are textually near-identical (try connect → onEvent → subscribe → settings.get → closed.then(retry)).

**Proposal.** `apps/desktop/src/main/core-link.ts`: one connection owned by the supervisor (AR1-01-03), `link.on(type, fn)` multiplexing one `events.subscribe` with the union of types, `link.settings()` cached from `settings.updated`, `link.call()` that waits for the next connection, and a single backoff. `crash.ts`, `updater.ts`, `workspaces.ts`, `preview.ts` import it; `countLaunch` and `checkCoreBuild` use it too.

**Success criteria.**
- [ ] `grep -c "connect(socketPath" apps/desktop/src/main/*.ts` totals 1.
- [ ] One `events.subscribe` per app process after startup (`core.info.connections` from main equals 1 with no windows open).
- [ ] `core-link.test.ts` covers reconnect after close and a call made while disconnected.

### AR1-01-07 · Give both handshakes a protocol version and a compatibility rule

- **Status:** open
- **Severity:** low
- **Effort:** M
- **Where:** `packages/core/src/terminals/host.ts:28`, `packages/core/src/terminals/remote.ts:109`, `packages/protocol/src/rpc.ts:79`, `packages/core/src/core.ts:71`

**Problem.** The host link uses equality (`msg.r.protocol !== HOST_PROTOCOL` → replace the host, killing every terminal and resurrecting it), so any wire change, even an additive one, is a terminal-killing release; the top comment already works around this ("`replaced` needed no bump"). The core's RPC has no protocol version at all: `core.hello` returns `VERSION = "0.0.1"`, unchanged since e462797, and the only skew defence is the app's build-hash equality. That covers app ↔ core, but a `cmd` CLI from another install, an old hook script, or the remote web client gets `unknown method` errors instead of a defined refuse/upgrade (00-research §1 asks exactly for this, citing Tailscale's version-mismatch path).

**Evidence.** `HOST_PROTOCOL` went 1 → 2 in 4009616 (2026-10-09); the user's `core.log` at 10:11:48 shows "speaks protocol 1, this core 2: replacing it" and a new host with 0 terminals, after a host that had 16. `grep -rn "PROTOCOL_VERSION\|protocolVersion" packages apps` returns nothing. VS Code's pty host revives rather than migrates processes too (00-research §6), so equality is parity, not a defect; a compatibility window is the improvement.

**Proposal.** Host: hello carries `{ protocol, minCore }`; the core accepts `protocol >= MIN_HOST && minCore <= HOST_PROTOCOL`, treats `unknown method` as "feature absent", and bumps `MIN_HOST` only for breaking changes (node-pty swaps). Core RPC: add `protocol: number` to `core.hello` and a `CORE_PROTOCOL` constant next to `Methods`, bumped by the rule "a removed or changed method or event bumps it"; `connect()` in `protocol/node.ts` exposes `hello` so the CLI prints "this cmd is older/newer than its core; restart the core from the app" instead of a method error; the app keeps hash equality for its own core.

**Success criteria.**
- [ ] `ptyhost.test.ts`: a host at protocol N serves a core requiring N−1 features without being replaced; a host below `MIN_HOST` is replaced.
- [ ] `core.hello` result has `protocol`; a CLI test calling a core that reports a lower protocol gets the version message.
- [ ] A changelog/skill note says when to bump `MIN_HOST` vs `HOST_PROTOCOL` vs `CORE_PROTOCOL`.

### AR1-01-08 · Harden the core's side of the host link

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `packages/core/src/terminals/remote.ts:106`, `packages/core/src/terminals/remote.ts:181-196`, `packages/core/src/terminals/remote.ts:334-344`

**Problem.** Two `JSON.parse` calls run inside socket `data` handlers without `try/catch` (the pre-hello line at 106 and `#receive` at 196). The core installs `installCrashHandlers("core", { exitOnException: true })`, so one malformed line from a host (a future host version, a corrupted write) exits the core with code 70 and a crash report, and the app then restarts it. `request()` has no timeout: a host blocked in a huge `snapshot` leaves `pane.read`, `cmd read` and the UI's snapshot requests pending forever, and `#backendLost` never fires because the socket is still open. The host's stdout file `ptyhost.out.log` is appended forever (the core's `core.out.log` at least restarts at 5 MB, `index.ts:320-324`).

**Evidence.** `host.ts:88-93` wraps its parse in `try/catch`; `remote.ts` does not. `grep -n "setTimeout\|timeout" packages/core/src/terminals/remote.ts` shows timers only in `connectHost`'s start loop, none per request. `remote.ts:340` writes to `outputFile` opened with `"a"` and no size check.

**Proposal.** Parse defensively (log and drop the line); give `request()` a 10 s deadline and count consecutive timeouts, declaring the host lost after three (the existing `#closed()` path then resurrects); rotate `ptyhost.out.log` like `core.out.log` in `startHost`.

**Success criteria.**
- [ ] `ptyhost.test.ts`: a fake host writing `not json\n` does not throw out of the data handler; the core logs a warning.
- [ ] A test where the host never answers `snapshot` sees the request reject within 11 s and the backend reported lost after three.
- [ ] `ptyhost.out.log` is truncated when over 5 MB at host start.

### AR1-01-09 · The footer's "outdated" disagrees with main's restart rule, and health is polled per window

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `apps/desktop/src/renderer/src/coreHealth.ts:21-23`, `apps/desktop/src/renderer/src/coreHealth.ts:51-63`, `apps/desktop/src/main/index.ts:171`

**Problem.** `checkCoreBuild` restarts a core when `build` *or* `root` differ; `coreHealth` reports `outdated` only on `build`. A same-build core run from another checkout (the case e6112c3 added) shows a green "Core" in every window and is then silently restarted at the next launch. Each visible window polls `core.info` and `core.processes` every 5 s (1.5 s with the details open), so N windows cost N round trips and, because `core.processes` reports CPU "since anyone last asked" (the comment at line 53 admits it), two windows corrupt each other's CPU%.

**Evidence.** `outdated: !!info && !!build && info.build !== build` (line 63) ignores `info.root`; `CoreInfo.root` exists for this (`rpc.ts:18-19`). `POLL_MS = 5000` per `useCoreHealth` instance, one per window footer.

**Proposal.** The core already pushes `core.startup`; add a `core.health` event every 5 s to subscribers that opted in (one computation, `ProcessStat` sampled once), and let the renderer derive `outdated` from `(build, root)` against `appInfo` exactly as main does, sharing the predicate through `@cmd/protocol` (`isCurrentCore(hello, app)`) so the two can never drift. Keep a client-side latency probe (one `core.info` per window is fine), drop the per-window `core.processes`.

**Success criteria.**
- [ ] One function in `packages/protocol` decides "current core", used by `main/index.ts` and `coreHealth.ts` (grep shows both import it).
- [ ] With three windows open, `core.processes` is called at most once per 5 s (count in a core test or via `[lag]`-style counters in `core.info`).
- [ ] A same-build core from another root shows "Core outdated · restart" in the footer.

### AR1-01-10 · Tests and CI never exercise the packaged lifecycle end to end

- **Status:** open
- **Severity:** low
- **Effort:** M
- **Where:** `scripts/check-runtime.mjs`, `e2e/packaged.mjs`, `e2e/smoke.mjs:9-19`

**Problem.** `check-runtime.mjs` boots the staged core once and asks `core.hello`; `e2e/packaged.mjs` launches the packaged app; neither covers the sequences that break in the field: an app of build B meeting a core of build A (restart, terminals survive), a HOST_PROTOCOL bump, a crashed core (SIGKILL) under a live host, a host SIGKILLed under a live core, two app launches at once. All five are covered today only by the user's own logs (32 build restarts, 18 "lost the PTY host" lines, 2 "didn't quit cleanly" in six days of `main.log`).

**Evidence.** `grep -n "restart\|SIGKILL\|protocol" e2e/packaged.mjs scripts/check-runtime.mjs` finds nothing about these; the only lifecycle e2e action is cleanup (`stopCore(home, { terminals: true })`). docs/34 "Not built" §3 asks for a startup e2e check too.

**Proposal.** `e2e/lifecycle.mjs` on the built app with a throwaway `$CMD_HOME`: start, open two terminals with a marker command, then (a) `kill -9` the core and assert both terminals keep their pid and screen after reconnect; (b) `kill -9` the host and assert resurrection under the same pane ids; (c) rewrite `core.pid`/`build` so the next launch sees a mismatch and assert "restarting it" plus surviving terminals; (d) launch two apps within 100 ms and assert one core (lock) and no crash report. Run it in CI next to `check-runtime.mjs`.

**Success criteria.**
- [ ] `e2e/lifecycle.mjs` exists and passes locally and in `.github/workflows/build.yml`.
- [ ] Each of scenarios (a)–(d) asserts terminal pids/pane ids and reads `main.log`/`core.log` for the expected line.
- [ ] No crash report is left in `<logs>/crashes` after the run.

## Course corrections

1. **Make the restart a handoff, not a stop-then-start** (AR1-01-01, with AR1-01-05): the lock becomes the queue and the liveness oracle, the app's `locked`/pid-polling state machine disappears, and every update or dev restart gets faster and simpler at once.
2. **Give main a supervisor and one core link** (AR1-01-03, AR1-01-06): the lifecycle becomes a tested class instead of 314 lines of module state, which is what makes 1 and the e2e in AR1-01-10 safe to do.
3. **Stop hosts from orphaning** (AR1-01-04): watch the socket and state dir, and register processes in `$TMPDIR` so reaping and the Task Manager no longer depend on `ps` and path regexes.
4. **Move the copy off the critical path** (AR1-01-02): the one measurable startup cost left in this scope.
5. **Version the handshakes** (AR1-01-07) before plugins, the web client or a second CLI generation make skew a user-visible problem.

## Quick wins

- AR1-01-02 (async copy, deferred deletion, `build-id` file)
- AR1-01-05 (`isLocked`, `stop-core` refuses to guess)
- AR1-01-06 (one core link)
- AR1-01-08 (parse guards, request timeout, log rotation)
- AR1-01-09 (shared "current core" predicate)
