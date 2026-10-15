# Event Log

A cmd widget: everything cmd records in this workspace, live, newest first. Commands, agents, git, notifications, tool calls: each row is the event's type, the plain values it carries and when it happened. An event recorded again (a command that ended) replaces its row and moves up. Filter by any word in an event; hide kinds from the toolbar's **Show** menu; click a row to see the event whole. The title menu switches between This Workspace and All Workspaces, pauses (new events wait, counted in the title bar) and clears.

It ships with cmd (Widget Library → Built-in), does the native Event Stream's job, and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/57](../../../docs/57-builtin-widgets.md)).

- `src/events.tsx`: the widget.
- `src/events.test.tsx`: its tests against the fake host (`pnpm vitest run packages/widgets/events`).
- `src/events.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/events`).

Permissions: `workspace: ["read", "all"]` (this workspace's events, and every workspace's from the title menu), `events: [...]` every class a widget may read (output, agents, tools, operator, transcripts, ai, browsing, system; git, notes and your actions need none). The pairing log (`remote`) is never readable by a widget.

## How it differs from the native Event Stream

- **Kinds, not classes.** The Show menu lists the families of the types it has seen (`agent`, `command`, `git`), not the log's data classes: those come from `data.explain`, which isn't in the widget API.
- **No "explain".** The native view has no AI explanation either: its `data.explain` call reads the class list above. So there is nothing to rebuild on `cmd.ai.complete`, and nothing is left out.
- **One workspace at a time, or all.** The native view reads the whole log, events without a workspace too (the data layer's own); a widget reads its workspace's, or every workspace's with All Workspaces, and never events that belong to none.
- **The row's title is the type.** The log's one-line text for an event isn't in the API's events, so the row says the type and the values its data carries.
- **No Copy Event or Copy ID** (a widget has no clipboard); open the row to see and select the event.
- **No "recorded again ×n" count**: an event recorded again replaces its row, which moves up.
