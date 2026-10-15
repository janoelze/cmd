# Countdown

A cmd widget: a countdown that tells you when it's done, in any workspace. The time left is large, with a bar that fills as it runs; the toolbar has the presets (5 to 60 minutes), a field to type a length (`10`, `1:30`, `90s`, `1h`), Start, Pause, Resume and Reset; the window's context menu has Start or Pause, and Reset. At the end it notifies ("25 min timer · done"), on time, from its own process, which keeps running while its window is open in any workspace; one that ended while nothing ran rings once, saying when.

It ships with cmd (Widget Library → Built-in), does the native Timer's job, and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/56](../../../docs/56-widgets-v3.md)).

- `src/timer.tsx`: the widget.
- `src/timer.test.tsx`: its tests against the fake host, with a fake clock (`pnpm vitest run packages/widgets/timer`).
- `src/timer.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/timer`).

Permissions: none. Its state is the window's, and notifications need no permission.
