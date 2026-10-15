# Recent Commands

A cmd widget: every command this workspace's terminals ran, or every workspace's. Running ones come first, then the rest, newest first; a failed one says its exit status, and the title bar counts the failures. Click a row to go to its terminal. **Run Again** (the button on a row you point at, and in its menu) opens a terminal in the command's folder with the command typed at the prompt, not run: you read it and press Return. A row's menu also has **Copy Command** and **New Terminal Here**. The title menu switches between This Workspace and All Workspaces, and Failed Only, kept per window.

It ships with cmd (Widget Library → Built-in), does the native Commands widget's job, and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/57](../../../docs/57-builtin-widgets.md)).

- `src/commands.tsx`: the widget.
- `src/commands.test.tsx`: its tests against the fake host (`pnpm vitest run packages/widgets/commands`).
- `src/commands.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/commands`).

Permissions: `workspace: ["read", "all"]` (its terminals, and every workspace's from the title menu), `events: ["output"]` (the commands the log keeps), `act: ["terminals.open"]` (Run Again and New Terminal Here, which asks like any act: a built-in package follows Settings → AI & Agents → Permissions, where Show things is Allow).

## How it differs from the native Commands

- **Run Again opens a new terminal.** The native view types the command into the terminal it ran in and runs it, when that terminal is open and back at its prompt. A widget can't run what it types: it opens a terminal in the command's folder with the command typed, and you press Return. Only for commands run in this workspace's folder, where a widget may open a terminal (New Terminal Here too).
- **The place is the branch,** in a neutral chip. The native view names the worktree or branch in the project's colour.
- **All Workspaces doesn't name each command's workspace**: a widget doesn't know workspaces' names.
