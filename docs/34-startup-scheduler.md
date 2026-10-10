# Startup phases and the work scheduler

> Status (2026-10-07): **phases, the scheduler and the watchdog built and stress-tested**: the core answers before it rebuilds anything, startup jobs run behind the socket in order and show in the footer ("Indexing sessions…"), long jobs yield on a budget, and the watchdog logs every block of the thread over 100 ms with what ran (`[lag] 642 ms in sessions rebuild`), kept in `core.info.stalls` and shown in the core details. The stress harness (below) then found and fixed what the watchdog named: on the author's 1.6 GB log a first launch now answers in 2 ms, finishes its rebuilds in 5 s and reads 4,260 transcripts in 4 minutes with one stall of 109 ms in the whole run. Not built: index builds on a worker; an e2e check on a large fixture; the app's start wait. Read first: this doc; `packages/core/src/scheduler.ts`; `Core.start()` in `packages/core/src/core.ts`; `apps/desktop/src/main/index.ts` (`waitForCore`). Builds on the data layer ([28](28-data-plan.md)): the views it rebuilds are the ones this schedules.

## Why

The core is one thread, and it does everything: terminals' bytes pass through it, hooks are recorded, views are rebuilt, transcripts are read, the journal reads git. When one of those runs long without yielding, every keystroke waits. Until now nothing enforced that they don't: each job was written to behave (the transcript reader records 250 events at a time, retention runs in batches, the sessions view rebuilds in pages), and each was a separate hand-rolled loop. Work ran where it was convenient, mostly in the `Core` constructor, before the socket opened.

Two things went wrong with that, both seen on the author's Mac on 2026-10-07:

- **Startup.** The first launch of a version migrates data: a view whose format changed is rebuilt from the whole log, old tables are imported, a new index is built. All of it ran before `listen()`. On the first launch of 0.16.0 the core finished restoring at 00:43:39 and only listened at 00:46:31, 172 s later, and its 30 s retention timer fired 3 minutes late, so the thread was blocked, not waiting. The app gave up after 5 s with "the core did not start"; the person relaunched twice; three more cores exited "already running". The window said "Connecting to core…" throughout, because a window counts as connected only after the core answers its first request, so a core that listens but is blocked looks the same as none.
- **Steady state.** A widget reloading every 10 s made the core rescan git for 89 repositories each time (fixed the same day); a search after each transcript pass reread the whole vocabulary; the first retention run read every blob row. Each was found by hand, by sampling the live core.

The pattern games use for this is a **frame budget**: a scheduler gives background jobs a slice of each frame and pauses them when it is used up, so the frame always ships ([Chou, Time Slicing](https://allenchou.net/2021/05/time-slicing); [Cesium's JobScheduler](https://ci-builds.cesium.com/cesium/main/Build/Coverage/Firefox%20145.0%20(Linux%200.0.0)/engine/Source/Scene/JobScheduler.js.html) with budgets per job type; React's scheduler with 5 ms slices and `shouldYield`). JavaScript can't interrupt a running function, so the budget only works for jobs written as steps; that is the same constraint React and the Cesium scheduler live with. VS Code adds the other half: **startup phases** (`Starting`, `Ready`, `Restored`, `Eventually`), where work that isn't needed to show the window is deferred to a later phase ([lifecycle phases](https://www.mintlify.com/microsoft/vscode/api/services/lifecycle-service)).

cmd needs both. The frame is "how long the core may go without answering"; the phases are "what must run before the socket answers" (almost nothing) and "what runs behind it" (everything else).

## What's built

### Phases: answer first

`main.ts` does, in order: lock, pid file, PTY host, `new Core` (opens `cmd.sqlite` and the event log's *tables*, wires services), `restore()` (reattach terminals), `listen()`. On the author's log that is about 0.8 s. `listen()` ends by calling `Core.start()`, which queues the startup jobs on the scheduler:

| Job | What it does | Why it waited before |
|---|---|---|
| `indexes` | `DataStore.ensureIndexes()`: the log's `CREATE INDEX IF NOT EXISTS` statements | a new index reads the whole log (about 2 s per index on 1.6 GB) |
| `legacy` | tables older cmds kept in `cmd.sqlite`, once | 0.9 s for 7.7k rows |
| `turns` | the turns view from `agent.hook` events, when `TURN_FORMAT` changed | one transaction, grows with history |
| `sessions` | the sessions view from transcript events, when its `VERSION` changed | 529k events on the author's log |
| `transcripts` | starts the transcript reader (its worker reads, the core records in paced steps) | the first pass records the whole log |
| `homes` | agent home discovery and auto-hooks | scans `~` |
| `journal` | the journal's git sync and its 5-minute timer | 90 days of git after a format change |
| `retention` | arms the retention timer (30 s, then every 6 h) | — |

Each job starts on its own tick, so requests between them are answered. The views constructed with `deferRebuild` don't rebuild themselves; they say `needsRebuild` and `start()` schedules it. Tests that construct a `Core` without `listen()` call `core.start()` and `await core.scheduler.idle()`.

The phase and the jobs still running are `core.info.startup` and the `core.startup` event. The footer's core status shows the running job ("Indexing sessions…") instead of "Core", and its details say "Terminals work meanwhile"; when the list is empty the phase is `ready`.

### The scheduler: a budget for steps

`Scheduler.yield(label)` is what a long job calls between steps. A slice of steps may run for `BUDGET_MS` (12 ms); once a slice has used that, `yield` pauses the job for long enough that background work takes at most `SHARE` (30%) of wall time, capped at 250 ms, then names the job again for the watchdog. Within the budget `yield` is one `setImmediate`, so requests that arrived run first. The sessions rebuild and the transcript recorder yield this way (through a `pace` option, so tests and the lab run them unpaced).

`Scheduler.startup(id, label, job)` queues a startup job; `ready()` marks the end of the list. `mark(activity)` names what runs for the watchdog's blame: `#receive` marks every request (`rpc <method>`), startup jobs mark themselves, and ending a mark hands the name back to what ran before, so a request answered during a job's pause doesn't take the job's name with it.

### The watchdog: stalls name themselves

A 50 ms timer measures how late it fires. Over `STALL_MS` (100 ms) is a stall: logged as `[lag] <ms> ms in <activity>`, kept (the last 20) in `core.info.stalls`, shown in the core details as "Stalls · 3 · longest 642 ms · in sessions rebuild". The blame is what runs now, else what ended since the timer came due (a block holds the thread until it ends, so the timer fires after the culprit finished), else "(idle: timers, I/O callbacks)", which means a timer or I/O callback that nothing marked.

This replaces sampling the live core by hand. On the first run on a copy of the author's log the socket answered after 781 ms, then the thread blocked for 316 s during the sessions rebuild; that block never reproduced (five more cold starts, a standalone rebuild), and its blame was wrong because of the first bug below. What the watchdog named afterwards is in the next section.

## What the stress test found

A harness on a copy of the author's event log (`data/` only, never `cmd.sqlite`, which would resume the author's agents) with a client pinging every 20 ms for request latency, and load phases one after another: the view rebuilds of a first launch, a first transcript pass over 4,260 files, 30 terminals printing 3,000 lines each, journal reloads with searches, query floods, idle. Six runs; each fixed what the previous one blamed.

| Found | Blamed by | Fix |
|---|---|---|
| A rebuild page of 2,000 events took up to 340 ms: six UPDATE statements per event, and each page re-scanned the whole type index | `sessions rebuild` | steps by seq range (a rowid range, no sort), folded per session before one upsert each; 16 s → 1.6 s, identical rows |
| A 134 MB transcript arrived from the worker as one message: 120 ms to receive | `transcripts` | the worker sends a file in chunks of 4 MB or 500 events, each acked |
| The first search after a transcript pass reread the vocabulary: 300–500 ms | wrongly `transcripts` (a yield's name stuck to everything after it) | the vocabulary is read on a worker, the old one serving meanwhile; a job's name ends with its step, and a stall blames the longest activity that ended since it began |
| Transcript steps of 20 events took 200 ms about every 20 s, regardless of size | `transcripts`, once the blame was right | a re-read of the whole log rewrote every row (`data = excluded.data`) and counted and uncounted every blob, gigabytes of WAL; every 1000 pages SQLite checkpointed into the 1.6 GB file inside a commit. `record()` now leaves an unchanged row alone (span, text, data, content, identities, flags), and checkpoints run on a worker (`checkpoint-worker.ts`, passive, every 3 s; this connection only at 80 MB of WAL, the file capped at 64 MB) |
| The turns rebuild in one transaction: 360 ms | `startup: turns` | yields between agents |
| The journal's first git read recorded 2,500 events in one transaction | `journal sync` | steps of 200 |

Before and after, same harness, same log (pings p95 / max, stalls over 100 ms):

| Phase | First run | Last run |
|---|---|---|
| View rebuilds (first launch) | 71 s, 71 ms / 339 ms, 21 stalls | 5 s, —, 1 stall (109 ms, turns) |
| First transcript pass | 344 s, 24 ms / 531 ms, 31 stalls | 241 s, 1 ms / 104 ms, 0 |
| 30 chatty terminals | 0 ms / 26 ms, 0 | 0 ms / 6 ms, 0 |
| Journal reloads and searches | 47 ms / 273 ms, 1 | 43 ms / 114 ms, 0 |
| Query floods | 16 ms / 80 ms, 0 | 18 ms / 27 ms, 0 |

The pattern held every time: the stall log named a job, a profile or an offline reproduction of that job found the statement, and the fix was either smaller steps, work folded before it is written, or a worker for what can't be split.

### How to run it again

`scripts/perf/stress-core.mjs <core.sock>` is the harness; its header says how to start a core for it. In short: copy only `data/events.sqlite` of a big log into a short, fresh `CMD_HOME` (never `cmd.sqlite`: a core on a copy of it resurrects the person's panes and resumes their agents), start a core there with `--instance=dev`, run the harness, then read `grep '\[lag\]' $CMD_HOME/logs/core.log`. Delete `data/views.sqlite` between runs to get the first-launch rebuilds again. A run takes about six minutes, most of it the transcript pass. Run it after any change to how the core reads or writes the log, and before a release that bumps a view's version.

## Lessons

What the six runs taught, for the next person who sees a stall:

1. **Measure where it runs, not where you think it runs.** Every culprit here was found by the stall log naming a job and a profile or an offline reproduction of that job, never by reading the code first. Reading the code suggested the rebuild's page query (fast: 50 ms) when the cost was six UPDATEs per event; it suggested big messages (120 ms) when the cost was checkpoints. The one guess made without a measurement, that a 316 s block was the sessions rebuild, was wrong.
2. **Blame needs care, or it misleads.** A watchdog that names "what runs now" is right for a block inside a job and wrong for everything after it: a yield's name stuck to later callbacks, a paused job went unnamed so a trivial request answered right after the block was blamed. The rule that held: what runs now, else the longest activity that ended since the stall began, else "(idle)". When the blame says `rpc core.hello` took 500 ms, the blame is wrong, not the request.
3. **Write amplification hides in "updates".** Recording an event that already exists did an UPDATE (the same bytes), two blob-count writes, an FTS delete and insert: a page in the WAL for every one of 529k events, and a checkpoint into a 1.6 GB file every few seconds. Compare before writing; a re-read should cost reads.
4. **Steps must be bounded by time, not count.** 250 events was 6 ms or 500 ms depending on the events; 2,000 rows of a rebuild was 340 ms of UPDATEs. Steps that size themselves (halve when slow, double when fast), or work folded so a step's writes don't grow with its rows, hold a budget; a fixed count doesn't.
5. **Some work can't yield; give it a thread.** One SQL statement, one structured clone, one checkpoint: no budget helps inside them. Readers of a WAL database on another thread are cheap (the vocabulary), and a writer that only checkpoints is safe (passive, never waiting on anyone). A new index is next.
6. **Fold before you write.** 529k events into 3,050 sessions: the per-event upserts were a hundred times the work of folding each step in memory and writing once per session, with identical results (checked row by row against the old code on the real log, which is the test to run for any rewrite of a view).
7. **A first launch is a different workload.** Fresh views, every transcript re-read, a new index: it runs everything at once on the whole log. Startup jobs make it survivable; the stress harness makes it measurable. Neither existed, so a 172 s "Connecting to core…" shipped.

## Rules for new code

- **Nothing before `listen()` but what the window needs**: opening `cmd.sqlite`, reattaching terminals. Anything that reads the event log in full, scans folders, runs git or a model is a startup job or a scheduled job.
- **A loop over the log yields**: every few hundred rows, `await yield(label)` (or the component's `pace`). A loop that can't yield (one statement) is noted in the stall log by its job's name; if it shows up there regularly, it moves to a worker (below).
- **Name what runs**: a new timer or I/O callback that does real work marks itself, so a stall blames it and not "(idle)".
- **Check the stall log** (`[lag]` in `core.log`, or the core details) after a change to the core. A test that drives the core on a large fixture should assert no stall over 250 ms.

## Not built

1. **A worker for the rest of the one-statement work.** The vocabulary read, search itself (`search-worker.ts`) and checkpoints run on workers now, and `buildFts` runs in paced steps beside the old index, in the background after startup is ready (started by the `fts` job, named `fts rebuild` for the watchdog: 150 s on 1.9 GB, pings p95 10 ms); `CREATE INDEX` on a big table and `recountBlobs` still block. The `indexes` job is the first candidate: a new index still blocks about 2 s once per version.
2. **The app's wait.** `waitForCore` in `main/index.ts` treats an alive core as busy for up to 10 minutes and shows "Connecting to core…". With phases the core answers in about a second, so this matters less; the dialog after 5 s without a pid file, and the cores spawned every 10 s while another holds the lock (they exit "already running"), can go.
3. **An e2e check** on a large fixture asserting the socket answers within 2 s of spawn and no startup stall exceeds 250 ms.
4. **Budgets per job type**, as Cesium does, if two background jobs ever compete; today they run in sequence.
