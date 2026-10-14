# Recent Commands

A cmd widget: every command this workspace's terminals ran, or every workspace's. Running ones come first, then the rest, newest first; a failed one says its exit status, and the title bar counts the failures. Click a row to go to its terminal. **Run Again** (in a row's menu) opens a terminal in the command's folder with the command typed at the prompt, not run: you read it and press Return. The title menu switches between This Workspace and All Workspaces, and Failed Only, kept per window.

It ships with cmd (Widget Library → Built-in), does the native Commands widget's job, and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/56](../../../docs/56-widgets-v3.md)).

- `src/commands.tsx`: the widget.
- `src/commands.test.tsx`: its tests against the fake host (`pnpm vitest run packages/widgets/commands`).
- `src/commands.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/commands`).

Permissions: `workspace: ["read", "all"]` (its terminals, and every workspace's from the title menu), `events: ["output"]` (the commands the log keeps), `act: ["terminals.open"]` (Run Again, which asks like any act: a built-in package follows Settings → AI & Agents → Permissions, where Show things is Allow).
