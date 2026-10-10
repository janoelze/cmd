# 16 Feature services: Workspace Actions, Journal, Summaries, Notifications, Timers

**Score: 6/10** · reviewed 2026-10-10 against commit ddb7832 · scope: the services built on the event log, the agent tracker and the AI service (actions/, journal/, summaries/, notifications.ts, timers.ts, their protocol types, handlers, CLI, widgets and tests)

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 7/10 | No service imports `core.ts` or a sibling; each takes a small option bag. But every feature is threaded through ~9 shared registries and keeps private tables in `cmd.sqlite` |
| Correctness & robustness | 5/10 | Past journal days are rewritten whenever a long session moves; forget doesn't reach what these services derived; OSC 9 notifications have no rate limit |
| Performance | 5/10 | `journal sync` blocks the core about 0.5 s every 5 minutes (524 `[lag]` lines in two days, median 577 ms, max 3.1 s) |
| Security | 5/10 | Privacy: journal days, their history, weeks and summary files survive `data.forget`; terminal output can raise unlimited system notifications |
| Testability & tests | 7/10 | 92 tests in 8 files pass in 3.2 s; a deterministic journal scorer and an eval runner exist. Format bumps, payload contracts and timers are untested |
| Extensibility | 5/10 | A clean `ActionSource` adapter interface, but a feature is not a unit: no manifest of the events it folds, windows, commands and settings it adds |
| Code health | 7/10 | Small, commented files (largest `actions/sources.ts` at 712 lines, 15 sources behind one interface); payloads are read through 15 `as` casts |

## What this system is

Five features that sit above the data layer (doc 06), the agent tracker (doc 05) and `AiService` (doc 11). All are built and wired in `packages/core/src/core.ts:338-480`, with RPC handlers at `core.ts:634-680` and `core.ts:824-827`.

- **Workspace Actions** (docs/39): `actions/service.ts` (397 lines) keeps a catalog per folder someone is looking at. `catalog.ts` (76) runs 15 `ActionSource` parsers from `sources.ts` (712) over the root and each workspace package. `classify.ts` (52) applies rules. `describe.ts` (192) asks the fast tier for descriptions, keyed by a hash of the input. `history.ts` (92) ranks actions by `command` events (90 days, 14-day half-life). It follows runs through OSC 133 marks and finds dev-server URLs in output.
- **Journal** (docs/23, 24): `journal/store.ts` (333) builds journal events from the log, the turns view and the sessions view. Only the model-written days and weeks, their history and the sync cursors are stored, in `cmd.sqlite`. `service.ts` (348) reads git reflogs into the log every 5 minutes (`git.ts`, 199). It builds threads (`threads.ts`, 281, deterministic) and a digest (`digest.ts`, 170), then writes a day with the smart tier (`writer.ts`, 185) and a week from days (`weeks.ts`, 94). `eval.ts` (65), `scripts/evals/journal.ts` and `scripts/journal/lab.ts` score and inspect on real data.
- **Session summaries** (docs/20): `summaries/service.ts` (321) prunes a transcript to 160k characters (`prune.ts`, 195), streams a fast-tier answer into `$CMD_HOME/summaries/<project>-<date>-<session>.md` (`render.ts`, 106) and shows it in a Markdown window.
- **Notifications** (docs/31 §"What exists"): `notifications.ts` (274) turns agent state changes, bells, OSC 9/777/99, long commands, `cmd notify`, widgets, summaries and timers into `AppNotification`s. It marks pane attention and records each as a `notification` event. The renderer decides presentation (`renderer/src/notify.ts`, 71; App.tsx).
- **Timers**: `timers.ts` (59) arms one `setTimeout` per running Timer window and rings through `notifications.window`.

Where state lives and what can be rebuilt:

| Service | Reads | Writes | State | Rebuildable from the log | Model calls |
|---|---|---|---|---|---|
| Actions | project files, `command` events | pins, describe cache | `workspace_actions_pins`, `workspace_actions_described` in `cmd.sqlite`; catalogs in memory | catalogs and ranking yes; descriptions by re-asking; pins no | fast tier, ≤ 24k chars, once per input hash per *absolute root* |
| Journal | `command`, `git.*`, `browser.visit`, `file.open`, `note`, `workspace.*` events; turns and sessions views; git reflogs | `git.*` and `note` events; days, weeks | `journal_days`, `journal_days_history`, `journal_weeks`, `journal_meta`, `schema_versions` in `cmd.sqlite` | events and threads yes; days only by paying the model again | smart tier, ≤ 160k chars per day, ≤ 60k per week |
| Summaries | owned transcript (or the agent's file), turns, `git log` | a Markdown file | `$CMD_HOME/summaries/*.md` (never pruned) | no record that a summary exists | fast tier, ≤ 180k chars |
| Notifications | pane OSC/foreground, agent updates | `notification` events | in-memory per-pane maps | the widget is a live query: yes | fast tier, 6k chars, per agent done/needs (`core.ts:908-918`) |
| Timers | window state | window state (`ring`) | in-memory timeouts | yes (re-armed from windows) | none |

Timers in scope, with their period and whether they are `unref`'d or paced. Only the journal sync goes through the scheduler (docs/34).

| Where | Period | unref | Scheduler |
|---|---|---|---|
| `actions/service.ts:124` sweep | 60 s | yes | no |
| `actions/service.ts:270` rescan debounce | 300 ms | yes | no (synchronous fs scan) |
| `actions/service.ts:322` describe debounce | 2 s | yes | n/a (async model call) |
| `journal/service.ts:116` git sync | 5 min | yes | yes (`pace.mark`, `yield` every 200 events) |
| `summaries/service.ts:299` file write throttle | 200 ms | no | no |
| `notifications.ts:175` AI wording wait | 1.5–2.5 s | no | n/a |
| `timers.ts:33` per Timer window | until `endsAt` | yes | no |
| renderer: ActionsView poll 60 s, clock 1 s/15 s; JournalView 5 s debounce + midnight; TimerView 250 ms; EventsView 5 s; NotificationsView 30 s | | | |

## What is good

- **Dependency injection without reaching in.** No file in `actions/`, `journal/` or `summaries/` imports `core.ts` or another feature. Their only core imports are `ai/*`, `checkout.ts`, `data/*`, `scheduler.ts`, `watch.ts`, `panes.ts` and `search/parser.ts`. Each takes a typed option bag (`ActionsOptions`, `JournalServiceOptions`, `SummaryServiceOptions`), so tests build them alone. This is the shape the plugin system of docs/06 needs; see AR1-16-08.
- **`ActionSource` is a clean adapter.** `sources.ts:55-63` defines one interface (`id`, `packages?`, `folders?`, `find(dir)`). It has 15 implementations and a single `SOURCES` list (`sources.ts:712`). A source that throws keeps its last good actions (`catalog.ts:46-52`). Sources parse files and never run project code (docs/39 "Parse, never run"). Other registries (agent kinds, doc 05's AR1-05-05) should copy this.
- **The journal is on the rails.** Its facts are log events (`store.ts:1-6`), and turns and sessions are read live from their views. Threads are deterministic and tested ("is deterministic"). Every layer has a version (docs/24), and older days are kept as written and marked outdated.
- **Model output is cached by input hash.** Actions use `inputOf(...).hash` (`describe.ts:115-119`, persisted). Journal days use `eventsHash` and the format (`journal/service.ts:244-256`), and today is throttled to once per 30 minutes. Weeks use `daysHash`. Summaries de-duplicate while one is running.
- **Notification wording degrades gracefully.** The AI body has a hard deadline and falls back to cmd's words (`notifications.ts:172-181`, tested). Bells are folded per terminal (2 s), start failures per burst (30 s), and quick turns you prompted stay quiet.
- **Timers are on the window model.** A Timer is ordinary window state, re-armed from `windows.list()` on start, so a core restart keeps it (`timers.ts:18-24`).
- **Tests are fast and specific.** 92 tests across actions (25), journal (31), summaries (21), notifications (15), journal-eval (2), attention, progress and the renderer's `notify` (5), in 3.2 s.

## Issues

### AR1-16-01 · Stop rewriting past journal days every time a long session moves

- **Status:** in progress (journal-days)
- **Severity:** high
- **Effort:** M
- **Where:** `packages/core/src/journal/digest.ts:18-27`, `packages/core/src/journal/backfill.ts:39-48`, `packages/core/src/journal/service.ts:248-253`, `apps/desktop/src/renderer/src/components/JournalView.tsx:56-62`

**Problem.** A day counts as "happened" when the hash of its threads' events changes. That hash includes each event's `until` and `text`. An agent session is one `agent.session` event spanning `started` to `updated`, with the session's title as its text. So a session resumed today, or renamed (docs/32), changes the hash of every earlier day it spans. Those days are then written again with the smart tier on the next `stale` read. The today-only throttle (`throttled = stored && today && …`) doesn't cover them. The Journal widget triggers a `stale` read 5 s after any `command` or `transcript.message` event. A three-day session therefore keeps re-paying for two finished days, at up to 160k characters (about 40k tokens) each, plus the week built from them. Meanwhile each rewrite pushes an older version out of the 3-entry history. That contradicts docs/24: "History stays as written".

**Evidence.** `eventsHash` hashes `${e.key}\0${e.until ?? e.at}\0${e.text}` (`digest.ts:24`). The session event's `until` is `Math.max(r.updated ?? r.started, r.started)`, and its `text` is the title (`backfill.ts:41-47`). `threads.ts:36` puts a span into every day it reaches (`(e.until ?? e.at) >= o.from`). `service.ts:253`: `stale = !stored || (happened && !throttled) || …`. `throttled` is only true for today (`service.ts:251`). The existing test "writes a day once, until its events change" covers a single day only.

**Proposal.** Hash what the day *contains*, not the span's end. For span events, clip `until` to the day window (`min(until, to)`) before hashing. Then a session that continues tomorrow doesn't change yesterday. Leave titles out of past days' hashes, or hash only the day's own turns, which are per-turn events with stable ends. Add a rule matching docs/24's intent: a day older than `UPGRADE_RECENT_DAYS` is rewritten only on `force` or a format change, never because a hash moved. Separately, make the widget's reload cheaper: `journal.days` with `write: "stale"` should consider only days whose events changed since the last call. The core can track a dirty set from the log cursor, the same "views from a cursor" idea as AR1-06-02, instead of recomputing 21 days of threads each time.

**Success criteria.**
- [x] A test: a session spanning three work days gets a new turn on day 3. Days 1 and 2 keep their `writtenAt`, and the fake AI is called once (for day 3).
- [x] A test: renaming a session (a `session.name` event) does not rewrite a day older than yesterday.
- [x] `eventsHash` clips span ends to the day window, and that is documented in `digest.ts`'s comment.
- [x] `THREADS_FORMAT` or `WRITER_FORMAT` is unchanged by the fix, or bumped with a note in docs/24, as AR1-16-04 requires.

### AR1-16-02 · Make forget and retention reach what these services derived

- **Status:** open
- **Severity:** high
- **Effort:** M
- **Where:** `packages/core/src/data/service.ts:279-288`, `packages/core/src/journal/store.ts:74-91`, `packages/core/src/summaries/service.ts:251`, `packages/core/src/actions/describe.ts:159`

**Problem.** `data.forget` deletes events and records a `data.op`. Nothing in the journal, summaries or actions listens. After "forget this project" or "forget this session", the model-written prose about it survives in four places: `journal_days`, `journal_days_history` (three older versions per day), `journal_weeks`, and the Markdown summary files in `$CMD_HOME/summaries`. The days are hidden from `journal.days` once their events are gone, because `day()` returns null without non-minor threads. But `journal.history` still returns them. The same applies to `data.keepDays` retention, and to the `ai.call` event content (doc 06/11). A person who asked cmd to forget a client project can still find its summary on disk and its days in `cmd.sqlite`.

**Evidence.** `grep -rln "journal_days\|journal_weeks" packages/core/src` returns only `journal/store.ts`. `grep -rn "summaries" packages/core/src` outside `summaries/` returns only the wiring in `core.ts:392-411`. `DataService.forget` (`data/service.ts:279`) emits no event services subscribe to. Summary files are never deleted (no `unlink` or `rm` in `summaries/`).

**Proposal.** Give derived stores one hook: `DataService` emits `forgot(what: ForgetWhat)` and `pruned(before)`, and every service that keeps derived state registers a handler. The journal deletes days, history and weeks whose scope or date the forget covers. Simplest and safest: delete every stored day touching the forgotten session or project, and let the next read rewrite it from what is left. Summaries record a `summary` event (`sessionId`, `path`, `hash`), so a forget of that session finds and deletes the file. The describe cache drops rows under a forgotten project. Doc 06's AR1-06-07 ("Make forget complete") is the data-layer half. This issue is the derived half, and should land as the same `forgot` hook.

**Success criteria.**
- [ ] A test: write a day and a week for a project, then `data.forget({ projectId })`. `journal_days`, `journal_days_history` and `journal_weeks` have no rows for it, and `journal.history` returns `[]`.
- [ ] A test: summarise an agent, then forget its session. The `.md` file is gone.
- [ ] Retention (`data.keepDays`) removes journal days older than the window.
- [ ] docs/28 (or the forget section of DEVELOPMENT.md) lists every derived store and how forget reaches it.

### AR1-16-03 · Take `journal sync` off the core thread's critical path

- **Status:** in progress (journal-days)
- **Severity:** high
- **Effort:** M
- **Where:** `packages/core/src/journal/service.ts:141-179`, `packages/core/src/journal/store.ts:214-217`, `packages/core/src/journal/service.ts:337-339`

**Problem.** The core logs a `[lag]` block attributed to `journal sync` on every 5-minute sync. The UI and every RPC wait for that half second, 288 times a day. The sync is paced (`pace.mark`, a `yield` every 200 events) but still stalls, so the blocking part runs between yields. The candidates are `store.repos()`, which is a synchronous `SELECT DISTINCT project_id … AND at >= ?` over the whole `dir:` range of the project index; `gitStamp` and `gitEvents` for about 60 repositories whose stamp never matches; and `recordAll` in 200-event batches. A second unbounded read sits in `#pool` (`limit: Number.MAX_SAFE_INTEGER`, 28 days of events) on every `journal.days` call.

**Evidence.** `~/Library/Logs/cmd/core.log` (the installed release, 2026-10-08 to 10-09) has 524 lines `[lag] … ms in journal sync`: median 577 ms, p90 708 ms, max 3131 ms, at :39 every 5 minutes. The matching `journal synced` lines say `{"repos":94,"skipped":34,"ms":336}`, so 60 of 94 repositories are read again on every sync. `store.ts:215` runs the DISTINCT query synchronously. Following the memory rule "core stalls: measure first", the exact culprit is not yet profiled.

**Proposal.** Measure first: profile one sync with `scripts/perf/stress-core.mjs` on a copied `data/` (never `cmd.sqlite`), with marks around `repos()`, the stamp loop and `recordAll`. The likely fixes, in order:
1. Keep the repository set as a small view, updated as `git.*`/`command` events are recorded, instead of a DISTINCT scan.
2. Remember repositories whose `gitStamp` is null (not a git checkout, or gone) and skip them until a workspace or event names them again.
3. Bound `#pool` by a query on the time index plus the day's types, and page it with `scheduler.yield()`.

If a single SQL statement stays over 100 ms, move the reflog read and the event diff into the indexer worker that search already uses (doc 06).

**Success criteria.**
- [x] A profile of one sync, with the top three costs, is attached to the PR.
- [x] On the stress log, `journal sync` produces no `[lag]` line over 100 ms.
- [x] `journal synced` logs `skipped` ≥ 90% of repositories on a sync where nothing changed.
- [x] `JournalService.#pool` has a bounded `limit` and a test for a day with more events than the bound.

### AR1-16-04 · Enforce the journal's format versions with golden fixtures

- **Status:** open
- **Severity:** medium
- **Effort:** S
- **Where:** `packages/core/src/journal/threads.ts:9-10`, `packages/protocol/src/journal.ts:27-30`, `packages/core/test/journal.test.ts`

**Problem.** docs/24 rests on each layer's version going up when its rules change: "Changing a rule changes threads: raise THREADS_FORMAT". Nothing checks that. Since the versions were introduced (2f3d975, 2026-10-06), threading rules have changed and every format is still 1. Days written by the old rules are therefore not marked outdated and not upgraded when recent. Two people see the same day threaded differently with no signal why.

**Evidence.** a4ed535 (2026-10-08) changed `worktreeOf` so it no longer guesses a branch's worktree from the folder name (`threads.ts`). That changes which sessions link to which branches. `THREADS_FORMAT`, `WRITER_FORMAT`, `SOURCES_FORMAT` and `JOURNAL_SCHEMA` are all `1` (`protocol/src/journal.ts:27-30`), as they were in 2f3d975 (`git log -S"WRITER_FORMAT = 1"` shows one commit).

**Proposal.** Add a golden test per layer. Build threads and the digest from the existing fixture day and hash the output. The test stores `{ THREADS_FORMAT: n, hash }` and fails if the hash changes while the format didn't, with the message "bump THREADS_FORMAT (docs/24)". Do the same for `SYSTEM`/`SCHEMA` against `WRITER_FORMAT`, and the sources mapping against `SOURCES_FORMAT`. This is the same ratchet idea as `design-debt.json` and `pnpm tokens --check`. Bump `THREADS_FORMAT` to 2 for a4ed535 when it lands.

**Success criteria.**
- [ ] `journal.test.ts` has golden hashes for threads/digest, writer prompt+schema and sources mapping, each paired with its format constant.
- [ ] Reverting a4ed535's `worktreeOf` change makes the test fail with a message naming the constant.
- [ ] `THREADS_FORMAT` is 2, and docs/24 has a line for what changed.

### AR1-16-05 · Put every notification source behind one rule shape with a key and a cooldown

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/notifications.ts:101-110`, `packages/core/src/notifications.ts:201-215`, `apps/desktop/src/main/updater.ts:63-68`, `apps/desktop/src/main/index.ts:612-615`

**Problem.** Rate limiting is per source and incomplete. Bells are folded (2 s per terminal) and start failures per burst. OSC 9/777/99 from a plain terminal and `cmd notify` have no limit at all. Any program, or `cat` of a file with escape sequences, or remote output over ssh, can post an unbounded stream of urgent macOS notifications. Each one also becomes a `notification` event in the log. Separately, the "one path for every source" claim (DEVELOPMENT.md, the file's header) is not quite true: the updater and the "test notification" post from main directly, outside the settings (`notifications.when`), the log and the widget. docs/31 already designs the fix, a rule engine with `key` for dedupe and a cooldown, but it is "handoff, not built".

**Evidence.** The `case "notify"` branch (`notifications.ts:201-215`) marks the pane and emits with no timestamp check. `send()` (`:102-110`) is the same. `grep -rn "new Notification"` finds `main/updater.ts:65` and `main/index.ts:577,614`. Only `:577` is the core's path.

**Proposal.** Introduce the docs/31 rule interface now, for the existing sources first: `{ id, key(ctx), cooldownMs, build(ctx) }`. `#emit` drops a notification whose `key` (for example `osc:<paneId>`, `cli:<paneId|global>`, `agent:<id>:<kind>`) fired within its cooldown, and folds a burst into "N more from <terminal>". Keep the existing per-source logic as rules, so behaviour is unchanged except for the new limits. Route the updater's notice through the core's `info()` when a core is connected, so it lands in the widget and the log. Then docs/31's context rules (the test passes now, the agent stopped on a limit can go on) are new rules, not new code paths. Attention and badge placement belong to the window model and the renderer: see doc 07 (AR1-07-05) and doc 08 (AR1-08-04).

**Success criteria.**
- [ ] A test: 100 OSC 9 sequences in one second from one terminal produce at most 2 `AppNotification`s and 2 `notification` events.
- [ ] A test: `notify.send` from one pane is limited the same way, and a different pane is not affected.
- [ ] Every existing notifications test passes unchanged.
- [ ] `grep -rn "new Notification" apps/desktop/src/main` lists only the core-driven path and the permission test.

### AR1-16-06 · Ring timers on wall-clock time, across sleep

- **Status:** open
- **Severity:** medium
- **Effort:** S
- **Where:** `packages/core/src/timers.ts:26-48`

**Problem.** `TimerAlarms` arms one `setTimeout(endsAt - now)` and trusts it to fire on time. Node's timers run on libuv's monotonic clock, which on macOS does not advance while the Mac sleeps. Verify this with one manual sleep test before fixing. If it holds, a 25-minute timer whose Mac sleeps for 20 minutes rings about 20 minutes late. The "late" branch (`:43-44`) only covers a core that was not running. The core is a detached Node process with no power events, and main's `powerMonitor` does not tell it about a wake. A timer is the one widget whose whole job is to be on time.

**Evidence.** `timers.ts:33`: `setTimeout(() => this.#fire(w.id, endsAt), Math.min(MAX_WAIT, Math.max(0, endsAt - Date.now())))`. There is no `resume` handling anywhere in `packages/core/src` (`grep -rn "resume\|powerMonitor" packages/core/src/timers.ts` returns nothing). There is no `TimerAlarms` test either (doc 03's AR1-03-09 asks for one).

**Proposal.** Keep the per-timer timeout, and add one `unref`'d 15 s interval that runs only while a timer is armed. It compares `Date.now()` with each `endsAt` and fires any that are due. That catches wake, clock changes and `MAX_WAIT` re-arms in one place. Alternatively, main forwards `powerMonitor` `resume` as an RPC (`core.resumed`) that re-syncs every timer. The interval is simpler and needs no protocol change, so recommend it.

**Success criteria.**
- [ ] A test with fake timers: arm a 10-minute timer, jump `Date.now()` forward 11 minutes without advancing timers, then advance 15 s. The window is rung once.
- [ ] No interval runs when no Timer window has an `endsAt` (asserted in the test).
- [ ] A manual check (noted in the PR): a 2-minute timer across a 5-minute sleep rings within 15 s of wake.

### AR1-16-07 · Key the actions' pins and descriptions by repository, not by absolute folder

- **Status:** open
- **Severity:** medium
- **Effort:** S
- **Where:** `packages/core/src/actions/describe.ts:115-119`, `packages/core/src/actions/describe.ts:154-173`, `packages/core/src/actions/service.ts:97`, `packages/core/src/actions/service.ts:217-226`

**Problem.** cmd's own workflow is one worktree per task, and docs/39 cares about worktrees. Action ids are already relative (`npm:package.json:dev`, `service.ts:173`). But pins and the model's descriptions are keyed by the absolute root. Each new worktree of a repository pays a fresh fast-tier call for the same `package.json` (the input hash includes `root`). A pin made in `~/src/cmd` is missing in `~/src/cmd-topic`. Neither table is ever trimmed, so rows for removed worktrees stay forever. Both tables are created ad hoc by the service in `cmd.sqlite`, outside any schema registry (doc 03's AR1-03-05).

**Evidence.** `inputOf` hashes `` `v2\0${root}\0${lines}\0${docs}` `` (`describe.ts:118`). The tables are `workspace_actions_described (root TEXT PRIMARY KEY, …)` and `workspace_actions_pins (root, id, …)` (`describe.ts:159`, `service.ts:97`). There is no `DELETE` other than an unpin.

**Proposal.** Key both by the repository's common git dir plus the root's path relative to the checkout top (`checkoutOf(root).common` + relative path), falling back to the absolute path outside git. Drop `root` from the hash, since `path.basename(root)` in the prompt is the only thing the model sees of it. Add a sweep on the existing 60 s timer that deletes describe rows unused for 90 days. Register the tables through doc 03's table registry when it lands.

**Success criteria.**
- [ ] A test: two worktrees of one repository with the same `package.json` cause one `describe` call, and a pin in one shows in the other.
- [ ] A test: a describe row older than 90 days with no catalog is deleted by the sweep.
- [ ] The `inputOf` hash no longer contains the absolute root (prefix bumped to `v3`).

### AR1-16-08 · Declare each feature as one contribution, as a dry run for plugins

- **Status:** open
- **Severity:** medium
- **Effort:** L
- **Where:** `packages/core/src/core.ts:338-480`, `packages/core/src/core.ts:634-680`, `packages/core/src/core.ts:824-827`, `packages/core/src/windows/builtin.ts:349-696`
- **Depends on:** AR1-03-01, AR1-03-02

**Problem.** Each service is decoupled in code, but a feature is not a unit. Adding or removing Workspace Actions touches about nine shared registries:
- `rpc.ts` `Methods`
- `core.ts` wiring (`:447-480`, 34 lines of lambdas) and handlers (`:824-827`)
- `SETTINGS_SCHEMA` and `settings/layout.ts`
- the core `windows/builtin.ts` and the renderer `windows/builtin.tsx`
- `shared/commands.ts`
- `cli/main.ts`

The journal touches six, timers five. These are the append-only files CLAUDE.md names as the worst merge conflicts. The plugin system of docs/06 will need exactly this declaration, and these five features are the cheapest place to learn it, because they already depend only on injected interfaces.

**Evidence.** `grep -rlI actions` over those registries lists 9 of them (plus generic window files). `core.ts` has 36 references to `this.journal|actions|summaries|notifications|timers`. There are 16 feature methods in `rpc.ts`.

**Proposal.** Define an in-process `Feature` contribution:

```ts
interface Feature<O> {
  id: string;
  settings?: SettingsSchemaPart;
  methods?: Partial<Handlers>;
  windowTypes?: WindowType[];
  folds?: { types: DataEventType[]; onEvent(e: DataEvent): void };
  startup?: StartupJob[];
  create(ctx: CoreContext): O & { dispose(): void };
}
```

`Core` loops over `FEATURES = [actions, journal, summaries, notifications, timers]`. Port timers first (smallest), then actions. This is the same move as doc 03's AR1-03-01 (handlers per feature) and doc 07's AR1-07-08 (window type SDK), applied to whole features. VS Code's contributions are the prior art: one `.contribution.ts` per feature registering into shared registries, which 00-research.md §10 names as the fix for append-only god lists (see also §7). Keep the renderer side for a second step.

**Success criteria.**
- [ ] `packages/core/src/features.ts` defines `Feature`, and timers and actions are registered through it.
- [ ] `core.ts` has no `new ActionsService` or `new TimerAlarms`, and its line count drops by at least 60.
- [ ] Removing `actions` from `FEATURES` compiles, and `pnpm test` passes with the actions tests skipped.
- [ ] A short section in docs/06 (or a new doc) records what the dry run taught about the plugin manifest.

### AR1-16-09 · Read event payloads through `EventPayloads`, and test the contract the journal and actions depend on

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `packages/core/src/journal/store.ts:296-321`, `packages/core/src/core.ts:450-457`, `packages/protocol/src/events.ts:17-86`

**Problem.** The protocol has a typed payload map (`EventPayloads`, with `EVENT_V`), but these consumers read payloads through casts: `payload.command`, `payload.cwd`, `payload.url`, `payload.path`, `payload.windowKind` in `toJournal`, and `{ command?, cwd?, exitCode? }` in the actions ranking. Renaming a field in a recorder compiles. The journal then silently drops commands from days (`cwd` becomes null), and ranking silently returns no history (`d.command && d.cwd` fails). No test pins the fields.

**Evidence.** 15 `data as` / `.data as` casts across `journal/*.ts`, `actions/*.ts` and `core.ts`. `core.ts:452` casts `e.data as { command?: string | null; cwd?: string; exitCode?: number | null }`.

**Proposal.** Give `DataService.query` a typed overload for one type (`query<"command">(…)` returns `DataEvent<"command">[]`), and use `EventPayloads[T]` in `toJournal`. Add one contract test that records each event kind the journal and actions read, through the real recorder (`CommandLog`, `recordWindows`), and asserts the journal event and the `Ran` they produce. After that, a payload change fails at compile time or in that test.

**Success criteria.**
- [ ] `grep -n "data as {" packages/core/src/journal packages/core/src/actions packages/core/src/core.ts` finds none for these reads.
- [ ] A test drives a real `command` through `CommandLog` and sees it in `journal.store.events()` and in `actions.list().history`.
- [ ] Renaming `cwd` in `EventPayloads["command"]` fails `pnpm typecheck`.

### AR1-16-10 · Keep an edited summary when asked again, and record that it exists

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `packages/core/src/summaries/service.ts:250-275`

**Problem.** A summary is "written to be edited and passed on" (docs/20). But asking again for the same session on the same day writes the same file name and overwrites the person's edits with the facts header, before the model answers. docs/20 documents "asking again overwrites", so this is a choice that has stopped paying off once people edit. A re-ask also re-pays the model even when the transcript hasn't changed. Nothing records that a summary exists, so Recent, search, the journal and a forget can't find it (AR1-16-02).

**Evidence.** The file name is `` `${slug(facts.project)}-${day}-${(session ?? a.id).slice(0, 8)}.md` `` (`:251`). `write(renderSummary(facts, {}, { pending … }))` at `:274` runs unconditionally. There is no `summary` type in `EventPayloads`.

**Proposal.** Record a `summary` event (`sessionId`, `path`, `inputHash` of the pruned context, `writtenHash` of the rendered file) when one is written. On a re-ask, compare: if the file's hash differs from `writtenHash`, the person edited it, so write to `…-2.md`. If the input hash is unchanged and the file is untouched, show the existing file and skip the call.

**Success criteria.**
- [ ] A test: summarise, edit the file, summarise again. The edited file is unchanged and a second file is written.
- [ ] A test: summarise twice with no new messages. The fake AI is called once.
- [ ] A `summary` event is in the log after a summary is written.

### AR1-16-11 · Use the shared JSONC parser in Workspace Actions

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `packages/core/src/actions/sources.ts:118-137`, `packages/protocol/src/jsonc.ts`

**Problem.** `actions/sources.ts` has its own `parseJsonc` (for tsconfig, `.vscode/tasks.json`, `deno.jsonc`). It skips strings while stripping comments, but its final trailing-comma regex runs over the whole text, strings included, so a task whose command or label contains `, ]` or `, }` is silently changed. AR1-15-01 (done in 7e25ce90) fixed the same bug for settings with `jsonc-parser` in `@cmd/protocol/src/jsonc.ts`.

**Evidence.** `parseJsonc('{ "a": "x, ]y" , }')` from `actions/sources.ts` returns `{"a":"x ]y"}` (checked on master after 7e25ce90).

**Proposal.** Delete the local parser and import `parseJsonc` from `@cmd/protocol`; it throws with a position on malformed input, so keep the callers' existing catch (a source that throws keeps its last good actions).

**Success criteria.**
- [ ] `grep -n "function parseJsonc" packages/core/src/actions/sources.ts` returns nothing.
- [ ] An actions test reads a `tasks.json` whose command contains `, ]` and gets it unchanged.

## Course corrections

1. **Stop the journal's silent spending and stalls** (AR1-16-01, AR1-16-03). One is a cost defect that grows with session length, the other a measured half-second block every five minutes. Both sit in the journal's read and sync paths and want the same thing: change-driven work from a log cursor (doc 06's AR1-06-02) instead of recomputing days and rescanning repositories.
2. **Make forget reach derived state** (AR1-16-02, with AR1-16-10's `summary` event). This keeps the data layer's privacy promise true for everything built on it, including docs/29 memory, which will be the next derived store.
3. **Enforce versions and payload contracts** (AR1-16-04, AR1-16-09). Cheap ratchets that turn "remember to bump" and "don't rename a field" into failing tests.
4. **Build docs/31's rule shape for the existing sources** (AR1-16-05). Rate limits now, context rules later, one code path.
5. **Use these five features as the plugin dry run** (AR1-16-08). They are already injected and small, so this is where the manifest gets designed cheaply.

## Quick wins

AR1-16-04, AR1-16-06, AR1-16-07, AR1-16-09, AR1-16-10, AR1-16-11.
