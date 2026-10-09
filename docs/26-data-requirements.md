# Data requirements

> Status (2026-10-06), branch `data-model`: the second of four documents. [25](25-data-model-critique.md) said what's wrong with how cmd stores and derives data. This one says what the data layer must do for the next six to twelve months, as requirements the plan (27) is measured against and the refactor (28) implements. It names no tables and no libraries. Decided already: cmd owns transcripts; redaction wherever possible (branch `redact`, tested on real transcripts).

## The vision, in data terms

cmd is a software workbench over terminals, file browsers, a browser, an editor and coding agents. UNIX works because it is low level and resilient: primitives, no magic connections, no imposed workflow. cmd keeps that at its core and works across agents without asking anyone to set anything up. On top it is smart: AI that stays on top of what you're building and helps in ways that didn't exist before. Magic widgets are the model case: ask for "all CI runs for this project" and seconds later a themed live view sits in the workspace. The whole is a **software intelligence layer** over what happens in terminals, files and the person's own actions.

For the data layer that means two things that pull in different directions and both have to hold:

- **Below: primitives.** What cmd records are facts, as they happened, from whoever produced them (an agent's hook, a shell's prompt mark, git, a window, the person), in one plain shape anyone can read with `sqlite3`, grep or a script. No feature's interpretation is baked into the record. Nothing depends on a particular agent, a particular workflow or cmd's UI being up.
- **Above: intelligence.** Every smart feature (a journal, a summary, a digest, a widget, a notification that knows context, an agent asking "what were we doing here") is a *view* over those facts: derived, versioned, cheap to add, cheap to throw away, and never the only copy of anything.

The critique found that today each feature owns its own facts. The requirements below are what "one layer of facts, many views" has to deliver.

## Scenarios the data must serve

Concrete things cmd will do in the coming months, from the roadmap docs and the vision. Each is a test of the design: if a scenario needs a new store or a new pipeline, the design failed it.

| # | Scenario | Needs |
|---|---|---|
| S1 | **The journal** as built (docs/23), plus week rollups, outcomes that change ("merged" Monday, "shipped" Tuesday), agents writing notes and reading days | events for months; threads and days as re-derivable views; a "week" view without a fourth store |
| S2 | **Session summaries** (docs/20) from cmd's own copy of the transcript, "since the last summary", for agents with and without transcripts | owned transcripts; one context builder; the summary kept as data, not only as a file |
| S3 | **Agent digests and contextual notifications** (docs/17): "the test you asked about passed", "it's waiting since 14:32, on the file you had open" | a join across agent turns, commands, windows and what the person looked at, in one query |
| S4 | **An Activity view**: per agent its turns, files, questions; for agents that exited too; "what happened while I was away" | turns as a durable, queryable view; agents as entities that outlive their process |
| S5 | **Agents reading cmd**: `cmd` (or an MCP tool) answering "what were we doing on the payments branch", "where did we leave the flaky test", "what did the other agent change in this repo today" | query by branch, file, project, time, agent; across sessions and agents; in text an agent can use |
| S6 | **Magic widgets over cmd's data**: "what did the agents do today", "commands that failed this week", "files touched most on this branch" | a sandboxed, read-only query API with the same shape as the CLI's |
| S7 | **Search everything**: transcripts, commands, pages, files, notes, journal entries, summaries, from the palette and from agents | one full-text index over all text cmd has, rebuildable |
| S8 | **Remote "Now"** on the phone (docs/13): agents, what they want, recent turns | the same views, filtered by a policy per view, not per method |
| S9 | **Rules get better**: a new interrupt rule, a new threading rule, a new agent version | re-derive state, turns, threads from the facts, at any age, offline, in tests, with the old and the new side by side |
| S10 | **Resilience**: core restart, app update, a Mac reboot, a downgrade, a corrupt file, a disk nearly full, two years of use | no fact lost in any of them; derived views rebuilt; the app starts |
| S11 | **Agents without hooks** (aider, amp, a plain `ssh`): still a session, still a turn when the data allows | capture from process, OSC, terminal output and git, in the same shape as hook events |
| S12 | **Plugins and adapters** (docs/06): a third party adds an agent, a monitor, a routine | adding a source, an event kind or a view is a local change with no migration |

## Requirements

Numbered for the plan to refer to. "Must" is a requirement; "should" is strongly preferred; "may" is allowed. Where a requirement implies a choice the user hasn't made, it says **Proposed** and the plan confirms it.

### A. Facts

- **A1. One record of what happened.** Everything cmd learns about the work is recorded as an event in one log with one envelope: when (one clock, one unit), who produced it (source and its version), which cmd recorded it (version, schema), and the identities it belongs to (A5). The payload is typed by kind and may be extended per source. Nothing is recorded only inside a feature's own table.
- **A2. Raw stays raw.** An event is stored as received, in full. Bounds are a policy (A8), not a constant in a normaliser; when a payload is cut, the record says so and by how much. Normalising, labelling and interpreting happen on read or in views (B), never in the stored event.
- **A3. Sources, now:** agent hooks (every event, every agent cmd knows), process detection, OSC marks and the shell integration (commands, cwd, titles, notifications), git (reflogs, commits, branches, tags, status changes during a turn), windows (pages, files, widgets), the person (A4), cmd itself (model calls: purpose, model, tokens, cost, input and output hashes; notifications shown; errors). **Sources, next:** terminal output (A7), agents without hooks (S11), plugins (S12).
- **A4. The person is a source.** Which pane or window has focus and since when, what was opened, closed, moved, docked, switched (Workspaces), which palette commands ran, which notifications were clicked or dismissed, which agents were looked at, what was typed into a terminal (the command, not the keystrokes; A8 says whether). Without this, every "intelligent" feature sees agents and never the person. **Proposed:** on by default for navigation and commands; typed terminal input is covered by the command events, not recorded separately.
- **A5. Identities, recorded at the time.** Every event carries the ids that apply when it happens, never inferred later from a path prefix: workspace, project, session, agent, pane, window, device, person. These are **entities** with records of their own (created, last seen, attributes, how they were identified), and stable across the things that today reset them: a session across `--resume`, a compaction and a core restart; an agent across restarts of cmd; a project across worktrees, moves and renames (a repository's identity, not a path); a pane across a resurrection. Joins between entities (pane ↔ agent, session ↔ project, agent ↔ parent) are facts with a time, not two mutable fields kept in step.
- **A6. Owned transcripts** (decided). cmd keeps its own copy of every agent session's content it can see: prompts, assistant text, tool calls with inputs and results, thinking where exposed, compaction summaries, as the agent's format gives them, parsed into cmd's shape and also kept verbatim. The agent's file is a source, not the store; when it is deleted or rewritten, cmd still has the session. Captured live where hooks allow it (hook payloads carry most of a turn) and completed from the transcript file (tailing it while the session runs, backfilling what exists).
- **A7. Terminal output.** **Proposed:** record each pane's output as a bounded ring per pane while it runs (as the headless terminal already holds it) plus the output of every command run, attributed to its command event, up to a per-command cap, redacted; and the output of agent panes attributed to their turn. Not every byte forever; enough to show "what happened" and to replay the rules that already depend on terminal activity (interrupts, questions answered). Size budget in A8.
- **A8. Retention and bounds as one policy.** A table of classes (hook payloads, transcripts, terminal output, commands, pages, user actions, model calls, derived views, entities) × (kept for, size cap, cut rule, redaction, user-visible switch). Defaults that fit a year of daily use in a few GB; everything the user can read in Settings and change. Nothing is pruned that a kept view was derived from and can't be re-derived without. **Proposed defaults:** facts 1 year, transcripts 1 year, terminal output 30 days with command output 90, derived views for as long as their facts, entities forever.
- **A9. Redaction at capture** (decided), with one shared set of rules tested against real transcripts, applied before a record is written or sent anywhere; a record says it was redacted. Plus exclusion lists (folders, hosts, commands) that stop recording altogether, and a per-class switch (A8).
- **A10. Capture survives everything.** Recording doesn't depend on the UI or the core being up (the hook spool and the PTY host already do this: keep it). A core that comes back takes what accumulated. A spool has a size bound and says when it dropped something.

### B. Views

- **B1. One mechanism for derived data.** State, turns, threads, days, summaries, digests, search indexes, counters are all *views*: named, versioned, computed from events by rules, stored or not, and re-derivable from the facts at any age. One registry of views, one way to declare a view's inputs, its version and its materialisation (live, incremental, on demand), one way to invalidate it.
- **B2. Re-derivation is a command, not a migration.** `cmd data rebuild <view> [--since]` recomputes a view from the log with the current rules; a version bump of a view's rules marks it stale and the core rebuilds it in the background, newest first, with a cost ceiling for views that call a model. Rebuilding a view never touches another view's data or the facts.
- **B3. Live state is a view.** "What is agent X doing now" is the latest state projected from X's events: computed the same way live, after a restart and in a test; held in memory for speed, written as a view for restore; never a hand-maintained document whose fields mirror another view's.
- **B4. Views have one owner and one copy.** A fact or a derived value lives in exactly one place; a view that needs another's data reads it, it doesn't copy it. Where two copies are unavoidable (an in-memory cache), one is declared authoritative and the other is rebuilt from it.
- **B5. Views say what they came from.** Every derived record names its inputs (event ids or a hash of them), the rule version, and for model-written views the model, the exact input sent (kept, not hashed) and the cost, so a wrong day or summary can be debugged, compared with the previous version and turned into an eval case.
- **B6. Adding a view is local.** A new view (a weekly rollup, a "files touched most" count, a widget's data) is one module that declares inputs, rules and version, plus tests; no new table in a shared schema, no new RPC method, no change to capture.

### C. Query

- **C1. One query API** over facts and views, used by the renderer, the CLI, agents (`cmd …`), widgets (sandboxed) and remote clients, with the same semantics everywhere: filter by time range, identity (Workspace, project, session, agent, pane, window), kind and typed fields; order; page; join to entities; full-text (C3). Expressed as data (a typed query object), so it can be checked, logged, rate-limited and policy-filtered, not as a method per question.
- **C2. Subscriptions.** A client can subscribe to a query and receive changes (new matching events, a view's updated records) as they happen, with one mechanism, instead of per-feature events and 15-minute polls. The renderer's stores, the Journal widget, the Commands widget, the Navigator and remote "Now" are all subscriptions.
- **C3. Search over everything cmd has.** One full-text index over the text of facts and views (transcripts, prompts, commands, pages, files, notes, journal entries, summaries), with the identity filters of C1, rebuildable from the facts (S7). **May** later add semantic search over the same corpus.
- **C4. Policy per class, not per method.** Which clients may read which classes and fields (remote: no prompts or commands; widgets: read-only, their workspace; agents: their project unless told otherwise) is a table over C1's query shape, enforced in the core.
- **C5. Fast enough for UI.** A view read for a visible widget under 20 ms at the sizes in A8; a subscription delivers within 100 ms of the fact; the app starts and shows live state before any index is ready.

### D. Intelligence

- **D1. One context builder.** Every model call that uses cmd's data assembles its input through one component: it takes a query (C1), a budget in tokens, a purpose, and returns text or structured input with redaction (A9), provenance (what was included, what was cut, why) and a hash; and records the call as a fact (A3). Journal days, summaries, digests, notifications and future features use it; none builds its own.
- **D2. Memory across sessions.** The facts and views are what an agent or a feature can recall: "what did we decide", "where did we leave this", "what changed since I last looked", by project, branch, file, person, time (S5). cmd exposes that to agents in the shapes they can use (CLI text, MCP), and the data design must make these questions cheap rather than special cases.
- **D3. Evaluable.** Model-written views come with a way to score a rule or prompt change: a corpus of real (anonymised) inputs with expected outputs, run by a command, so a revision is measured, not eyeballed (docs/24 asks for this).
- **D4. Cost and consent are visible.** Every call's purpose, model, tokens and cost are facts; per-purpose totals and switches are in Settings; background features are off until the user turns them on, and say what is sent.

### E. Operations

- **E1. Upgrades, downgrades, corruption.** A newer cmd opens an older store and migrates facts forward once, in a transaction, with a backup; an older cmd opens a newer store read-only or refuses with a clear message, never corrupts it; a corrupt or missing file is detected at start, the app comes up, the user is told what was lost and what was rebuilt.
- **E2. Backup and export.** The facts are in a form a person can copy, back up and restore (one folder, few files); `cmd data export` writes them as JSONL with the envelope and versions; `cmd data import` reads such a file; the user can delete a session, a project, a day, a class, and the views follow.
- **E3. Observability of the data layer itself.** Size per class, events per day, views and their staleness, rebuilds running, capture gaps (a spool that dropped, a transcript that couldn't be read), as facts and in Settings.
- **E4. Multi-instance stays possible.** Dev and release instances, worktrees with their own `CMD_HOME`, a throwaway e2e home: separate stores by construction, as today.

### F. Developer experience

- **F1. Adding a source, an event kind, an entity or a view** touches a known, short list of places, each typed so the compiler finds what's missing (as `Methods`/`Handlers` do today), and ships with fixtures.
- **F2. Fixtures and the lab** (docs/19) carry over: real sessions, anonymised, replayed through capture → facts → views in tests; the lab drives real agents in a dev core and compares screen with data. Views are testable offline from recorded facts.
- **F3. Readable with standard tools.** `sqlite3`, `jq`, a script: the files and the envelope are documented in the repo and stable across versions except where a version says otherwise.

## Non-requirements

- Multi-user sync, shared workspaces, a server: single person, one Mac, several devices through the existing relay.
- Compatibility with today's tables and files. What's recorded on the author's Mac is migrated where it's cheap (hook events, journal events, the agents' transcripts are re-read anyway); otherwise it is dropped. No users to protect yet.
- Replacing SQLite as the primary store: it is the right engine for a local, single-writer, long-lived store; the plan may add others beside it (an analytics engine, a vector index) if a scenario needs one.
- Recording screen contents or keystrokes beyond what the shell integration already reports.

## Measures

The plan is accepted when it can show, for each scenario S1–S12, which requirements make it one query or one view away; and when a prototype on the author's data demonstrates: a year of simulated events within the A8 budget; S9 (rebuild turns and threads from facts with new rules, offline); S10 (kill the core mid-turn, update the build, restart; nothing lost); C5 timings; one context builder serving the journal and a summary.

## Open for the plan (27)

Decisions the research and the plan make, within these requirements:

1. The event envelope and how payloads are typed and versioned (upcasting vs. reading several shapes).
2. The view framework: how views declare inputs and materialisation; incremental vs. replay; where live views live.
3. The query language: shape, expressiveness, how it maps to SQL and to policy.
4. Subscriptions: how change reaches clients from a single-writer SQLite core.
5. Search: one FTS over everything vs. per-class; where vectors fit, if at all.
6. Transcript capture: live from hooks plus tailing the agent's file vs. file-only; per agent.
7. Terminal output: the cap per command and per pane, and whether to keep it in the main store or beside it.
8. One file or several: facts, views and indexes in one SQLite file, or facts in one and rebuildable data in others.
9. Entities: how projects are identified (repository id, remote URL, first commit) and how sessions are resumed across agents.
10. What of today's code carries over as the first views: the reducer and its rules, the threading rules, the parsers, the digest and writer prompts.
