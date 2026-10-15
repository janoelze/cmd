// Event Log's states for the UI Workbench (`pnpm workbench widgets/events`): the widget against
// the fake host, one variant per state, each the host's data.

import type { HostData } from "@cmd/widget-api/testing/host";
import { command, event, pane } from "@cmd/widget-api/testing/fixtures";
import EventLog from "./events.tsx";

export default EventLog;

const ago = (ms: number) => Date.now() - ms;
const log = [
  event({ type: "git.commit", at: ago(9 * 60_000), text: "Committed “docs/57: wave 1”", data: { subject: "docs/57: wave 1", files: 4, branch: "builtin-wave1" } }),
  command({ command: "pnpm typecheck", exitCode: 0, ago: 6 * 60_000, took: 41_000 }),
  event({ type: "agent.prompt", at: ago(4 * 60_000), text: "Record the widgets tour again", data: { agent: "Tours", prompt: "Record the widgets tour again" } }),
  command({ command: "pnpm vitest run packages/widgets", exitCode: 1, ago: 3 * 60_000, took: 6200 }),
  event({ type: "notification", at: ago(2 * 60_000), text: "Tours · needs you", data: { title: "Tours · needs you", body: "Allow “pnpm tour”?" } }),
  event({ type: "agent.stop", at: ago(40_000), data: { agent: "Perf", reason: "done" } }),
  command({ command: "pnpm dev", ago: 20_000 }),
];

/** A busy few minutes: commands, an agent, a commit, a notification. */
export const Busy: HostData = { terminals: [pane()], events: log };

/** Paused from the title menu half a minute ago: the rows hold still, what came since waits. */
export const Paused: HostData = { terminals: [pane()], events: log, state: { pausedAt: ago(30_000) } };

/** Two classes hidden from the Show menu. */
export const Hidden: HostData = { terminals: [pane()], events: log, state: { hiddenClasses: ["output", "git"] } };

/** Every class hidden: a way back. */
export const AllHidden: HostData = { terminals: [pane()], events: log, state: { hiddenClasses: ["agents", "output", "git", "notes"] } };

/** In a narrow window, as in a sidebar. */
export const Narrow: HostData & { size: "narrow" } = { terminals: [pane()], events: log, size: "narrow" };

/** Many events: the newest drawn. */
export const Many: HostData = { events: Array.from({ length: 400 }, (_, i) => event({ type: ["command", "agent.prompt", "git.commit", "note"][i % 4]!, at: ago((400 - i) * 1000), data: { n: i } })) };

/** Nothing recorded in this workspace yet. */
export const Empty: HostData = { events: [] };
