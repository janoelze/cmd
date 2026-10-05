# Session summaries

> Status (2026-10-05): built (branch `summary`). Tested against real Claude Code and Codex sessions (4 minutes to 8 hours, 10 to 283 messages) on gpt-5.4-mini: facts in the file within ~150 ms, the full summary in 2–12 s.

Right-click an agent's title bar (or the sidebar row, or Session → Summarize Session) and a Markdown window opens next to it with a summary of what the session did. It is written to be edited and passed on: to the team chat, into a ticket or merge request, or to yourself next week. The first of the AI features in [17-ai.md](17-ai.md), on the data from [18-agent-activity.md](18-agent-activity.md).

## Experience

1. **The menu item exists only with an AI provider.** The title bar menu reads `aiStatus()` when it opens, so a key added in Settings → AI shows the item on the next right-click; a key the provider refuses hides it. The menu bar item is disabled instead (menu bar items are fixed; `MenuState` has no `visible`).
2. **The window opens at once,** in the agent's Space, with what cmd knows without a model: title line, agent, project, branch, when, prompts, files changed, and "Summarizing 12 prompts with gpt-5.4-mini…".
3. **The answer streams into the file.** `ai.object` with `onPartial` streams the structured answer; every partial is rendered to Markdown and written (at most every 200 ms). The Markdown window already re-renders a watched file in place, keeping the scroll, so no new UI was needed: a summary is a file, editable with ⌘E, readable by agents and the CLI.
4. **When it's written,** a notification ("Summary ready") with the summary window as its `windowId`. The UI's usual rule shows it only if you looked away (`notifications.when`), and clicking it brings the window forward. A failure is written into the file and notified the same way.
5. **Copy Team Update / Copy for Ticket** in the Markdown window's menu copy a part of the file, found by its headings (`summaryPart` in `protocol/src/summary.ts`), so they copy what you edited.

Why not a toast: macOS notifications can't be updated, and a toast saying "generating" is noise when the window itself shows progress. Why not a widget: the file plus the existing Markdown window give live rendering, editing and CLI access; a widget would add a window type, stored summaries and an event for the same result. A widget can come later as another view over the same core service.

## Inputs

| What | From | Used for |
|---|---|---|
| The conversation in order | the transcript (`parseClaude`/`parseCodex` with an `out` list; the index doesn't use it) | the model |
| Prompts, commands, finals, errors | the session's recorded turns, when there's no transcript | the model |
| Files changed | the turns (git, folder watch, tools), else the files of the commits made since the session began | rendered by code |
| Commits since the session began | `git log --since` | the model only ("some may be others' work") |
| Branch, cwd, times | the transcript, else git and the turns | rendered by code |

Claude reports a finished background task (a subagent) as a prompt (`<task-notification>`); it becomes an assistant message with the subagent's summary and result, so it doesn't count as a prompt or crowd the outline.

## Fitting the budget (`summaries/prune.ts`)

160,000 characters (~40k tokens) go to the model. Measured on 44 real sessions: parsed transcripts are 20k characters at the median, 310k at most; the largest prune in under 15 ms. A session within the budget is sent as it is. Otherwise, in order:

1. Every message: fenced code and runs of output-like lines (logs, diffs, stack traces) keep their first and last lines; prompts are cut at 6,000 characters, replies at 4,000, tool calls at 240, each with a marker saying how much went (`[… 12,345 characters cut …]`); runs of tool calls shrink to their first and last with a count; repeats in a row count once.
2. Tighter passes over everything but the last 8 messages (which hold the outcome).
3. Whole old messages dropped, tool calls first, then replies, then prompts, never the first prompt; each run leaves a marker, counted against the budget.
4. As a last resort the recent messages too.

Secrets are masked before anything is sent (`redact`: private keys, Anthropic/OpenAI/GitHub/GitLab/Slack/AWS/Google keys, JWTs, `user:password@` URLs, `TOKEN=…`-style assignments with a secret's name), and the model is told to leave them out.

## The answer

The model writes three fields (`SUMMARY_SCHEMA`; every key required, as OpenAI's strict schemas demand): a `title`, a Markdown `body`, and a `teamUpdate`. The system prompt describes what each kind of session needs (building or fixing, investigating, research and planning, review and operations, small or inconclusive) instead of fixed sections, so a four-minute test gets two sentences and an investigation gets "Root cause" and "Still caveated". The body's headings are kept under the title and away from the ones the app looks for.

What testing changed:

- **Recency.** Small models summarise the end of a long session. The user's prompts, in order, go *after* the transcript ("each one that led to work belongs in the summary"); before that, a 3-prompt session about boot performance came back as "set the default volume to 70%", its last prompt.
- **Fixed fields** (changes with a reason, decisions, verification, follow-ups) made every session look the same and padded reasons ("— to ship the feature"). Free-form guidance flexes better.
- Sessions resumed on another day show both days, not a 94-hour duration.

## Pieces

| Piece | Where |
|---|---|
| Service: inputs, file, window, streaming, notification | `core/src/summaries/service.ts` |
| Pruning and redaction | `core/src/summaries/prune.ts` |
| Schema and Markdown | `core/src/summaries/render.ts` |
| Marker, section names, `summaryPart` | `protocol/src/summary.ts` |
| Streaming objects | `ai/backends.ts` `completeObject` (`onPartial` → `streamText`) |
| RPC | `agent.summarize { agentId, open?, wait? }` → `{ path, windowId, markdown }` (remote: never) |
| CLI | `cmd agents summary <agent> [--open]` |
| UI | title bar and sidebar menu (`App.tsx`), `session.summarize`, `summarizeSession` and `copySummaryPart` (`actions.ts`), Markdown window menu |
| Files | `$CMD_HOME/summaries/<project>-<date>-<session>.md` (else the temp folder's `cmd-summaries`); asking again overwrites |

One summary per agent at a time: asking again while one is written shows that one.

## Open

- **Scope:** always the whole current session. "Since the last summary" would suit long-running sessions.
- **Tier:** the fast tier is good enough on the sessions tried; the smart tier could be an option for long sessions.
- **Agents without transcripts** (Qwen, Copilot are parsed but not in order; others have none) fall back to recorded turns.
- **Commit attribution:** `git log --since` includes commits others made meanwhile; only the model sees them, flagged as such.
