// Workbench stories (pnpm workbench journal): the Journal widget, on two days
// of this repo's own history as a summariser might write them up.
import { Window, WindowBar, WindowBarMenu, WindowBody, WindowFrame } from "@cmd/ui";
import type { ReactNode } from "react";
import type { JournalDay, JournalEntry, JournalWeek } from "@cmd/protocol";
import { Journal } from "./Journal.tsx";

type Draft = Omit<JournalEntry, "repo" | "threads" | "counts" | "outcome"> & { project?: string; outcome?: JournalEntry["outcome"]; counts: Partial<JournalEntry["counts"]> };
const day = (d: { date: number; headline: string; entries: Draft[] }): JournalDay => ({
  ...d,
  scope: "workspace:cmd",
  writtenBy: "Claude Sonnet 5.5",
  writtenAt: d.date,
  format: { schema: 1, threads: 1, writer: 1 },
  eventsHash: "",
  inputHash: "",
  minor: 3,
  entries: d.entries.map(({ project, counts, ...e }) => ({ ...e, outcome: e.outcome ?? null, repo: project ? `/Users/sam/src/${project}` : null, threads: [e.id], counts: { agents: 0, prompts: 0, commands: 0, commits: 0, pages: 0, files: 0, ...counts } })),
});

const NOW = new Date(2026, 9, 6, 11, 45).getTime();
const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
const midnight = (d: number) => new Date(2026, 9, d).getTime();

const DAYS: JournalDay[] = (
  [
  {
    date: midnight(6),
    headline: "Drag and drop landed and shipped in v0.14.4, then the kit took over drawing every window.",
    entries: [
      {
        id: "kit-windows",
        kind: "design",
        title: "Moved windows into the UI kit",
        summary: "Tiles, sidebars and window sheets are now drawn by Window, WindowBar and WindowFrame from @cmd/ui, so dialogs and tiles finally match.",
        start: at(6, 11, 20),
        end: at(6, 11, 37),
        project: "cmd",
        outcome: "merged",
        counts: { agents: 2, commands: 14, commits: 2 },
      },
      {
        id: "v0144",
        kind: "release",
        title: "Released v0.14.4",
        summary: "Drag and drop between Finder, terminals and file browsers, with guards and Undo. Dialogs can dress as windows.",
        start: at(6, 10, 55),
        end: at(6, 11, 26),
        project: "cmd",
        outcome: "shipped",
        counts: { agents: 1, commands: 9, commits: 6 },
      },
      {
        id: "dnd",
        kind: "feature",
        title: "Built drag and drop for files",
        summary: "Files move between Finder, terminals, file browsers and windows. Dropping onto a folder an open window uses asks first.",
        start: at(6, 9, 40),
        end: at(6, 11, 16),
        project: "cmd",
        outcome: "merged",
        counts: { agents: 3, commands: 31, commits: 3, files: 12 },
      },
    ],
  },
  {
    date: midnight(5),
    headline: "A long design day: the Workbench arrived, sheets were rebuilt from the kit and went out in two late releases. A corrupt search index was traced to a crash mid-write.",
    entries: [
      {
        id: "v0142",
        kind: "release",
        title: "Released v0.14.2 and v0.14.3",
        summary: "Sheets got one shape, settings got one-line descriptions, and the space switcher stopped showing a dash while connecting.",
        start: at(6, 0, 3),
        end: at(6, 1, 31),
        project: "cmd",
        outcome: "shipped",
        counts: { agents: 2, commands: 22, commits: 24 },
      },
      {
        id: "workbench",
        kind: "feature",
        title: "Built the Workbench",
        summary: "One component at a time in the real app, driven by pnpm workbench, with 2× shots cropped to the component.",
        start: at(5, 21, 10),
        end: at(5, 23, 47),
        project: "cmd",
        outcome: "merged",
        counts: { agents: 1, commands: 40, commits: 5 },
      },
      {
        id: "db",
        kind: "investigation",
        title: "Investigated a corrupt search index",
        summary: "Transcript search returned nothing after a crash. The worker died mid-write, leaving the FTS table malformed. Fixed with a rebuild on open; the root cause is still open.",
        start: at(5, 15, 5),
        end: at(5, 17, 40),
        project: "cmd",
        outcome: "open",
        counts: { agents: 2, commands: 26, pages: 4, files: 3 },
      },
      {
        id: "il-kit",
        kind: "chore",
        title: "Tidied the agent kit's Jira skill",
        summary: "Clarified when to use JQL over board queries.",
        start: at(5, 14, 10),
        end: at(5, 14, 50),
        project: "il-agent-kit",
        outcome: "merged",
        counts: { agents: 1, commits: 1 },
      },
      {
        id: "pr-review",
        kind: "research",
        title: "Compared widget stores",
        summary: "Read how Raycast and Übersicht share extensions, for the widget store's next step.",
        start: at(5, 11, 0),
        end: at(5, 12, 5),
        project: "cmd",
        counts: { pages: 9, agents: 1 },
      },
    ],
  },
  ] satisfies { date: number; headline: string; entries: Draft[] }[]
).map(day);

/** A widget tile as the board draws it. */
function Tile({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  return (
    <Window style={{ width, height, position: "relative" }}>
      <WindowBody style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <WindowBar icon="book" name="Journal">
          <span style={{ flex: 1 }} />
          <WindowBarMenu>This Workspace</WindowBarMenu>
        </WindowBar>
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>{children}</div>
      </WindowBody>
      <WindowFrame />
    </Window>
  );
}

const WEEK: JournalWeek = {
  start: NOW - 3 * 86400_000,
  scope: "all",
  headline: "Shipped v0.14.4 with drag and drop, rebuilt the sidebars, and started the journal.",
  themes: [
    { title: "Drag and drop", summary: "Files move between Finder, terminals and file browsers; released in v0.14.4.", entries: [] },
    { title: "Sidebars as windows", summary: "Any window docks left or right; the Navigator replaced the old sidebar.", entries: [] },
    { title: "Work journal", summary: "Days written from agents, terminals and git; weeks still open.", entries: [] },
  ],
  days: [],
  writtenBy: "Model",
  writtenAt: NOW,
  format: 1,
  daysHash: "",
};

export const Sidebar = () => (
  <Tile width={360} height={760}>
    <Journal days={DAYS} week={WEEK} now={NOW} showProject={false} onRefresh={() => {}} />
  </Tile>
);
export const AllWorkspaces = () => (
  <Tile width={520} height={760}>
    <Journal days={DAYS} now={NOW} onRefresh={() => {}} />
  </Tile>
);
export const Writing = () => (
  <Tile width={360} height={420}>
    <Journal days={DAYS.slice(0, 1)} now={NOW} summarising="Writing up the last hour…" showProject={false} />
  </Tile>
);
export const NeedsAi = () => (
  <Tile width={360} height={300}>
    <Journal days={[]} now={NOW} onSetUpAi={() => {}} />
  </Tile>
);
export const Empty = () => (
  <Tile width={360} height={300}>
    <Journal days={[]} now={NOW} />
  </Tile>
);
