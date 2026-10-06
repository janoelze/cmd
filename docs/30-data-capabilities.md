# What the data model makes possible

> Status (2026-10-06): a map of what cmd can do now that everything it sees is one event log ([28](28-data-plan.md), built), and what that won compared to before ([25](25-data-model-critique.md)). For people deciding what to build next. Every "possible" feature below lists what already exists and what is missing, usually a screen.

## What cmd knows now

One log of facts (`$CMD_HOME/data/events.sqlite`), each with the same envelope: when, what type, who produced it, which Space, project, session, agent, pane and window it belongs to, a one-line text, a typed payload, and big content as a compressed blob.

| What | Events | Kept |
|---|---|---|
| Every agent hook event: prompts, tool calls with inputs and results, questions, stops, failures | `agent.hook`, `agent.note` | a year |
| cmd's own copy of every agent session (Claude Code, Codex, Qwen, Copilot), line by line | `transcript.*` | a year |
| When an agent's pane was printing, and what each turn printed | `pane.activity`, `agent.output` | a year / 90 days |
| Every shell command in a terminal: line, folder, exit code, how long, **what it printed** | `command` | 90 days for output |
| Git: commits, merges, branches, checkouts, tags, rebases, resets, per worktree | `git.*` | forever |
| Pages browser windows showed, files opened, windows and Spaces opened and closed | `browser.visit`, `file.open`, `window.*`, `space.*` | a year |
| What **you** did: which pane or window had focus and for how long, which commands you ran, which agents you looked at | `user.focus`, `user.command`, `user.look` | a year |
| Notifications shown, notes written down | `notification`, `note` | forever |
| Every model call cmd made: purpose, model, tokens, what was sent and what came back, and what the input was built from | `ai.call` | a year |
| Remote access: pairings, sessions, refusals | `remote.audit` | 90 days |

Around the facts:

- **Entities with links**: agents (kind, model, version), sessions (title, folder, branch, span), projects (path, name, git remote), panes, windows, Spaces; an agent *runs* a session, *ran in* a pane, is a *child of* another agent, is *in* a project.
- **Views**, derived and rebuildable: turns (one row per prompt with outcome, tools, files, final answer), sessions, full-text search over everything with words in it, journal days and weeks.
- **One query shape** for the app, the CLI, agents and widgets, **live queries** over events and views, and **one context builder** for every model call.
- **Privacy built in**: redaction before anything is stored, "Never record" rules for folders, hosts and commands, `cmd data forget` for a session or a project, retention per class, all visible in Settings → Data and `cmd data explain`.

## What we won

| Before | Now |
|---|---|
| Four logs (activity, journal, command list, search index), each with its own copy of the same facts | One log; everything else is a view of it |
| Raw agent events kept 14 days, clipped copies 180: history couldn't be derived again | Raw events a year; turns, sessions and search rebuild from them at any time (`cmd data rebuild`) |
| Turns frozen by the rules of the cmd that wrote them; inferred interrupts lost on a rebuild | A rebuild replays the reducer and its timing rules against recorded terminal activity: the same turns the live core saw |
| Transcripts were the agents' files; a deleted or rewritten file lost the session | cmd owns a copy; search, summaries and the journal read it |
| Commands in memory, 300 runs, no output | Every command with what it printed, for months |
| Nothing about what the person did | Focus, commands run, agents looked at |
| Space attached later by guessing from folder paths; two journal APIs disagreed about a Space's events | Space, project and session recorded with every event when it happens |
| 120 RPC methods, each a query someone wrote for one feature | One query (`data.query`), live (`data.subscribe`, `data.subscribeView`), plus the old methods as thin views |
| Polling: the Journal widget every 15 min, Resources every 2 s | Live queries push changes |
| Credentials in commands stored as typed for 180 days and sent to models | Redacted before storage and again before any model call; patterns tested on 1.9 GB of real transcripts |
| Each AI feature built its own input; nothing recorded what was sent | One context builder; every call recorded with its input, output, cost and what was cut |
| Agent state derived twice (status files and the reducer), repositories detected four ways | One of each |
| 352 MB search index beside a 19 MB database, no way to say what's kept | One 1.6 GB file of facts for 3.5 months of heavy use, a disposable views file, a retention policy you can read |

## Features this makes possible

Grouped by how much is missing. "Has" is what exists; "needs" is the work.

### Only a screen away

**Agent Activity, for real.** Per agent: its turns as they happen, what each asked, the files it changed, what its terminal printed, how long, how it ended; for agents that have exited too.
Has: the turns view with live queries (`data.subscribeView {view: "turns", agentId}`), `agent.output`, entities. Needs: the widget's detail view.

**While you were away.** Coming back to the Mac or a Space: "3 agents finished, 1 waits on you since 14:32 (wants to run `rm -rf dist`), the build you started failed after 4 min." 
Has: `user.focus` spans (when you were last here), turns since then, command events with exit codes. Needs: a sheet, and optionally the fast tier for one line per agent.

**Search everything.** One field over sessions, commands and their output, commit messages, pages, files, notes and journal entries, filtered by project, Space or time.
Has: the log's full-text index and `data.query {text, projectId, at}`. Needs: result rows per type in the palette.

**Project pages.** One page per repository: its sessions and agents, branches and merges, releases, the commands that failed, the journal's days for it, where it lives and its remote.
Has: project entities with links, every event carries `projectId`. Needs: the page.

**Usage and cost.** Model calls by feature and model (tokens, failures, how often input was cut), agent turns per day and project, agents by model.
Has: `ai.call` with context records, turns, `cmd data ai`. Needs: a widget; the dataviz is the work.

**Time per project.** How long you spent where, from focus spans and agent work, by day and week (ActivityWatch's model, without a separate app).
Has: `user.focus` (spans), `pane.activity`, `projectId` everywhere. Needs: the rollup and a view.

### Small features on the new primitives

**Notifications that know context.** "The test you ran ten minutes ago passes now." "The agent finished the branch you have open." "This build fails the same way it did at 11:02."
Has: commands with exit codes and output, turns, focus, live queries in the core. Needs: a few rules over those (no model needed for most).

**Command history that remembers what happened.** `⌃R`-style search over every command you ran anywhere, with its exit code, folder and output, and "run it again here".
Has: `command` events with output. Needs: a palette mode.

**Failed-command explainer.** A command fails: one click sends its line, its output and the folder's recent commits through the context builder to the fast tier: "the port is taken by the dev server in pane 3".
Has: output, git, panes, the context builder. Needs: the action and its prompt.

**Handoffs and standups.** "Write what I did today for the team channel." "Summarise this branch for the merge request." Built from the journal's days, the branch's commits and the sessions that built it, with sources.
Has: journal days and weeks, entity links, summaries. Needs: two prompts and a copy button.

**Widgets about your own work, made with Magic.** "Commands that failed today", "what the agents changed in this repo this week", "my longest sessions", "pages I read about Stripe".
Has: `events()` in a widget's data.ts, read-only and bounded. Needs: nothing; the Magic prompt documents it. Good examples for the Widget Library.

**Agent replay.** Step through a past turn: prompt, each tool call with its input and result, the screen output, the files it changed.
Has: hook events with whole payloads as blobs, `agent.output`, the transcript. Needs: a timeline view.

**Rule changes measured on real history.** Change the interrupt rule or the threading rules, rebuild, compare against the old turns or days on months of real data.
Has: `cmd data rebuild turns`, the journal eval harness. Needs: a diff script per view.

### Bigger features the model was built for

**Memory and recall** ([29](29-memory.md)). "Why did we drop deflate?" "Where did we leave the flaky test?" Facts that expire rather than vanish, each with the events it came from; per-project notes every agent gets; `cmd recall` and an MCP tool so any agent can ask.

**Agents reading cmd.** An agent asks cmd what the other agents in its repository did today, which commands failed in its folder, what the person was looking at. Through `cmd data query`, the journal, an MCP server.

**Cross-session continuity.** A new session in a project starts with a short brief: what the last sessions did, what's still open, what failed. From turns, the journal and memory, through the context builder, within a budget.

**Team and multi-device, later.** The envelope has `deviceId` and the person as an entity; `cmd data export` writes portable JSONL; the remote relay already moves data between devices. A shared, opt-in project log is a sync layer on top, not a new model.

## Examples, today

What you can ask from a terminal right now:

```sh
cmd data query --type command --since 1d --text "test"        # every command mentioning test today, with exit codes
cmd data query --type git. --since 7d --project ~/src/cmd       # a week of git in one repository
cmd data entities agent <id>                                    # an agent: model, version, pane, project, session
cmd data entities project dir:$HOME/src/cmd                     # a project and what links to it
cmd data subscribe --view turns --agent <id>                    # an agent's turns as they happen
cmd data subscribe --type notification                          # notifications as they're sent
cmd data ai --since 30d                                         # model calls by purpose: calls, tokens, cuts
cmd data rebuild turns                                          # turns again from the log, with today's rules
cmd journal week                                                # this week's main threads of work
cmd data forget --session claude:<id>                           # gone for good, and never recorded again
cmd data explain                                                # what's kept, for how long, what leaves this Mac
```

From a widget's data.ts:

```ts
import { events } from "cmd";
const failed = (await events({ types: ["command"], at: [Date.now() - 86400_000, Date.now()] }))
  .filter((e) => typeof e.data.exitCode === "number" && e.data.exitCode !== 0);
```

From the app (renderer), a live list:

```ts
subscribeView({ view: "turns", agentId }, (rows, initial) => …);
subscribeData({ types: ["command"], spaceId, order: "desc", limit: 300 }, (events, initial) => …);
```

## Limits worth knowing

- **Agents without hooks** (aider, amp, plain ssh) give processes, OSC marks, commands and git, but no prompts or tool calls unless their transcripts are a format cmd reads.
- **Turn output is a terminal's output**: escape codes stripped and redraws collapsed, but a TUI's screen is not a clean log; the transcript is the better source for what an agent said.
- **The agent's current state** is restored from its snapshot after a restart (fast); `ActivityView.replay` derives it from the log on demand, but nothing uses that at startup yet.
- **Size**: about 2.5–3 GB a year of heavy use on the author's Mac, mostly transcripts and command output. Retention per class and "Never record" are the levers.
- **Views are disposable, facts are not**: deleting `data/views.sqlite` costs a rebuild; deleting `data/events.sqlite` loses history. Back up the one file.
