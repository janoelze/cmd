# The data model, challenged

> Status (2026-10-06), branch `data-model`: the first of four documents. This one says what cmd stores today, how each piece came to be, and where the whole falls short of what the next year asks for: an app that is the most resilient and the most intelligent place to work with agents. Nothing here is a design. Next: requirements for the coming months (26), then research and a plan, then the refactor. cmd has almost no users, so compatibility with today's files is not a constraint; what's recorded on the author's Mac is the only data worth carrying over, and only if it's cheap.

The short version: **cmd has four event logs and no event model.** Agent activity, the journal, the command log and the transcript index were each built for one feature, each with its own capture, its own vocabulary, its own derivation, its own retention and its own read path. Every one of them is reasonable on its own. Together they store the same facts several times, lose some of them after 14 days, derive the rest in five different ways with five different invalidation rules, and offer no way to ask a question nobody anticipated. The next features (digests, "what were we doing on the payments branch", week rollups, agents reading their own history, widgets over agent data) would each add a fifth pipeline.

## 1. What is stored today

Measured on the author's Mac, release build, 6 October 2026 (`~/Library/Application Support/cmd`).

| Store | Where | Written by | Read by | Kept | Size |
|---|---|---|---|---|---|
| `agent_events` (raw hook payloads, 5.5k rows) | `cmd.sqlite` | `ActivityLog.insert` from the spool (`agents/tracker.ts`) | the reducer (on write), `cmd agents`, the journal (raw SQL), nothing in the UI | 14 days | 11 MB, 2 KB/event, 2–4k events a day |
| `agent_turns` (derived, 300) | `cmd.sqlite` | the reducer, upserted on every event | notifications (via `Agent.turn`), summaries, the journal, `cmd agents turns`, nothing in the UI | 14 days | 1.3 MB |
| `agents` (live tree, 7) | `cmd.sqlite` | tracker, whole doc on every change | `restore.ts` only | while the agent lives | |
| `journal_events` (1.8k) | `cmd.sqlite` | 5-min pull from turns, sessions, reflogs; live push of commands, visits, file opens | threads → digest → the day writer; `cmd journal` | 180 days | 1.7 MB |
| `journal_days`, `_history` (0) | `cmd.sqlite` | the day writer (a model) | Journal widget, `cmd journal` | forever | |
| `panes`, `pane_screens`, `windows`, `spaces`, `ui_state` | `cmd.sqlite` | their managers | restore, the renderer | while open | 4.3 MB screens |
| `remote_devices`, `remote_log`, `agent_homes`, `schema_versions`, `journal_meta` | `cmd.sqlite` | | | | |
| `sessions`, `session_fts`, `message_fts`, `files`, `learned_roots` | `search.sqlite`, a worker | the indexer, from 4,055 transcripts | palette, Navigator, `cmd search`, the journal (sessions) | rebuilt on any version change | **352 MB** |
| `CommandLog` | memory | OSC 133 | Commands widget, the journal | 300 runs | |
| `NotificationCenter` | memory | agent state diffs, long commands | Notifications widget | until cleared | |
| summaries | `summaries/*.md` | the summary writer | a Markdown window | forever | |
| widgets, secrets, ai-models, remote keys, settings | JSON files | | | | |
| `ui/` (Chromium profile with browser windows' cookies and caches), `runtime/` (one 34 MB folder per build, never cleaned) | | | | | 331 MB, 103 MB |
| `$TMPDIR/cmd-agents/<pane>/` (status files + spool), `history/*.zsh_history` | files | the hook, the shells | the tracker, the shells | until the pane goes | |

Two databases, five in-memory stores, four file formats. Versioned by nine constants (`ACTIVITY_SCHEMA`, `TURN_FORMAT`, `HOOK_FORMAT`, `EXPORT_FORMAT`, `JOURNAL_SCHEMA`, `SOURCES_FORMAT`, `THREADS_FORMAT`, `WRITER_FORMAT`, search's `SCHEMA.PARSER`), each with its own rule for what a bump re-reads, re-derives or drops.

## 2. How it got here

Each store answers the question its feature asked, and no more:

- **The activity log** (docs/18) asked "what is this agent doing right now, and what did its last turn do", for state, notifications and a future Activity widget. So it keeps 14 days, has no Space, no user actions, and stores the current turn twice (`agent_turns.doc` and `agents.doc.turn`).
- **The journal** (docs/23) asked "what happened in this workspace, for months". The activity log couldn't answer (14 days, no Space, agent rows vanish), so it copies turns, sessions, commits, commands and pages into a second log with a second vocabulary, and resolves Space by folder prefix at copy time.
- **The command log** asked "what ran in my terminals today", for one widget. Memory, 300 runs; the journal copies finished ones out so they survive.
- **The transcript index** asked "find that session". So it indexes foreign files in a separate database, and the journal reaches into it for sessions because nothing in cmd's own store knows them.
- **Summaries** (docs/20) asked "what did this session do", once, now. So they re-parse the transcript, re-run git and assemble a context nothing else can reuse.

Each decision was right locally. The sum is what this document is about.

## 3. Findings

### 3.1 One fact, many places

The same information is recorded or maintained in several stores, by hand, with nothing keeping them consistent:

| Fact | Where it lives |
|---|---|
| The current turn | `agent_turns.doc`, `agents.doc.turn`, the reducer's memory, `journal_events` (clipped copy) |
| An agent's last message / prompt / what it asks | `Agent.lastMessage/lastPrompt/detail` and `turn.final/prompt/ask` |
| The model, the agent's version | `Agent.model`, `reducer.model`, `turn.model`; `Agent.version`, `reducer.ctx`, `turn.agentVersion`, `agent_events.agent_version` |
| The session id | `Agent.native.claudeSessionId/codexThreadId`, `turn.sessionId`, `agent_events.session_id`, `sessions.id`, `journal_events.thread` |
| Agent ↔ pane | `Pane.agentId` and `Agent.paneId`, both maintained by `setAgent`; `agents.parent_id/root_id` repeat the doc |
| A shell command | `PaneRecord.command`, `CommandLog`, `NotificationCenter.#running`, then `journal_events` |
| A session | `sessions` (search), `agent.session` journal events, turns' `sessionId` |
| Where transcripts are | `agent_homes` (core DB) and `learned_roots` (search DB), fed from the same signals |
| Agent state from hooks | `statusfiles.deriveStatus` **and** `normalize`+`reduce`, over the same hard-linked files, each with its own subagent and session rules |
| Previous agent state | on the agent, and again in `NotificationCenter.#agentStates` |
| Which repository a folder is in | `peers.checkoutOf`, `journal/git.repoOf`, `gitsnap.snapshot` |
| Files a turn changed | the turn (git snapshot ∪ fs watch ∪ tool paths) and summaries' fallback (`git log --name-status`) |
| Transcript parsing | the search worker and summaries (whole file, every time) |
| git access | four `execFile("git")` helpers (`journal/git.ts`, `summaries/service.ts`, `gitsnap.ts`, `git.ts`) |

Every hook event writes an event row, the full turn doc and the full agent doc. Every one of these pairs is a place where a fix lands on one side and not the other (the first review already found one: a turn ended by the next turn's first event wasn't saved in its final state, docs/19).

### 3.2 Derivation happens five ways, invalidated five ways

"Keep raw, derive the rest" (docs/18) is the right principle, and it is applied differently in every layer:

| Derived thing | When derived | When re-derived |
|---|---|---|
| `ActivityEvent` from a raw payload | on read (`toEvent` → `normalize`) | always: an adapter fix reaches history |
| Agent state and turns | on write, incrementally, in memory | **never** when `TURN_FORMAT` or a reducer rule changes; only the tail after a restart |
| Journal events from turns, sessions, git | 5-min pull with a 2-hour overlap on `started_at` | on a `SOURCES_FORMAT` bump, 90 days back; a turn that changed later than 2 h after it started (long turns, files added by the end snapshot) is **never** pulled again |
| Threads | on read | always |
| Days | on request, by a model | when `eventsHash` changed, which hashes key, span and `text` only: a turn whose files, outcome or final message changed doesn't count; outdated days older than two days stay as written |
| Summaries | on request | never (a file) |
| Search index | file size/mtime | full rebuild on any version change (352 MB, every parser fix) |

So the only layer that honours the principle completely is the cheapest one (normalising on read). The one that matters most for the UI (turns and state) is frozen at write time, and the reducer that writes it loses `#open` tool calls, `#subagents`, `#askAt` and git "before" snapshots on every core restart (`reduce.ts:88-100`, `tracker.ts:64-84`): a `subagent.stop` after a restart is misread as a helper note; files changed in a turn that spans a restart are never diffed.

There is no single answer to "when is this stale" because there is no single notion of "this".

### 3.3 Retention is per feature, and upside down

Raw events live 14 days; the clipped copies derived from them live 180. After two weeks a turn exists only as `journal_events.data` with a 2,000-character prompt, 1,500 of final, 60 file paths and 12 commands, and can never be derived again. The journal's own `turnEvents` needs `agent_events` to find a turn's cwd (`backfill.ts:80`), so for a turn older than 14 days that lookup already fails. Git reflogs (90 days) and transcripts (as long as the agents keep them) are the only long-term sources, and both are someone else's files.

Days are never pruned; `remote_log` is never pruned; `runtime/` grows 34 MB per build; `ui/Cache` is 184 MB. Nothing says what cmd intends to keep and for how long.

### 3.4 Capture is partial, and "raw" isn't

What cmd records about the work is what hooks happen to send, plus OSC 133 marks, plus reflogs. Missing:

- **The user.** Nothing records what the person did: which pane they looked at (only `seenAt` on an agent), what they typed into a terminal, which windows they opened or closed, which Space they switched to, which palette command they ran, which notification they clicked, what they dragged where. docs/23's "Next" lists UI actions as the next journal kind; without them, every "intelligent" feature sees agents and never the person working with them.
- **Terminal output.** Only the last screen per pane (`pane_screens`), for restore. A command's output, an agent's screen while it worked, errors that scrolled by: gone. The interrupt and "question answered" rules already lean on terminal activity (`pane.lastActivityAt`) without it being recorded, so they can't be replayed or tested from the log.
- **Transcript content.** cmd never owns any of it. The index is a derived view of files Claude and Codex may delete, move or reformat; summaries re-read them; the journal takes titles and first prompts from the index. If a transcript goes, cmd's knowledge of that session is a title and a span.
- **Commands in agent panes** are dropped on purpose (`commands.ts:51`), so an agent's `pnpm test` is known only as a `tool.start` payload clipped at 4 KB.
- **Space on turns**: resolved from cwd prefix at pull time, from a live agent if it still exists (`journal/service.ts:133`).
- **"Raw" payloads are cut** at 4,000 characters per string and 200 array items before storage (`normalize.ts:201`). A `Write` of a 300-line file, a long `Bash` output, a `Read` result: truncated for good. That's a sensible bound for a 14-day cache; it isn't a record.
- **Agents without hooks** (aider, amp, opencode, a plain `ssh`): process name and OSC only.

### 3.5 Identity is strings and heuristics

There is no entity model. Identities are whatever each pipeline had at hand:

- An **agent** is a UUID that dies with the process; a `--resume` is a new agent. The thing people mean ("my session on the payments branch") has no id: it's `claudeSessionId ?? codexThreadId` joined by hand in seven places (`core.ts:450`, `summaries/service.ts`, `renderer/actions.ts:70,153`, `Navigator.tsx:87`, `tracker.ts`), and `sessions.id` isn't even unique in the index (archived copies).
- A **project** is `repo` = the main worktree's path, computed three different ways; a folder that isn't a repository is its own project; moving the repo loses everything.
- A **Space** is attached to events by `cwd.startsWith(space.root)` at sync time, and `journal.events` (strict `space_id = ?`) and `journal.days` (`#inScope`, with the prefix fallback) disagree about which events a Space has.
- A **thread** is a semantic string (`branch:cmd#dnd`, `terminal:<pane>@<at>`), good for determinism, useless for joining to anything stored.
- A **turn** is `(agent_id, idx)`; a **journal event** is an AUTOINCREMENT id but its real identity is `key`, a string built differently per kind (`turn:<agent>:<idx>`, `visit:<window>:<url>:<half-hour>`, `note:<at>:<text40>`).
- The **person** doesn't exist. Nor does a **device** (remote), a **model**, a **tool** or a **file** as something you can point at twice.

Time has the same problem: `at` is REAL ms from `mtimeNs/1e6` in `agent_events`, `Date.now()` elsewhere, seconds in the hook's own `ts`, seconds×1000 from reflogs, declared INTEGER but stored REAL in `journal_events`, local midnight in `journal_days.date`, strings in `journal_meta`.

### 3.6 You can only ask the questions somebody built a method for

The read side is 120 RPC methods, each a bespoke query over one store, and most filtering happens after a full load:

- `agents.coverage` scans every event of N days into JS; `journal.threads` loads a week plus a day and filters Space in JS (`#inScope`); the Commands widget fetches every run and filters Space, failure and state client-side though the server takes a `spaceId`; Resources and Task Manager both poll `pane.list` + `core.processes` every 2 s and aggregate in JS.
- Documents are opaque JSON (`doc` columns) with a few promoted columns and indices on `at`, `space_id`, `repo`, `thread`. "Turns that touched `panes.ts`", "sessions where a test failed then passed", "what did I do after that notification" are impossible without `json_extract` over everything, or a new method.
- Agent bucketing and ranking (needs → unseen → recency) is written four times: `protocol/attention.ts` (used only by its test), `renderer/model.ts`, `AgentActivity.tsx`, `apps/web/model.ts`.
- There are **no change events for the journal or summaries**: the widget polls every 15 minutes; a summary's progress arrives as `fs.changed` on its file. `agent.activity` is broadcast per event and consumed by nothing but `cmd agents events --follow`. Neither the Agent Activity widget nor the sidebar reads `agent.events` or `agent.turns`: the richest data cmd has is shown nowhere.
- The two databases can't be joined in SQL. The journal pulls `sessions` rows through a callback and merges them with turns by sharing a thread string.
- Magic widgets can't read any of it except by shelling out to `cmd` or opening the SQLite files.

### 3.7 Live state and history are two systems

`Agent` is a mutable document whose fields mirror the turn, maintained by a reducer whose state lives in memory, persisted whole on every change, read back only by `restore.ts`. Notifications diff it against their own copy of the previous state. The status-file fallback derives state a second way. Nothing treats "the current state of agent X" as what it is: the latest projection of X's event stream. So restart recovery is a special path (`#reducerFor` seeds from `lastTurn` and replays the tail), the Navigator and the web remote can't ask "what was the state at 14:32", and a rule fix in the reducer changes the future and not the past.

### 3.8 Context for the model is assembled per feature

Three features send cmd's data to a model, with three context builders: the journal's `digest` (threads as text, S/B/R refs), summaries' `prune`+`redact` (transcript to a 160k budget), notifications' `noticeContext` (the turn's fields). Each decides alone what to include, how to clip, what to redact: `redact` runs on summaries only, so a `curl -H "Authorization: …"` in a terminal is stored as typed for 180 days and sent in the day's digest. What was sent is kept as a hash (`inputHash`), never as text, so a bad day can't be debugged or turned into an eval case (docs/24 "Not yet" says so). Agents can't read any of it except `cmd journal` Markdown.

### 3.9 What is good and should survive

Not everything needs replacing, and some of it is ahead of what most tools do:

- **Keep raw, derive the rest** as the stated principle; **provenance on every row** (`schema`, `cmd`, `hook`, `agent_version`, `derivedBy`, `writtenBy`); **unknown is a value**.
- **Idempotent recording by key** (`journal_events.key` upsert: live beats backfill, spans grow), which is what makes backfill and replay safe.
- **The pure reducer** fed by recorded fixtures, the **lab loop** (docs/19) and `cmd agents record`: the data has tests, and the tests are real sessions.
- **Deterministic threads** with named link rules, and **days that remember what they were written from**.
- **`stored.ts` decoders**: a row from another version is repaired or skipped, never fatal.
- **The hook spool** (hard links, write-time order, survives a dead core) and the **PTY host** outliving the core: capture doesn't depend on the UI or the core running.
- **The core owns all state**, behind one socket, with the CLI and the renderer as equal clients.
- **Versions stamped on data** and a runbook for revisions (docs/24).

The problem is not quality. It is that these virtues live inside one feature each.

## 4. What this costs next

The features the roadmap implies, and what each would have to do today:

| Feature | Today it would need |
|---|---|
| Agent digests every few minutes (docs/17) | a fifth context builder over `Agent.turn` + transcript tail; no place to keep the digest but the agent doc |
| "What were we doing on the payments branch?" from an agent | `cmd journal` Markdown and hope; no query by branch, file or time across sessions |
| Week rollups (docs/23) | a fourth derived layer with its own staleness rule over days |
| An Activity widget: per agent, its turns, the files, what it asked | the first UI reader of `agent_turns`; a 14-day horizon; nothing for agents that exited |
| Notifications that know context ("the test you asked about passed") | a join of notifications, commands, turns and what the user looked at: four stores, two of them memory |
| Widgets over agent data (`cmd.agents()`) | a sandbox-safe query API that doesn't exist, over documents that aren't queryable |
| Remote "Now" | a policy per method; today all of activity, journal, search and commands are `never` |
| Replaying a day with better rules | impossible beyond 14 days; impossible for turns at any age |
| Cross-session memory ("you fixed this flaky test on the 3rd") | transcripts cmd doesn't own, turns it prunes, no entity for "this test" |
| Multi-device, multi-Mac | two SQLite files and `$TMPDIR` |

Each is a new pipeline, each pipeline a new place for the same facts to diverge.

## 5. The questions the requirements have to answer

Not answers; the questions whose answers decide the design in the next two documents.

1. **What is an event?** One log for everything that happens (agent hooks, user actions, terminal marks, git, files, windows, notifications, model calls) with one envelope (time, actor, Space, project, session, source, version) and typed payloads? Or several logs with a shared identity model? Today's answer is "whatever the feature needed".
2. **What does cmd own?** Transcript content (and from which agents), terminal output (how much, for how long), tool inputs and outputs uncut? Owning more makes cmd resilient to the agents' files and formats, and costs disk and a privacy story. **Decided (2026-10-06): cmd owns transcripts.** It is to become the brain of AI-assisted development, with features over every kind of activity; a session's content can't depend on files another program may delete or reformat. Terminal output and uncut tool payloads are still open.
3. **Retention and privacy as a policy, not a constant per table.** How long, per class of data; what is redacted at capture, what at use; what never leaves the machine; what the user can see and delete. Today: 14/180/forever/300 rows, redaction in one of three model paths. **Decided (2026-10-06): redact wherever possible**, with the patterns tested against real local transcripts; done ahead of the refactor on branch `redact`.
4. **Derivation as one mechanism.** Projections (state, turns, threads, days, index) derived from the log by versioned rules, re-derivable from the log at any age, invalidated by one rule. Which projections must be live (state), which incremental (turns, index), which on demand (days)?
5. **Identity.** Stable ids for session (across resumes and agents), project (across moves and worktrees), person, device, model, and how Space relates to them (membership recorded at the time, not inferred later).
6. **Query.** Do we want SQL over promoted columns, a typed query API, a subscription model (live queries that push changes), or all three? Who may ask: the renderer, the CLI, agents (`cmd`), widgets (sandboxed), remote devices?
7. **Model context as a product.** One context builder with budgets, redaction and provenance, inputs kept (not hashed) for debugging and evals; per-purpose on/off and cost.
8. **One database or two?** The transcript index is 352 MB of rebuildable data; keeping it apart was right. Is "everything cmd records" one file, and derived indexes another, with a rule for what may be dropped and rebuilt?
9. **Time.** One clock, one unit, one storage type, one day boundary.
10. **What from today carries over?** The principles in 3.9, the fixtures, the reducer rules as the first projection, the hook spool. The tables, probably not.

## 6. Numbers to keep in mind

- 2–4k hook events a day, 2 KB each: ~2–3 MB a day of raw payloads at the current cut. Uncut, more (the largest payload was 34 KB; `PostToolUse` is 60% of the bytes). A year uncut is in the low single-digit GB.
- 4,055 transcripts on this Mac: 1.9 GB on disk, 352 MB indexed.
- A journal day's digest: ~30k characters, ~9k tokens, a few cents, 20 s; 70 sessions, 92 merges, 8 releases on the busiest day measured.
- 120 RPC methods; 11 of them `agent.*`, 7 `journal.*`, 4 `search.*`, 1 `command.*`.
- Journal days written on this Mac so far: 0 (the key is set; nobody opened the widget). The data layer's main consumer is still the CLI.
