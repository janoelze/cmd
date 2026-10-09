# 05 Agents: detection, hooks and activity

**Score: 5/10** · reviewed 2026-10-10 against commit ddb7832 · scope: everything that knows what a coding agent is doing: foreground detection, the hook script and its installation, the spool, normalising and reducing events to state and turns, the agent tree, naming, peer briefings, git snapshots per turn, and the agent-facing CLI and widgets.

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 5/10 | `reduce`/`normalize`/`spool`/`gitsnap` are clean, pure modules; `tracker.ts` is an 876-line god object that wires seven concerns, and per-agent knowledge is spread over a dozen tables in nine files |
| Correctness & robustness | 6/10 | Fixture-replayed rules with recorded causes are a strength; a second agent kind in a pane corrupts the first agent's turn, a reducer failure loops forever, and turn snapshots look at the wrong checkout |
| Performance | 7/10 | The hook is plain `sh` and the core path is gated by a flag file; git snapshots run synchronous `statSync` loops on the core thread and every hook event costs three SQLite writes |
| Security | 6/10 | Hook commands are quoted (`shq`) and configs written atomically through symlinks; the hook's inline shell body carries absolute paths of the build, and peer briefings paste other agents' prompts into an agent's context by design |
| Testability & tests | 7/10 | 135 tests in 2.6 s, recorded sessions for Claude 2.1.289, Codex 0.144.5 and Gemini 0.62.0, a replay harness; no transition table, `state.test.ts` is 11 lines, no test for a mismatched-kind event or a poisoned event |
| Extensibility | 4/10 | Adding an agent kind touches `AgentKind`, `KNOWN_AGENTS`, `SPECS`, `HOME_SPECS`, `GEMINI_EVENTS`/`KINDS`, `HOME_ENV`, `KIND_LABELS`, `nativeSession`, `launchCommand`, a `TranscriptSource` and a settings key: 11 places in 3 packages |
| Code health | 6/10 | Good top-of-file comments and tight helpers; `tracker.ts` imports `DEFAULT_SETTINGS` twice, keeps 43 methods, and has had 24 commits of churn (52 in `agents/`) |

## What this system is

Two sources tell the core what an agent does. **Foreground detection** (`panes.ts` polls `procinfo`, a native helper, every 500 ms for panes with output and every 5 s for quiet ones; `agents/procinfo.ts` 226 lines classifies argv against `KNOWN_AGENTS`) says *which* agent process runs in a pane and when it started. **Hooks** say *what* it does: at startup the core writes `<state dir>/hooks/cmd-hook` (`agents/hooks.ts`, 255 lines) and installs the script's body inline into the agent configs it finds (`agents/homes.ts`, 161 lines, a registry of Claude/Codex/Gemini config dirs in SQLite). The hook writes every event to `$TMPDIR/cmd-agents/<pane id>/log/<ts>.<pid>.<Event>.json` (`statusfiles.ts` 58, `activity/spool.ts` 56); the core drains that spool on FSEvents and every 2 s, stores each payload as an `agent.hook` event in the event log (`data/views/activity.ts`, 357 lines), normalises it to one vocabulary (`activity/normalize.ts`, 219) and reduces it per agent into state and turns (`activity/reduce.ts`, 364, pure). Turns are a view in `views.sqlite` rebuilt from events when `TURN_FORMAT` changes; files changed per turn come from git snapshots or a folder watch (`gitsnap.ts` 83, `fswatch.ts` 50). `agents/tracker.ts` (876 lines) ties it all together: reconciles both sources, owns the agent tree (subagents as virtual children), persists each agent to SQLite, implements the host API (spawn/send/wait/kill/resume), names agents from worktrees (`names.ts`), hands out peer briefings (`peers.ts`, via `hook-main.ts`, 48 lines, a Node round trip on SessionStart and prompts when `agents.peers` is on) and takes the git snapshots. `naming.ts`/`namer.ts`/`names-eval.ts` (475 lines together) name agents with the fast model tier; `notice.ts` (156) words notifications from the turn. The protocol side is `activity.ts` (215), `attention.ts` (41) and `names.ts` (88); the CLI exposes `cmd agents …` (`cli/src/agents.ts`, 203) and the legacy `cmd hook`; the renderer shows it in `AgentActivity.tsx` (115), `LiveDiff.tsx` (181) and `settings/AgentHooks.tsx` (64). Design: docs/05 (signals and layering), docs/08 (the tree and host API), docs/18 and 19 (the activity layer and its review against real data), docs/32 (names), docs/31 and 29 (planned consumers).

Reconciliation, as built: an agent record is created by whichever source speaks first (`#onForeground` or `applyStatus`/`ingestHook`); events that arrive before the process is seen are stored unclaimed and claimed by the agent with `at >= process start - 500 ms` (`activity.claim`), which is also what keeps a previous session's leftovers in the same pane out. Once any hook event has been reduced the agent is in `#hooked` and OSC notifications are ignored; the process is the last word on *presence* (return to the shell exits the agent, `SessionEnd` exits it only if the process is gone). State across core restarts lives in the `agents` table (one `saveAgent` per change) and the `turns` view (the reducer resumes from the last saved turn's `last_seq`); `#hooked`, `#told`, `#wrote`, `#started` and open snapshots are in memory only.

## What is good

- **Keep raw, derive the rest** is real: payloads are stored as received, normalised on read, and turns are a view with a version (`TURN_FORMAT`), so `cmd data rebuild turns` and a version bump re-derive history with today's rules. The replay even steps the reducer's 2 s timing check against recorded terminal activity (`activity.ts:231-283`), so inferred interrupts come out the same offline as live. This is the VS Code Agent Host pattern (immutable events, pure reducers, 00-research §1 and §4) done properly; other systems should copy it.
- **Every state change has a cause** (`Agent.stateCause`, `AgentTurn.inferred`), and anomalies are events, not log lines. docs/19's lab loop turned real sessions into fixtures with a test each; the rules (quiet 30 s, 60 s with a tool in flight, answered after 3 s of output, dismissed after a screen change then quiet) are each traceable to a finding.
- **The hook costs the agent nothing**: plain `sh`, a hard link per event, no core round trip unless a flag file says peer briefings are on, and it works while the core is down and inside sandboxes. `hookCommand` runs only when `CMD_PANE_ID` is set, and filters headless Claude (`CLAUDE_CODE_ENTRYPOINT=sdk*`).
- **Agent homes are discovered, not configured** (`homes.ts`): defaults, env, hooks' reports, transcript paths and a bounded scan, all in one SQLite registry that hooks, transcripts and resume share.
- `normalize.ts` and `reduce.ts` are pure, table-driven and small; `namer.ts` is pure and driven by the same functions live and in the eval; `notice.ts` is pure. The seams are right where they should be.
- The tests use the fake PTY factory and in-memory stores, run in 2.6 s, and exercise the real hook script end to end (`hooks.test.ts` spawns `/bin/sh` on the generated command).

## Issues

### AR1-05-01 · Keep another agent kind's hook events out of the pane's agent

- **Status:** done (1df00ec7)
- **Severity:** high
- **Effort:** S
- **Where:** `packages/core/src/agents/tracker.ts:176-194`, `packages/core/src/agents/tracker.ts:273-279`, `packages/core/src/agents/hooks.ts:53`

**Outcome.** Done as the skip (one anomaly per nested session); the virtual child agent is left for AR1-05-02. The comparison moved into `#foreign()`, so the literal grep in the last box no longer matches.

**Problem.** A pane has one agent record, found by `#byPane`, and every hook event in that pane's spool is reduced into it. When Claude runs `codex exec …` or `gemini -p …` from its Bash tool (the pane's `CMD_PANE_ID` is inherited), the nested agent's hooks spool into the same folder: the tracker notes an anomaly and then applies the event anyway, so Codex's `SessionStart` (a new `session_id`) closes Claude's open turn as "interrupted: new session before the turn ended" and its `Stop` marks Claude "done". The same happens when a person starts a second agent from a shell inside the first. Only headless Claude is filtered, in the script. Foreground detection has the same blind spot: once `current` exists, `fg.class.agent` is never compared with `current.kind`, so a Codex that takes the foreground of a Claude pane updates Claude's `version` to Codex's.

**Evidence.**
```ts
// tracker.ts:273-279
if (ev.agent && ev.agent !== agent.kind && ev.source === "hook") {
  this.emit("activity", this.activity.note("anomaly", `${ev.agent} hook event in a pane whose agent is ${agent.kind}`, …));
}
this.#hooked.add(agent.id);
try { this.#applyReduction(agent, red, red.apply(ev), ev, live.has(ev.id)); }
```
`hooks.ts:53` filters `claude:sdk*` only; there is no equivalent for `CODEX_*`/Gemini headless runs. `tracker.ts:178-186`: `if (a) { … if (a.state === "starting") … }` never reads `fg.class.agent`. No test in `tracker.test.ts`, `detection.test.ts` or `activity.test.ts` feeds an event of another kind into a pane.

**Proposal.** Reduce by `(pane, agent kind)`, not by pane: in `#ingest`, an event whose `ev.agent` differs from the agent's kind is noted and **skipped** (not reduced). Better: give nested agents a record of their own, as docs/08 already models for Claude subagents: a hook event of kind B in a pane whose agent is kind A creates a virtual child `{kind: B, paneId: null, parentId: A, source: "detected"}` keyed by `(pane, kind, session_id)`, and its events reduce into that child. In `#onForeground`, a foreground agent of a different kind than `current` becomes that child while it is in front, and `current` keeps its version. In the hook script, also stay quiet for Codex and Gemini headless runs when the parent env says so (`CODEX_SANDBOX`/`GEMINI_CLI` equivalents of `CLAUDE_CODE_ENTRYPOINT`; record which variables exist in docs/18).

**Success criteria.**
- [x] A test in `activity.test.ts`: a Claude session with a nested `codex exec` (SessionStart/Stop of kind codex mid-turn) leaves Claude's turn `working` and `done` only on Claude's own Stop.
- [x] The nested run appears as a child agent (or is dropped with one anomaly), never as a state change of the host; `cmd agents events <host>` shows no codex events reduced into it.
- [x] `#onForeground` with a foreground agent of another kind than `current` does not change `current.version` (test in `detection.test.ts`).
- [x] `grep -n 'ev.agent !== agent.kind' tracker.ts` is followed by a `continue`/skip, not by `applyReduction`.

### AR1-05-02 · Split `tracker.ts` into the five things it is

- **Status:** open
- **Severity:** high
- **Effort:** L
- **Where:** `packages/core/src/agents/tracker.ts:75-856`

**Problem.** `AgentTracker` is 876 lines, 43 methods, 27 imports and 7 private maps/sets, and it carries: (1) reconciling foreground and hook detection, (2) spool draining and event claiming, (3) reducer orchestration and turn persistence, (4) the agent tree with subagent lifecycle and sweeps, (5) the host API (spawn, resume, send, wait, kill, moveTree) with `launchCommand`, (6) worktree placement and naming (`#placeAfter`, `#worktreeName`, `modelName`, `rename`), (7) git snapshots and folder watches, plus peer briefings and SQLite persistence. Every feature in this area (names, places, subagents, snapshots, restore) has landed as more state in this class: 24 commits touch it, half of the folder's history. The next ones (docs/31's rules, docs/29's briefing line, Codex thread spawns) will too, and tests already construct the whole thing to test one part (`peers.test.ts`, `names.test.ts`).

**Evidence.** `grep -c '^  (async )?#?[a-zA-Z]+\(' tracker.ts` → 43. Imports from 5 subsystems: `../search/*` (resume), `../data/*` (log, views), `../checkout.ts` (git places), `./activity/*` (reduce, spool, snapshots, fswatch), `./peers.ts`, `./names.ts`, `./state.ts`. `DEFAULT_SETTINGS` is imported twice (lines 14 and 31). `#applyReduction` alone (lines 305-353) touches state, subagents, exit, turn saving, places, names, homes, transcripts and snapshots.

**Proposal.** Keep `AgentTracker` as the façade the rest of the core and the tests know (`list/get/on("updated")`, the host API), and move the bodies into focused modules that take the registry as a dependency, the way `windows/` and `search/` are already laid out:

- `agents/registry.ts`: `#agents`, tree queries, `#create/#update/#remove`, persistence, events. The only writer of `Agent`.
- `agents/detect.ts`: `#onForeground`, `applyStatus`, `#drain`, `#ingest`, claiming, `tick`. Emits "events for agent X" to the next layer.
- `agents/turns.ts`: reducers per agent, `#applyReduction`, turn saving, the subagent lifecycle it drives.
- `agents/places.ts`: `#placeAfter`, `#worktreeName`, `#wrote`, with `names.ts`.
- `agents/snapshots.ts`: `#snapStart/#snapEnd`, `#snaps`, the per-checkout git service of AR1-05-04.
- `agents/host.ts`: `spawn`, `resume`, `send`, `wait`, `kill`, `moveTree`, `launchCommand`, `#expectStart`.

Prior art: VS Code's contribution layout (one folder per feature, a service interface each, 00-research §10) and this repo's `windows/types.ts` + `builtin.ts`. Add the size ratchet 00-research §9 recommends: a test that fails when any file in `agents/` exceeds 400 lines.

**Success criteria.**
- [ ] No file in `packages/core/src/agents/` over 400 lines; a ratchet test (`design-debt.json`-style) locks the counts.
- [ ] `Agent` records are mutated in exactly one module (`grep -rn 'agent.state = ' packages/core/src/agents` hits one file).
- [ ] `peers.test.ts` and `names.test.ts` construct only the module they test plus the registry, not the tracker.
- [ ] `pnpm typecheck && pnpm test` pass; `core.ts` still constructs one `AgentTracker`.
- [ ] `tracker.ts` imports `DEFAULT_SETTINGS` once.

### AR1-05-03 · Make the installed hook command build-independent and small

- **Status:** open
- **Severity:** high
- **Effort:** M
- **Where:** `packages/core/src/agents/hooks.ts:43-107`, `packages/core/src/agents/hooks.ts:192-249`, `packages/core/src/core.ts:954-975`

**Problem.** The command written into each agent config is the hook script's whole body inline (`sh -c '<1.6 KB>' '<script>' claude`), once per event: 12 entries for Claude, 10 for Codex, 8 for Gemini. The body embeds `process.execPath`, the checkout/runtime root and the flag file's path, so it differs per build and per instance: every app update and every switch between a development build and the installed app makes the installed entry `legacy` or `elsewhere`, and `#autoHooks` rewrites the user's `settings.json` again at the next start. The user's own `~/.claude/settings.json` is 25 KB with 12 copies and was rewritten today. Claude Code itself writes `settings.json` (permissions, `/hooks`, model), and `installHooks` is read-modify-write with no check that the file is still what it read: a concurrent write by the agent loses one side. The `.cmd-backup` is taken once, so it never reflects the user's later edits. On Windows (which CI packages) the command is `/bin/sh` and can never run. The inline design was chosen so a sandboxed agent that cannot read the state dir still reports (file comment, lines 6-10); that goal is met, but at a cost that grows with every release.

**Evidence.** Measured with `hookCommand("claude", …)`: 1,646 bytes; a `{model:"opus"}` settings file becomes 23,901 bytes after `installHooks` (Codex 19,903, Gemini 16,281). `hookState` returns `legacy` for "this cmd's, but older (another build …)" (line 200-201) and `#autoHooks` reinstalls on `legacy` (core.ts:960). `write()` (lines 228-238) does `realpath → backupOnce → writeFileSync(tmp) → renameSync` with no mtime/content check against the `read()` of line 243. `grep -n win32 hooks.ts` → nothing; `hooks.test.ts` is `skipIf(win32)`.

**Proposal.** Keep the inline-and-sandbox-proof property, drop the build-specific parts, so the command is one constant string per agent kind that never needs rewriting:

1. **Env-based injection.** Panes already get `CMD_PANE_ID` and `CMD_SOCKET`; add `CMD_HOOK_NODE` (the core's Node) and `CMD_HOOK_FLAG` (or fold the flag into the socket dir). The inline body references `$CMD_HOOK_NODE`/`$CMD_HOOK_FLAG` and a hook-main path derived from `$CMD_SOCKET`'s instance, not literal paths. Then `hookCommand(kind)` has no build in it; `HOOK_FORMAT` bumps only when the body's behaviour changes, and dev builds and the installed app share one entry (no more `elsewhere` between them).
2. **Shrink the body** to the spool write (about 25 lines) and move the briefing branch into `hook-main.ts`, which already knows how to answer each agent.
3. **Guard the write**: re-read and compare (mtime + bytes) just before the rename and retry once; refuse if the file changed under us. Use a lock file next to the target during the write (`settings.json.cmd-lock`), as git does for `.git/config`.
4. Register hooks in one group per event with one handler (already) and keep the per-event list in the adapter of AR1-05-05; on Windows install a PowerShell or `cmd.exe` body, or don't install and say so in Settings (belongs with the packaging/platform review).

**Success criteria.**
- [ ] `hookCommand("claude", scriptA) === hookCommand("claude", scriptB)` for two different state dirs; a test asserts the string contains no absolute path of the build.
- [ ] After `installHooks`, a `{model:"opus"}` file is under 6 KB.
- [ ] Switching between a dev core and the installed app does not change `hooks.status` from `installed` (test with two `Core`s on one home).
- [ ] A test writes the config between `read` and `write` and asserts the install refuses or retries without losing the other write.
- [ ] `hookState` no longer needs the `legacy` branch for "another build".

### AR1-05-04 · Snapshot the checkout the agent works in, once per checkout, off the core thread

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/agents/tracker.ts:403-437`, `packages/core/src/agents/activity/gitsnap.ts:31-63`, `apps/desktop/src/renderer/src/components/LiveDiff.tsx:20-77`

**Problem.** `#snapStart` snapshots `agent.cwd`, but docs/35 and `Agent.git` say agents start in the main checkout and move to a worktree by writing there: for this repository's own workflow (CLAUDE.md: "one git worktree per task") the snapshot watches `~/src/cmd` while the agent edits `~/src/cmd-topic`, so git finds nothing and `files` falls back to tool paths only; `via: "git"` coverage silently drops. Each snapshot runs three git processes and then `fs.statSync` on every listed file (up to 5,000) synchronously on the core thread; two snapshots per turn, per agent, with no sharing: ten agents in one repository run ten `git status` at about the same time. Meanwhile `LiveDiff.tsx` polls `git.status` + `git.diff` every 3 s per widget from the renderer. Two git pollers, no shared view of a checkout.

**Evidence.** `tracker.ts:404`: `const cwd = agent.cwd;` (not `agent.git?.top`). `gitsnap.ts:57`: `files.set(abs, { change, stamp: stamp(abs) })` inside the parse loop, `stamp` = `fs.statSync`. Measured here on a small clean worktree: 202 ms cold, 80 ms warm per `snapshot()`; docs/19 §3 lists "git snapshot time on the largest repositories" as unmeasured. `LiveDiff.tsx:20` `POLL_MS = 3000`. docs/18 already notes attribution is per folder with several agents.

**Proposal.** One `GitWatch` per checkout `top` in the core (next to `checkout.ts`): it owns the `.git/index`, `HEAD` and `logs/HEAD` watches LiveDiff sets up today, debounces a `git status --porcelain=v2 -z` into a cached snapshot, and serves both consumers: `LiveDiff` subscribes (push, no 3 s poll), and a turn's start/end take the cached snapshot (or request a fresh one, shared between agents whose turns start within the same second). Snapshot `agent.git?.top ?? agent.cwd`, and when `#placeAfter` moves an agent mid-turn, take a late "before" of the new checkout. Replace the sync `statSync` loop with `fs.promises.stat` in batches of 200 under `scheduler.yield()`, and log the snapshot as a scheduler activity so stalls name it. Add `agents.turnFiles` (on | tool-only) for very large repositories. Attribution across agents stays approximate (docs/18), but the per-checkout service makes "which agent's turn overlapped" a query.

**Success criteria.**
- [ ] A test: an agent whose `cwd` is the main checkout and whose `git.top` is a worktree gets `via: ["git"]` files from the worktree.
- [ ] Two agents in one checkout starting turns within a second share one `git status` (spy counts one spawn).
- [ ] `grep -n statSync packages/core/src/agents/activity/gitsnap.ts` returns nothing.
- [ ] `LiveDiff.tsx` has no `setInterval`; it updates through a core subscription.
- [ ] `scripts/perf/stress-core.mjs` with an agent turn in a 50k-file repository shows no `[lag]` line attributed to snapshots.

### AR1-05-05 · One `AgentAdapter` per kind instead of eleven tables

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/agents/procinfo.ts:25-38`, `hooks.ts:138-157`, `homes.ts:31-35`, `state.ts:22-30`, `activity/normalize.ts:24-43`, `tracker.ts:864-876`, `packages/protocol/src/names.ts:20`, `packages/protocol/src/model.ts:171`, `packages/core/src/search/builtin.ts:165-169`, `packages/protocol/src/settings.ts:335-362`

**Problem.** docs/18's principle 5 ("agent-specific knowledge is data") is honoured locally: each file has its table. But there is no adapter that gathers a kind's knowledge, so the coverage matrix is uneven and nobody can see it: Gemini has hooks and a home spec but no transcript source, no resume and no launch setting; Qwen and Copilot have transcript sources and settings keys but no hook spec, no home spec and no event mapping; OpenCode has a label and a `KNOWN_AGENTS` entry only; aider, amp, goose, crush, droid, cursor-agent are process names. `kind === "claude" | "codex" | "gemini"` branches appear 17 times in core (plus 2 outside); `launchCommand` special-cases Claude's `--session-id` while `resume` goes through `TranscriptSource.resume`, two homes for the same knowledge.

**Evidence.** `grep -rn -E '(===|!==)\s*"(claude|codex|gemini)"' packages/core/src --include='*.ts' | grep -v test | wc -l` → 17 (tracker 2, hook-main 1, state 2, normalize 1, homes 2, hooks 3, parser 1, summaries 1, transcripts 5). Tables enumerating kinds: `AgentKind`, `KNOWN_AGENTS`, `SPECS`, `HOME_SPECS`, `GEMINI_EVENTS`, `KINDS`, `HOME_ENV`, `KIND_LABELS`, `nativeSession`, `launchCommand`, `registerBuiltinSources`, four `agents.<kind>.command` settings. The `TranscriptSource` interface (`search/sources.ts:39-58`) already is half an adapter (locate, rootFor, sniff, parse, resume).

**Proposal.** `agents/adapters/<kind>.ts` exporting one `AgentAdapter`, registered in `agents/builtin.ts` the way `windows/builtin.ts` and `search/builtin.ts` register theirs:

```ts
interface AgentAdapter {
  kind: AgentKind; label: string; executables: string[];       // procinfo
  hooks?: { configFile(home): string; events: string[]; tools: string[]; timeout; eventName(raw): string; headlessEnv?: (env) => boolean };
  home?: HomeSpec;                                              // homes.ts
  session: { key: "claudeSessionId" | "codexThreadId" | …; idFromPayload(p): string | null };
  launch(settings, prompt?): { command; sessionId? };          // tracker.launchCommand
  transcripts?: TranscriptSource;                               // search/sources.ts
  normalize?: { kindOf?(name, p): ActivityKind | null; tool?(p): Partial<ActivityTool> }; // the gemini branches
}
```
`procinfo.classify`, `hooks.hookTargets/installHooks`, `homes.discover`, `normalize.kindOf`, `state.nativeSession`, `launchCommand` and `resume` read the registry. The protocol keeps `AgentKind` open (`string & {}`) and `kindLabel` falls back as now. `cmd agents coverage` gains a "supported" column from the registry, so the matrix above is visible.

**Success criteria.**
- [ ] `grep -rn -E '(===|!==)\s*"(claude|codex|gemini)"' packages/core/src --include='*.ts' | grep -v '/test/\|/adapters/'` returns nothing.
- [ ] Adding a kind means one new file under `agents/adapters/` plus its settings key; a test registers a fake adapter and sees it in `classify`, `hookTargets`, `homes.discover` and `launchCommand`.
- [ ] `hookEventName`, `GEMINI_EVENTS`, `HOME_ENV`, `SPECS` and `HOME_SPECS` no longer exist as free-standing tables.
- [ ] `cmd agents coverage --json` reports per kind which capabilities the adapter declares.

### AR1-05-06 · Put every state transition through one reducer, and test it as a table

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/agents/tracker.ts:127-132`, `tracker.ts:176-202`, `tracker.ts:311-318`, `tracker.ts:457`, `tracker.ts:510-513`, `tracker.ts:572-580`, `packages/core/test/state.test.ts`

**Problem.** `reduce.ts` is explicit and pure for hook events, which answers half the question. The other half of the state machine is in the tracker: `starting → idle` when the process appears, `→ exited`/removed when the shell returns, OSC notify `→ needs_input` while unhooked, `SessionEnd` exits only if the process is gone, subagent `working/done/removed`, and the 15 s start timeout. These transitions are direct `#update(a, { state })` calls, never events, so they are not in the log, not replayable, and not covered by `rebuild()`: a replay of an agent's events cannot tell when the process came and went, and `activity.ts:231` has to guess `kind` and `cwd` from the first events. The flags that qualify those transitions (`#hooked`, `#started`, `#wrote`, `#told`) are in memory, so a core restart forgets them: until the next hook event an OSC notification can flip a hooked agent to `needs_input` again. Tests are scenario prose; there is no table that says, for each `(state, event kind)`, the next state and cause. `state.test.ts` tests `describeTool` only.

**Evidence.** `grep -n 'state: "' tracker.ts` → 6 direct state writes (lines 131, 182, 457, 510, 513, 555) besides the reducer's. `forget()` and `restore()` rebuild `#started` but not `#hooked` (line 647 vs 648: `applyStatus` sets it only if the spool has something). `activity.test.ts` "reduce" block: 9 scenario tests, none enumerates transitions.

**Proposal.** Treat detection as events (docs/18 principle 4 applied to the process): the tracker records `agent.note`-style events `process.start {kind, version, pid}`, `process.exit`, `osc.notify {text}` and `start.timeout` into the same log and feeds them to the same `ActivityReducer`, which owns `starting/idle/exited` as well. `#hooked` becomes "the reducer has seen a hook event" (a field on the reducer, persisted with the turn), `#started` becomes "has seen `process.start`". `rebuild()` then replays the full story and `restore()` needs no special cases. Write `TRANSITIONS` as data in `reduce.ts` (`Record<State, Partial<Record<ActivityKind, Next>>>`) and one table test (`reduce.table.test.ts`) that iterates it; keep the timing rules as the three named constants with their own rows. VS Code's Agent Host does exactly this (pure reducers over an ordered action stream, snapshot then actions; 00-research §1).

**Success criteria.**
- [ ] `grep -n 'state: "' packages/core/src/agents/tracker.ts` (or its successor modules) returns nothing outside `reduce.ts`.
- [ ] `reduce.table.test.ts` exists and covers every `(state, kind)` pair the table declares, with the cause string.
- [ ] A recorded session with process events replays to the same state sequence live and through `ActivityView.replay` (a test asserts equality).
- [ ] After `forget()`/`restore(live)`, an OSC notification on a hooked agent does not change its state (test).
- [ ] `state.test.ts` either covers `state.ts` or is folded into the table test.

### AR1-05-07 · Stop a reducer failure from repeating every two seconds

- **Status:** open
- **Severity:** medium
- **Effort:** S
- **Where:** `packages/core/src/agents/tracker.ts:278-286`, `tracker.ts:260-272`, `tracker.ts:291-303`

**Problem.** When `red.apply(ev)` throws (the catch names "a turn saved by another version", i.e. a downgrade), the tracker logs an error, deletes the reducer and breaks. On the next tick (2 s) `#ingest` finds no reducer, claims again, resumes from the last saved turn (`replayedTo = last_seq`), filters to events after it, and hits the same event: the same throw, the same `log.error`, forever, and the agent never gets state from events again. Nothing records the failure in the log, so `cmd agents events` shows nothing wrong.

**Evidence.** `tracker.ts:283-284`: `this.#reducers.delete(agent.id); break;` with no advance of `replayedTo`. `#reducerFor` (292-303) always resumes from `activity.lastTurn(agent.id)`, which the failing event never updated because `saveTurn` runs inside `#applyReduction` after `apply`. No test feeds a poisoned event.

**Proposal.** On failure: record an `anomaly` note with the event id and error, mark the reducer past the event (`red.replayedTo = ev.id`; `saveTurn(red.turn ?? emptyTurn, ev.id)` so the restart path skips it too), keep the reducer, and continue with the next event. If the saved turn itself can't be decoded (the version case), start a fresh reducer at `index + 1` instead of giving up: `decodeTurn` already returns null for a bad doc.

**Success criteria.**
- [ ] A test injects an event that makes `apply` throw and asserts: one `anomaly` event, one log error, and the following event reduces normally.
- [ ] After a restart with a turn doc of an unknown format, the agent still gets state from new events (test with a hand-written `turns` row).
- [ ] `grep -n 'reducers.delete' tracker.ts` appears only in `#remove`/`forget`.

### AR1-05-08 · Fewer writes and scans per hook event

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `packages/core/src/agents/tracker.ts:816-819`, `tracker.ts:324-328`, `tracker.ts:836-839`, `packages/core/src/data/views/activity.ts:124-130`, `activity.ts:140-145`

**Problem.** Each hook event costs three synchronous SQLite writes on the core thread: the event (`insert`), the turn (`saveTurn` on every `r.turn`, i.e. every tool call) and the agent (`saveAgent` from `#emitUpdate`, because `detail` changes with every tool). Every `PostToolUse` also runs `#startOf`, a `json_extract` over the pane's last day of hook rows to find its `PreToolUse`. `#byPane` is a linear scan over all agents and is called from `tick()` for every agent every 2 s. None of this shows in the stall log today, but it is the kind of per-keystroke work docs/34 asks to keep bounded, and busy Claude sessions emit two or three events a second.

**Evidence.** `#update` → `#emitUpdate` → `this.#store?.saveAgent(agent)` on any dirty field (line 813-818); `saveTurn` in `#applyReduction` (326) runs whenever `r.turn` is set, which `reduce.ts` sets for every `tool.start`/`tool.end`. `#startOf` filters by `json_extract(data, '$.payload.tool_use_id')` with only `(type, at)` indexed (`data/schema.ts:12`). `grep -c '#byPane' tracker.ts` → 9.

**Proposal.** Persist the agent row only when `state`, `name`, `paneId`, `native`, `git` or `cwd` change (the fields restore reads), not on `detail`; save the turn at open, close, every 20 events and on `tick`; keep a `paneId → agentId` map in the registry; add a generated column or a `links` row for `tool_use_id` so `#startOf` is an index lookup. Measure with a counter in the tests.

**Success criteria.**
- [ ] A test counts `Store.saveAgent` calls over a recorded session: at most one per state change, none for `detail`-only updates.
- [ ] `saveTurn` calls over the Claude fixture are under 10% of its events.
- [ ] `#startOf` uses an indexed column (EXPLAIN QUERY PLAN shows no table scan).
- [ ] `#byPane` is O(1).

### AR1-05-09 · Persist the namer's state so a restart or resume doesn't ask again

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `packages/core/src/agents/naming.ts:42-46`, `naming.ts:88-90`, `packages/core/src/agents/namer.ts:189`

**Problem.** `AgentNaming` keeps `NameState` (tries, pending change, history) in memory per agent id. A core restart with unnamed agents starts their `FIRST_TRIES` (6 questions, each up to 2 calls) over; `agent.resume` mints a new agent id for a session that already has a name in the sessions view, and asks again. docs/32 says the name belongs to the session, and the sessions view stores it, but the namer never reads it back. There is no cap on calls per hour across agents; the eval's 0.39–0.43 calls per turn is per session, not a budget.

**Evidence.** `naming.ts:90`: after a restart "what the agent already has stands in for the remembered state" only when `a.name` is set; an unnamed agent gets `NO_NAME`. `resume()` in `tracker.ts:583-593` creates an agent with `name: null` and never consults `sessions` for the session's name.

**Proposal.** Keep `NameState` in the turns view (one `names` table keyed by `agent:<session>`), seed a resumed agent's name and state from the sessions view by `sessionId` in `restore()`/`resume()`, and route every call through the AI service's per-purpose budget (see the AI system's doc for the budget itself).

**Success criteria.**
- [ ] A test: resume a session whose sessions-view row has a name; the agent starts with that name and `nameBy`, and `ai.object` is not called.
- [ ] A test: restart with an unnamed agent after 3 tries; it has 3 tries left, not 6.
- [ ] `NameState` survives `core.close()`/`new Core()` on the same `CMD_HOME`.

### AR1-05-10 · Retire the legacy `cmd hook` path and its flag

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `packages/cli/src/main.ts:452-476`, `packages/core/src/agents/tracker.ts:468-486`, `packages/core/src/agents/hooks.ts:169-170`, `hooks.ts:14,31`

**Problem.** Two ingestion paths exist for one thing: the spool (every installed hook since `HOOK_FORMAT` 2) and `hook.ingest` with `spooled: false` for the old `cmd hook <kind>` CLI entry, which `#autoHooks` replaces on sight (`legacy`). `ingestHook` carries the branch for both plus the `SessionEnd` special case; `hook-main.ts` passes `spooled` as a positional word; `hooks.ts` keeps `legacy()` matching. The old path also skips `claim()`, so its events can't be attributed later. It is dead weight that a reader has to understand before the live path.

**Evidence.** `main.ts:154`: `if (cmd === "hook") return hook(pos[0] ?? "claude");` and `main.ts:452-476`. `tracker.ts:471-475` vs `476-485`: two bodies. `ingestHook` is also what `tracker.test.ts` uses to inject events (lines 61, 70-71), so the method stays as a test seam.

**Proposal.** Remove the `hook` CLI command (keep `hooks`), make `hook.ingest` spool-only (drop `spooled`), keep `ingestHook` as an internal test API that writes to the spool directory used by the test, and keep `legacy()` in `hookState` for one more release so old entries are still replaced. Also delete the duplicate `DEFAULT_SETTINGS` import in `tracker.ts`.

**Success criteria.**
- [ ] `cmd hook` prints the usage error; `COMMANDS` in `main.ts` has no `hook`.
- [ ] `Methods["hook.ingest"].params` has no `spooled`; `ingestHook` has one body.
- [ ] `tracker.test.ts` still passes using the spool (or an explicit test helper).
- [ ] `grep -c DEFAULT_SETTINGS tracker.ts` → 1.

## Course corrections

1. **Reduce by (pane, kind) and record detection as events** (AR1-05-01, AR1-05-06): the two correctness holes share a cause, that the tracker decides state outside the reducer and by pane alone. Closing them makes the event log the whole story, which is what docs/18 promised and what rebuild and restore already assume.
2. **Split the tracker along its seams** (AR1-05-02, then AR1-05-07 and AR1-05-08 fall out of the `turns` and `registry` modules): every planned feature in this area (docs/31 rules, docs/29 briefings, Codex thread spawns) lands here, and the class is already the most-churned file of the folder.
3. **Make the hook command a constant** (AR1-05-03): it stops rewriting users' agent configs on every release, ends the dev-vs-installed tug of war, and removes the `legacy`/`elsewhere` machinery, which AR1-05-10 then deletes.
4. **One adapter per agent kind** (AR1-05-05): the matrix of what each agent gets is invisible today; a registry makes Gemini's missing transcripts and Qwen's missing hooks a one-file task each, and gives the hook installer and the home scanner one source.
5. **A git service per checkout** (AR1-05-04): fixes the worktree miss for this repo's own workflow and gives LiveDiff, turns and docs/31's "two agents on one file" rule the same view of a repository.

## Quick wins

- AR1-05-01 (the skip in `#ingest` and the kind check in `#onForeground`; the virtual child can follow)
- AR1-05-07
- AR1-05-08
- AR1-05-09
- AR1-05-10
