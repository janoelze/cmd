# Context-aware notifications

> Status (2026-10-06): **handoff, not built.** A plan for the next agent: notifications that know what happened around them ("the test you ran 10 minutes ago passes now", "the agent finished the file you have open"), built as rules over the event log ([28](28-data-plan.md), [30](30-data-capabilities.md)). Read first: this doc; `packages/core/src/notifications.ts`; the copywriting skill's Notifications section (`.claude/skills/copywriting/SKILL.md`); docs/30's table of what cmd records. Work in a worktree with its own `CMD_HOME` (CLAUDE.md).

## What exists

Every notification goes through `NotificationCenter` (`core/src/notifications.ts`): the core decides what's worth telling, sets the terminal's attention marker, and emits an `AppNotification`; the renderer decides whether to show it (`notifications.when`: always, only in the background, never), with sound and Dock bounce. Each one is also an event in the log (`notification`), and the Notifications widget lists them from there.

| Source | When | Setting |
|---|---|---|
| `agent-input` | an agent needs you (a permission, a question) | `notifications.needsInput` |
| `agent-done` | an agent finished a turn, or stopped on an error | `notifications.done`; body written by the fast tier with `notifications.ai` |
| `bell` | a terminal rang the bell | `notifications.bell`, `notifications.visualBell` |
| `terminal` | a program asked for one (OSC 9, 777, 99) | `notifications.terminalSequences` |
| `command` | a command that ran longer than N seconds ended | `notifications.longCommand` (seconds; 0 is off) |
| `cli` | `cmd notify`, and things cmd did by itself (`info`) | — |
| `widget` | a Magic widget's data.ts called `notify()` | `notifications.widgets` |
| `summary` | a session summary is written | — |
| `timer` | a Timer widget ran out | — |

Each looks at one thing as it happens. None knows what came before, what you're looking at, or how two things relate. That is what the log now makes cheap.

## Principles

From the copywriting skill, and what context adds:

1. **Only when it matters.** One notification per event, no reminders for the same thing. A rule that fires more than a few times a day for one person is a bad rule.
2. **Never about what you're looking at.** If the pane, window or agent it's about has the focus now (`user.focus`), mark it and don't notify. The renderer's `notifications.when` stays the last word.
3. **Say why.** Context is the point, so the body says it: "failed at 14:02, passes now", "you have calc.py open". Every notification keeps the evidence (the event ids it came from) so the UI can answer "Why this?".
4. **Honest urgency.** Needs you is urgent. Something you asked about or had open is informative. Things cmd noticed by itself are quiet.
5. **Rules, not a model, decide.** Every trigger is a query over events with a threshold. A model may word the body (as `notifications.ai` does), never decide whether to send.
6. **Quiet until proven.** New rules ship after a dry run over real history (below) shows how often they'd fire; noisy ones default off.

Title: subject · state, as today ("cmd · test passes", "calc.py · changed by an agent"). Body: one line, at most ~70 characters, the result and the reason.

## Catalogue

Each with its trigger, the data it reads, an example, urgency, and a proposed default. "Has" = already recorded; nothing here needs new capture unless it says so.

### Commands and tests

**1. A command that failed passes now.** The same command line in the same folder failed earlier (within 4 h), and now exits 0. Most useful for tests and builds you rerun after a fix (yours or an agent's).
Data: `command` events (line, cwd, exit code, at). Match on the normalised line (whitespace, trailing flags like `--watch` out) and folder.
"pnpm test · passes now" / "Failed at 14:02 and twice since." Informative. **On.**

**2. A command that passed fails now.** The same line in the same folder passed in its last run (within 24 h) and fails now. A regression signal, especially after an agent's turn changed files there.
Data: `command`, plus the turns that changed files in that project since the last pass.
"pnpm test · fails now" / "Passed at 11:40. Since then claude changed 3 files." Urgent if an agent's turn is in between. **On.**

**3. A long command took unusually long.** Today's long-command notification, with history: "took 4 min, usually 40 s" (median of its last 5 runs). Only adds a line to the existing notification; no new one.
Data: `command` durations. **On (as part of the existing one).**

**4. A command's output says what's wrong.** A failed command whose output matches a known cause: port in use (and which pane holds it), disk full, permission denied, command not found, out of memory, a lock file left behind.
Data: `command` output (the blob), panes and their commands for "which pane holds port 5173". Pattern table, no model.
"pnpm dev · failed" / "Port 5173 is taken by the dev server in “web”." Informative. **On.**

**5. A long-running process died while you were elsewhere.** A command that had been running for more than 10 minutes (a dev server, a watcher) exits non-zero while you're focused on something else.
Data: `command` (span, exit code), `user.focus`. Urgent. **On.**

### Agents

**6. An agent changed something you have open.** A turn ends that changed a file open in a text or Markdown window, or the branch checked out in the folder of the pane you're focused on.
Data: turns (`files`), `window.*` and window state (open paths), `user.focus`, the checkout of the focused pane's folder (`checkout.ts`). Through `data.subscribeView {view: "turns"}` in the core.
"calc.py · changed by claude" / "The window you have open is out of date." Informative. **On.**

**7. Two agents worked on the same file.** Turns of two different agents changed the same path within 15 minutes. The git-only attribution caveat (docs/18) applies: only `via: tool` files count, so the agent's own edits.
Data: turns' files with `via`. "panes.ts · 2 agents" / "claude and codex both edited it in the last 15 min." Urgent. **On.**

**8. An agent says it's done, but its last check failed.** A turn ends `done` while its last test or build command in that turn exited non-zero (from `PostToolUse` of a shell call with an exit code where the agent reports one, or the turn's `commands` matched against `command` events of that pane). The honesty check.
Data: `agent.hook` tool results, turns. "cmd · done, but tests failed" / "Its last pnpm test exited 1." Urgent. **On**, after the dry run checks it isn't noisy for agents that run tests expecting failure (TDD).

**9. An agent keeps failing the same thing.** In one turn, the same shell command (normalised) failed 3 times or more.
Data: `agent.hook` tool calls and results in the turn. "cmd · stuck on pnpm build" / "Failed 4 times in this turn." Informative. **Off** until the dry run.

**10. A stopped agent can go on.** A turn failed on a usage limit with a reset time ("resets Oct 7, 3 am"); when that time passes, one notification for all agents stopped that way.
Data: turns (`outcome: failed`, `error`, the parsed reset time). Needs a timer in the rule engine. "claude · available again" / "2 sessions stopped on the limit can go on." Informative. **On.**

**11. An agent finished and you never looked.** An agent finished more than an hour ago and there's no `user.look` for it since; notified once, when you next open its workspace (not on a timer).
Data: turns, `user.look`, `user.focus`. Quiet (marker in the sidebar plus one toast, no system notification). **On.**

**12. Background work an agent left running finished.** Claude ends a turn with `background_tasks`; a later auto turn reports it. Today that's a second "done"; say it's the background work: "cmd · background task done" / "The test run it left running passed."
Data: turns (`background`, `auto`). Improves `agent-done`'s wording; no new rule. **On.**

### Git and branches

**13. A branch you worked on shipped.** A branch you or an agent committed to (in this workspace's projects) was merged into the default branch, or shipped in a tag.
Data: `git.merge`, `git.tag`, `git.commit` (branch), the journal's threads (release ships the branches merged since the last tag). "dnd · merged" / "Shipped in v0.14.4." Quiet. **On.**

**14. Work left behind.** An agent's process exited (agent removed) while its worktree has uncommitted changes, and nothing happens there for 30 minutes.
Data: `agent` entity (cwd), `checkout.ts`, a `git status` at that moment (the only rule that runs git). "cmd-dnd · 4 files not committed" / "Its agent exited an hour ago." Quiet. **Off** until the dry run.

### Your attention

**15. While you were away.** You come back (focus after more than 30 minutes without any) and things happened: one notification summing it up, opening a "While you were away" sheet (a separate feature, docs/30).
Data: `user.focus` gaps, turns, notifications sent meanwhile, failed commands. "While you were away" / "3 agents finished, 1 needs you, 1 build failed." Informative. **On** once the sheet exists.

**16. Focus drift (opt-in).** You've been in a workspace for 2 hours that isn't the one with agents waiting on you. Off by default; it's coaching, not news.

### cmd itself

**17. An AI feature keeps failing.** 3 or more failed `ai.call`s for one purpose within an hour (a refused key, a model a provider dropped, a schema error), once a day. This would have caught the `minimal` effort and schema errors in the dev logs of 2026-10-05.
Data: `ai.call` (ok, error, purpose). "Notifications · can't be written" / "OpenAI refuses the request: check Settings → AI." Informative. **On.**

**18. AI spend crossed a limit you set.** Daily tokens (or cost, where the provider reports it) over a threshold in Settings.
Data: `ai.call` tokens. Off unless a limit is set.

**19. Someone tried to pair, or a device was refused** while you were away from the Mac.
Data: `remote.audit` (`pair-denied`, `handshake-failed`, `denied`). Urgent for pairing attempts. **On** when remote access is on.

**20. The journal wrote your day** (opt-in, at the end of a work day). Quiet. **Off.**

## Design

### A rule engine in the core

`packages/core/src/notify/` (new), next to `notifications.ts`:

```ts
interface Rule {
  id: string;                      // "command.passesNow"
  setting: SettingKey;             // its switch, e.g. "notifications.smart.passesNow"
  /** What wakes it: event types (via DataService "recorded"/"batch"), view changes (turns, sessions), or a time it asked for. */
  on: { events?: string[]; views?: ("turns" | "sessions")[] };
  /** Decide from the trigger and the log; null: nothing to say. Pure apart from reading `ctx`. */
  check(trigger: Trigger, ctx: RuleContext): Notice | null;
}

interface Notice {
  key: string;                     // dedupe: one notification per key, ever (or per cooldown)
  subject: { paneId?; windowId?; agentId?; projectId? };   // for "is it focused?" and the attention marker
  title: string; body: string;     // the copywriting skill's shape
  urgent: boolean; quiet?: boolean;
  evidence: string[];              // event ids, for "Why this?"
}

interface RuleContext {
  data: DataService;               // data.query, store.entityOf
  turns(q): TurnRow[]; sessions(q): SessionInfo[];
  focus(): { workspaceId; paneId?; windowId? } | null;   // from the core's #focus (user.focus)
  openFiles(): string[];           // text/Markdown windows' paths
  checkout(dir): Checkout | null;
  at(time, ruleId, payload): void; // a timer (rule 10's reset time)
  now(): number;
}
```

- The engine subscribes in-process: `data.on("recorded" | "batch")`, `activity.onTurn`, `sessions.onChange`. No RPC; rules run in the core where the data is.
- **Dedupe and cooldown** per `key` (kept in memory and as the notification event, so a restart doesn't repeat one); a **cap** per rule per hour; suppression when `subject` is focused now.
- Notices go through `NotificationCenter` (a new method, `contextual(n)`, with a new `source: "context"` and the rule id), so the attention marker, the renderer's `notifications.when`, the log and the widget work unchanged.
- The `notification` event's payload gains `rule` and `evidence`; the Notifications widget shows "Why?" from them.
- `notifications.ai` can word the body through the context builder (the evidence events as parts), with the same short wait and fallback as `agent-done`.

### Settings

A section **Smart notifications** on the Notifications page: one switch per rule group (Commands, Agents, Branches, cmd itself), defaults as above. Settings keys under `notifications.smart.*`, added to `SETTINGS_SCHEMA` and `settings/layout.ts` (a test checks placement).

### The dry run (do this first)

Before any rule ships, run it over real history and read what it would have said:

```sh
cmd notify rules --dry-run --since 14d [--rule command.passesNow]
```

It replays the log in order through the engine with a fake clock and focus from `user.focus`, and prints each notification it would have sent, with its evidence and a count per rule per day. That's how thresholds (4 h, 3 failures, 15 min) get chosen and how noisy rules are caught. Keep the output out of the repo; it's real commands and prompts.

## Order of work

1. **Engine and dry run**: the rule interface, dedupe, focus suppression, `cmd notify rules --dry-run`; no notifications sent yet.
2. **Commands** (1, 2, 3, 4, 5): the cheapest and least ambiguous. Tune on a dry run of the author's last two weeks.
3. **Agents** (6, 7, 8, 10, 11, 12): via the turns view.
4. **cmd itself** (17, 19), **Branches** (13).
5. **"Why this?"** in the Notifications widget, AI wording through the context builder.
6. The rest (9, 14, 15 with the "While you were away" sheet, 16, 18, 20) after the dry run says they're worth it.

Each step: tests that feed events into the engine with a fake clock (`packages/core/test/notify-rules.test.ts`), the dry run on real data, then e2e once at the end.

## Open questions

1. Command identity for rules 1–3: normalise how much (flags, paths, `npm` vs `pnpm`)? Start with exact line plus folder; widen from the dry run.
2. Rule 8 needs an exit code from the agent's shell call: Claude's `tool_response` has it, Codex's doesn't (docs/18). Codex falls back to matching the turn's commands to `command` events, which only exist for panes without an agent. Accept Claude-only first?
3. Should rules 6 and 7 look at files changed by git (`via: git`) too? More recall, worse attribution with several agents in one repository.
4. Where does "Why this?" live: the Notifications widget only, or also the system notification's action button?
5. Per-project overrides (mute smart notifications for one repository)?
