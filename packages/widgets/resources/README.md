# Terminal Usage

A cmd widget: what each terminal in this workspace uses now, live: CPU (a share of one core) and memory of everything running in it, its whole process tree, busiest first, with its largest processes beside it. A terminal over 80% CPU has its light on. The totals sit at the top with the last two minutes as sparklines inside their tiles, and in the title bar; under the terminals, what cmd itself uses: the app and the background process that keeps terminals running. A click on a row goes to its terminal; a column's header sorts by it (kept per window). The title menu switches between This Workspace and All Workspaces, where each terminal says its workspace's name.

It ships with cmd (Widget Library → Built-in), does the native Resources widget's job, and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/57](../../../docs/57-builtin-widgets.md)). Its numbers are cmd's own samples, pushed as they're taken: each terminal's (`useTerminalUsage`, API 1.2) and cmd's own (`useAppUsage`, 1.3); workspaces' names come from `useWorkspaces` (1.3).

- `src/resources.tsx`: the widget.
- `src/resources.test.tsx`: its tests against the fake host (`pnpm vitest run packages/widgets/resources`).
- `src/resources.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/resources`), on the native Resources story's terminals.

Permissions: `workspace: ["read", "all"]` (this workspace's terminals and what they use, and every workspace's with their names from the title menu), `events: ["system"]` (what cmd itself uses, the class that holds cmd's own health).

## How it differs from the native Resources

- **No Task Manager link** in the footer or the title menu: a widget never opens cmd's own windows. Window → Task Manager has the full detail.
- **Sortable**: a column's header sorts the table, where the native table is always busiest first (the default without a sort).
- **An agent's terminal shows its kind's icon**, as the sidebar does; the native view draws the terminal icon for every row.
- **Terminals cmd hasn't sampled yet say “Measuring…”** rather than that none are running.
- “1 process”, where the native footer says “1 processes”.
