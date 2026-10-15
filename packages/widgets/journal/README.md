# Work Log

A cmd widget: the last days of this workspace as the Journal wrote them, newest first. Each day is its name and the hours worked, a headline, a ribbon of those hours (a bar per piece of work, in its kind's colour; a click rings the entry it belongs to) and a timeline of what was done: a title, how it ended (Shipped, Merged, Fixed, Open…), a line of summary, how long it took and what it took (agents, commands, commits, pages, files). The footer says when the newest day was written; **Read Again** is the small button on the newest day's heading (where the native Journal has Write Again), and it looks again every few minutes by itself.

It ships with cmd (Widget Library → Built-in), shows what the native Journal writes, and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/57](../../../docs/57-builtin-widgets.md)).

- `src/journal.tsx`: the widget.
- `src/journal.test.tsx`: its tests against the fake host (`pnpm vitest run packages/widgets/journal`).
- `src/journal.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/journal`).

Permissions: `workspace: ["read"]` and `events: ["agents"]`, what `cmd.journal.days` (API 1.2) needs: a day is written from this workspace's agents' prompts and work.

## How it differs from the native Journal

- **Read only.** A widget never has a day written (that runs the person's model), so there is no Write Again, no "Writing up what happened…" line and no Set Up AI: it shows what the Journal wrote and says when. A day not written yet isn't there; the empty state sends you to the Journal.
- **No week.** The native view rolls the week's threads up above the days (`journal.week`, model-written); `journal.days` has no week.
- **This workspace only.** `journal.days` reads the widget's workspace; there is no All Workspaces scope and so no project chips (an entry comes without its repository).
- **It looks again on a timer** (every 5 minutes, and from Read Again), not when something is recorded: the API has no live journal topic.
- **A picked bar rings its entry without scrolling to it**: a widget can't scroll its view.
- **No older days**: the last 7 written days, no paging back.
