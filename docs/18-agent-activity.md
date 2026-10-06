# Agent activity data

> Status (2026-10-05): the data layer is built (branch `agent-activity`): spooled hook events, the activity log, normalising, state and turns, files changed per turn, agent homes, automatic hook installs, `cmd agents`. Not yet: the UI using turns (sidebar, Agent Activity widget, notifications beyond the final message), recorded Gemini fixtures, transcript tails for agents without hooks. Comes before the AI features in [17-ai.md](17-ai.md) ("First features on top"), which need this data to be worth anything.

cmd knew *that* an agent was working or finished, not *what* happened: its picture of an agent was the current state plus one line, rebuilt from whichever hook files were on disk, and the "done" notification's body was always empty. This is the layer that captures what agents do reliably — complete, ordered, attributable to a source, surviving restarts, the same shape for every agent — and the agent state derived from it. Features are listed at the end.

Principles:

1. **Keep raw, derive the rest.** Every signal is stored as received. State, turns and summaries are derived and can be re-derived when the derivation improves.
2. **Stable interfaces over internal formats.** Hook payloads are a documented API; git and the filesystem are the truth about what changed; transcript formats are internal and change without notice.
3. **Unknown is a value.** A missing field means less detail, never a wrong state. A changed payload key loses one field, not the agent.
4. **Every fact has a source.** State changes record their cause, turns the rules that shaped them, files how they were found.
5. **Agent-specific knowledge is data**: event names, tool names, home specs. Tested against sessions recorded from the real agents.

## Pieces

| Piece | Where |
|---|---|
| Hook script: status files + spool + the agent's config dir | `core/src/agents/hooks.ts` |
| Spool reader | `agents/activity/spool.ts` |
| Hook events in the event log (`agent.hook`, `agent.note`), turns as a view | `data/views/activity.ts` over `data/service.ts` (docs/28) |
| Raw payload → `ActivityEvent` | `agents/activity/normalize.ts` |
| Events → state and turns | `agents/activity/reduce.ts` |
| Files changed: git snapshots, folder watch | `agents/activity/gitsnap.ts`, `fswatch.ts` |
| Wiring (ingest, replay, restart, snapshots) | `agents/tracker.ts` |
| Agent homes | `agents/homes.ts` |
| Fixtures | `agents/activity/fixture.ts`, `test/fixtures/agents/` |
| Types | `protocol/src/activity.ts` (`ActivityEvent`, `AgentTurn`, `AgentHome`, `AgentCoverage`); `Agent.turn`, `Agent.stateCause` |
| RPC | `agent.events`, `agent.turns`, `agents.coverage`, `agents.homes`; event `agent.activity` (local only: remote policy says never) |
| CLI | `cmd agents events|turns|coverage|homes|record` |

## Capture

**The hook spools every event.** cmd's hook (its code inline in each agent config, so a change to it rewrites the entries: the installed app does that at its next start) still writes `<status root>/<pane>/<Event>.json` (the latest of each, for older cores) and now also hard-links the same file into `<pane>/log/<ts>.<pid>.<Event>.json`. Linking after writing makes every spool file complete when it appears; unique names mean none is overwritten. The record carries the agent's config dir from its environment (`$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`, `$GEMINI_CLI_HOME`, JSON-escaped in sh). SessionEnd no longer deletes the pane's folder (`/clear` fires SessionEnd while the process lives on); the core cleans up when the pane goes.

**The core takes the spool into SQLite.** On every change (FSEvents, 30 ms debounce) and every 2 s as a backstop, the tracker drains a pane's spool in write-time order (mtime, ns) into the event log as `agent.hook` events, raw, with long strings cut (4 KB), long arrays shortened and credentials replaced by `[redacted]` (`core/src/redact.ts`, one list for every store and every model call; its patterns were checked against the author's transcripts, see docs/25 3.8). Events that arrive before the agent is detected (SessionStart usually beats the process poll) are stored unclaimed and taken by the agent when it appears. Capture doesn't depend on the core running: a core that's down reads the spool when it's back. Events are kept by the data layer's retention (a year by default, Settings → Data); turns follow their events and are rebuilt from them when `TURN_FORMAT` changes (docs/28 §3).

`hook.ingest` (the socket path) is now only for peer briefings (`spooled: true`: the core reads the spool first) and the old `cmd hook` (its event goes into the same log). Both paths reduce the same way.

## Normalising

`normalize.ts` maps a raw payload to one vocabulary: `session.start/end`, `prompt`, `tool.start/end`, `ask`, `idle`, `stop`, `fail`, `compact`, `subagent.start/stop`, `other`; the core adds `interrupt` and `anomaly`. Gemini's event names map onto Claude's (`hookEventName`). Fields: session and turn ids (Claude `prompt_id`, Codex `turn_id`), the subagent an event came from (`agent_id`), text by kind (prompt, final message, question, error), the tool (name, id, label from `describeTool`, written paths, command, ok, duration), cwd, transcript path, config dir. Normalising happens when events are read, so fixing an adapter fixes history.

From the recorded sessions (Claude Code 2.1.289):

- Claude's subagent tool is now `Agent` (was `Task`); its subagents' tool calls carry `agent_id` and are kept out of the parent's state.
- `Stop` carries `background_tasks`: an agent can say it's done while a subagent it started keeps running. Kept as `ActivityEvent.background` / `AgentTurn.background`.
- When such a task finishes, Claude submits a prompt itself (`<task-notification>…`), starting a new turn. Kept as `auto` (and not shown as the user's last prompt).
- `PermissionRequest` has no `message`: the ask is the tool and its input ("Allow Bash?" + `rm NOTES.md`).
- In `-p` runs a permission request is denied without a PostToolUse: an open tool call ends with the turn.

From the recorded sessions (Codex 0.144.5, `codex exec`):

- The same payload keys as Claude (`session_id`, `turn_id` on every event of a turn, `transcript_path`, `cwd`, `model`, `permission_mode`); its shell tool is called `Bash` too.
- `apply_patch` puts the patch in `tool_input.command`. Patches are recognised by their body (`*** Begin Patch`) wherever they are, so they're read as file edits, not as a shell command.
- `tool_response` is text. A shell call's is only its output: a command that exits 3 looks like one that succeeded. A failed patch sends no PostToolUse at all.
- No `SessionEnd` from `codex exec`, no `duration_ms`.

A tool call that hasn't reported back when its turn ends counts as failed (`inferred: "1 tool call never finished"`): Codex's failed patches, Claude's denied permissions.

## State and turns

`reduce.ts` is a pure state machine per agent, fed events in order. What the agent says decides the state; every change records its cause (`Agent.stateCause`: "hook Stop", "inferred: quiet for 30 s"). Rules where it says nothing:

- **New session** (resume, `/clear`): an open turn ends `interrupted`. A SessionStart in the same session (Claude's after compaction) keeps the turn going.
- **Interrupt** (no agent sends anything on Esc): a working turn with no events and no terminal output for 30 s (60 s while a tool call is in flight; agents animate a timer while tools run) ends `interrupted`, state idle, noted as an `interrupt` event. An agent that turns out to be still going (a late tool call or Stop) reopens the same turn. Claude's `idle_prompt` notification with a turn open ends it the same way.
- **Questions** (no agent sends anything when a question is answered or dismissed): a waiting turn whose terminal is still busy more than 3 s after the question was **answered** (back to working); one whose terminal changed after the question and then stayed quiet for 30 s was **dismissed** (ends `interrupted`, "declined"). A prompt while a turn waits means its question was dismissed too; a prompt while it works is a follow-up in the same turn. A reminder about the question already up doesn't replace it.
- **SessionEnd** exits the agent only if its process is gone.
- **Mismatches** become `anomaly` events: a spool file that isn't an event, a hook event of another agent kind than the pane's agent.

A **turn** runs from a prompt to stop, failure or interruption. It has the prompt (and whether the agent sent it itself), outcome (`working`, `waiting`, `done`, `failed`, `interrupted`), the ask while waiting, the final message, the error, tools by name with failures, the last commands, how many shell commands looked like writes, files changed, subagents, background work left running, and `inferred` (rules that decided something). Saved on every change with the id of the last event in it, so a restarted core resumes the reducer from the last turn and replays only later events. The current turn is `Agent.turn`, so every client gets it through `agent.updated`.

The "done" notification's body is the agent's final message again (it was always empty: the file path never read `last_assistant_message`).

## Files changed

A survey of 484 recorded sessions on this Mac (454 Claude across 75 projects, 30 Codex) measured how agents change files:

- Claude: 54% of file changes go through Edit/Write, **46% through the shell**: inline Python/Node scripts (`python3 - <<EOF … open(p,'w')`, 18% of all changes), heredocs and redirects (13%), `sed -i`, file commands, downloads, git. Codex: 71% `apply_patch`, most of the rest builds.
- Paths can be read reliably from only a third of shell writes, and 79% of read-only shell commands contain path-like tokens: parsing commands for paths is mostly noise. Paths named in an agent's messages are weak too (29% of changed files are ever mentioned).
- 80% of Claude's structured edits land in the session's git repository; about 13% in a folder that isn't one.

So, per turn:

1. **Git snapshots** at the turn's start and end (`git status` with each listed file's size and mtime, plus HEAD; read-only, no optional locks): a file counts if it's new to the list, changed on disk, left the list, or touched by a commit made during the turn. Sees every mechanism inside a repository.
2. **A folder watch** (FSEvents, recursive) for the turn when the folder isn't a repository, leaving out `.git`, `node_modules`, build output; not for home or `/`. Untracked generated folders (`__pycache__`, an unignored `node_modules`) are left out of git's list too.
3. **Tool paths** from Edit/Write/MultiEdit/NotebookEdit/`apply_patch`, failed calls left out: exact, and say the agent's own tools wrote them.
4. **Shell writes are labelled, not parsed** (`ActivityTool.writes`: script, sed -i, redirect, tee, file command, git, formatter, download, install; shell syntax matched outside quotes).

Each file says how it was found (`via: git | fs | tool`). Both 1 and 2 see every writer in the folder, so with several agents in one repository attribution is approximate; `tool` says which writes were the agent's own. Together 1 and 3 cover nearly every change inside a repository.

## Agent homes

Where an agent keeps its config decides where hooks go, which transcripts are indexed and what env a resume needs. `AgentHomes` is one registry (SQLite `agent_homes`) for all three, replacing the hard-coded `~/.claude-profiles`. Homes are found by:

1. **Defaults and the core's env** (`~/.claude`, `$XDG_CONFIG_HOME/claude`, `~/.codex`, `~/.gemini`, `$CLAUDE_CONFIG_DIR`, …).
2. **A bounded scan**: every folder in `~`, and one level into those named like claude, codex, gemini, agent, profile or `.config`, for the shape of a home (Claude: `projects/` plus `.claude.json`, `settings.json` or `history.jsonl`; Codex: `sessions/` or `archived_sessions/`). A project's `.claude/` folder doesn't match. Takes ~20 ms.
3. **What running agents report**: the config dir the hook passes on, and the home a transcript lives in.
4. **`agents.homes`**, for the rest.

Reading a running agent's environment directly (`KERN_PROCARGS2`, which the native helper already uses for argv) was tried: on this macOS it returns no environment at all, even for one's own child processes. The hook, which runs inside the agent's environment, is the reliable way to learn it.

New homes get their transcripts indexed (`TranscriptSource.rootsIn`, the search worker's `home` message) and, out of the box, cmd's hook.

## Hooks out of the box

The installed app (`autoHooks`, set in `main.ts` for the release instance only) puts cmd's hook into every home's config that has **no cmd hook, an old one** (`cmd hook`, its own in an older form: the config carries the hook's code, so an update that changes it rewrites the entry) **or a broken one** (a cmd hook whose script is gone: a deleted worktree's development build). At startup, every few hours, when homes change and when the setting is turned on. It never:

- replaces another live cmd's hook (`elsewhere`, e.g. a development build's),
- touches a file the user removed the hook from (`hooks.remove` remembers it; Install forgets it),
- writes a file that isn't valid JSON,
- runs from a development build or tests (their script lives in a checkout or a temp dir).

The first time cmd writes an agent's config it keeps a copy next to it (`.cmd-backup`); writes go through symlinks (dotfile repos) and keep everything else in the file. A quiet notification says what was set up. `agents.hooks.auto` turns it off. Codex still asks the user to approve a new hook (`/hooks` in Codex).

## Formats and versions

Data recorded now has to stay readable when cmd, the agents and these formats change, so everything says what wrote it (`protocol/src/activity.ts`):

| Version | Covers | Where it's kept |
|---|---|---|
| `ACTIVITY_SCHEMA` (1) | the normalised event (`ActivityEvent.recorded.schema`) | the stored envelope is the event log's (docs/28 §2: `type`, `v`, `source`, `recorded`) |
| `HOOK_FORMAT` (2) | the record cmd's hook writes (`{v, agent, ts, env, event}`) | `agent.hook` data (`hook`); spool files without `v` are 2 |
| `TURN_FORMAT` (1) | `AgentTurn` and the rules that derive it | `AgentTurn.format` |
| `EXPORT_FORMAT` (1) | `cmd agents export` files | the header line's `version` |
| fixture format (1) | recorded test sessions | the fixture's header line |

Every event also records **which cmd** recorded it (`recorded.cmd`: the app's version, or `source+<build>` from a checkout) and **the agent's version** (`agentVersion`, from its executable: a version in its real path such as Claude's `…/versions/2.1.289` or Homebrew's `Caskroom/codex/0.144.5`, else the nearest `package.json`). Turns carry `derivedBy`, `agentKind`, `agentVersion` and `model`, since they outlive their agent. (Claude's `-p` sessions send no model; interactive ones do.)

Rules:

- **Raw is the truth.** Payloads are stored as the agent sent them (long strings cut); normalised events are derived when read, turns when events arrive. Turns can be rebuilt from events by a newer cmd.
- **Additive changes need no version bump.** A new optional field, a new event kind, a new column. Tables only grow: a newer cmd adds missing columns to an older database when it opens it (`COLUMNS` in `log.ts`) and records its schema version; rows from before a column existed read as that column's unknown (schema 1, cmd null).
- **Incompatible changes raise the version** of what changed, and readers branch on it.

`cmd agents export [--days N] [--anonymize] [--out FILE]` writes everything recorded as JSONL: a header (`{format: "cmd-agent-activity", version, schema, turnFormat, exportedAt, cmd, since, anonymized}`), then `{type: "turn", …}` and `{type: "event", …, raw}` lines. `--anonymize` rewrites the home folder to `~`. That's the file to collect real-world data with.

## Verifying

- **Recorded sessions.** `test/fixtures/agents/claude-2.1.289/` holds three real sessions recorded through the new hook (`claude -p --settings <hooks> --setting-sources project` in a scratch repository): edits through Edit and Bash, a denied permission, a background subagent. `codex-0.144.5/` holds two (`codex exec --dangerously-bypass-hook-trust` with a scratch `CODEX_HOME` holding only the hook and a link to the login): a patch and shell edits, a failing command and patch. Tests replay them through normalize, reduce and the tracker (including a restart mid-session). `cmd agents record <agent> <file>` writes a fixture from the log, with the home and work dir rewritten; `test/fixtures/agents/record.ts` does the same from a spool folder. A new agent version is a new folder.
- **`cmd agents events <agent> [--raw] [--follow]`**: every event as mapped, with causes and anomalies. First thing to look at when the sidebar says something wrong.
- **`cmd agents coverage`**: what each agent's events actually carried (kinds, share of events with each field, unmapped event names, anomalies). Drift after an agent update shows here.
- End to end: real Claude and Codex sessions in panes of a development core each became one turn with the files they changed through a Python one-liner or `echo >>` (found by git), the patched file (tool and git), the final message and the shell write.

## What this enables (separate work)

- **Notifications** (built, 2026-10-05: `agents/notice.ts`, worded by the copywriting skill): subject · state, the agent's own first sentence, the files and time cmd checked, what a waiting agent asks, why it stopped, background work left running. Next: AI phrasing ([17-ai.md](17-ai.md): a fast-tier call over the turn record, not the transcript).
- **Agent Activity widget** as an overview: per agent the current turn, what it wants, files changed, recent turns (`agent.turns`).
- **Sidebar and tooltips** from turn facts.
- **Remote "Now"** from structured fields (once the policy allows `agent.turns`).
- **Magic widgets** through a future `cmd.agents()`.

## Open

The first review of real data is planned in [19-agent-activity-review.md](19-agent-activity-review.md).

- **Gemini recordings.** Its adapter is a table built from documentation; record real sessions (`cmd agents record`) and add a fixture folder. Codex in an interactive session (permission requests, interrupts) isn't recorded yet either.
- **Codex shell failures** are invisible in its hooks (no exit code); its transcript has them.
- **Interrupt timing** in interactive sessions: 30 s quiet is a guess; check against recorded Esc-interrupts.
- **Agents without hooks** (aider, amp, …): process + OSC + git only. A transcript tail (`TranscriptSource.tail`) or screen text could add prompts and answers.
- **Spool growth** while the core is down for long: bounded only by how much agents do meanwhile.
- **Attribution** with several agents in one repository: tool paths are exact, git and the folder watch are per folder.
