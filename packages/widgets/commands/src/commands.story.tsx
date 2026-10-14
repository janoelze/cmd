// Recent Commands' states for the UI Workbench (`pnpm workbench widgets/commands`): the widget
// against the fake host, one variant per state, each the host's data.

import type { HostData } from "@cmd/widget-api/testing/host";
import { command, pane } from "@cmd/widget-api/testing/fixtures";
import RecentCommands from "./commands.tsx";

export default RecentCommands;

const log = [
  command({ command: "pnpm dev", ago: 40 * 60_000, branch: "main" }),
  command({ command: "pnpm vitest run packages/core/test/widget-act.test.ts", exitCode: 1, ago: 3 * 60_000, took: 6200, branch: "main" }),
  command({ command: "git status", exitCode: 0, ago: 5 * 60_000, took: 80, branch: "main" }),
  command({ command: "pnpm typecheck", exitCode: 0, ago: 12 * 60_000, took: 41_000, branch: "main" }),
  command({ command: "make e2e", exitCode: 130, ago: 30 * 60_000, took: 95_000, branch: "main" }),
];

/** A dev server running, a test that failed, the rest finished; "1 failed" in the title bar. */
export const Busy: HostData = { terminals: [pane()], events: log };

/** Failed Only from the title menu. */
export const FailedOnly: HostData = { terminals: [pane()], events: log, state: { failedOnly: true } };

/** In a narrow window, as in a sidebar. */
export const Narrow: HostData & { size: "narrow" } = { terminals: [pane()], events: log, size: "narrow" };

/** Nothing ran in this workspace yet. */
export const Empty: HostData = { events: [] };
