# Agents

A cmd widget: every agent in this workspace, or all of them, at a glance. Who waits for you comes first, then who is working, then the rest, most recent first; subagents sit under their host. Click a row to go to that agent's terminal, in its workspace. The title bar counts who waits, works and is done; its menu switches between This Workspace and All Workspaces, kept per window.

It ships with cmd (Widget Library → Built-in) and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/56](../../../docs/56-widgets-v3.md)).

- `src/activity.tsx`: the widget.
- `src/activity.test.tsx`: its tests against the fake host (`pnpm vitest run packages/widgets/agents`).
- `src/activity.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/agents`).

Permissions: `workspace: ["read", "all"]`, to see the agents of this workspace and, from the title menu, of every workspace.
