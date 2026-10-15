# Countdown

A cmd widget: a countdown that tells you when it's done, in any workspace. The time left is large, in a ring that empties as it runs, sized to the window; click the time to type a length (`10`, `1:30`, `90s`, `1h`). The toolbar has the presets (5 to 60 minutes), Start, Pause, Resume and Reset; the window's context menu has Start or Pause, and Reset. At the end it notifies ("25 min timer · done"), on time, from its own process, which keeps running while its window is open in any workspace; one that ended while nothing ran rings once, saying when.

It ships with cmd (Widget Library → Built-in), does the native Timer's job and looks like it, and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/56](../../../docs/56-widgets-v3.md)).

- `src/timer.tsx`: the widget.
- `src/timer.test.tsx`: its tests against the fake host, with a fake clock (`pnpm vitest run packages/widgets/timer`).
- `src/timer.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/timer`).

Permissions: none. Its state is the window's, and notifications need no permission.

## How it differs from the native Timer

- It rings from its own process, not from cmd's: it rings on time while its window is open in any workspace, and a timer that ended while the window was closed (or the Mac slept) rings once when it opens again, saying when it ended. The native one rings from cmd even with its window closed.
- The context menu says Resume for a paused timer (the toolbar's word) and greys out Reset when there is nothing to reset; the native menu says Start and always offers Reset.
- It needs API 1.3 (the `Dial`).
