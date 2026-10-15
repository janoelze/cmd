// Work Log's states for the UI Workbench (`pnpm workbench widgets/journal`): the widget against
// the fake host, one variant per state, each the host's data.

import type { HostData } from "@cmd/widget-api/testing/host";
import { day } from "@cmd/widget-api/testing/fixtures";
import WorkLog from "./journal.tsx";

export default WorkLog;

const H = 3_600_000;
const today = new Date(Date.now() - 4 * H).setHours(0, 0, 0, 0);
const before = (n: number) => new Date(today - n * 24 * H + 12 * H).setHours(0, 0, 0, 0);
const c = (o: Partial<Record<"agents" | "prompts" | "commands" | "commits" | "pages" | "files", number>>) => ({ agents: 0, prompts: 0, commands: 0, commits: 0, pages: 0, files: 0, ...o });

const week = [
  day({
    date: today,
    headline: "Ported the Journal, Notifications and Now Playing to widget packages",
    writtenAt: today + 15.5 * H,
    entries: [
      { id: "t1", kind: "feature", title: "Ported the Journal to a widget package", summary: "Reads the written days through journal.days; the ribbon and timeline as the native view draws them.", outcome: "merged", start: today + 9 * H, end: today + 11.5 * H, counts: c({ agents: 2, prompts: 6, commands: 14, commits: 3, files: 5 }) },
      { id: "t2", kind: "investigation", title: "Looked into why the e2e journal was empty", summary: "A day shows only once something happened in it; a note is enough.", outcome: "answered", start: today + 11.5 * H, end: today + 12.25 * H, counts: c({ agents: 1, prompts: 2, commands: 6 }) },
      { id: "t3", kind: "fix", title: "Fixed the footer's line in light themes", summary: "It read the dark theme's edge.", outcome: "fixed", start: today + 13 * H, end: today + 13.75 * H, counts: c({ commands: 3, commits: 1, files: 1 }) },
      { id: "t4", kind: "review", title: "Reviewed the Stats port", summary: "Two charts lacked their unit.", outcome: "open", start: today + 14 * H, end: today + 15 * H, counts: c({ agents: 1, pages: 3 }) },
    ],
  }),
  day({
    date: before(1),
    headline: "Released v0.31 and decided API 1.2's verbs",
    entries: [
      { id: "y1", kind: "release", title: "Released v0.31", summary: "Signed, notarized and on the update feed.", outcome: "shipped", start: before(1) + 10 * H, end: before(1) + 11 * H, counts: c({ commands: 8, commits: 2 }) },
      { id: "y2", kind: "design", title: "Decided API 1.2's verbs", summary: "Eight approved, four not.", outcome: null, start: before(1) + 14 * H, end: before(1) + 17 * H, counts: c({ agents: 1, prompts: 4, files: 2 }) },
    ],
  }),
  day({ date: before(2), headline: "Tidied the dev setup", entries: [{ id: "d1", kind: "ops", title: "Moved dev cores onto Electron's Node", summary: "System Node 22 broke symlinked imports.", outcome: "fixed", start: before(2) + 16 * H, end: before(2) + 18 * H, counts: c({ commands: 20, commits: 1 }) }] }),
];

/** A week of written days, newest first. */
export const Week: HostData = { journal: week };

/** Only today written so far. */
export const Today: HostData = { journal: week.slice(0, 1) };

/** In a narrow window, as in a sidebar. */
export const Narrow: HostData & { size: "narrow" } = { journal: week, size: "narrow" };

/** Many days, many entries each. */
export const Many: HostData = {
  journal: Array.from({ length: 7 }, (_, i) =>
    day({ date: before(i), headline: `A busy day, ${9 - (i % 3)} things done`, entries: Array.from({ length: 9 - (i % 3) }, (_, j) => ({ id: `${i}-${j}`, kind: (["feature", "fix", "review", "research", "chore"] as const)[j % 5]!, title: `Piece of work ${j + 1}`, summary: "What was done, in a line.", outcome: (["merged", "fixed", null, "answered", "dropped"] as const)[j % 5]!, start: before(i) + (6 + j * 1.5) * H, end: before(i) + (7 + j * 1.5) * H, counts: c({ commands: j + 1, commits: j % 2 }) })) }),
  ),
};

/** Nothing written in this workspace yet. */
export const Empty: HostData = { journal: [] };

/** The journal refused: the grant lacks agents' events. */
export const Refused: HostData = { journal: week, deny: { "journal.days": 'events: ["agents"]' } };
