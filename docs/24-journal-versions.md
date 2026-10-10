# Journal versions

> Status (2026-10-06), branch `journal-versions`: built. Every layer of the journal ([23-journal.md](23-journal.md)) has a version; data says which versions made it; the core decides from them what to read again, what to write again and what to leave as it was. Written ahead of the journal's first revision, so that one doesn't turn into a mess of half-old, half-new days.

## Why

The journal is three layers, each derived from the one before: events (facts), threads (rules), days (a model's write-up). Each will change, for different reasons and at different costs:

- **Events** are history. A recorded command or page can't be recorded again; a turn, a session or a commit can (their sources keep them).
- **Threads** are computed on read and never stored, so a new rule applies at once, everywhere, for free.
- **Days** cost a model call each. A new prompt shouldn't quietly rewrite (and bill) every day someone scrolls past, and an old day is a record of what was said then.

Without versions, the only signal was "the digest's hash changed", which mixes "something happened" with "the rules changed": a threading fix would have rewritten every day viewed, and a prompt change none.

## The versions

All in `packages/protocol/src/journal.ts`:

| Constant | Covers | Raise when | What the core does |
|---|---|---|---|
| `JOURNAL_SCHEMA` | Stored events: table columns, `JournalData` per kind | A kind's data changes shape | Runs `UPGRADES[n]` (store.ts) once, in a transaction, on an older database; records the schema in `schema_versions` |
| `SOURCES_FORMAT` | How pulled sources (turns, sessions, git) become events (`backfill.ts`, `git.ts`) | That mapping changes (a new field, a better title) | The next sync reads every source again, 90 days back; keys are stable, so events are updated in place |
| `THREADS_FORMAT` | Threading rules and the digest's text (`threads.ts`, `digest.ts`) | A rule or the digest changes | Nothing to migrate (computed on read); days written by older rules count as outdated |
| `WRITER_FORMAT` | The prompt, the answer's schema and its checks (`writer.ts`) | Any of those change | Days written by older rules count as outdated |

## What data carries

- **Every event row**: `schema` (the `JOURNAL_SCHEMA` that wrote it) and `cmd` (the build: its version, or `source+<build>` from a checkout), next to `source` (live or backfill).
- **Every written day**: `format` (`{ schema, threads, writer }`), `writtenBy` (the model), `writtenAt`, `eventsHash` and `inputHash`.
  - `eventsHash`: what the day contains, by event key, span and text, with spans clipped to the day's window and a session's title left out (its turns are what the day did). So a session resumed tomorrow, or renamed, doesn't change the days before. Independent of the rules. Days stored with the older, unclipped hash (before AR1-16-01) count as unchanged while that one still matches.
  - `inputHash`: the digest the model got, for comparing revisions.
- **`journal_meta`**: the sync cursors per source (a restart reads only what's new) and the `SOURCES_FORMAT` events were read with.
- **`journal_days_history`**: when a day is written again, the version it replaces, the newest 3 per day.

Days written before this (format 1, no `eventsHash`) are read with `format: {1, 1, 1}` and compared by their digest, as before.

## When a day is written again

`JournalService.day` (stale mode, what the widget and `cmd journal` use):

1. **Something happened since** (`eventsHash` changed): written again. Today at most every 30 minutes. A day older than yesterday that was written after it ended is **final**: a changed hash (a commit read late, say) no longer writes it again; only rule 3 does. One written before it ended (opened that afternoon) is still completed.
2. **Only the rules changed** (`format` older than this cmd's): written again if it's today or yesterday; older days **stay as written** and come back with `outdated: true`.
3. **Asked to** (`write: "force"`, `cmd journal --write`, the widget's Write Again): written again, whatever the rules.

So a revision updates what people look at now, keeps history as it was said, and spends money only when asked for more.

## Reading what you don't know

- An event row whose data doesn't parse, or whose data's kind doesn't match its row (a kind from a newer cmd), is skipped and logged, never fatal. Threads ignore kinds they don't know.
- A database whose schema is newer than the cmd reading it (a downgrade) is read as it is, with a warning; no upgrade runs backwards.
- A day document missing fields gets them filled in when read.

## Doing a revision

The runbook for the next one.

1. **Work in a worktree** with its own `CMD_HOME` (CLAUDE.md), and iterate with the lab on real data first: `node scripts/journal/lab.ts threads|digest|write --data <copy of $CMD_HOME/data> --day YYYY-MM-DD [--repo …]`, and `--synthetic` for the messy fixture day. Write a few days with the old code and the new (`--out a.json`, `--out b.json`) and compare them side by side.
2. **Raise the version of each layer you changed**, in `protocol/src/journal.ts`:
   - a threading rule or the digest → `THREADS_FORMAT`;
   - the prompt, the schema or the checks → `WRITER_FORMAT`;
   - how a turn, session or commit becomes an event → `SOURCES_FORMAT`;
   - the shape of stored event data → `JOURNAL_SCHEMA` plus an entry in `UPGRADES` (or readers that take both shapes, for live kinds: commands, pages, files, notes can't be read again).
   A change can raise several.
3. **Tests**: `packages/core/test/journal.test.ts` pins threading on the fixture day (`test/fixtures/journal-day.ts`) and the versioning rules. Change the expectations a rule change meant to change; add the messy case that motivated the revision to the fixture.
4. **Ship.** Today and yesterday are written with the new rules the first time they're opened; older days stay. `cmd journal --write --days N` rewrites a range on purpose; `cmd journal history --day D` shows a day now and as each earlier version wrote it.
5. **Write it down**: what changed and why in [23-journal.md](23-journal.md), and the version numbers in the status line there.

## API

- `journal.history` (RPC), `cmd journal history [--day]`: a day now and before.
- `journal.days`/`journal.day` return `format`, `eventsHash`, `inputHash` and `outdated` with each day (`--json`).
- `JournalStore`: `schemaVersion()`, `meta`/`setMeta`, `history(scope, date)`, `UPGRADES`.

## Not yet

- The widget doesn't show `outdated` (an older day reads like any other); a quiet "written by earlier rules · Write Again" line under such a day's heading would do it.
- No eval set beyond the fixture: a handful of real days, anonymised, with the entries a person would expect, would let a revision be scored instead of eyeballed.
- `journal_days` keeps one current version per day and scope; comparing two writer versions on the same day in the app (A/B) would need both kept as current.
