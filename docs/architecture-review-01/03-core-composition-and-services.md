# 03 Core composition and services

**Score: 5/10** · reviewed 2026-10-10 against commit ddb7832 · scope: how the core process is put together: the `Core` class, its services and how they are wired, the scheduler, settings, the SQLite store, the small services (watch, timers, notifications, usage, secrets, git, checkout, fileops, resources, sqlite reader, workspaces)

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 4/10 | `Core` is a 1,640-line god object; every service reaches back into it through lambdas, so Core plus 24 services form one strongly connected component |
| Correctness & robustness | 7/10 | The pieces are careful (atomic writes, decoders for old rows, socket rebinding); gaps are small (one error code for everything, no schema version on `cmd.sqlite`, `agents.close()` twice) |
| Performance | 8/10 | docs/34 is built and measured: startup jobs behind the socket, a budgeted `yield`, a watchdog that names stalls, workers for what can't be split; one known 2 s block remains |
| Security | 6/10 | Socket files 0600, widget tokens, a remote policy table; API keys sit in a plain 0600 JSON file, not the Keychain |
| Testability & tests | 6/10 | Every small service has a direct test; `Core` itself is tested only end to end (33 `new Core(` across 20 files), `Store` and `TimerAlarms` have none of their own |
| Extensibility | 5/10 | Adding a feature means editing the constructor, the `Handlers` map, `start()`, `close()` and `#afterCall` in one file: the append-only god-list 00-research §10 warns about |
| Code health | 5/10 | 113 of the last 300 commits touch `core.ts`; 67 imports; 103 lambdas in a 276-line constructor |

## What this system is

The core is a detached Node process (`packages/core/src/main.ts` constructs it, `core.ts` is it) that owns all state and serves JSON-RPC over a Unix socket. `Core` (`packages/core/src/core.ts`, 1,640 lines) constructs about 25 services in its constructor, wires them to each other and to itself with option bags of lambdas, exposes a `handlers` map typed against the protocol's `Methods` (142 methods), queues startup work on a `Scheduler` (`scheduler.ts`, 210 lines; docs/34-startup-scheduler.md) and fans events out to subscribed connections. Durable state is three SQLite files: `cmd.sqlite` (`store.ts`, 255 lines, plus tables other services create on `store.db`), `data/events.sqlite` and `data/views.sqlite` (the data layer, another doc). `stored.ts` (185 lines) decodes rows written by other versions against per-type defaults. `settings.ts` (152 lines) loads, validates, watches and writes `settings.json` and offers `bind(keys, fn)` for live application. The small services in scope: `watch.ts` (fs watches for windows, 90), `timers.ts` (Timer widgets ring from the core, 59), `notifications.ts` (one path for every notification source, 274), `usage.ts` (anonymous counters, 166), `secrets.ts` and `dev-keys.ts` (API keys, 97 and 69), `git.ts` and `checkout.ts` (git status via a process, and the checkout a path is in without one, 142 and 152), `fileops.ts` (118), `resources.ts` (process-tree sampling, 113), `sqlite/service.ts` and `worker.ts` (a reader process per database for SQLite windows, 182 and 210; docs/36), `workspaces/manager.ts` and `paths.ts` (222 and 63; docs/11-workspaces.md). Workspace Actions (docs/39) is wired here but lives in `actions/`. The flows that matter: `new Core()` → `restore()` → `listen()` → `start()` (startup jobs), a request through `#serveSocket` → `#receive` → `handlers[method]` → `#afterCall`, and an event through `#broadcast` to every subscriber.

## What is good

- **The scheduler is the right design and it is measured.** `Scheduler.startup()` runs jobs one per tick behind the socket; `yield()` keeps background work to 30 % of wall time in 12 ms slices; the watchdog blames stalls on the longest activity that ended since the stall began, which docs/34 shows was tuned against six stress runs (71 s / 21 stalls → 5 s / 1 stall on a 1.6 GB log). The `Pacer` interface (`scheduler.ts:35`) lets views and the journal run paced in the core and unpaced in tests. Keep it; the rest of the codebase should name what runs the way `#receive` does (`core.ts:1331`).
- **Workers are used where yielding can't help**, and the rule is written down (docs/34 lesson 5): the transcript parser, stats, checkpoints and the vocabulary read are `worker_threads`; SQLite viewer reads are a child *process* because a thread stuck in one statement can't be killed (`sqlite/service.ts:1-8`). That is a principled split.
- **Settings are sound.** The file is the source of truth; `set()` writes atomically (`tmp` + rename, `settings.ts:133-135`); `watch()` watches the folder (editors replace files), polls as a backstop and re-reads once after the watch starts (`settings.ts:59-73`); `resolveSettings` validates every key against the schema and keeps the errors in the snapshot; renamed and removed keys are handled; `bind()` compares values, and every setting is a primitive (45 boolean, 25 number, 21 string, 17 enum), so `!==` is correct. Eleven tests cover it, including hand edits and the ingest restart.
- **Rows from other versions are decoded, never cast** (`stored.ts`): required fields reject the row, the rest fall back to defaults, unknown fields survive. `Store` opens WAL with `synchronous=NORMAL`, caches prepared statements and records its own path so a copied database resurrects nothing (`store.ts:96-107`).
- **Small services are small, documented at the top, and tested on their own**: `WatchService`, `TimerAlarms`, `UsageStats` (fetch and clock injectable), `NotificationCenter`, `WorkspaceManager`, `SqliteService`, `gitStatus`, `checkoutOf`, `fileops`. Their option bags name what they need and nothing more.
- **Socket hygiene**: bind under a temp name and rename into place, chmod 0600, inode check before unlinking, rebinding when the file disappears (`core.ts:1197-1270`), tested in `core.test.ts:183-217`.
- **RPC handlers that throw a `TypeError`/`ReferenceError`/`RangeError` are filed as crash reports**, expected failures only logged (`core.ts:1350-1356`). A useful convention; issue 06 asks for the other half.

## Issues

### AR1-03-01 · Split `Core` into per-feature handler modules registered into one `Handlers` map

- **Status:** open
- **Severity:** high
- **Effort:** L
- **Where:** `packages/core/src/core.ts:167-1596`, `packages/core/src/core.ts:591-888` (handlers), `packages/core/src/core.ts:1556-1595` (close)

**Problem.** `Core` is a god object. It is the composition root, the RPC dispatcher, the subscription manager, the hook installer, the Widget Library, the workspace closer, the preview broker and the search restarter. Every feature touches it, so several agents working in parallel (CLAUDE.md: "one worktree per task") conflict in it, and nobody can read the file end to end. The feature logic that lives only here (`#closeWorkspace`, `#place`, `#widgets`, `#openWindow`, `#hookTargets`/`#autoHooks`, `#restartSearch`, `#focused`, `#countAgent`) has no unit tests because the only way to construct it is a whole `Core`.

**Evidence.** 1,640 lines; 67 `import` lines; 64 fields (24 public services, 40 private); a 276-line constructor (`core.ts:252-527`); 142 handlers of which 112 are one-line delegations and 30 carry logic; 38 private methods; 7 public ones. `git log -300 -- src/core.ts` → 113 commits (38 % of the last 300 touch this file). `close()` is 40 lines of ordered disposal and calls `this.agents.close()` twice (`core.ts:1561`, `core.ts:1592`). The next largest core file is `agents/tracker.ts` at 876 lines.

**Proposal.** The handlers are already the seam: 112 of 142 only forward to a service. Move each feature's handlers into its folder as a module that registers a *typed slice* of the map, and keep exhaustiveness in tsc by assembling the slices into the full `Handlers` type:

```ts
// packages/core/src/rpc.ts
export type Handlers = { [M in Method]: (p: Params<M>, call: CallContext) => Result<M> | Promise<Result<M>> };
export type HandlerSlice<K extends Method> = Pick<Handlers, K>;
export const slice = <K extends Method>(h: HandlerSlice<K>) => h;

// packages/core/src/workspaces/handlers.ts
export const workspaceHandlers = (ctx: Pick<CoreContext, "workspaces" | "panes" | "agents" | "windows" | "broadcast">) =>
  slice({
    "workspace.list": (p) => ctx.workspaces.list(p.closed),
    "workspace.close": (p) => (closeWorkspace(ctx, p.id), null),
    …
  });

// core.ts
readonly handlers: Handlers = { ...coreHandlers(ctx), ...paneHandlers(ctx), ...workspaceHandlers(ctx), …, ...remoteHandlers(ctx) };
```

A missing method fails the assignment to `Handlers`; a method registered twice is caught by a 5-line test that counts keys across slices. `#closeWorkspace`, `#place`, `#widgets`, `#openWindow` and the hook helpers go with their slices as plain functions over `ctx`, which makes them unit-testable with a fake context. Prior art: VS Code's `*.contribution.ts` per feature, with nothing outside the feature folder depending on it (00-research §10), and this codebase's own `windows/builtin.ts` and `search/builtin.ts` registries. Do it after AR1-03-02 (the slices need a context to receive) and together with AR1-03-03 (the `CallContext` argument). Add a line-count ratchet for `core.ts` the way `design-debt.json` ratchets CSS literals (00-research §9).

**Success criteria.**

- [ ] `core.ts` is under 500 lines and contains no `"<method>":` handler bodies except `core.hello`, `core.info` and `events.subscribe`
- [ ] Every feature folder that owns methods (`panes`, `agents`, `windows`, `workspaces`, `data`, `journal`, `magic`, `actions`, `remote`, `settings`, `fs`/`git`/`sqlite`) has a `handlers.ts` exporting a `slice(...)`
- [ ] `pnpm typecheck` fails when a method of `Methods` has no handler (demonstrated by removing one), and a test fails when two slices register the same method
- [ ] A test in `apps/*/test` or `packages/core/test` asserts `core.ts` line count ≤ the number in a checked-in ratchet file
- [ ] `agents.close()` is called once in `close()`

### AR1-03-02 · Replace the lambda option bags with a typed `CoreContext`

- **Status:** open
- **Severity:** high
- **Effort:** M
- **Where:** `packages/core/src/core.ts:252-527`, `packages/core/src/core.ts:308`, `packages/core/src/core.ts:356`, `packages/core/src/core.ts:466-470`, `packages/core/src/core.ts:405-411`

**Problem.** Each service receives an options object whose fields are closures back into `Core` (`() => this.ai.object(o)`, `(id) => this.agents.get(id)?.paneId`, `() => this.#subscribers.size > 0`). Read one at a time these are honest, narrow interfaces. Read together they are an implicit service locator spread over 103 lambdas, with two kinds of fragility: construction order shows through (property injection after construction, lambdas that read fields assigned later), and every dependency edge is invisible to tooling (no import, no type names the relation), so the graph below had to be reconstructed by hand.

**Evidence.** 103 `=>` in the constructor. `this.data` is referenced 22 times, `this.settings` 20, `this.#broadcast` 19, `this.agents` 18, `this.panes` 17, `this.workspaces` 16, `this.ai` 16, `this.windows` 14. Temporal coupling: `activity.workspaceOf = …` is set after construction (`core.ts:308`); `notifications.workspaceOf` is set only once `windows` exists (`core.ts:356`), because `NotificationCenter` is constructed before `WindowManager`; `ActionsService.createPane` (`core.ts:466-470`) and `SummaryService.show` (via `#opened`, `core.ts:1053`) read `this.usage`, which is assigned at `core.ts:495`, after both; `agents.homes` binds wait on `#homesDiscovered` because `bind` runs its function at once, before discovery (`core.ts:334-336`). The dependency graph, from the constructor (`[]` = through a lambda, `*` = property set after construction, `†` = reads a field assigned later):

```
panes         ← settings, windowTypes, store
data          ← settings                      views ← –        scheduler ← –
activity      ← data, views, scheduler, [panes]*
sessions      ← views, data, scheduler
agents        ← panes, store, settings, transcripts, activity
paneOutput    ← data, panes, activity, [agents]
homes         ← store.db, settings
notifications ← panes, agents, settings, [ai, naming via #writeNotice], [panes, windows]*
timers        ← windows, notifications        commands ← panes, data
resources     ← panes, [#subscribers]         workspaces ← store, checkout
windows       ← panes, store, windowTypes, settings
ai            ← settings, secrets, [data]
naming        ← [ai, settings, agents, activity]
summaries     ← [ai, agents, activity, data, transcripts, windows, workspaces, notifications, usage†]
journal       ← store.db, activity, data, sessions, workspaces, agents, ai, scheduler
magic         ← windows, settings, ai, notifications, workspaces, widgetTokens, [#broadcast, #previewer, #libraryChanged, #subscribers]
actions       ← panes, store.db, [data, ai, settings, windows, agents, workspaces, usage†]
usage         ← settings                      remote ← store, settings, [data, serve, #broadcast]
```

Among services there is no import cycle; every cycle goes through `Core`: `magic → Core.#libraryChanged → Core.#widgets → magic.library()`, `summaries → Core.#opened → usage`, `notifications → Core.#writeNotice → ai, naming`, `actions → Core → panes, usage`. Because `Core` reaches into all 24 and 11 of them reach back, Core plus those 11 are one strongly connected component.

**Proposal.** One `CoreContext` interface in `packages/core/src/context.ts` naming the shared services and the two cross-cutting functions (`broadcast`, `record`), built once in the constructor in dependency order. Each service declares the slice it needs with `Pick<CoreContext, …>`, so its dependencies are visible in its signature and checkable by tooling:

```ts
export interface CoreContext {
  settings: SettingsService; store: Store; data: DataService; scheduler: Scheduler;
  panes: PaneManager; agents: AgentTracker; windows: WindowManager; workspaces: WorkspaceManager;
  ai: AiService; notifications: NotificationCenter; usage: UsageStats;
  broadcast(e: CoreEvent): void; watched(): boolean;
}
class SummaryService { constructor(ctx: Pick<CoreContext, "ai" | "agents" | "data" | "windows" | "workspaces" | "notifications" | "usage">, o: { dir: string | null }) }
```

Lambdas stay only where they adapt (the `onCall` recorder, `transcript: (a) => conversationOf(...)`). The two `workspaceOf` property injections disappear because `ctx.windows` exists by the time anyone asks. The `†` cases disappear because the context is built before the services that read it. Tests build a context with fakes (the `fakeFactory()` pattern already exists for terminals). Prior art: VS Code's constructor-injected services with identifiers (00-research §10); keep it a plain object, not a container. This is also what AR1-03-01's slices receive.

**Success criteria.**

- [ ] `packages/core/src/context.ts` exists and every service in the graph above takes `Pick<CoreContext, …>` (or nothing) instead of a bag of closures into `Core`
- [ ] `grep -c "=>" core.ts` constructor region under 25, and `grep -n "workspaceOf =" core.ts` returns nothing
- [ ] No lambda in the constructor reads a `this.*` field assigned on a later line (a test constructs `Core` with `usage` stubbed to throw and calls `actions.run`/`agent.summarize` paths)
- [ ] `dependency-cruiser` (00-research §9) or a small script lists services → context slices with no edge into `core.ts`
- [ ] `SummaryService`, `ActionsService`, `AgentNaming` and `JournalService` each have a test that constructs them with a fake context and no `Core`

### AR1-03-03 · Give handlers the connection and delete `#afterCall`

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/core.ts:1375-1422`, `packages/core/src/core.ts:631`, `packages/core/src/core.ts:801`, `packages/core/src/core.ts:835-836`, `packages/core/src/core.ts:878`, `packages/core/src/core.ts:1334-1337`

**Problem.** Handlers take `params` only, so the eleven methods that depend on who is calling (`pane.fitOverride`, `pane.write` from a remote, `fs.watch`/`fs.unwatch`, `data.subscribe`/`subscribeView`/`unsubscribe`, `window.follow`, `magic.previewer`, `events.subscribe`, `remote.bootstrap`) are handled twice: a stub in the map ("Connection-aware; handled in serve", some returning `null`) and a 48-line `if/else` chain in `#afterCall` keyed on method-name strings that casts `params` and `result` back from `unknown`. `#receive` special-cases `pane.fitOverride` before dispatch. The per-connection state lives in seven maps on `Core` (`#subscribers`, `#connWatches`, `#dataSubs`, `#dataPending`, `#viewSubs`, `#viewPending`, `#follows`, `#previewers`). In-process callers (`core.call`) get the stub behaviour, which differs from the socket's.

**Evidence.** `core.ts:1375-1422`: nine `method ===` comparisons with `params.x as string` casts; `core.ts:631` and `core.ts:1334-1337`: `pane.fitOverride` dispatched in two places; `core.ts:801`, `core.ts:878`, `core.ts:696`: handlers whose body is `() => null`; `core.ts:1295-1311`: `serve().closed` clears the seven maps by hand; the JSON-RPC event line is built in four places (`core.ts:1449`, `1477`, `1541`, `1548`).

**Proposal.** Handlers get a second argument, `call: CallContext { conn: Connection; access: RemoteScope | "local"; deviceId: string | null }` (in-process calls pass a `local` context). The connection-aware methods become ordinary handlers that register with a `Subscriptions` class (`packages/core/src/subscriptions.ts`) owning the seven maps, the two 50 ms flushers (`#dataChanged`, `#viewChanged`, `#viewReset`) and `closed(conn)`. `#afterCall` and the `fitOverride` special case are deleted; one `sendEvent(conn, event)` builds the line. This is the shape AR1-03-01's slices need, and it makes the policy check (`checkRemoteCall`) a wrapper around dispatch rather than a branch inside `#receive`.

**Success criteria.**

- [ ] `grep -n "afterCall\|method === \"" packages/core/src/core.ts` returns nothing
- [ ] No handler in the map has the body `() => null` as a placeholder for connection-aware work
- [ ] `packages/core/src/subscriptions.ts` exists with its own test covering `data.subscribe` fan-out, `view.changed` reset and cleanup on close (today `data-subscriptions.test.ts` drives these through a `Core`)
- [ ] `core.call("fs.watch", …)` in-process and over the socket behave the same (watch released on close)
- [ ] `grep -c 'method: "event"' packages/core/src/core.ts` ≤ 1

### AR1-03-04 · Let services declare their own startup jobs

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/core.ts:537-574`, `packages/core/src/core.ts:977-998`, `packages/core/src/core.ts:546-553`

**Problem.** `Core.start()` knows the internals of six services to queue eleven startup jobs: `this.data.store.ensureIndexes()`, `this.store.db.exec("DROP TABLE IF EXISTS agent_events; …")`, `this.data.importLegacy(this.store.db)`, `this.#searchView.warm()`, `indexCommandOutput(this.data, s)`, the workspaces check timer. The transcript reader's whole lifecycle (`#restartSearch`, `#ingest`, `#searchSwap`, `#searchGen`, `NO_SEARCH`) is a service implemented as five fields and a method on `Core`. A service that gains a startup job edits `start()`; a service that needs a periodic timer (`#homesTimer`, `#workspacesTimer`) puts it on `Core` and remembers to clear it in `close()`. docs/34 says "startup jobs owned by services" is the direction; the code has the scheduler but not the ownership.

**Evidence.** `core.ts:537-574`: 11 `s.startup(...)` calls, 9 guarded by `o.stateDir`, three reaching two levels deep (`this.data.store.ensureIndexes`, `this.store.db.exec`, `this.journal.store`). `core.ts:546-553`: the `legacy` job drops four tables and removes three files on *every* launch, forever, because nothing records that it ran. `core.ts:977-998` plus fields at `core.ts:242`, `249-250`: the ingest lifecycle on `Core`. Timers owned by `Core`: `#homesTimer`, `#workspacesTimer`, `#sockCheck`, `#libraryTimer`, `#dataFlush`, `#viewFlush`.

**Proposal.** A small lifecycle protocol: services that have startup work implement `startup(s: Scheduler): void` and queue their own jobs with their own labels; `Core.start()` becomes an ordered list of services (`[data, legacy, activity, sessions, ingest, search, commands, homes, journal, retention, workspaces]`) and nothing else, so the order stays explicit while the content moves out. `#restartSearch` and friends become `TranscriptIngestService` in `data/sources/` with `startup()`, `close()` and a `settings.bind`. The `legacy` job records completion in `meta` (or is folded into AR1-03-05's migrations) so it runs once. Services that own timers own their `close()`. Prior art: VS Code lifecycle phases, where each contribution registers for the phase it needs (docs/34 cites it).

**Success criteria.**

- [ ] `Core.start()` is under 25 lines and contains no `this.*.store`, `this.store.db` or `fs.rmSync` calls
- [ ] `packages/core/src/data/sources/ingest-service.ts` (or equivalent) owns `#ingest`, `#searchSwap`, `#searchGen` and the `transcripts` startup job; `core.ts` has no field named `#ingest`
- [ ] The `legacy` import runs once: a second `Core` on the same `cmd.sqlite` logs no "Importing older data" job (test with a temp state dir)
- [ ] Every `setInterval` in `packages/core/src` is cleared by the class that created it (grep `setInterval` and check the owner's `close`/`dispose`)
- [ ] `core.startup` still reports the same job ids and labels (the footer copy does not change)

### AR1-03-05 · Version `cmd.sqlite` and register its tables in one place

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/store.ts:29-94`, `packages/core/src/store.ts:109-112`, `packages/core/src/agents/homes.ts`, `packages/core/src/journal/store.ts`, `packages/core/src/actions/service.ts`, `packages/core/src/actions/describe.ts`, `packages/core/src/core.ts:546-553`

**Problem.** `cmd.sqlite` has no schema version. Its tables are created by `CREATE TABLE IF NOT EXISTS` in `Store` plus four other files that take `store.db` ("for services that keep their own tables in the same file", `store.ts:109`), and migrations are ad hoc: `#renameSpaces()` inspects `sqlite_master` on every open, `start()` drops legacy tables on every launch, `WorkspaceManager` strips a `hue` field in memory (`workspaces/manager.ts:34`). The decoders in `stored.ts` make reading old *rows* safe, but a *table* change (a new column, a renamed index, a split) has no place to go, and three files open SQLite three ways. By contrast `views.sqlite` has the right pattern: `ViewsStore.ensure(name, version, tables, create)` rebuilds a view when its version changes.

**Evidence.** `grep -rn user_version packages/core/src` → only the SQLite viewer reading a foreign file. `CREATE TABLE` in `cmd.sqlite` from five files: `store.ts`, `agents/homes.ts`, `journal/store.ts`, `actions/service.ts`, `actions/describe.ts`. Three `new DatabaseSync(...)` with different busy timeouts: 2,000 ms (`store.ts:31`), 5,000 ms (`data/store.ts:84`, `data/views/views.ts:20`), each repeating the WAL/synchronous pragmas. `core.ts:548`, `550`: `DROP TABLE IF EXISTS …` twice per launch for the life of the install. docs/11 says "No backwards compatibility: the store schema and `ui_state` keys change freely", which was true for a prototype and is no longer: `#renameSpaces` exists because people had data.

**Proposal.** (1) One `openDatabase(file, { timeoutMs })` in `packages/core/src/sqlite/open.ts` that applies `journal_mode=WAL`, `synchronous=NORMAL` and the busy timeout, used by all three stores. (2) `Store` keeps `PRAGMA user_version` and an ordered array of migrations (`[{ v: 1, up: renameSpaces }, { v: 2, up: dropLegacyTables }, …]`) run in one transaction at open; the `legacy` startup job becomes migration 2 and runs once. (3) Services register their tables through `store.ensure(name, version, sql)` (the `ViewsStore.ensure` shape, `data/views/views.ts:54`) instead of raw `store.db.exec`, so the schema of the file is enumerable from one registry and a bumped version can drop and recreate a derived table (the actions description cache, agent homes). `store.db` stays available for queries but no longer for DDL. Prior art: `ViewsStore.ensure` in this codebase; `node:sqlite` is the driver already (00-research §4), no new dependency.

**Success criteria.**

- [ ] `grep -rn "new DatabaseSync(" packages/core/src` returns only `sqlite/open.ts` and the viewer's `worker.ts`
- [ ] `grep -rln "CREATE TABLE" packages/core/src` lists `store.ts` (migrations) and `data/` only; `homes.ts`, `journal/store.ts`, `actions/*.ts` call `store.ensure(...)`
- [ ] A test opens a fixture `cmd.sqlite` with a `spaces` table and `user_version = 0`, constructs `Store`, and finds `workspaces`, no `agent_events`, `user_version = <latest>`; opening it again runs no migration (assert on a counter or log)
- [ ] `Core.start()` has no `legacy` job and no `DROP TABLE`
- [ ] `docs/11-workspaces.md` "No backwards compatibility" note is replaced by a line pointing at the migration list

### AR1-03-06 · Give RPC errors codes and stop dropping malformed requests silently

- **Status:** open
- **Severity:** medium
- **Effort:** S
- **Where:** `packages/core/src/core.ts:1313-1358`, `packages/core/src/core.ts:1179-1183`, `packages/protocol/src/rpc.ts`

**Problem.** Every expected failure reaches the client as `{ code: -32000, message }`, so the CLI and renderer can only string-match (`/no such agent/` in `core.test.ts:103`) to tell "not found" from "bad params" from "not available right now" (transcripts off, AI not set up). An unknown method is also `-32000` rather than JSON-RPC's `-32601`; a line that is not JSON is dropped with no reply (`core.ts:1318-1320`), so a client with a framing bug waits forever; a request without an `id` (a notification) is answered with `id: undefined`. The crash-report split (`TypeError` = bug) is good but hinges on the error class, so a handler that wraps an error in `new Error(...)` hides a bug and one that throws a `RangeError` for user input files a false crash.

**Evidence.** `grep -rn "32000\|32001" apps packages/cli packages/protocol` → nothing: no client reads the code. `core.ts:1356`: one code for all handler errors; `core.ts:1181`: `unknown method` thrown as a plain `Error`; `core.ts:1318-1320`: `catch { return; }` on parse failure. `recordCrash` is called from two places in `core.ts` and two in `terminals/remote.ts`, all keyed on error class.

**Proposal.** `RpcError` in `packages/protocol/src/rpc.ts` with a small closed set of codes (`notFound`, `invalidParams`, `unavailable`, `denied`, `conflict`) mapped to JSON-RPC numbers, plus the standard `-32700` parse, `-32600` invalid request and `-32601` method-not-found replies in `#receive`. Handlers throw `new RpcError("notFound", "no such agent")`; anything else that is not an `RpcError` is a bug and is reported (simpler and stricter than the three-class test). The CLI prints by code; the renderer can show "Set up AI" for `unavailable` without parsing prose. Keep the messages in the copywriting voice.

**Success criteria.**

- [ ] `RpcError` exists in `@cmd/protocol` and `#receive` maps it; a non-`RpcError` thrown by a handler is logged as an error and filed with `recordCrash`
- [ ] A test sends `not json\n`, `{"jsonrpc":"2.0","id":1,"method":"nope"}` and `{"jsonrpc":"2.0","method":"core.hello"}` (no id) and receives `-32700`, `-32601` and no reply respectively
- [ ] `agent.kill` on an unknown id returns code `notFound`; `search.reindex` with transcripts off returns `unavailable`
- [ ] `packages/cli` prints errors by code in at least `agent`, `search` and `settings` commands, and no test matches an error by regex on its message where a code exists

### AR1-03-07 · Mark the unmarked callbacks and move the last one-statement startup job off the thread

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/scheduler.ts:84-121`, `packages/core/src/core.ts:544`, `packages/core/src/core.ts:486-509`, `docs/34-startup-scheduler.md`

**Problem.** The scheduler is the right mechanism for work that can be written as steps (views, ingest, journal, command indexing: 7 files call `yield()`), and the worker split is principled (lesson 5). Two gaps remain. First, `mark()` is called only by `#receive` and by startup jobs, so a stall inside a pane `output`/`updated` listener, a hook-file watcher, a settings reload or any `setInterval` is blamed on "(idle: timers, I/O callbacks)", which docs/34 lesson 2 says is the blame that misleads. Second, the `indexes` job (`DataStore.ensureIndexes()`) is one `CREATE INDEX` per new index on the whole log, about 2 s each per version on a 1.6 GB log, still on the main thread; docs/34 lists it first under "Not built". A small drift: docs/34 documents `yield(label)` but `Pacer.yield()` takes no label.

**Evidence.** `grep -rn "\.mark(" packages/core/src` → `core.ts:1331` (requests) and `scheduler.ts:135` (startup jobs) only. `grep -rn "yield()" packages/core/src` → `commands.ts` (2), `data/sources/ingest.ts`, `data/views/activity.ts`, `data/views/sessions.ts` (2), `journal/service.ts`. Workers: `data/checkpoint-worker.ts`, `data/stats-worker.ts`, `data/sources/ingest-worker.ts`, `data/views/vocab-worker.ts`, plus the SQLite reader process. `core.ts:544`: `s.startup("indexes", …, () => this.data.store.ensureIndexes())` with the comment "a new one reads the whole log (seconds)".

**Proposal.** (1) A `scheduler.wrap(name, fn)` helper used where the core subscribes to high-rate emitters (`panes.on("output"|"updated")`, `agents.on("updated")`, `data.on("recorded")`, the hook watcher, `settings.on("updated")`) and for every timer the core owns, so blame covers the remaining 90 % of callbacks; the cost is one closure per event. (2) Build new indexes in a worker on its own connection: because `CREATE INDEX` takes the write lock and `node:sqlite`'s busy handler blocks the calling thread, the core must not write while it runs; the `DataService` already defers (`deferIndexes`) and batches, so queue `record()` into memory until the worker reports done, with a cap that falls back to the inline build. Measure with `scripts/perf/stress-core.mjs` before and after. (3) Either add the label to `Pacer.yield` or fix docs/34. Keep the budget numbers; they were tuned.

**Success criteria.**

- [ ] On the stress harness's first-launch phase, no `[lag]` line is blamed on `(idle: timers, I/O callbacks)` for a block the core itself caused (pane output, hooks, settings)
- [ ] `startup: indexes` no longer appears in `core.info.stalls` on a first launch over a log that needs a new index; the index exists afterwards (`sqlite_master`)
- [ ] `scheduler.test.ts` gains a case for `wrap()` blaming a wrapped callback
- [ ] docs/34 and `Pacer` agree on `yield`'s signature

### AR1-03-08 · Keep API keys in the Keychain, or at least check the file they are in

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/secrets.ts:1-5`, `packages/core/src/secrets.ts:59-65`, `packages/core/src/secrets.ts:13-27`

**Problem.** Anthropic and OpenAI keys are stored as plaintext JSON in `$CMD_HOME/secrets.json`, mode 0600, with a comment that this keeps them "out of settings.json". That is the right first step, and values never leave the core (clients see `…abcd`). But any process running as the user reads the file (the threat the Keychain's per-app ACL addresses), a Time Machine or iCloud Drive copy of `Application Support` carries it in clear, and the mode is only set when cmd writes it: a file restored or copied with 0644 is read without complaint. 00-research §8: prefer the platform's secret store.

**Evidence.** `grep -rn safeStorage apps packages` → nothing. `secrets.ts:62-63` sets mode on write; `readSecrets()` (`secrets.ts:13`) never stats. `cmd magic`'s prompt lab reads the file directly (`secrets.ts:12`), so two code paths read it.

**Proposal.** The core is Node, not Electron, so `safeStorage` is not available to it directly. Two routes: (a) the core stores values in the login Keychain through `/usr/bin/security add-generic-password -s cmd -a <key> -U` and reads them with `find-generic-password -w`, keeping `secrets.json` as the fallback on Windows and in tests (`secretsPath: null`); (b) the app encrypts with `safeStorage` and hands the core a decrypted blob at connect, which puts a secret on the socket and makes the CLI's `cmd ai connect` depend on the app. Recommend (a): one process owns the keys, as today. In either case, on load `stat` the file and refuse (log, `status()` says `unreadable: permissions`) when it is readable by group or others, and have the prompt lab go through `SecretsService`.

**Success criteria.**

- [ ] On macOS a key set with `secrets.set` is found by `security find-generic-password -s cmd -a ANTHROPIC_API_KEY` and `secrets.json` does not contain it
- [ ] A `secrets.json` with mode 0644 is not read: `secrets.status()` reports it and `core.log` says why
- [ ] `grep -rn "readSecrets(" packages` shows one caller (`SecretsService`)
- [ ] `secrets.test.ts` (new) covers set, remove, migrate-from-file and the permission check with a temp dir

### AR1-03-09 · Test `Store` and `TimerAlarms` directly

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `packages/core/src/store.ts`, `packages/core/src/timers.ts`, `packages/core/test/`

**Problem.** `core.test.ts` is an honest integration test (real PTYs, real socket, 11 tests in 3.8 s), and most services have their own test. Two in scope have none: `Store` is exercised only through `workspaces`, `windows`, `restore` and `image` tests, so `claim()` (the copied-database guard that decides whether terminals are resurrected), `#renameSpaces()` and `deleteUiStateOf()`'s suffix match are untested on their own; `TimerAlarms` (a timer ringing after sleep, the `MAX_WAIT` re-arm, a window removed before it fires) has no test at all.

**Evidence.** `ls packages/core/test | grep -c "store.test\|timers.test"` → 0; `grep -rln "new Store(" packages/core/test` → five files, none asserting on `Store` behaviour itself; `grep -rln TimerAlarms packages/core/test` → none. `new Core(` appears 33 times in 20 test files: the default way to test anything is to build the whole core.

**Proposal.** `store.test.ts`: `claim()` returns the old path once after a copy and `null` after; `#renameSpaces` on a fixture with `spaces` and `"spaceId":` docs; `deleteUiStateOf("abc")` leaves `x.abcd`; `transaction()` rolls back. `timers.test.ts` with `vi.useFakeTimers()`: rings once, re-arms past `MAX_WAIT`, says "Ended at" when late, clears on `removed`. Both are under an hour each and stop AR1-03-05's migrations from shipping blind.

**Success criteria.**

- [ ] `packages/core/test/store.test.ts` exists with the four cases above and passes
- [ ] `packages/core/test/timers.test.ts` exists with the four cases above and passes under fake timers in under a second
- [ ] `pnpm vitest run packages/core/test/core.test.ts` still passes in under 10 s

### AR1-03-10 · Sample resources and tick widgets only for connections that show something

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `packages/core/src/core.ts:341`, `packages/core/src/core.ts:439`, `packages/core/src/resources.ts:46-47`

**Problem.** `ResourceMonitor` and Magic refreshes run "while a UI is connected", implemented as `this.#subscribers.size > 0`. Every connection that called `events.subscribe` counts, including Electron main's long-lived typed subscriptions (docs/14 "four long-lived main-process connections") and the Settings window, so with the app running and no window open (normal on macOS) the process table is still scanned every 2 s and widgets still refresh. docs/14 win #3 claims the idle cost is zero "until a UI connects"; that holds only when the app is quit.

**Evidence.** `core.ts:341`: `() => this.#subscribers.size > 0`; `core.ts:439`: the same lambda for `magic.watched`; `core.ts:1415`: a typed subscription (`types: [...]`) registers like a full one. `resources.ts:46`: the tick asks `watched()` and otherwise samples every pane's tree.

**Proposal.** `watched()` counts connections that follow windows (`#follows` non-empty, set by `window.follow`) or whose subscription wants `pane.updated`. Main's connections subscribe with `types` and follow nothing, so they stop counting. Falls out of AR1-03-03's `Subscriptions` class as `subscriptions.anyoneWatching()`.

**Success criteria.**

- [ ] A test subscribes with `types: ["workspace.show"]` only and asserts `resources.tick()` takes no sample and `magic` does not refresh
- [ ] A test that calls `window.follow` sees samples resume within one interval
- [ ] docs/14's idle claim is re-measured with the app open and no window, and the number recorded in its Wins table

## Course corrections

1. **Build the context, then split the file** (AR1-03-02 → AR1-03-01 → AR1-03-03). The three together turn `core.ts` from the place every feature edits into a composition root under 500 lines, make every service's dependencies a type, and give handlers the connection they already need. This is what the structure, extensibility and code-health scores rest on.
2. **Let services own their lifecycle** (AR1-03-04): startup jobs, timers and the transcript reader move out of `Core.start()` and `close()`; the `legacy` job runs once.
3. **Version `cmd.sqlite`** (AR1-03-05) with one open helper and one table registry, before the next table change forces another `#renameSpaces`.
4. **Finish the scheduler's coverage** (AR1-03-07): mark the callbacks the core itself installs and take the last 2 s block off the thread, so the stall log stays the tool docs/34 made it.
5. **Error codes** (AR1-03-06) are cheap and unblock better CLI and UI copy.

## Quick wins

- AR1-03-06 (error codes, S)
- AR1-03-09 (`Store` and `TimerAlarms` tests, S)
- AR1-03-10 (`watched()` predicate, S)
- The `agents.close()` duplicate in `close()` (part of AR1-03-01, a one-line fix that can land alone)
- The `yield(label)` doc drift in docs/34 (part of AR1-03-07)
