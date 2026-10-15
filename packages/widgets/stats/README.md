# Usage Stats

A cmd widget: how you and your agents worked in this workspace, as one page read top to bottom. A sentence (“This week: agents worked 12h 23m, 18% more than last week.”), the headline numbers with their change against the range before (Agent time, Turns, Commands, Failed commands, Tokens), then a pane per area: agent time per day by agent, how turns ended and how long agents waited on you, the commands run most and how often each failed, when agents work (weekday × hour over 30 days, today by the hour, a year as a calendar), and tokens by model. **Today**, **Week**, **Month** and **Year** in the toolbar; a number opens its detail: the chart large, split by what the stat can be split by, and its ranking. The title menu switches between This Workspace and All Workspaces; with All Workspaces it adds your active time, the projects agent time went to and cmd's own model calls, and "when you work" is your active time. The page counts again a moment after a command or an agent's turn is recorded, and once a minute.

It ships with cmd (Widget Library → Built-in), does the native Stats window's job, and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/57](../../../docs/57-builtin-widgets.md)). Each pane is one `cmd.stats.query` (API 1.2).

- `src/stats.tsx`: the widget.
- `src/stats.test.tsx`: its tests against the fake host (`pnpm vitest run packages/widgets/stats`).
- `src/stats.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/stats`).

Permissions: `workspace: ["read", "all"]` (this workspace's stats, and every workspace's from the title menu, which your active time and cmd's model calls need: they can't be told apart by workspace), `events: ["agents", "ai"]` (agent time, turns, waiting and tokens are counted from agents' events; cmd's model calls from its AI log). Commands and your active time are counted from classes any widget reads.

## How it differs from the native Stats

- **One workspace by default.** The native window opens on This Workspace too, but its page always shows your active time and the heatmap of when you work, which have no workspace. Here they come with All Workspaces; in one workspace the heatmap is when agents worked there.
- **No “cmd” pane** (core memory, stalls, the event log's size). It is cmd's own health, read from the `system` class; like cmd's processes in Resources, that stays in the native view, and the widget doesn't ask for `system`.
- **No sparkline inside a number's tile**: the API's `Stat` takes no children, so the sparkline sits under it. The change is the `Stat`'s `delta` in green or red (`deltaTone`), not the kit's `Delta` with its arrow.
- **No median or 90th percentile in a detail's header** (the API's result has no quantiles); the waiting line's “at a time” is its own `p50` query.
- **Charts format by the stat's unit** (`unit`), so a chart's ticks and readout follow the API's formats, not the native view's own functions.
- **No “stats changed” push**: the API has no topic for it, so the page counts again after a command or `agent.stop` is recorded (its own `useEvents`) and once a minute. A stat that is still being counted says “Counting since …” in the footer, as the native one does; “Updated” is when the widget last asked.
- **A stat the widget may not read leaves its pane out**; when none can be read, the page says why and offers Try Again.
