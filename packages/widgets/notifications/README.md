# Notification Log

A cmd widget: the notifications cmd sent in this workspace, shown or not, so one missed while away is still here. Newest first, under Today and Earlier: each with its source's icon (an agent that needs you, one that's done, a command, a timer), its title and body, and the time (an age for older ones). One that needed you is in the attention colour. A click goes to the terminal it's about; **Show Terminal** and **Copy Text** are in a row's menu. The title menu switches between This Workspace and All Workspaces, and **Clear Notifications** empties this list (new ones show up after).

It ships with cmd (Widget Library → Built-in), does the native Notifications' job, and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/57](../../../docs/57-builtin-widgets.md)).

- `src/notifications.tsx`: the widget.
- `src/notifications.test.tsx`: its tests against the fake host (`pnpm vitest run packages/widgets/notifications`).
- `src/notifications.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/notifications`).

Permissions: `workspace: ["read", "all"]`: this workspace's notifications, and every workspace's from the title menu. Notifications are notes in the event log, which need no class (`useEvents({ types: ["notification"] })`).

## How it differs from the native Notifications

- **Clear is this list's own.** It keeps when it was cleared (per window, across reloads); the native Clear Notifications clears the app's list for every workspace. Decided for API 1.2: no `notify.clear` or `notify.list` verb.
- **Only notifications about a workspace.** One about nothing in particular (sent with no terminal or window: the CLI's, a widget's) shows in every workspace natively; a widget never reads events without a workspace.
- **The workspace it was sent in**, not the one its terminal is in now: a terminal moved since stays with the workspace it was in.
- **A click goes to a terminal only.** A notification about a window (a widget's) has no target here: `ApiEvent` carries the terminal, not the window (a 1.3 candidate, docs/57).
- **Copy Text after a click only**, as every widget's copy (API 1.2's `clipboard.write`, on this Mac).
