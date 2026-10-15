# Event Log

A cmd widget: everything cmd records in this workspace, live, newest first. Commands, agents, git, notifications, tool calls: each row is the log's line for the event, its type, the plain values it carries and when it happened. An event recorded again (a command that ended) replaces its row, moves up and says how often ("recorded again ×2"). Each row's chip names its class as Settings → Data does, in the colour cmd gives that name. Filter by any word in an event; click a row to see the event whole; **Copy Event** and **Copy ID** are in a row's menu. The title menu (its button says **All Events**, or **2 hidden**) switches between This Workspace and All Workspaces, pauses (new events wait, counted in the title bar), clears, and hides the log's classes; the window's context menu has the same entries. Hidden classes are one preference for every Event Log; the scope, pause and clear are each window's own.

It ships with cmd (Widget Library → Built-in), does the native Event Stream's job and looks like it, and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/57](../../../docs/57-builtin-widgets.md)).

- `src/events.tsx`: the widget.
- `src/events.test.tsx`: its tests against the fake host (`pnpm vitest run packages/widgets/events`).
- `src/events.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/events`).

Permissions: `workspace: ["read", "all"]` (this workspace's events, and every workspace's from the title menu), `events: [...]` every class a widget may read (output, agents, tools, operator, transcripts, ai, browsing, system; git, notes and your actions need none). The pairing log (`remote`) is never readable by a widget.

## How it differs from the native Event Stream

- **One workspace at a time, or all.** The native view reads the whole log, events without a workspace too (the data layer's own); a widget reads its workspace's, or every workspace's with All Workspaces, and never events that belong to none. So its title menu has the scope, which the native one doesn't.
- **A row's second line is the event's data**, not its envelope: the native view lists how cmd stored it (format version, who wrote it, which cmd, its workspace, terminal and window ids, flags); a widget's event carries its type, its data and its terminal, so the row says the data's plain values ("command pnpm test · exitCode 1"). Copy Event and the opened event are the widget's view of it, without the envelope too.
- **Pause and Clear last.** Paused, the rows hold what was recorded before the pause, across a reload too; Clear hides what came before it until you open a new Event Log. The native view's pause and clear last only until the window reloads.
- **No "explain".** The native view has no AI explanation either: its `data.explain` call reads the class list, which the package reads through `cmd.events.classes`.

It needs API 1.3 (`menuLabel`, `fmt.hue`, `useStorage`, and useEvents' `again`).
