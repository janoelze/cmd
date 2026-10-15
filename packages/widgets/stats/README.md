# Usage Stats

A cmd widget: how you and your agents worked in this workspace, as one page read top to bottom. A sentence (“This week: agents worked 12h 23m, 18% more than last week.”), the headline numbers with their change against the range before, an arrow in green or red by which way is good, and a sparkline in each tile (Agent time, Active time, Turns, Commands, Failed commands, Tokens), then a pane per area: agent time per day by agent, how turns ended and how long agents waited on you, the commands run most and how often each failed, when you work (weekday × hour over 30 days, today by the hour, a year as a calendar), the projects agent time went to, tokens by model, cmd's own model calls, and cmd itself (its core's memory, stalls and the event log's size). **Today**, **Week**, **Month** and **Year** in the toolbar; a number opens its detail: the chart large with its change and, for a stat that spreads, its median and 90th percentile, split by what the stat can be split by, and its ranking. The title menu switches between This Workspace and All Workspaces, with the same panes. Your active time, cmd's model calls and cmd's own pane have no workspace, so they are every workspace's in both, as on the native page.

It ships with cmd (Widget Library → Built-in), does the native Stats window's job, and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/57](../../../docs/57-builtin-widgets.md)). Each number is a live stat (`useStat`, API 1.3): cmd counts it again soon after it records something for it, and each minute for time spent, so the widget never polls.

- `src/stats.tsx`: the widget.
- `src/stats.test.tsx`: its tests against the fake host (`pnpm vitest run packages/widgets/stats`).
- `src/stats.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/stats`), on the native Stats story's numbers.

Permissions: `workspace: ["read", "all"]` (this workspace's stats, and every workspace's from the title menu, which your active time, cmd's own pane and cmd's model calls need: they can't be told apart by workspace), `events: ["agents", "ai", "system"]` (agent time, turns, waiting and tokens are counted from agents' events; cmd's model calls from its AI log; the core's memory and stalls and the log's size from cmd's own records, `system`). Commands and your active time are counted from classes any widget reads.

## How it differs from the native Stats

- **Rankings, turns, the punch card and the calendar write values short** (“2d”, “2.4K”), where the native view writes them whole (“2d 13h”, “2,372”): the API's charts take a `unit`, and cmd draws a unit's values short everywhere but a chart's summary.
- **No split by workspace in This Workspace**: within one workspace it says nothing, and the API refuses it.
- **An open detail is kept per window**, so it is still open after the widget reloads.
- When cmd refuses a stat, the page says why and offers Try Again, as the native page does when the core fails.
