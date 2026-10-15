# Run Scripts

A cmd widget: how to run the project in this workspace's folder, from its own files (package.json scripts, a Makefile, a justfile and similar). The first one sits on its own with **Run**; the rest are under it, with Run on hover. A click runs one in its own terminal; while it runs, a click goes to its terminal. Each row says how its last run here went: running for how long, failed with its exit status, or how long it took. A risky action (a deploy, a publish) is listed apart, dimmed: a widget can't run it.

It ships with cmd (Widget Library → Built-in), does the native Workspace Actions' job of listing and running, and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/57](../../../docs/57-builtin-widgets.md)).

- `src/actions.tsx`: the widget.
- `src/actions.test.tsx`: its tests against the fake host (`pnpm vitest run packages/widgets/actions`).
- `src/actions.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/actions`).

Permissions: `workspace: ["read"]` (this workspace's actions and terminals; its commands' events need no class), `act: ["actions.run"]` (Run, which asks like any act: a built-in package follows Settings → AI & Agents → Permissions).

## How it differs from the native Workspace Actions

- **No Pin, Stop or Restart.** The widget API has no `actions.pin` or `actions.stop` yet (proposed for API 1.2 in docs/57). Without Stop there is no "Stop?" confirmation either; when `actions.stop` exists, the act's own approval sheet asks.
- **Risky actions don't run.** cmd refuses a risky action from any widget rather than asking; the native view asks with its own sheet.
- **No sections by kind** (Dev, Test, Build…), no packages, no From Your History or Suggested: the API's actions are a name, a description and whether they're risky, in cmd's order. The first one that isn't risky is the main action.
- **Run state only for runs started here.** It follows the terminal a run from this window went to; a dev server started elsewhere (another window, another worktree) doesn't show as running, and there is no "in <branch>" link.
- **No dev server address, Copy Command or Open <file>**: the API's actions carry neither the address, the command nor its file, and a widget has no clipboard.
- **No folder of its own**: it runs the workspace's actions; the native widget can be given another folder.
- **No Settings link** (Set up AI, Describing actions…): a widget can't open Settings.
