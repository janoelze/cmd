# The data layer: design and plan

> Status (2026-10-06): the fourth document. [25](25-data-model-critique.md) said what's wrong, [26](26-data-requirements.md) what the layer must do, [27](27-data-research.md) what others do. This is the design that meets 26 using what 27 showed works, and the phases to build it. **Phase 0 (the spike) is done** (§11). **Phases 1 and 2 are built**, branch `data-facts`, as one cutover with no dual write: hook events, commands (with their output), git, pages, files, windows, Spaces, notifications, the person's focus, commands and looks, and every model call are events in `data/events.sqlite`; turns are a view in `data/views.sqlite` rebuilt by replay; the activity log's and the journal's own tables are imported once and dropped; `data.*` RPC, `cmd data`, Settings → Data. **Phase 3 is built**, branch `data-transcripts`: cmd owns transcripts (a worker reads the agents' files into `transcript.*` events from each file's last offset), a `sessions` view and a search view over the log's FTS replace `search.sqlite` (deleted at first start), summaries read the owned copy, the journal's sessions come from the view; `search.enabled` became `data.record.transcripts`. **Phase 4 is built**, branch `data-query`: `data.subscribe`/`unsubscribe` per connection (matched as events are recorded, one debounced `data.changed` per subscription); command runs are events from their start, so the Commands widget is a live query; the Journal widget and the Navigator refetch on changes instead of polling; `cmd data subscribe`; widgets read the log through a widgets socket with a per-run token (`events()` in data.ts), read-only and bounded. **Phase 5 is built**, branch `data-context`: the context builder (`core/src/ai/context.ts`: named parts, a character budget shared by weight, a fit per part, redaction, and a record of sizes, cuts, redactions, source events and a hash kept with each `ai.call`); journal days, summaries and notifications build their input with it; journal evals (`core/src/journal/eval.ts` scorer, `scripts/evals/journal.ts corpus|run`, real days kept in `$CMD_HOME/evals/journal`, outside the repo); `cmd data ai` for calls, tokens and cuts by purpose. Not yet: deny rules (folders, hosts) beyond redaction, `cmd data forget`, entities beyond ids, agent-pane output per turn (A7), subscriptions to views, week rollups, a summaries eval. Phase 6 (memory and recall) is deferred and planned in [29](29-memory.md). **Gaps closed**, branch `data-gaps`: `cmd data forget` (a session, a project, a time, types; forgotten sessions and projects are refused from then on), the `data.exclude` setting (folders, hosts, commands) applied when recording and by `cmd data prune --rules`, README and DEVELOPMENT. **Sweep** (branch `data-sweep`): hook payloads cut in the row with the whole payload as a blob, the Space on agent events, the per-event `agent.activity` broadcast gone (`cmd agents events --follow` is a live query), the Notifications widget and `notify.list` read the log (Clear is a recorded marker), the remote access audit is `remote.audit` events (`remote_log` imported once and dropped). Kept on purpose: the notifier's own long-command tracking (it names a command by its foreground process and sees an agent start mid-run) and `cmd agents export` (docs/19's review format: derived turns plus normalised events). **Agent state** (branch `agent-state`): one derivation of agent state (the hook spool through the reducer; the status files stay for older cores, unread), the `agents` table keeps identity and current state but no copy of the turn (restore takes it from the turns view), one repository detector (`core/src/checkout.ts`) for Spaces, project ids, the journal and peer briefings. Checked live with the agent lab: an interactive Claude through a core restart mid-session, turn restored, the next prompt continuing as the next turn. The agent's current state stays a snapshot rather than a replay: inferred transitions depend on terminal activity the log doesn't hold (A7). Still open: agent-pane output per turn (A7), subscriptions to views, entities beyond ids, a summaries eval. Week rollups are built (docs/23). Decided by the user on 2026-10-06: two files; the person's actions recorded by default; command output as blobs; a year of retention. Requirement ids (A1…F3) refer to 26.

## In one paragraph

One append-only **log of events** in SQLite is the source of truth for everything that happens (A1): hook events, transcript messages, commands and their output, git, windows, the person's actions, cmd's own model calls. Each event has one envelope (sequence, id, time, type and version, source, the identities it belongs to, a parent) and a typed payload; large content goes to content-addressed **blobs**; **entities** (session, project, agent, pane, window, device, person) have records of their own and are referenced by id, never inferred later (A5). Everything else cmd shows or sends is a **view**: a named, versioned materialisation of the log (live state, turns, sessions, threads, days, summaries, the search index, counters, memories), rebuilt from the log when its rules change (B1–B6). One **query** shape over events and views, with **subscriptions** driven by the single writer's commit hook and a **policy** per class of data, serves the renderer, the CLI, agents, widgets and remote devices (C1–C5). One **context builder** turns queries into model input with a budget, redaction and provenance, and records the call as an event (D1). Retention is a policy table over classes (A8); redaction happens at capture (A9). Facts live in one file, rebuildable data in another.

## 1. Storage

```
$CMD_HOME/
  cmd.sqlite        app state as today: panes, pane_screens, windows, spaces, ui_state, remote_*  (operational, not history)
  data/
    events.sqlite   facts: events, blobs, entities, links, retention marks        ← the precious file (E2)
    views.sqlite    derived: every view's tables, FTS, snapshots, view_versions    ← rebuildable from events.sqlite
```

Two files, not one (open question 8 in 26): facts are precious and small-ish; views are disposable and large (the FTS alone is hundreds of MB today). A corrupt index can't take the facts with it; a backup is one file; a rebuild is `rm views.sqlite`. Reads join across them with `ATTACH` (per-file atomicity in WAL is fine: views are derived). `search.sqlite` goes away, its index becomes a view. `cmd.sqlite` keeps what is state, not history: a pane's current size, a window's layout, UI state. Window *openings* are events; the window's *record* is state.

Why not one more engine: SQLite is the right store for a local, single-writer, long-lived app (27 §6; its own appfileformat essay); Node's `node:sqlite` is already in the core; JSONB, generated columns, FTS5 and (later) `sqlite-vec` cover payloads, hot fields, search and vectors. DuckDB over Parquet exports is a later option for year-scale analytics, not a dependency now.

## 2. Events

```sql
CREATE TABLE events (
  seq        INTEGER PRIMARY KEY,     -- monotonic: identity, order, subscription cursor (27 pattern 2)
  id         TEXT NOT NULL UNIQUE,    -- stable across re-recording: the source's own id, else a key ("claude:<uuid>", "git:<repo>:<hash>", "cmd:<uuid>")
  at         INTEGER NOT NULL,        -- ms since epoch, UTC; one clock, one unit (A1)
  until      INTEGER,                 -- spans (commands, turns, sessions); null for moments
  type       TEXT NOT NULL,           -- "agent.hook", "transcript.message", "command", "git.commit", "window.open", "user.focus", "ai.call" …
  v          INTEGER NOT NULL,        -- the payload's schema version for this type; readers upcast (27 §1)
  source     TEXT NOT NULL,           -- who produced it: "hook:claude@2.1.289", "osc", "git", "window", "user", "cmd@0.16.0", "import:agent_events"
  recorded   TEXT NOT NULL,           -- the cmd that wrote it: version or source+build
  parent_id  TEXT,                    -- causal parent: tool.end → tool.start, message → previous message, turn → first prompt
  -- identities (A5), nullable, indexed; recorded at the time, never inferred later
  space_id, project_id, session_id, agent_id, pane_id, window_id, device_id TEXT,
  text       TEXT,                    -- one line for people, search and models
  data       BLOB NOT NULL,           -- JSONB payload, typed by (type, v)
  blob       TEXT,                    -- hash of offloaded content (blobs.hash), when data was too large
  flags      INTEGER NOT NULL DEFAULT 0  -- redacted, cut, imported, tombstone
);
CREATE INDEX events_at ON events(at);
CREATE INDEX events_type_at ON events(type, at);
CREATE INDEX events_session ON events(session_id, seq);
CREATE INDEX events_project_at ON events(project_id, at);
CREATE INDEX events_space_at ON events(space_id, at);
CREATE INDEX events_parent ON events(parent_id);
```

- **Idempotent by id.** Recording an event whose id exists is an update of `until`, `text`, `data`, identities (fill nulls), never of `seq` or `at`: the journal's key-upsert, generalised. A session that grows, a turn that ends, a visit seen again all update their row. Sources' own ids are used verbatim (Claude `uuid`, `tool_use_id`, `sessionId`; Codex `call_id`; a commit hash), never re-minted (27 §4).
- **Types and payloads** are declared in `packages/protocol/src/events/` as one `EventTypes` map (`type → { v, data schema }`), the same way `Methods` works, so the compiler finds a recorder or a view that doesn't match. A new type is one entry plus its recorder. Payload shapes change by raising `v` and adding an upcaster `(old) → new` in the same file; readers always see the current shape. Upcasting is a function per step, applied on read and cached by the views that materialise.
- **Raw stays raw** (A2). The hook payload, the transcript line, the reflog line are the `data` (or a blob) as received. Cuts are a policy (A8): over the per-class size, content moves to a blob; over the blob cap, it is cut and `flags` says so.
- **Text** is the one-line human form (a command's first line, a prompt's first line, a commit subject, a page title), redacted, what FTS indexes first.
- **Agent hook events** stay the finest grain (`agent.hook`, data = the payload, `parent_id` pairs end with start). Turns are a view, not events; a turn's wide row lives in views (27 pattern 7).
- **Transcript messages** (A6) are events: `transcript.message`, id `claude:<uuid>` / `codex:<id>`, `parent_id` = the agent's parent pointer, `data` = the message normalised (role, content blocks with tool ids), `blob` = the verbatim line. Compaction boundaries and summaries are events of their own kinds pointing at what they replace (27 pattern 11). Duplicate lines (Claude #92089) collapse on `id`.
- **Commands** are one event per run (`command`, span, exit code, cwd, pane) with the output in a blob up to the class cap (A7). Agent panes' output is attached per turn the same way. The live ring stays in the PTY host.
- **The person** (A4): `user.focus` (pane/window, with `until`), `user.open/close/move/dock`, `user.space`, `user.command` (palette or menu command id), `user.notification` (shown, clicked, dismissed), `user.look` (an agent looked at: today's `seenAt`). Recorded by the core's handlers, not the renderer, so every path (menu, palette, context menu, CLI) is caught.
- **cmd itself**: `ai.call` (purpose, model, tiers, tokens, cost, input and output as blobs; D4), `notification`, `error`, `data.rebuild`, `data.prune`.
- **Heartbeats** for repeated identical observations (foreground process, cwd, URL): the recorder extends the previous event's `until` when `data` is equal and within a pulse, instead of writing a new row (27 §2).

### Blobs

```sql
CREATE TABLE blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, created INTEGER NOT NULL, refs INTEGER NOT NULL DEFAULT 0, bytes BLOB NOT NULL);
```

Content-addressed (SHA-256), deduplicated, reference-counted by events. Pruning an event decrements; a sweep deletes orphans. This, not the row, is what makes big content and retention tractable (Cursor's 97 GB is the counter-example, 27).

### Entities and links

```sql
CREATE TABLE entities (kind TEXT NOT NULL, id TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL, attrs BLOB NOT NULL, PRIMARY KEY (kind, id));
CREATE TABLE links (from_kind, from_id, to_kind, to_id, kind TEXT NOT NULL, at INTEGER NOT NULL, until INTEGER, PRIMARY KEY (from_kind, from_id, to_kind, to_id, kind, at));
```

- **session**: `<agent>:<native id>`; a `--resume`, a compaction and a core restart are the same session (Claude's continuation carries the parent `sessionId`; Codex's `exec resume` repeats the id). A fork links to its parent.
- **project**: a repository is `repo:<hash of its root commit>` (stable across moves, clones and worktrees), with its remote URL and current path as attrs; a folder that isn't a repository is `dir:<realpath>`. Worktrees link to the project with `kind: worktree`.
- **agent**: cmd's id for one agent process, as today, linked to its session(s), pane and parent.
- **pane**, **window**, **space**, **device**: as today, as entities so events can refer to them after they're gone.
- **person**: one entity for now (`me`), so a second device or a teammate later is a row, not a schema change.
- Links are facts with time: pane ↔ agent, session ↔ project, agent ↔ parent, window ↔ space; what today is two mutable fields kept in step (`Pane.agentId`/`Agent.paneId`).

## 3. Views

```ts
// packages/core/src/data/views/view.ts
interface View<Row> {
  name: string;                                 // "turns", "agent.state", "sessions", "threads", "days", "search", "counters.daily"
  version: number;                              // raise when the rules change: the view is rebuilt
  inputs: EventSelector[];                      // which types (and identities) it consumes
  mode: "live" | "incremental" | "ondemand";    // see below
  reduce?: (state, event) => state;             // live and incremental: a pure fold over events in seq order
  materialize?: (state) => Row[];               // what is written to views.sqlite
  compute?: (query: DataQuery) => Row[];        // ondemand: computed from events and other views when asked
  tables: TableSpec[];                          // its tables in views.sqlite; the framework creates and drops them
}
```

- **Live** views (agent state) are folded in memory as events arrive and snapshotted to views.sqlite with the `seq` they're at; restore = load the snapshot, replay events after `seq`. That is today's reducer and its restart path, made the general case (B3). What the reducer keeps in memory (open tools, subagents, timers) is part of the snapshot, so a restart loses nothing.
- **Incremental** views (turns, sessions, counters, the search index) consume from a cursor in `view_versions(name, version, cursor_seq)` on each commit, in the same transaction's wake, so they're never more than one commit behind.
- **On demand** views (threads, days, summaries, digests) compute when asked and may cache their result with the input hash and version, as the journal does now; model-written ones obey a cost ceiling and the "today at most every 30 min" kind of rule as view options.
- **Rebuild** (B2): a version bump, `cmd data rebuild <view>`, or a missing views.sqlite drops the view's tables and replays its inputs from `seq` 0 (or `--since`), newest-first for views with a model, in the background with progress as events (E3). Other views are untouched.
- **Deletion follows**: when events are pruned or forgotten (tombstoned), incremental views receive the tombstone and remove what they derived; on-demand views are recomputed; days written from pruned events stay (they're small and the user asked for them), marked `sources: pruned`.
- **The first views**, carried over from today's code (open question 10): `agent.state` (reduce.ts and tracker rules), `turns` (the same reducer's turn output as a wide row: agent, session, project, model, tokens, cost, tools, files, outcome, duration), `sessions` (from transcript and hook events), `commands.recent` (replaces CommandLog), `threads` (threads.ts, on demand), `days` (digest + writer, on demand with cache and history), `summaries` (on demand, cached), `search` (FTS5 over `events.text` and transcript messages, external-content with delete triggers, `detail=column`, nightly merge), `counters.daily` (events per type per project per day, for widgets and Settings). Later: `memory.facts` (§6).

## 4. Query and subscriptions

```ts
interface DataQuery {
  from: "events" | ViewName;
  where?: {
    at?: [from: number, to: number];
    types?: string[];                         // prefixes allowed: "git.", "user."
    spaceId?: string; projectId?: string; sessionId?: string; agentId?: string; paneId?: string; windowId?: string;
    parentId?: string;
    text?: string;                            // FTS, with the other filters applied
    data?: { path: string; op: "=" | "!=" | "<" | ">" | "in" | "like"; value: unknown }[];   // json_extract on hot paths, generated columns behind
  };
  order?: "asc" | "desc"; limit?: number; after?: number /* seq cursor */;
  include?: { blobs?: boolean; entities?: boolean; raw?: boolean };
}
```

- **RPC**: `data.query(q) → rows`, `data.subscribe(q) → id`, `data.unsubscribe(id)`, event `data.changed { id, added, updated, removed }`. Four methods replace the dozens of per-feature readers over time (`agent.events`, `agent.turns`, `journal.*` reads, `command.list`, `search.*`, `notify.list`), which become thin wrappers during the transition and are then removed.
- **Subscriptions** (C2): the core is the single writer, so after each commit it publishes `(table, seq range, identity keys touched)`; each subscription is matched against that (events: by type and identities; views: by name and keys), its query re-run and diffed against the last result (PowerSync's incremental mode, 27 §6). The renderer's stores, the Navigator, the Commands, Notifications and Journal widgets, remote "Now" are subscriptions. No more `agent.activity` broadcast nobody reads and no 15-minute poll.
- **Policy** (C4): `packages/core/src/data/policy.ts`, a table `client kind × type prefix / view → allow | deny | fields`. Remote: no `transcript.*`, `command` text, `user.*`; widgets: read-only, their Space, no blobs unless declared; agents: their project by default. Enforced in the query layer, so a new reader can't bypass it.
- **CLI**: `cmd data query '<json>' | --type git. --since 7d --project . --text "flaky"`, `--json`/`--md`, `cmd data subscribe` (streams), `cmd data rebuild|prune|forget|export|import|stats|explain`. `cmd journal`, `cmd agents` and `cmd search` keep their shapes on top.
- **Widgets**: `cmd.data.query` in the Deno sandbox over the socket with the widget's identity (policy applies); the first "widgets over cmd's data" (S6) are the proof.
- **Performance** (C5): hot fields get generated columns and indexes; the wide `turns` row answers the Activity view without joins; FTS is `detail=column`; the spike measures all of it.

## 5. Capture

Recorders are small adapters from a source to `data.record(event)`; today's producers move onto them:

| Source | Today | Becomes |
|---|---|---|
| Agent hooks (spool, `hook.ingest`) | `ActivityLog.insert` + reducer + `agents` doc | `agent.hook` events; `agent.state` and `turns` views |
| Process detection, OSC marks, exec | `Pane` fields, `CommandLog`, `NotificationCenter.#running`, `PaneRecord.command` | `command` events (span, exit, output blob), `pane.foreground` heartbeats; one place |
| Transcripts | search worker (index only), summaries (re-parse) | a tailer per live session plus a backfill walker over agent homes → `transcript.message`, `transcript.compaction` events (A6); the index is a view |
| git | journal/git.ts (reflogs), gitsnap (status), summaries (`git log`), peers | one `git` recorder: reflog events, status snapshots at turn edges as `git.status` events; project ids from root commits |
| Windows, Spaces | journal recorders | `window.*`, `space.*` events from the managers, plus `user.*` from the handlers |
| cmd | logs | `ai.call`, `notification`, `error`, `data.*` events |
| Imports | | `import:*` sources for today's `agent_events` and `journal_events`, once |

Redaction (A9) runs in `data.record` on `text`, `data` and blobs, with the deny rules (folders, hosts, commands) before it; `redacted`/`cut` flags are set there. Capture independence (A10): the spool and the PTY host stay as they are.

## 6. Intelligence

- **Context builder** (D1), `packages/core/src/ai/context.ts`: `build({ purpose, budget, parts: [{ query | view | text, weight, render }] }) → { text | messages, provenance: { included: event ids, cut: …, redacted: n }, hash }`. Renders events and view rows into the compact text the journal's digest and the summaries' pruner produce today (those renderers become part of it), fits the budget by weight, redacts again at the boundary, and records `ai.call` with input and output blobs. Journal days, summaries, notifications and digests call it; no feature assembles its own input.
- **Memory** (D2), phase 6: a `memory.facts` view with rows `{fact, entities[], sources: event ids, valid_at, invalid_at, created, expired, confidence}` written by a model from turns, notes and commits per project, expired rather than deleted (Graphiti, 27 §5); per-project **blocks** (small, editable, always included: "this repo uses worktrees per task", "tests: pnpm test"); retrieval = FTS + (later) `sqlite-vec`, fused, budgeted. Exposed to agents as `cmd recall <question>` and an MCP tool; the briefing points at it.
- **Evals** (D3): `packages/core/test/evals/` with anonymised real inputs (digests, transcripts cut down) and expected shapes; `pnpm eval journal|summary` scores a prompt or rule change. The lab (docs/19) stays the way to record new cases.

## 7. Retention, privacy, operations

- **Policy table** (A8), `packages/core/src/data/retention.ts`, read by a daily job and shown in Settings → Data:

| Class | Types | Keep | Per-item cap | Blob cap | Switch |
|---|---|---|---|---|---|
| agent events | `agent.hook` | 1 year | 64 KB → blob | 1 MB | `data.record.agents` |
| transcripts | `transcript.*` | 1 year | 64 KB → blob | 4 MB | `data.record.transcripts` |
| command output | `command` blobs | 90 days | | 256 KB | `data.record.output` |
| pages, files, windows | `window.*`, `browser.*`, `file.*` | 1 year | | | `data.record.browsing` |
| person | `user.*` | 1 year | | | `data.record.actions` |
| model calls | `ai.call` | 1 year | | 1 MB | always (cost) |
| git | `git.*` | forever | | | |
| entities, days, summaries, notes | | forever | | | |

Proposed defaults (A8); the spike measures what a year costs.

- **Forget**: `cmd data forget --session|--project|--range|--type` tombstones events (a `data.forget` event records that something was removed, not what), deletes blobs and view rows, and runs FTS deletes through the triggers. Deny rules apply retroactively with `cmd data prune --apply-rules` (Atuin's prune).
- **Explain**: `cmd data explain` prints every type with its class, retention, redaction and whether it ever leaves the machine (model calls, usage stats, remote), from the same tables Settings shows (VS Code's catalogue, 27 §7).
- **Upgrades** (E1): `events.sqlite` has one schema version; a newer cmd migrates it forward in a transaction after copying the file aside; an older cmd opening a newer file refuses with a message; payload shapes evolve by `v` and upcasters without touching rows. `views.sqlite` has no migrations: a version mismatch rebuilds the view.
- **Corruption** (E1): both files `PRAGMA quick_check` at start; a bad views.sqlite is rebuilt; a bad events.sqlite is moved aside, a fresh one started, the user told, and `cmd data import` can take what `sqlite3 .recover` saves.
- **Export/import** (E2): JSONL with the envelope, `v`, blobs inline base64 or beside; `--anonymize` rewrites home and project paths; this replaces `cmd agents export`.
- **Stats** (E3): size per class and file, events per day, view cursors and staleness, running rebuilds, capture gaps: a view (`data.stats`) and a Settings page.

## 8. Alternatives considered

- **Keep the four logs, add a read layer over them.** Cheapest, and it leaves every finding in 25 in place: four vocabularies, four retentions, copies kept in step by hand. Rejected.
- **Event-source the app state too** (panes, windows, layouts). Clean in theory; in practice layout state is high-frequency, low-value history and the restore path works. The *openings and movements* are events (A4); the records stay state. Revisit if a "replay my day" feature wants it.
- **One SQLite file for everything.** Simpler ATTACH story, one backup; but a broken or bloated index takes the facts with it, and "rebuild everything derived" is `rm` of one file in the two-file design. Two files.
- **A document store or key-value (Cursor's shape).** Exactly the failure 27 documents. No.
- **Postgres, DuckDB, ClickHouse.** Wrong for a local app with one writer; DuckDB stays an option for Parquet exports.
- **Vectors from day one.** Not needed for S1–S12; FTS plus identities covers them. `sqlite-vec` slots into the `search` view later.

## 9. Phases

One worktree per phase, each green (`pnpm typecheck && pnpm test`, e2e once at the end of each phase), merged before the next starts. Estimates are working days for one agent with review.

| # | Phase | Delivers | Proves |
|---|---|---|---|
| 0 | **Spike** (3–4 d) | `events.sqlite` with the envelope; an importer for this Mac's `agent_events`, `journal_events` and transcripts (1.9 GB); `turns` replayed through the existing reducer over imported events and diffed against stored turns; FTS over all text; timings of the C5 queries; size per class | the numbers in 26 "Measures": size of a year, query times, rebuild time; blob threshold; JSONB vs text. Go/no-go for the design |
| 1 | **Facts** (5–7 d) | `packages/core/src/data/`: store, envelope, `EventTypes`, upcasters, blobs, entities and links, `data.record` with redaction and deny rules, retention job, `cmd data stats|explain|export|import`; recorders for hooks, commands (with output), git, windows, user actions, ai calls; the one-time import | A1–A5, A8–A10, E2, E3, F1 |
| 2 | **Views** (5–7 d) | the view framework, `agent.state` (live, snapshot + replay), `turns`, `sessions`, `commands.recent`, `counters.daily`; `cmd data rebuild`; `agents`/`agent_turns`/`CommandLog`/`NotificationCenter.#running` removed; notifications and restore on views | B1–B6, S4, S9, S10 |
| 3 | **Transcripts and search** (5–7 d) | the tailer and the backfill walker; `transcript.*` events; the `search` view replacing `search.sqlite`; summaries reading owned transcripts; palette and Navigator on the new search | A6, S2, S7 |
| 4 | **Query, subscriptions, policy** (5–7 d) | `data.query/subscribe`; the commit-hook publisher; policy table; renderer stores, Navigator, Commands/Notifications/Journal widgets and remote "Now" on subscriptions; `cmd data query`; widget access from the sandbox; per-feature read methods become wrappers | C1–C5, S6, S8 |
| 5 | **Intelligence** (5–7 d) | the context builder; threads and days as views on the new events (same rules, THREADS/WRITER versions kept); summaries and notifications through the builder; `ai.call` events; the eval harness with the first corpus; a week rollup as the proof that a new view is one module | D1, D3, D4, S1, S3 |
| 6 | **Memory and agents** (5–7 d) | `memory.facts` and blocks; `cmd recall`, the MCP tool, the briefing line; old tables and `search.sqlite` deleted; docs/18, 20, 23, 24 updated to point here; README and DEVELOPMENT | D2, S5, S12 |

About seven to eight weeks of focused work; phases 3 and 4 can run in parallel worktrees after 2. Each phase ends with its numbers added to this document.

## 10. Risks (written before the spike; see §11 for what it settled)

- **Scope.** The design touches every feature. Mitigation: phases that each leave the app working, wrappers during transition, no big-bang cutover; the spike before any commitment.
- **`node:sqlite` features.** JSONB, generated columns, FTS5 external content and `update_hook`-equivalents must work in the SQLite Node 22 bundles; the spike checks. Fallback: text JSON and a polling publisher on `PRAGMA data_version`.
- **Transcript tailing.** Agents rewrite or move files (Claude's continuations, Codex's zstd); the walker must reconcile, not assume append-only. Dedupe by id makes re-reading safe.
- **Replay cost.** A year of hook events through the reducer: the spike measures; snapshots per session bound it.
- **Renderer migration to subscriptions** is the widest UI change; done per widget behind the existing RPC wrappers.
- **Privacy expectations.** Recording the person's actions and command output is new; it is on by default only where 26 proposed it, visible in Settings → Data, and `cmd data explain` says exactly what is kept.

## 11. Phase 0: what the spike showed

`scripts/data/spike.ts` (branch `data-spike`) imports a copy of `cmd.sqlite` (`agent_events`, the journal's live and git kinds) and every transcript on this Mac into the events file of §2 (`packages/core/src/data/`), builds the FTS, replays the activity reducer over the imported hook events against the turns the core stored, and times the queries. Run on 2026-10-06 against 605 transcripts (571 Claude Code, 34 Codex; 239,618 lines; 1,916 MB on disk; 22 June to 6 October; 485 sessions, 221 projects; 10–22k lines a day in the last two weeks).

**Size.** Everything in, uncut, deflate-compressed blobs: 1,494 MB. With zstd and tool results cut at 64 KB: **647 MB**, imported in 65 s. Of that: blobs 349 MB (662 MB raw → 298 MB, 45%), the events table 208 MB (243k rows, ~850 bytes a row: the envelope plus the inline message for lines under 2 KB), indexes 56 MB, FTS 10 MB. At this autumn's pace that is about **2.2 GB a year**, inside 26's "a few GB". Where the bytes were before the cap: tool results (file reads, command output) were 80% of all raw content (22k blobs, 1,459 MB, 251 of them over 1 MB); messages 199 MB; attachments 128 MB. Codex's `reasoning` items are encrypted and don't compress (77%); their bytes are dropped, the row kept.

**Decisions the numbers forced.**
- **zstd, not deflate**, for blobs: 36% vs 64% of raw on a 400-blob sample (`node:zlib` has it since 22.15). Level 3.
- **A per-class content cap is the retention lever**, exactly as A8 says: tool results at 64 KB halves the file; everything else is small. Messages and attachments stay whole.
- **FTS `detail=full`**: `detail=column` forbids phrase queries, and the index is 10 MB either way next to 600 MB of rows. Contentless with `contentless_delete`; coverage verified (phrases from the same day's session are found).
- **`+at` when a type filter is present**: the planner picked the wide `at` index over `(type, at)` even after `ANALYZE`; `git.*` in 30 days went from 50 ms to 2 ms.
- **Noise line types stay out of the row store or become counters**: Claude's `last-prompt`, `atis-latch`, `mode`, `cost-state`, `file-history-delta` and Codex's `token_count` are 35k of 243k rows and say nothing a view wants; phase 1 maps them to counters or skips them.
- The 2 KB inline threshold puts 64% of assistant lines (they carry `usage` and long text) into blobs; with zstd that is the right side to be on.

**Replay (S9).** 44 agents' hook events replayed through today's reducer in 65 ms total. 29 agents came out identical to the stored turns. All 15 that differed had turns stored by cmd 0.11.0 under `TURN_FORMAT` 1, which ended a turn at the next prompt (docs/19); today's rules merge those into fewer turns with follow-ups (one agent: 13 stored, 7 of them left `working`; replayed: 6, all `done`, 7 follow-ups). No outcome or prompt mismatch anywhere else. So: today's `agent_turns` is a mix of rule versions that was never re-derived, and re-deriving from the log is one function call. Inferred interrupts (the quiet rule) can't be replayed until terminal activity is in the log (A7); the spike counted none that mattered.

**Queries (C5), median of 7 on the 647 MB file:** last 50 events of the busiest session (4,726 events) 0.2 ms; that whole session 17 ms; the busiest agent's hook events (replay input) 5 ms; `git.*` in 30 days 2 ms; FTS "flaky OR test" 0.5 ms, "sqlite" within one project 2.4 ms; events per type per day over 30 days 33 ms; a 1.3 MB blob read and decompress 34 ms. One number to remember rather than fix: materialising 62k rows of one project's week took 716 ms, almost all of it JSON parsing in JS; views aggregate, the UI pages, nobody asks for that.

**Also confirmed:** `node:sqlite` in Node 22.23 is SQLite 3.53 with JSONB, generated columns, FTS5 `contentless_delete`; redaction on import cost nothing measurable; the importer is the phase-3 backfill (the same `claudeLine`/`codexLine` will be fed by the tailer).

**Go.** The design holds at this scale with headroom; phase 1 starts from `packages/core/src/data/` as the spike left it.
