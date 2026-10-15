# Run Scripts

A cmd widget: how to run the project in this workspace's folder, from its own files (package.json scripts, a Makefile, a justfile and similar). cmd's main action (usually dev) sits on its own with **Run**; the rest are under it in sections by kind (Pinned, Dev, Test, Build, Check…) and a monorepo's packages each in their own, with Run on hover. A click on a section's heading folds it; a package's start folded, and what you fold or open is kept per window. A click runs one in its own terminal; while it runs, a click goes to its terminal, and **Stop** and **Restart** are on its row. A dev server shows its address, which opens in a browser window. Each row says how its last run went: running for how long, failed with its exit status, or how long it took, wherever it was started. **Copy Command** is in a row's menu. A risky action (a deploy, a publish) is listed apart, dimmed: a widget can't run it.

It ships with cmd (Widget Library → Built-in), does the native Workspace Actions' job of listing and running, and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/57](../../../docs/57-builtin-widgets.md)).

- `src/actions.tsx`: the widget.
- `src/actions.test.tsx`: its tests against the fake host (`pnpm vitest run packages/widgets/actions`).
- `src/actions.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/actions`).

Permissions: `workspace: ["read"]` (this workspace's actions; its commands' events need no class), `act: ["actions.run", "actions.stop"]` (Run, Restart and Stop, which ask like any act: a built-in package follows Settings → AI & Agents → Permissions). It uses API 1.2 (`cmd.actions.stop`, `cmd.actions.run(name, { restart })`, `cmd.clipboard.write` and the actions' run fields).

## How it differs from the native Workspace Actions

- **No Pin.** The widget API has no `actions.pin` (decided against for 1.2: only an actions list shows the ranking it changes); pinned actions are listed first, as pinned in Workspace Actions.
- **Stop asks.** Stop is an act, so the approval sheet asks (or the permission levels decide) where the native view stops at once.
- **Risky actions don't run.** cmd refuses a risky action from any widget rather than asking; the native view asks with its own sheet.
- **No From Your History or Suggested** sections, no "in <branch>" link to a run in another worktree, no Open <file>: the API's actions are the workspace root's list, without their files.
- **No folder of its own**: it runs the workspace's actions; the native widget can be given another folder.
- **No Settings link** (Set up AI, Describing actions…): a widget can't open Settings.
