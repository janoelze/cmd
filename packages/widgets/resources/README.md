# Terminal Usage

A cmd widget: what each terminal in this workspace uses now, live: CPU (a share of one core) and memory of everything running in it, its whole process tree, busiest first, with its largest processes beside it. A terminal over 80% CPU has its light on. The totals sit at the top with the last two minutes as sparklines, and in the title bar. A click on a row goes to its terminal; a column's header sorts by it (kept per window). The title menu switches between This Workspace and All Workspaces, which adds where each terminal runs.

It ships with cmd (Widget Library → Built-in), does the terminals part of the native Resources widget's job, and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/57](../../../docs/57-builtin-widgets.md)). Its numbers are cmd's own samples of each terminal (`useTerminalUsage`, API 1.2), pushed every few seconds.

- `src/resources.tsx`: the widget.
- `src/resources.test.tsx`: its tests against the fake host (`pnpm vitest run packages/widgets/resources`).
- `src/resources.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/resources`).

Permissions: `workspace: ["read", "all"]` (this workspace's terminals and what they use, and every workspace's from the title menu). It reads no events.

## How it differs from the native Resources

- **No “cmd” pane.** cmd's own processes (the app, and the background process that keeps terminals running) aren't terminals, and the widget API leaves them out on purpose (`terminals.usage` has no `core.processes`: only a built-in would want them). They stay in the native Resources widget and in Window → Task Manager.
- **No Task Manager link** in the footer: a widget can't open cmd's own windows.
- **Where a terminal runs is its folder**, not its workspace's name, for terminals of other workspaces (the API names only the widget's own workspace).
- **Sortable**: a column's header sorts the table, where the native table is always busiest first.
- **The sparklines start when the widget does**: two minutes of history kept in the window while it runs, as the native one keeps them, so a reload starts them over. Terminals cmd hasn't sampled yet read as loading.
