# The journal

> Status (2026-10-06), branch `journal`: built: the event log and its tables, git from reflogs, backfill from the activity log and the transcript index, live recording of commands, pages and files, threads, the digest, the day writer, `journal.*` RPC, `cmd journal`, the Journal widget. Tested on two real days of this repository and a made-up messy one. Not yet: UI actions, week rollups, an agent tool beyond the CLI, the Settings switch. See "Next".

cmd sees most of what happens in a workspace: agents and their prompts, terminals and their commands, git, pages read, files opened. Until now it kept almost none of it: the activity log goes after 14 days and has no Space, commands live in memory, a browser window remembers one URL, and an agent's row goes when it does. The journal keeps it, and turns it into what a person would write in a work log: "Released v0.14.4", "Investigated a corrupt search index (cause still open)", "Compared Stripe Checkout with Adyen". Not a timeline of tools; the work.

People read it in the Journal widget. Agents read it with `cmd journal` ("what did we do this week?", "where did we leave the flaky test?").

## Three layers

Each is derived from the one before and can be derived again when the rules or the prompt get better (docs/18's "keep raw, derive the rest").

| Layer | What | Deterministic | Where |
|---|---|---|---|
| **Events** | Facts, as recorded or backfilled, kept 180 days | yes | `journal/store.ts`, table `journal_events` |
| **Threads** | Events grouped by identity, with links between them that say why | yes | `journal/threads.ts` |
| **Days** | Entries a model wrote from a digest of a day's threads, and a headline | no (a model) | `journal/digest.ts`, `writer.ts`, table `journal_days` |

### Events

`JournalEvent` (`protocol/src/journal.ts`): `at`, `until` (spans: sessions, turns, commands), `kind`, a `key`, `spaceId`, `repo` (the project: a repository's main worktree, so worktrees of one repository are one project), `cwd`, `thread` (the identity it was recorded under, the threads' seed), `text` (one line) and typed `data` per kind.

The key makes recording idempotent: seeing an event again (live, then a backfill; a session that grows) updates it. The span grows, the newest text wins, live wins over backfill.

Kinds: `agent.session`, `agent.turn`, `command`, `git.commit`, `git.merge`, `git.branch`, `git.checkout`, `git.tag`, `git.rebase`, `git.reset`, `browser.visit`, `file.open`, `note`, `space.open/close`.

**Two ways in** (`journal/service.ts`):

- **Pulled**, for sources that keep their own record: turns from the activity log, sessions from the transcript index, git from reflogs. `sync()` reads what changed since the last pull, with an overlap, every 5 minutes and before a day is written. A core that was down misses nothing; the first sync reaches 30 days back.
- **Pushed**, for signals nothing else keeps (`journal/recorders.ts`): commands when they end (CommandLog), pages browser windows show (one visit per page per half hour, titled), files windows open, notes (`cmd journal note`).

**Git** (`journal/git.ts`) is read from reflog files, not by running git: the main worktree's HEAD log, each linked worktree's, each branch's. They hold 90 days, so they're the backfill too. A branch merged and deleted (cmd's own workflow: a worktree per task) leaves only its merge in the main log; the commits it brought come from the merge's range. Each commit knows its branch and the worktree it was made in. Tags are releases.

### Threads

Rules, in order (each link records its rule, shown in `cmd journal threads`):

1. **Identity.** An agent session (its turns and its index row), a git branch (commits, merge, creation), a release (its tag, and the "Changelog for vX"/"Release vX" commits just before it), a terminal's burst of commands, a browser window's burst of pages. A burst ends after 45 quiet minutes; commits straight on the default branch are bursts too.
2. **Session → branch**: it edited files in the branch's worktree (or the sibling folder named `<repo>-<branch>`, cmd's convention, for worktrees already removed), ran in it, created it (`worktree add … -b`), or merged it.
3. **Session → commits on the default branch** made while it worked in the main worktree.
4. **Session → release**: a turn about releasing was running when the tag landed.
5. **Release → branches it shipped**: merged since the previous tag.
6. **Hints**: a terminal or browser burst busy while exactly one session of the same project or Space worked ("ran while", "read while").

**Groups.** Strong links (2–4) join threads into a group, the suggestion "this is one piece of work". Shipping (5) and hints (6) don't join: a release isn't the work it shipped. A session linked to three branches or more is an orchestrator: its links stay hints, or one long session would swallow the day.

**Minor** threads are left out unless something links to them: sessions in temp folders, sessions of only "hi", "yes", "continue", a two-minute single prompt with no files, terminal bursts of `ls`/`cd`/`git status`, a single page, and a session whose only presence in the day is its span (its work was the day before).

### Writing a day

A work day runs 04:00 to 04:00, so a late night stays with the day it began on.

The **digest** (`digest.ts`) is the day's threads as text, in groups, each thread with a short ref (S3 session, B2 branch, R1 release, T terminal, W browsing, N note): a session's prompts (the person's own words, up to 10, pasted text collapsed) and its last answer, a branch's commits and merge, what a release shipped, a terminal's notable commands and exit codes, page titles and hosts, then the minor threads in a line each. It's deterministic, and its hash says whether a day needs writing again.

The **writer** (`writer.ts`) asks for `{ headline, entries: [{ refs, kind, title, summary, outcome }] }` and checks the answer: unknown refs are dropped, and every group that isn't minor ends up in an entry. A group the model skipped gets one from the data ("Released v0.14.4: shipped dnd, tm-align, …"; a session's title; a branch's commits). Entry ids are their first thread's, so they're stable when a day is written again. An entry's span is its sessions', branches' and releases', not a dev server's left running around it.

Kinds: release, investigation, feature, fix, design, refactor, research, review, ops, chore. Outcomes: shipped, merged, fixed, answered, open, dropped.

**When**: on request (the widget, `cmd journal`), when the digest changed; today at most every 30 minutes unless asked. One call per day and scope, `smart` tier, in the background queue. Without an AI provider no day is written: titled from the data alone, entries read like a list of prompts (tried, dropped). Events are still recorded, so the days are written once a provider is set up; the widget and `cmd journal` say how. Titles are 2 to 4 words ("Drag and drop for files"); the summary carries the detail.

## What the runs showed

`scripts/journal/lab.ts` backfills a throwaway journal from a copy of `cmd.sqlite`, the transcript index and git, and prints threads, the digest or the written day (`claude -p` stands in for AiService).

- **Monday 5 Oct, this repository** (≈70 sessions, 92 merges, 8 releases): 84 threads, 12 minor, 30k characters of digest. Sonnet wrote 27 entries that match what happened, merged each session with its branch and its release, split nothing wrongly, in 18–20 s. Haiku (through `claude -p`) left half the threads out and over-merged; the fallbacks caught it, but its entries were thin. **Use the smart tier** for days: about 9k tokens in, a few cents a day.
- **Tuesday 6 Oct** (the morning so far): 7 entries, including this branch ("Prototyped the workspace journal and its core", open). It split one session that did two things (dialogs, the window kit) into two entries, as the prompt asks.
- **A made-up messy day** (`test/fixtures/journal-day.ts`: an investigation across an agent, three terminals, SQLite docs and a note; a parallel UI fix; a release; research without code; an unfinished flaky-test branch; a second project; noise): 6 entries. The investigation became one entry with all its threads, the flaky test "investigation, open" with the right reason, the research "answered", and the noise was left out.

What made the difference: git (branches as tasks, merges, tags) and the session ↔ worktree link carry most of the structure, before any model. Prompts carry intent. A model is needed for titles, for joining what links can't (a terminal poking a database while an agent investigates) and for splitting long sessions.

## API

| | |
|---|---|
| RPC | `journal.days` (scope, count, write: never/stale/force), `journal.day`, `journal.events`, `journal.threads` (threads and digest), `journal.note`, `journal.sync`. Remote: never (prompts, commands, pages). |
| CLI | `cmd journal [--days N] [--all\|--space\|--repo] [--write\|--no-write] [--json]`, `journal note TEXT`, `journal threads [--day]`, `journal events`, `journal sync`. Inside a cmd terminal, the scope is its Space. |
| Widget | `journal` (built-in, This Space / All Spaces): shows what's written at once, then writes what changed under "Writing up what happened…". |

Scopes: a Space is its events, plus events without a Space whose project or folder is under its root. "repo:<path>" is one project. "all" is everything.

## Next

1. **Agents writing it down.** `cmd journal note` from an agent's terminal joins its session; a line in the agent briefing ("note decisions and causes with `cmd journal note`") would give investigations their conclusions in the agent's own words.
2. **Agents reading it.** `cmd journal --days 7` is already Markdown an agent can read. A briefing line, or an MCP tool, so "what were we doing on the payments branch?" works across sessions.
3. **UI actions** worth keeping: Spaces opened, windows opened and closed, widgets made with Magic, settings changed. Record in the core's handlers (the renderer's `run(id)` misses the palette's and context menus' paths).
4. **Turns with their Space.** Turns are matched to a Space by their folder when their agent is gone; recording `spaceId` and `cwd` on `agent_turns` would make it exact.
5. **Weeks.** A week is its days' entries, rolled up: "This week: v0.11 to v0.14.4, sidebars, summaries, drag and drop".
6. **Outcomes that change.** An entry "merged" on Monday whose branch shipped on Tuesday could say "shipped" when Monday is read again (links already know).
7. **Settings**: `journal.enabled`, the tier, kept days; pages and commands could be opt-out for people who don't want them recorded.
8. **Shell history** with timestamps (zsh's extended history) as a backfill for commands run outside cmd.
