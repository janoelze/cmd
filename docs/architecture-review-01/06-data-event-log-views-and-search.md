# 06 Data: event log, views and search

**Score: 6/10** · reviewed 2026-10-10 against commit ddb7832 · scope: `packages/core/src/data/**`, `packages/core/src/search/**`, `redact.ts`, `protocol/src/events.ts`, the `data.*`/`search.*` handlers in `core.ts`, `scripts/{perf,data}`

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 6/10 | Store, policy service and views are cleanly separated, but each view runs its own ad hoc loop and the "disposable" views file holds ingest state |
| Correctness & robustness | 5/10 | Seqs are reused after a delete, the sessions view can miss events after a crash, and forget leaves entities behind |
| Performance | 6/10 | Ingest, rebuilds and checkpoints are measured and paced (docs/34), but search runs on the core thread: 0.3–5 s for a common word |
| Security | 5/10 | Redaction misses secrets held under a key name in structured payloads. Widget queries ignore the policy that docs/28 §4 describes. Forget doesn't scrub file pages |
| Testability & tests | 6/10 | 80 tests across 7 files pass in 2 s; no ingest, crash/resume or fold-vs-rebuild test |
| Extensibility | 6/10 | The class table and the type map make a new event cheap, but `EVENT_V` has no upcasters and the events file has no migrations |
| Code health | 6/10 | Short, well-commented files; 130 lines of dead parsers, a perf script importing a deleted module, schema constant defined twice |

## What this system is

Everything that happens in cmd is recorded as an event in one SQLite log, `data/events.sqlite`. Each event has one envelope (`seq`, a stable `id`, `at`/`until`, `type`+`v`, the identities it belongs to) and a JSONB `data` payload. Content larger than the row goes to zstd blobs, content-addressed and reference-counted. Derived tables live in `data/views.sqlite`. This is docs/28-data-plan.md, with the phases recorded in its status line. App state (panes, windows, workspaces) stays in `cmd.sqlite` (`store.ts`, 255 lines; see doc 03).

- **Store and service.** `data/store.ts` (484 lines) is `DataStore`: an idempotent upsert by id (`record`) that skips unchanged rows, blobs, entities and links, the query→SQL translation (`conditions`) and a contentless FTS5 table (`events_fts`, rowid = seq). Its schema is in `schema.ts` (98 lines). `data/service.ts` (388 lines) is `DataService`, the front door. It checks the class switch (`DATA_CLASSES` in `protocol/src/events.ts`, 314 lines), the exclude rules (`exclude.ts`) and the forgotten set. Then it redacts (`redact.ts`, 95 lines), applies the class cap, records, notes entities and emits `recorded`/`batch`/`removed`. Retention runs in batches 30 s after start and then every 6 h. WAL checkpoints run on a worker (`checkpoint-worker.ts`). Stats are read on a worker too (`stats-worker.ts`).
- **Recorders.** `recorders.ts`, `describe.ts`, `sources/pane-output.ts` and the hook path through `views/activity.ts`. Transcripts are read by a worker (`sources/ingest-worker.ts`, 155 lines) that walks the agent folders, reads each file from its last offset (`transcripts.ts`, 368 lines: one Claude/Codex JSONL line = one event), redacts, and posts chunks of at most 4 MB or 500 events. Each chunk is acked. `sources/ingest.ts` (258 lines) records them in self-sizing steps on the core thread and feeds the sessions view.
- **Views.** `views/views.ts` (79 lines) keeps `view_versions`, and a changed version drops and rebuilds a view. There are three views. `turns` (`activity.ts`, 357 lines) replays hook events through the reducer. `sessions` (`sessions.ts`, 332 lines) folds transcript events. `transcript_files` holds the ingest offsets. Search (`views/search.ts`, 305 lines) ranks sessions by bm25 with weights from docs/33. It gets typo tolerance from an `fts5vocab` read on a worker (`vocab-worker.ts`). File search (`search/files.ts`) shells out to ripgrep.
- **Subscriptions.** `data.subscribe` stores a query per connection. Each recorded event is matched in memory (`match.ts`) and sent as `data.changed`, debounced 50 ms (`core.ts:1456-1484`).

Measured on a copy of the author's release log (1.92 GB, 618,609 events since 2026-01-09; 198,711 blobs, 1,586 MB raw → 655 MB stored): 173k events and about 346 MB (156 MB inline, 190 MB of blobs) carry a time in the last 7 days. That is about 50 MB a day.

## What is good

- **Measured, then fixed.** docs/34's stress harness found the six stalls and fixed each (unchanged rows not rewritten, checkpoints on a worker, seq-range rebuild steps, chunked worker messages). The `pace.mark`/`yield` names make stalls blame themselves. The ranking in docs/33 is tuned against 16 known-item queries (MRR 0.70 → 0.84). Other systems should copy this loop.
- **Idempotent by source id** (`store.ts:172-210`). Re-reading a transcript or an archived copy writes nothing, so a full re-read is safe. That is what makes `reindex` and the version-2 `transcript_files` bump cheap to reason about.
- **One class table** (`DATA_CLASSES`). Retention, the on/off switch, the content cap, `cmd data explain` and the Settings page all read the same row. Adding a kind is a type plus a class.
- **Workers with their own read-only connection** for anything that reads the whole log: stats, vocabulary and checkpoints. The core stays the single writer.
- **Redaction is tested against real data** (the header of `redact.ts` lists the false positives the first version had), and the ingest worker redacts off the core thread.
- **Indexes match the queries.** I ran EXPLAIN on the hot queries over the 1.9 GB copy. `#startOf` (22 ms over 3 days), `ActivityView.events` (3 ms, `events_agent`), replay's `pane.activity` (8 ms), retention's prefix delete (47 ms, covering `events_type_at`) and `conversationOf` (`events_session`) all use an index. The sessions rebuild steps by rowid range. No hot query scans the table.

## Issues

### AR1-06-01 · Stop reusing `seq` after a delete

- **Status:** done (d6ccec51)
- **Severity:** high
- **Effort:** M
- **Where:** `packages/core/src/data/schema.ts:30`, `packages/core/src/data/store.ts:226-243`, `packages/core/src/data/service.ts:279-288`
- **Depends on:** AR1-06-03 (the table rebuild is a migration)

**Problem.** `seq INTEGER PRIMARY KEY` without `AUTOINCREMENT` makes SQLite hand out `MAX(rowid)+1`. When the newest events are deleted, which is what `data.forget` of a live session usually does, the next event gets their seq again. `seq` is documented as "identity for cursors and subscriptions" (`events.ts:131`). Cursors depend on it: `after` paging in the CLI and widgets, `turns.last_seq`, and a client that remembers the last seq it saw. A cursor past the reused value silently skips the new event.

**Evidence.** I recorded `a` (seq 1) and `b` (seq 2, session s1) in an in-memory `DataService`, then ran `forget({ sessionId: "s1" })`. `query({ after: 1 })` returns `data:forget:… seq 2`. A subscriber that had seen `b` at seq 2 never sees the forget record, nor anything else that takes seq 2. The release log's `MAX(seq)` equals `COUNT(*)` (618,609), so nothing has been deleted yet. The first year of retention (2027-01) and every `forget` will start deleting rows.

**Proposal.** Make the seq monotonic forever. Two options:
- (a) Rebuild `events` with `seq INTEGER PRIMARY KEY AUTOINCREMENT` in the schema-2 migration (AR1-06-03). This is one `INSERT INTO events2 SELECT …`, about 1 minute on 1.9 GB, run on a startup job with progress.
- (b) Without a table rebuild: keep a high-water mark `meta('seq.next')`. `delete()` raises it to `MAX(seq)+1` inside its transaction, and `record()` inserts with an explicit `seq` while the mark is above `MAX(seq)`.

Prefer (a): it is what docs/28 §2 promised ("monotonic: identity, order, subscription cursor"), and SQLite enforces it with no code path to forget.

**Success criteria.**
- [ ] A test in `data-forget.test.ts` records a, b, forgets b's session, records c and asserts `c.seq > b.seq`.
- [ ] The same test with `prune()` deleting the newest rows passes.
- [ ] `sqlite_sequence` has a row for `events` in a migrated log, or `meta('seq.next')` exists.
- [ ] `grep -n "INTEGER PRIMARY KEY," packages/core/src/data/schema.ts` returns no line for `events.seq`.

### AR1-06-02 · Drive views from a cursor on the log, not from in-process callbacks

- **Status:** open
- **Severity:** high
- **Effort:** L
- **Where:** `packages/core/src/data/views/views.ts:24,67-74`, `packages/core/src/data/sources/ingest.ts:196-206`, `packages/core/src/data/service.ts:186-190`, `packages/core/src/data/views/sessions.ts:119-151`, `packages/core/src/core.ts:303-306`

**Problem.** Facts and views live in two files with no shared transaction, and the views follow the log only through `EventEmitter` calls in the same process. The ingest commits a chunk to `events.sqlite` (`recordBatch`). It then applies the chunk to `sessions` and saves the file offset, both in `views.sqlite`. If the core is stopped or crashes between the two commits, the next start re-reads the chunk. `recordBatch` then returns only rows that were `inserted`, so those events are never applied. The session keeps a wrong message count, a missing title or a missing first prompt until something forces a full rebuild. `view_versions.cursor` exists for this, but `setCursor` has no caller. Removal goes the other way: any `forget` or `applyRules` that touches `transcript.*` rebuilds the whole sessions view, and one touching `agent.*` rebuilds all turns. Forgetting one session re-reads every transcript event in the log. Finally, `transcript_files` (ingest offsets) and the sessions' `path`/`env` live in a file whose header says "nothing in this file is the only copy of anything". Deleting it costs a full re-read of every transcript, not a rebuild.

**Evidence.** `grep -rn "setCursor" packages/core/src` finds only the definition (`views.ts:72`). `service.ts:188`: `if (!inserted) continue; // read before … not news to views or subscribers`. `ingest.ts:198-205` makes three separate commits: events, sessions, offset. `core.ts:303-306` rebuilds whole views on any `removed`. docs/28 §3 specified incremental views that "consume from a cursor in `view_versions(name, version, cursor_seq)`" and receive tombstones. docs/34 measures a full sessions rebuild at 1.6 s on 1.6 GB, which a single forget now pays.

**Proposal.** Build the `View` interface from docs/28 §3 once, in `views/view.ts`: `{ name, version, inputs, apply(events), remove(tombstones), tables }`, plus a runner. After each commit, the runner reads `events WHERE seq > cursor AND type IN inputs` in pages. It applies them and sets the cursor in the same `views.sqlite` transaction. At startup it catches up from the cursor. This replaces the `inserted` gate and the `onPrune`/`removed` callbacks: deletes write a tombstone row (`FLAG_TOMBSTONE` already exists, unused) that views consume like any input. `sessions`, `turns` and the vocabulary invalidation become three views on that runner. Move `transcript_files` into `events.sqlite` as ingest state, next to `entities('transcript-root')` where the learned roots already live. Prior art: Linear's sync IDs and VS Code's agent host (snapshot, then ordered actions after a cursor) in 00-research.md §4.

**Success criteria.**
- [ ] A test records a transcript chunk, skips the view apply (simulated crash), reopens both stores, and finds the sessions row correct after start-up catch-up.
- [ ] `view_versions.cursor` is non-zero for `sessions` and `turns` on a live log, and `setCursor` has a caller.
- [ ] `forget({ sessionId })` on a log with 10k sessions changes only that session's rows. A test asserts that the other rows' `updated` values are unchanged and that no `sessions rebuild` mark runs.
- [ ] `transcript_files` is no longer created in `views.sqlite`. Deleting `views.sqlite` reads no transcript file again (the ingest status shows 0 changed).

### AR1-06-03 · Give events.sqlite a migration path and the promised upcasters

- **Status:** done (d6ccec51)
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/data/schema.ts:7`, `packages/protocol/src/events.ts:5-15`, `packages/core/src/data/store.ts:81-115`, `packages/core/src/data/sources/ingest.ts:76`, `packages/core/src/core.ts:544-553`

**Problem.** The facts file has a schema version that nothing reads. `EVENTS_SCHEMA = 1` is defined twice (protocol and `schema.ts`). It is written to `meta('schema')` once and never compared. Changes so far have been ad hoc: `#renameSpaces` keyed on a column's existence, a view version bump that deletes facts (`transcript_files` v2 runs `delete({ types: ["transcript."], before: 1 })`), and drops of `cmd.sqlite` tables in `start()`. An older cmd opening a newer log isn't refused, which docs/28 §7 requires: an older build that expects `space_id` fails on its first insert. The protocol header tells contributors to "add an upcaster in core/src/data/upcast.ts". That file doesn't exist, every `EVENT_V` is 1, and no reader looks at `v`. The first payload change will have nowhere to go.

**Evidence.** `ls packages/core/src/data/upcast.ts` reports no such file. `grep -rn 'meta("schema")'` finds only the write at `store.ts:89`. `ensureIndexes` (`core.ts:544`) runs every `CREATE INDEX IF NOT EXISTS` on the core thread. It is a no-op when an index exists, but a new index reads the whole log there ("seconds", `schema.ts:9`). The release log still carries `events_space_at` and `space.*` rows, so it has never been migrated forward.

**Proposal.** Add `data/migrations.ts`: an ordered list `[{ to: 2, run(db) }, …]` run in one `BEGIN IMMEDIATE`. Copy the file aside first (`VACUUM INTO events.sqlite.bak-v1`), compare `meta('schema')` against the newest version, and refuse with a clear error when the file is newer than the code. Fold `#renameSpaces`, the AUTOINCREMENT rebuild (AR1-06-01) and any new index into numbered steps, so a new index costs its one build under a startup label instead of a check on every start. Keep one `EVENTS_SCHEMA`, in `schema.ts`. Add `upcast.ts` as `Record<type, ((data) => data)[]>`, applied in `toEvent` when `row.v < EVENT_V[type]`, plus a test that fails if an `EVENT_V` entry above 1 has no upcaster. View versions stay as they are, since views rebuild by design. See doc 03 (AR1-03-05) for the same treatment of `cmd.sqlite`.

**Success criteria.**
- [ ] `packages/core/src/data/migrations.ts` exists. A test opens a v1 fixture, migrates it to the newest version, and checks `meta('schema')`.
- [ ] Opening a file whose `meta('schema')` is above the code's version throws a named error, covered by a test.
- [ ] `grep -rn "EVENTS_SCHEMA = " packages` returns one line.
- [ ] `packages/core/src/data/upcast.ts` exists, and a test asserts every `EVENT_V[t] > 1` has `EVENT_V[t] - 1` upcasters.
- [ ] `ingest.ts` no longer deletes events when a view version changes.

### AR1-06-04 · Redact secrets held under a key name inside structured payloads

- **Status:** done (34d12c85)
- **Severity:** high
- **Effort:** S
- **Where:** `packages/core/src/redact.ts:81-90`, `packages/core/src/data/views/activity.ts:93-117`, `packages/core/src/data/sources/transcripts.ts:133-141`

**Outcome.** An `Authorization` value keeps its scheme (`Basic [redacted]`), as the text rule already did.

**Problem.** `redactDeep` walks a JSON value and redacts each string on its own. It never looks at the key the string sits under. The `NAMED` rule only fires when the name and the value are in the same string (`API_TOKEN=…`), so `{ "password": "correcthorsebattery" }` and `{ "env": { "API_TOKEN": "abcd1234efgh5678" } }` pass through untouched. That is the shape of hook payloads' `tool_input` and of transcript lines under 2 KB, which are kept whole in `data.message` (`INLINE_LINE`). Both go to the log and from there to models via the context builder. The same line over 2 KB is stored as a string blob, where `redact` does catch the secret. So one secret is redacted or kept depending on how long the line around it is.

**Evidence.** I ran `redactDeep({ tool_input: { env: { API_TOKEN: "abcd1234efgh5678" }, password: "correcthorsebattery" }, headers: { Authorization: "Basic dXNlcjpwYXNzd29yZDEyMzQ=" } })` against the module. It returned the input unchanged. `redact(JSON.stringify(sameObject))` returned `{"env":{"API_TOKEN":"[redacted]"},"password":"[redacted]"}`. `redact.test.ts` has 8 tests, and its one `redactDeep` case relies on a string-level pattern (`Bearer`, `ghp_`).

**Proposal.** Give `redactDeep` the key. When the key matches `SECRET_WORD` (anchored the same way as `NAMED`, so `author` and `tokenize` stay) and the value is a string of 8 or more characters that fails `PLACEHOLDER`, replace it with `[redacted]`. Recurse with the key into objects, so `env` maps work. Basic-auth header values also need a rule. Add one test per shape above, using real hook payload fixtures from `packages/core/test/fixtures`. The `redacted` flag then also covers this case.

**Success criteria.**
- [x] `redactDeep` of the three shapes in the evidence returns `[redacted]` for each value, with tests in `redact.test.ts`.
- [x] `redactDeep({ author: "Jan Oelze", maxOutputTokens: 4096, tokenize: "words" })` is unchanged (no new false positives).
- [x] A transcript line under 2 KB and the same line padded over 2 KB store the same redacted secret (test via `claudeLine` + `redactEvent`).

### AR1-06-05 · Enforce the widget data policy that docs/28 §4 describes

- **Status:** done (317c7afa)
- **Severity:** high
- **Effort:** S
- **Where:** `packages/core/src/data/widgets.ts:1-5,43-46`, `packages/core/src/core.ts:1361-1371`

**Problem.** The widgets socket lets a widget's `data.ts` query the whole log. That includes every workspace's transcripts with prompts and answers, hook payloads, command lines, page addresses and `ai.call` records. The file header says the query is answered "within the policy here", and the token carries `workspaceId` "which is all the policy needs". The only policy applied is `limit ≤ 1000`. Magic widgets are model-written code (see 00-research.md §7: MCP Apps and Zed scope what untrusted UI may read). docs/28 §4 specified "widgets: read-only, their workspace, no blobs unless declared".

**Evidence.** `widgetQuery` returns `{ ...q, limit: Math.min(q.limit ?? 200, 1000) }`. `#widgetCall` checks the token, then calls `this.data.query(widgetQuery(params.query))`, and the identity's `workspaceId` is never read. `grep -rn "policy.ts" packages/core/src/data` finds nothing.

**Proposal.** Write `data/policy.ts` as docs/28 §4 drew it, a table `client kind × type prefix → allow | deny | fields`. For widgets: force `workspaceId` from the token, allow a declared set of classes (default `git`, `notes`, `output` without the blob, `actions`), deny `transcripts`, `agents` and `ai` unless the widget's manifest declares them, and strip `data` down to declared fields. Enforce it in `widgetQuery`, so a widget can't widen it. The same table can later serve remote (today `never` for all `data.*`, which is correct).

**Success criteria.**
- [x] A test issues a token for workspace A. A widget query without `workspaceId`, or with B, returns only A's events.
- [x] A widget query for `types: ["transcript."]` without a declared capability returns an error or nothing (test).
- [x] `packages/core/src/data/policy.ts` exists, and `widgetQuery` takes the identity.

### AR1-06-06 · Take search off the core thread and stop joining every match

- **Status:** done (57caff75)
- **Severity:** high
- **Effort:** M
- **Where:** `packages/core/src/data/views/search.ts:100-126,134-139,195-209`, `packages/core/src/data/store.ts:334-343`

**Problem.** Session search and history search run synchronous SQL on the core thread, once per keystroke in the palette's `?` mode. Both join every FTS match to `events` before filtering by type and sorting by bm25, so the cost grows with how common the word is, not with the result size. History is the worst case. It wants a few hundred `command`/`browser.visit`/`file.open` rows but joins all transcript matches to find them. A prefix like "the" blocks the thread that forwards keystrokes to terminals. On top of that, `search()` may run a second, fuzzy round and decompress a blob per hit for snippets.

**Evidence.** Timings are from the 1.9 GB copy (sqlite3 3.51, cold run then warm). `#match` for `"test"*`: 378 ms cold, 69 ms warm. For `"the"*` (119,361 FTS rows; the FTS lookup alone takes 12 ms): 1,161 ms cold, 298 ms warm. `matches()` for history, `"the"*`: 76 rows in 4,956 ms cold and 625 ms warm. docs/34's watchdog flags anything over 100 ms as a stall.

**Proposal.** Two changes, both following patterns this folder already uses:
- (1) Answer `search.query` and `search.history` from a long-lived read-only search worker. It is the same shape as `vocab-worker.ts`, and with it the vocabulary lives in the worker and stops crossing threads. The core only forwards.
- (2) Make the FTS do the narrowing. Add a `kind` column to `events_fts` (`transcript`, `history`, `agent`, …). Query with `kind : history AND <expr>`, so FTS5 intersects doclists before any join. Configure the weights with `INSERT INTO events_fts(events_fts, rank) VALUES ('rank', 'bm25(3.0, 1.0)')` and take `ORDER BY rank LIMIT n` inside the FTS subquery. That subquery alone measured 190 ms warm against 298 ms for the join.

Rebuild the FTS once through `buildFts` (it exists).

**Success criteria.**
- [x] `grep -n "events_fts MATCH" packages/core/src/data/views/search.ts` returns nothing (the queries live in the worker module).
- [x] On the stress log (`scripts/perf/stress-core.mjs` plus a search phase typing "t", "th", "the"), core pings p95 stay under 20 ms and no `[lag]` line names search.
- [x] `search.history("the")` returns in under 100 ms warm on a ≥1.5 GB log, measured by a bench case in `scripts/perf/bench.ts search`.

### AR1-06-07 · Make forget complete: entities, file pages and subscribers

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/data/service.ts:279-298`, `packages/core/src/data/describe.ts:26-29`, `packages/core/src/data/schema.ts:22-25`, `packages/core/src/core.ts:303-306`
- **Depends on:** AR1-06-02 (tombstones)

**Problem.** `data.forget` deletes events and unreferenced blobs. It leaves the rest:
- **Entities and links.** The forgotten session's entity keeps its `title` and `firstPrompt` (written by `describeSession`), and its links (`in project`, `runs`) stay. `data.entities` and `cmd data entities` still show them.
- **File pages.** SQLite's `secure_delete` is off and `auto_vacuum` is 0, so the deleted rows' bytes stay in free pages until overwritten. The file never shrinks after prune or forget.
- **Subscribers.** Open subscriptions get no removal. `data.changed` only carries additions (`core.ts:1476`), so the Commands and Notifications widgets keep showing forgotten rows.
- **Re-reads.** A forget by time or by type is undone by the next `search.reindex` or a `transcript_files` bump, which reads the files again. Only forgotten sessions and projects are kept in the refused set.

**Evidence.** In-memory test: `describe("session", "s1", { firstPrompt: "my secret plan" })`, then `forget({ sessionId: "s1" })`, then `entityOf("session", "s1")` still returns `attrs: { firstPrompt: "my secret plan", title: "t" }`. On the release copy, `PRAGMA auto_vacuum` returns 0 and `grep -rni vacuum packages/core/src packages/cli/src` returns nothing. `data-forget.test.ts` (15 tests) checks events, blobs, views and refusal, but not entities.

**Proposal.**
- `forget` deletes the named entities and their links, plus `entities('pane'|'agent')` rows whose only link was the forgotten session.
- Set `PRAGMA secure_delete = FAST` on the events connection. Set `auto_vacuum = INCREMENTAL` in the migration (AR1-06-03, one `VACUUM`) and run `PRAGMA incremental_vacuum(N)` in retention's batches.
- Tombstones (AR1-06-02) give `data.changed { removed: seq[] }`.
- Keep a `forgotten-range` entity for time and type forgets, so re-reads respect them, the way sessions are refused today.

**Success criteria.**
- [ ] A test in `data-forget.test.ts` asserts `entityOf("session", id)` is null and `linksOf("session", id)` is empty after a forget.
- [ ] After forgetting a session with a unique 32-character marker in its text, the bytes of `events.sqlite` (after `wal_checkpoint(TRUNCATE)`) don't contain the marker (test with a temp file).
- [ ] A subscription test gets `removed` with the forgotten seqs.
- [ ] After `forget({ before: t, types: ["transcript."] })` followed by `reindex()`, no transcript event before `t` returns.

### AR1-06-08 · Record less: drop unread noise and stop storing tool output twice

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/data/sources/transcripts.ts:50-52,166`, `packages/core/src/data/views/activity.ts:93-117`, `packages/core/src/core.ts:656`, `apps/desktop/src/renderer/src/App.tsx:555`

**Problem.** docs/28 §11 estimated 2.2 GB a year and decided that noise line types "become counters or are skipped". The log now grows about 7–8 times faster than that estimate, and much of the growth is rows no code reads:
- **`transcript.other`.** 165,476 rows (27% of the log): Claude `attachment` (100,221), `permission-mode` (32,320), `file-history-snapshot` (13,587), `queue-operation` (10,103). They take 18 MB inline and 66 MB of blobs (263 MB raw).
- **`user.look`.** 4,515 rows in 7 days. Like `user.focus` and `user.command`, it is written and only ever read back generically.
- **`agent.hook`.** 96 MB in 7 days (66 MB inline, 30 MB blobs). Hook payloads carry the same `tool_input`/`tool_response` the transcript records as `transcript.tool_result`.

Disk, the WAL, retention and every full-log read (stats, rebuilds, FTS) pay for this.

**Evidence.** Queries on the release copy: last 7 days 172,888 events, 156 MB inline + 190 MB blobs (about 50 MB a day, so about 18 GB a year at this pace). `transcript.other` is broken down by `json_extract(data,'$.line')`. Every reader in the repo was grepped: for `user.look`, `user.focus`, `user.command`, `transcript.other` and `transcript.system`, no `types: [...]` query names them or a prefix of them. Only the generic `cmd data query` can return them.

**Proposal.**
- Extend `CLAUDE_NOISE` with `permission-mode`, `queue-operation` and `file-history-snapshot`. Keep `attachment` only as `{ type, chars }` with no blob, unless a reader appears.
- Store `agent.hook` payloads with `tool_response` cut to a short preview when a transcript source covers the agent. The transcript is the record (A6), and the hook keeps timing and identity.
- Fold `user.look` into a span or a counter, using the heartbeat rule of docs/28 §2.
- Add `bytesPerDay` per class to `data.stats`, so the next drift shows in Settings.

**Success criteria.**
- [ ] After a reindex of a fixture folder, `transcript.other` rows with `line` in the noise set number 0 (test).
- [ ] A hook `PostToolUse` with a 50 KB `tool_response` stores under 4 KB (row plus blob) when the agent kind has a transcript source (test).
- [ ] `data.stats` returns bytes per class per day, shown in Settings → Data.
- [ ] On the stress log replay, bytes recorded per day drop by at least 30% (number recorded in docs/28 §11).

### AR1-06-09 · Make subscriptions say what changed, and stop emitting no-ops

- **Status:** open
- **Severity:** medium
- **Effort:** S
- **Where:** `packages/core/src/core.ts:1456-1484`, `packages/core/src/data/service.ts:135-168`

**Problem.** Fan-out has four gaps:
- **Silent truncation.** The pending list is cut to its last 500 events (`evs.slice(-500)`) with no flag. A burst, such as a transcript chunk or an import, makes a subscriber miss rows without knowing it should refetch.
- **No-op emits.** `DataService.record` emits `recorded` even when the store left the row unchanged (`store.record` returned early). Every window update re-records its `browser.visit`, which costs a SELECT, two `JSON.stringify` calls, a `store.get` and a matching pass, and then sends a `data.changed` for nothing.
- **Text subscriptions.** For these, `textMatches` prepares a new statement per event per subscription.
- **Removals.** Never sent (AR1-06-07).

Per event, the cost is O(connections × subscriptions) in-memory matches. That is fine at today's 3 subscribing clients, but the text path is SQL.

**Evidence.** `core.ts:1476`: `events: evs.slice(-500)`. `service.ts:148-151`: `this.store.record(stored)`, then `this.store.get(e.id)`, then `emit("recorded")` unconditionally. `store.ts:179` returns `{ inserted: false }` for unchanged rows, and the caller can't tell "unchanged" apart from "updated". `service.ts:164` calls `prepare` inside `textMatches`.

**Proposal.** Have `store.record` return `{ seq, inserted, changed }`, and have `record`/`recordBatch` emit only when `changed`. Shape the event `data.changed { id, added, updated, removed, truncated }`, so a client resyncs (`data.query` with `after`) when `truncated`. Cache the `textMatches` statement. For text subscriptions, match once per batch: `SELECT rowid FROM events_fts WHERE MATCH ? AND rowid IN (…batch seqs)`.

**Success criteria.**
- [ ] A test records the same visit twice and gets one `data.changed`.
- [ ] A test records 600 matching events in one batch and gets `truncated: true` (or all 600).
- [ ] `grep -n "prepare(" packages/core/src/data/service.ts` shows no call inside `textMatches`.

### AR1-06-10 · Mint event ids in one place and refuse cross-type upserts

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `packages/core/src/data/store.ts:182-201`, `packages/core/src/data/views/activity.ts:103`, `packages/core/src/core.ts:379,519,638,656`, `apps/desktop/src/renderer/src/App.tsx:555`

**Problem.** About 15 call sites build ids by hand, often from `Date.now()`: `data:forget:${now}`, `notification-clear:${Date.now()}`, `look:${agent}:${Date.now()}`, `remote:${Date.now()}:…`, `command:${Date.now()}:${id}` (a `user.command` sharing the `command:` prefix with command runs). Two in the same millisecond merge into one row. Because the upsert updates `data` but never `type`, an id collision across types silently gives one type's row another type's payload. Hook ids use a per-process counter (`hook:${pane}:${ms}:${name}:${n++}`), so the same spool file recorded again after a restart gets a new id and duplicates instead of deduping (docs/28 §2: "never re-minted"). Ordering itself is sound: cursors follow `seq`, and `at` from the hook is whole seconds.

**Evidence.** `grep -rn "id: \`" packages/core/src apps/desktop/src | grep -c "Date.now()"` lists the sites. `store.ts:185-199` has no `type` in its `DO UPDATE SET`, and no check that `excluded.type = type`.

**Proposal.** Add `eventId(type, key?)` in `data/ids.ts`. It returns `${type}:${key}` when the source has a stable key (the hook spool file name, a notification id) and `${type}:${randomUUID()}` otherwise. Add `WHERE events.type = excluded.type` to the upsert, and log and re-mint on mismatch. Use the spool file's name for hooks, so replays dedupe (see doc 05 for the spool).

**Success criteria.**
- [ ] `grep -rn "Date.now()}\`" packages/core/src/data packages/core/src/core.ts` returns no id construction.
- [ ] A test records two events of different types with the same id and finds both, with their own payloads.
- [ ] A test feeding the same hook file twice through `ActivityView.insert` yields one row.

### AR1-06-11 · Delete the dead whole-file Claude/Codex parsers and the broken perf script

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `packages/core/src/search/parser.ts:10-15,173-305`, `packages/core/src/search/builtin.ts:45,81`, `scripts/perf/index-mem.ts:7`

**Problem.** `parser.ts` (438 lines) isn't a query parser. The query side is `SearchQuery` in `query.ts`, about 50 lines, which is right-sized. `parser.ts` is the transcript parser ported from the Swift fork, and production now reads Claude and Codex line by line in `transcripts.ts` (`claudeLine`/`codexLine`). `parseClaude` and `parseCodex` (about 130 lines) are reached only from `summaries.test.ts` and `search.test.ts`. That leaves two Claude parsers to keep in step. `PARSER_VERSION` is read nowhere, and its comment ("the index then re-reads every transcript") describes the deleted `search.sqlite`. `scripts/perf/index-mem.ts` imports `search/index.ts`, which no longer exists, and so fails to load.

**Evidence.** `readTranscript` (`transcripts.ts:271`) takes the line path for `claude` and `codex` and calls `sources.parse` only for the other kinds. `grep -rn PARSER_VERSION packages` finds the definition only. `ls packages/core/src/search/index.ts` reports no such file.

**Proposal.** Remove `parseClaude`, `parseCodex` and `PARSER_VERSION`. Keep `parseQwen`, `parseCopilot`, the fallback walker and the helpers that `transcripts.ts` imports, and move them to `data/sources/whole-file.ts`. Port the two parser tests to `claudeLine`/`codexLine`. Delete `index-mem.ts`, or rewrite it against `TranscriptIngest` with `inline: true`.

**Success criteria.**
- [ ] `grep -rn "parseClaude\|parseCodex\|PARSER_VERSION" packages` returns nothing.
- [ ] `node --no-warnings scripts/perf/index-mem.ts --help` (or the file's absence) gives no import error.
- [ ] `pnpm vitest run packages/core/test/search.test.ts packages/core/test/summaries.test.ts` passes.

### AR1-06-12 · Flag imported events as redacted when the worker redacted them

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `packages/core/src/data/service.ts:174-190`, `packages/core/src/data/sources/ingest-worker.ts:81`

**Problem.** `DataService.record` sets `DATA_FLAGS.redacted` when redaction changed an event, but `recordBatch` never does. Transcript events are redacted in the ingest worker (`result.events.map(redactEvent)`) and recorded with `{ redacted: true }`, which skips redaction in the core and also skips the flag. So every imported transcript event that had a secret removed carries no sign of it, and `cmd data explain` / anything filtering on the flag undercounts. Found while reviewing AR1-06-04 (already the case before that fix).

**Evidence.** `service.ts:144` computes the flag in `record`; `recordBatch` (`:174-190`) starts from `DATA_FLAGS.imported` and adds only `cut`. `ingest-worker.ts:81` redacts before posting.

**Proposal.** Have the worker return, per event, whether `redactEvent` changed it (compare as `record` does, off the core thread) and carry it as a field on the posted event; `recordBatch` ORs `DATA_FLAGS.redacted` from it. When `recordBatch` redacts itself (`o.redacted` false), compare there as `record` does.

**Success criteria.**
- [ ] A test records a transcript chunk through `TranscriptIngest` containing a secret and finds the stored event's flags include `redacted`; one without a secret doesn't.
- [ ] `recordBatch` without `o.redacted` sets the flag the same way `record` does (test).

## Course corrections

1. **Privacy first, all small:** AR1-06-04 (key-aware redaction) and AR1-06-05 (widget policy). These are the two places where data the person expects to be protected leaks today.
2. **Make `seq` a real cursor and put views on it:** AR1-06-01, then AR1-06-02. This turns three hand-wired views, an unused cursor column and whole-view rebuilds on forget into the incremental view runner docs/28 §3 designed. It fixes the crash gap, and AR1-06-07's removal path falls out of it.
3. **Search off the core thread:** AR1-06-06. It is the largest measured stall left in this system and sits on the keystroke path.
4. **A migration path before the next schema change:** AR1-06-03. AR1-06-01's table rebuild and AR1-06-07's `auto_vacuum` both need it.
5. **Stop the growth:** AR1-06-08. At about 50 MB a day, the first retention run and every full-log read get slower each week.

## Quick wins

AR1-06-05, AR1-06-09, AR1-06-10, AR1-06-11, AR1-06-12. Done: AR1-06-04.
