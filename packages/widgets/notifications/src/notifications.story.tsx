// Notification Log's states for the UI Workbench (`pnpm workbench widgets/notifications`): the
// widget against the fake host, one variant per state, each the host's data.

import type { HostData } from "@cmd/widget-api/testing/host";
import { event, pane } from "@cmd/widget-api/testing/fixtures";
import NotificationLog from "./notifications.tsx";

export default NotificationLog;

const ago = (ms: number) => Date.now() - ms;
const yesterday = new Date(new Date().setHours(0, 0, 0, 0) - 5 * 3_600_000).getTime();
const note = (title: string, body: string, source: string, at: number, o: { urgent?: boolean; terminalId?: string } = {}) =>
  event({ type: "notification", at, terminalId: o.terminalId ?? null, data: { source, title, body, urgent: !!o.urgent, alert: true } });

const log = [
  note("cmd · done", "Released v0.31; the update feed has it.", "agent-done", yesterday, { terminalId: "t-zsh" }),
  note("Countdown", "25 min timer · done", "timer", yesterday + 3_600_000, { urgent: true }),
  note("pnpm e2e · done", "All checks passed in 2 min.", "command", ago(40 * 60_000), { terminalId: "t-zsh" }),
  note("Tours · needs you", "Allow “pnpm tour widgets.tour.ts”?", "agent-input", ago(6 * 60_000), { urgent: true, terminalId: "t-zsh" }),
  note("Perf · stopped", "You've hit your weekly limit · resets Oct 21 at 3am", "agent-done", ago(90_000), { terminalId: "t-zsh" }),
];

/** Today's and earlier notifications. */
export const Busy: HostData = { terminals: [pane()], events: log };

/** In a narrow window, as in a sidebar. */
export const Narrow: HostData & { size: "narrow" } = { terminals: [pane()], events: log, size: "narrow" };

/** Many notifications. */
export const Many: HostData = { events: Array.from({ length: 120 }, (_, i) => note(`agent-${i % 7} · done`, "Fixed add(); tests pass.", i % 5 ? "agent-done" : "command", ago((120 - i) * 9 * 60_000))) };

/** Cleared from the title menu a minute ago: only what came since. */
export const Cleared: HostData = { terminals: [pane()], events: [...log, note("pnpm test · failed", "3 tests failed in add.test.ts.", "command", ago(20_000), { terminalId: "t-zsh" })], state: { clearedAt: ago(60_000) } };

/** None sent in this workspace yet. */
export const Empty: HostData = { events: [] };

/** All Workspaces without the grant for it. */
export const Refused: HostData = { events: log, state: { scope: "all" }, deny: { "events.query": 'workspace: ["all"]' } };
