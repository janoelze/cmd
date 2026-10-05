# Agent activity data

> Status (2026-10-05): plan, nothing built. Builds on [05-agent-integration.md](05-agent-integration.md) (hooks, status files) and comes before the AI features sketched in [17-ai.md](17-ai.md) ("First features on top"), which need this data to be worth anything.

cmd knows *that* an agent is working or finished, not *what* happened. Its picture of an agent is the current state plus one line of text, rebuilt from whichever hook files happen to be on disk. Before building smarter notifications, an activity widget or summaries, the core has to capture what agents do reliably: complete, ordered, attributable to a source, surviving restarts, and the same shape for every agent. This doc is about that data and the agent state derived from it. Features come later and are only listed at the end.

Principles:

1. **Keep raw, derive the rest.** Every signal is recorded as received. Turns, state and summaries are derived from it and can be re-derived when the derivation improves.
2. **Stable interfaces over internal formats.** Hook payloads are a documented API; git and the filesystem are the truth about what changed; transcript formats are internal and change without notice. Rank sources by that.
3. **Unknown is a value.** A missing field means less detail, never a wrong state. A changed payload key loses one field, not the agent.
4. **Every fact has a source.** Each field records where it came from (hook, git, process, screen, transcript), so consumers know how far to trust it and bugs can be traced.
5. **Agent-specific knowledge is data.** Event names, payload keys, tool verbs, config homes: tables per agent, tested against recorded payloads. A new agent or version is a table entry and a fixture folder.

## What exists (2026-10-05)

| Piece | Where | Quality problem |
|---|---|---|
| Hook files | `agents/hooks.ts` (script), `agents/statusfiles.ts` | Each event's raw payload goes to `$TMPDIR/cmd-agents/<pane>/<Event>.json`, **overwritten** per event name. Only the latest of each kind survives; the order between kinds is guessed from file mtimes. SessionEnd deletes the folder. |
| Deriving state | `statusfiles.ts` `deriveStatus`, `stateOf` | Reads a handful of keys. **Drops** `Stop.last_assistant_message`, `StopFailure.error`, `PostToolUse.tool_response`/`duration_ms`, Subagent events. |
| Two ingest paths | files → `tracker.applyStatus`; RPC `hook.ingest` → `state.ts` `applyHook` | Different semantics. `applyHook` reads the final message, errors and subagents, but the installed script only calls it for SessionStart/UserPromptSubmit when peer briefings are on. Result: `Agent.lastMessage` is never set, and "X is done" notifications have an **empty body**. |
| Agent model | `protocol/src/model.ts` `Agent` | Current `state`, `stateSince`, `detail`, `lastMessage`, `lastPrompt`. No history, no turns, no counts, no provenance. |
| Process | `agents/procinfo.ts`, `native/procinfo.c`, `panes.ts` `pollForeground` | Solid: agent kind from argv/path, polled every 0.5–5 s. Reads argv, not env. |
| Terminal | `osc.ts`, `panes.ts` | OSC notify, 133 prompt marks, 9;4 progress, title, output timestamps (`lastActivityAt`), screen via `panes.read`. Used only as a fallback for agents without hooks. |
| Transcripts | `search/` | Built for full-text search: a session flattens to `prompts[]`, `responses[]`, `tools[]` with no turns, order or timestamps; reparsed whole, at most every 30 s. Not usable for live state. |
| Agent homes | `search/builtin.ts` `locate`, `agents/hooks.ts` `hookTargets`, `learned_roots` in the search worker | Three separate lists. `~/.claude-profiles/*` only works because it's hard-coded. A home cmd doesn't know gets no hooks, so it never reports a path, so it's never learned. |

## Sources

Ranked by how stable and how truthful they are:

| # | Source | Gives | Coverage |
|---|---|---|---|
| 1 | **Hook events** | prompts, tools with inputs and results, permission asks, final message, errors, subagents, session ids, transcript path | Claude, Codex, Gemini (as installed) |
| 2 | **Git / filesystem in the agent's cwd** | what actually changed in a turn, whatever the agent claims and however it edited (tools, Bash, scripts) | any agent in a repo |
| 3 | **Process** | agent present, kind, pid, start time, CPU/memory, config env (see "Agent homes") | every agent |
| 4 | **Terminal** | output activity, OSC notify/progress, title, prompt marks | every agent, varies |
| 5 | **Screen text** | what the user sees; last resort for asks in agents without hooks | every agent, unstructured |
| 6 | **Transcript** | the full conversation; recovery after restarts, agents with transcripts but no hooks | per-format parsers, fragile |

Hooks are the backbone; 2–4 confirm and fill in; 5–6 are fallbacks. No single source is required: hooks missing → process + terminal + git still give presence, activity and changed files.

## Capture: an event log

**On disk, written by the hook.** The hook script appends every payload as one line to `<pane>/events.jsonl`, with a timestamp and a per-pane sequence number, before anything else. The per-event files stay for older cores and the fork. Appends of one line are atomic for small payloads; the script caps big fields (`tool_response`, `tool_input.content`) at a few KB with a marker, so lines stay small and secrets in tool output don't pile up. SessionEnd no longer deletes the folder; the core removes it after it has ingested the log.

This makes capture independent of the core: a core that's down, restarting or slow loses nothing, it reads on from its last offset.

**In the core, kept raw.** The core tails each pane's log by byte offset (persisted, so a restart resumes), and stores every event raw in SQLite:

```
agent_events(id, pane_id, agent_id, session_id, seq, ts, source, kind, raw_json)
```

`source` is `hook`, `process`, `terminal`, `git`, `screen`, `transcript`; the non-hook sources write events into the same table (process appeared/left, OSC notify, git snapshot), so there's one ordered stream per agent. Bounded per agent (last N sessions, rotated by size); raw payloads are local only.

## Normalising

An adapter per agent maps raw events to one vocabulary. The adapter is a table (event names, which key holds what) plus `describeTool`, which exists:

| Kind | Claude / Codex | Gemini | Fields |
|---|---|---|---|
| `session` | SessionStart, SessionEnd | same | session id, source (startup, resume, clear, compact), transcript path, model |
| `prompt` | UserPromptSubmit | BeforeAgent | text |
| `tool.start` | PreToolUse | BeforeTool | tool, verb + target, paths, command, tool use id |
| `tool.end` | PostToolUse, PostToolUseFailure | AfterTool | tool use id, ok, duration, result excerpt |
| `ask` | PermissionRequest, Notification (not idle) | Notification | message, pending tool + input |
| `idle` | Notification `idle_prompt` | | |
| `stop` | Stop | AfterAgent | final message |
| `fail` | StopFailure | | error |
| `compact` | PreCompact | PreCompress | |
| `subagent` | SubagentStart / SubagentStop | | agent id, type, final message |

Unknown events and tools pass through as `other` with their raw name. Normalising runs on read from the raw table, so fixing an adapter fixes history.

## Agent state

State today is "the last stateful hook event wins". With an ordered stream it becomes a small state machine with explicit reconciliation, tested in isolation:

- **Ordering.** By `seq` within a pane, `ts` across sources. No mtimes.
- **Sessions.** A new `session_id` (resume, `/clear`, compact) closes the open turn and starts a new session; the agent keeps its id.
- **Interrupts.** Claude sends no Stop when the user presses Esc. An open turn followed by a `prompt` closes as `interrupted`; an open turn with no events, no tool in flight, no output and a prompt mark or idle screen for a while is `interrupted` too, marked as inferred.
- **Asks.** `ask` → `needs_input`; the next `tool.end`, `prompt` or `stop` answers it. A permission denied shows up as a failed `tool.end`.
- **Exits.** Process gone without SessionEnd → turn `interrupted`, agent `exited`. Hooks without a process (stale files) are ignored, as today.
- **Cross-checks.** `working` with no events and no output for minutes, `done` while CPU and output are busy, files in git but no tool touched them: recorded as anomalies (counted, logged, visible in the debug view), not silently fixed.

Every state change records its cause (`event id`, or `inferred: <rule>`), so a wrong state can be traced to the event or rule that produced it.

## Turns

A turn runs from `prompt` to `stop`, `fail` or `interrupted`; an `ask` pauses it. Derived from the stream, stored for querying:

```ts
interface AgentTurn {
  agentId: string; sessionId: string | null; index: number;
  startedAt: number; endedAt: number | null;
  prompt: string | null;
  outcome: "working" | "waiting" | "done" | "failed" | "interrupted";
  ask: { message: string; tool?: string; input?: string } | null;
  final: string | null;                 // the agent's own last message
  tools: { verb: string; count: number; failed: number }[];
  commands: string[];                   // last few, capped
  files: { path: string; change: "A" | "M" | "D"; via: "git" | "tool" }[];
  diff: { files: number; added: number; removed: number } | null;
  subagents: number;
  sources: string[];                    // which sources contributed
}
```

**Git snapshots** at turn start and end in the agent's cwd: `git status --porcelain` and `git diff --stat` with `--no-optional-locks`, a timeout, skipped outside a work tree, at most one in flight per repo. Several agents in one repo make attribution approximate; the turn records files that changed *during* it, and `via` says whether a tool of this agent touched them.

`agent_turns` in SQLite; the current turn on `Agent.turn` (so it reaches every client through `agent.updated`); `agent.turns { agentId, limit }` and `agent.events { agentId, since }` RPCs.

## Agent homes

Where an agent keeps its config decides where hooks are installed, which transcripts are indexed, and what env a resume needs. Users keep them in odd places: a profile per account (`~/.claude-profiles/work` through `CLAUDE_CONFIG_DIR` in a shell function), dotfile repos, `CODEX_HOME`. The core is launched from the Dock and rarely has the user's shell variables, so `process.env` doesn't help. Discovery must break the loop "unknown home → no hooks → no paths reported → never learned", without the user configuring anything.

### Sources, best first

1. **The running agent's environment.** When procinfo classifies a foreground process as an agent, it also reads the agent's environment: `KERN_PROCARGS2`, which `native/procinfo.c` already calls for argv, returns the environment right after argv, readable for the user's own processes. The helper returns only the variables the agent's spec names (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `QWEN_HOME`, `XDG_CONFIG_HOME`, `HOME`), never the whole block. This is the truth for that agent right now and works through any wrapper (shell function, safehouse, direct exec), because the variable is inherited.
2. **Hook-reported paths.** `transcript_path` → `rootFor` → the home.
3. **Fingerprint scan**, at startup and daily: a bounded walk (depth 2 under `~`, plus `$XDG_CONFIG_HOME`) for dirs that look like a home. Claude: `projects/` plus one of `settings.json`, `.claude.json`, `history.jsonl`. Codex: `sessions/` or `config.toml` plus `auth.json`. Names like `.claude*`, `*claude*`, `.codex*` first; skip `Library`, `node_modules`, repos, mounts. `stat`s only.
4. **The login shell's environment**, captured once (`$SHELL -lic env`, 2 s timeout) for exported variables the Dock-launched core lacks. Doesn't see variables set inside functions; 1 does.
5. **A setting** (`agents.homes`) for the rest, shown next to what was discovered.

### One registry

`AgentHomes` in the core replaces the three lists: `{ agent, dir, via, env, firstSeen, lastSeen }` in the core's SQLite (`learned_roots` moves out of the search worker). Search roots, hook targets and resume env all come from it. Specs are data:

```ts
{ agent: "claude", env: ["CLAUDE_CONFIG_DIR"], defaults: ["~/.claude", "$XDG_CONFIG_HOME/claude"],
  fingerprint: { all: ["projects"], any: ["settings.json", ".claude.json", "history.jsonl"] },
  hooksFile: "settings.json" }
```

An agent running from a home without hooks is a **coverage gap** the core can see (process says agent, no events arrive). It is recorded per home and shown in Settings → Agents, with an Install action or automatic install (open question).

## Verifying quality

- **Fixtures from real sessions.** `cmd agents record` copies a pane's `events.jsonl` into `packages/core/test/fixtures/agents/<agent>/<version>/`. Tests replay them through adapter, state machine and turn builder and compare with an expected turn list. A new agent version adds a folder; a payload change shows up as a failing fixture, not in production.
- **Coverage per agent**, computed from data, not claimed: which kinds each agent's events produced recently, which fields were present. `cmd agents coverage` and a row per agent in Settings → Agents ("Codex: no `ask` text, no final message").
- **A debug view.** `cmd agents events <agent>` prints raw and normalised events, state changes with causes, and anomalies. The first thing to look at when the sidebar says something wrong.
- **Anomaly counts** in the core log and `cmd agents coverage`, so drift after an agent update is noticed.

## What this enables (later, separate work)

- **Notifications** with the agent's final message or its question, then AI phrasing.
- **Agent Activity widget** as an overview: per agent the current turn, what it wants, files changed, recent turns.
- **Sidebar and tooltips** from turn facts.
- **Summaries** ([17-ai.md](17-ai.md) `agents.turn`/`agents.digest`): a fast-tier call over the turn record (a few hundred tokens), never the transcript; outcome from state, words from the model; once per turn, opt-in.
- **Remote "Now"** from structured fields.
- **Magic widgets** through a future `cmd.agents()`.

## Order of work

1. **Read what's already on disk.** `deriveStatus` reads `last_assistant_message`, `error` and the ask fallback like `applyHook`; one ingest semantics for files and RPC. Fixes the empty "done" body.
2. **Agent homes.** procinfo reports the spec's env vars; `AgentHomes` registry; search, hooks and resume use it; coverage gaps in Settings → Agents.
3. **Event log.** Hook script appends `events.jsonl` with seq and caps; core tails by offset into `agent_events`; non-hook sources write there too. Bump the hook script version so installs refresh.
4. **Adapters and state machine** on the stream, with causes and anomalies; `agent.events`, `cmd agents events`.
5. **Turns and git snapshots**; `agent_turns`, `Agent.turn`, `agent.turns`.
6. **Fixtures and coverage**: `cmd agents record`, recorded sessions for Claude, Codex, Gemini, `cmd agents coverage`.
7. Then features.

## Open questions

- **Hooks for discovered homes.** When a home without hooks shows up and hooks are installed elsewhere: install automatically and say so, or ask? Recommended: automatically, with a toast and Undo.
- **Reading process environments.** Only named variables leave the helper, but it sees the whole block. Acceptable for a local helper that already reads argv?
- **Retention.** How many sessions of raw events to keep per agent, and whether tool results are kept at all beyond an excerpt.
- **Git snapshots in very large repos.** Timeout and skip, or a setting?
- **Interrupt inference.** How long idle before an open turn counts as interrupted; per agent, or one rule plus prompt marks?
