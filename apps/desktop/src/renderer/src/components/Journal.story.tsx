// Workbench stories (pnpm workbench journal): the Journal widget, on two days
// of this repo's own history as a summariser might write them up.
import { Window, WindowBar, WindowBarMenu, WindowBody, WindowFrame } from "@cmd/ui";
import type { ReactNode } from "react";
import { Journal, type JournalDay } from "./Journal.tsx";

const NOW = new Date(2026, 9, 6, 11, 45).getTime();
const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
const midnight = (d: number) => new Date(2026, 9, d).getTime();

const DAYS: JournalDay[] = [
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
        events: [
          { kind: "agent", text: "Make windows part of the kit", at: at(6, 11, 20), meta: "Claude · 17 min" },
          { kind: "agent", text: "e2e: run without stealing focus", at: at(6, 11, 22), meta: "Claude · 15 min" },
          { kind: "command", text: "pnpm workbench matrix whatsnew", at: at(6, 11, 31), meta: "8 s" },
          { kind: "commit", text: "Windows are the kit's: Window, WindowBody…", at: at(6, 11, 35), meta: "master" },
          { kind: "commit", text: "e2e background mode: windows are transparent…", at: at(6, 11, 37), meta: "master" },
        ],
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
        events: [
          { kind: "commit", text: "Drag and drop: files between Finder, terminals…", at: at(6, 10, 58) },
          { kind: "commit", text: "Drag and drop guards: protected folders…", at: at(6, 11, 16) },
          { kind: "command", text: "pnpm typecheck && pnpm test", at: at(6, 11, 21), meta: "48 s" },
          { kind: "commit", text: "Changelog for v0.14.4", at: at(6, 11, 25) },
          { kind: "command", text: "pnpm release 0.14.4", at: at(6, 11, 26), meta: "1 min" },
          { kind: "release", text: "v0.14.4 published on GitHub", at: at(6, 11, 34) },
        ],
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
        events: [
          { kind: "agent", text: "Drag files between Finder and cmd", at: at(6, 9, 40), meta: "Claude · 1 h 18 min" },
          { kind: "command", text: "pnpm vitest run drops", at: at(6, 10, 22), failed: true, meta: "exit 1" },
          { kind: "command", text: "pnpm vitest run drops", at: at(6, 10, 31), meta: "3 s" },
          { kind: "file", text: "docs/drag-and-drop.md", at: at(6, 10, 59) },
        ],
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
        events: [
          { kind: "command", text: "pnpm release 0.14.2", at: at(6, 0, 43), meta: "1 min" },
          { kind: "command", text: "pnpm release 0.14.3", at: at(6, 1, 18), meta: "1 min" },
        ],
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
        events: [
          { kind: "agent", text: "A workbench for prototyping UI", at: at(5, 21, 10), meta: "Claude · 2 h 37 min" },
          { kind: "commit", text: "Workbench: one component at a time in the real app", at: at(5, 23, 47) },
        ],
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
        events: [
          { kind: "note", text: "“search shows nothing since the crash”", at: at(5, 15, 5) },
          { kind: "command", text: "sqlite3 cmd.db 'PRAGMA integrity_check'", at: at(5, 15, 12), failed: true, meta: "malformed" },
          { kind: "page", text: "SQLite FTS5: The 'rebuild' command", at: at(5, 15, 30), meta: "sqlite.org" },
          { kind: "agent", text: "Why is the search index corrupt?", at: at(5, 15, 34), meta: "Claude · 1 h 50 min" },
          { kind: "page", text: "WAL mode and crashes", at: at(5, 16, 2), meta: "sqlite.org" },
          { kind: "command", text: "pnpm vitest run search", at: at(5, 17, 20), meta: "6 s" },
        ],
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
        events: [{ kind: "agent", text: "Jira skill: JQL first", at: at(5, 14, 10), meta: "Claude · 40 min" }],
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
        events: [
          { kind: "page", text: "Raycast Store: publishing an extension", at: at(5, 11, 3), meta: "developers.raycast.com" },
          { kind: "page", text: "Übersicht widgets gallery", at: at(5, 11, 20), meta: "tracesof.net" },
        ],
      },
    ],
  },
];

/** A widget tile as the desk draws it. */
function Tile({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  return (
    <Window style={{ width, height, position: "relative" }}>
      <WindowBody style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <WindowBar icon="book" name="Journal">
          <span style={{ flex: 1 }} />
          <WindowBarMenu>This Space</WindowBarMenu>
        </WindowBar>
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>{children}</div>
      </WindowBody>
      <WindowFrame />
    </Window>
  );
}

export const Sidebar = () => (
  <Tile width={360} height={760}>
    <Journal days={DAYS} now={NOW} showProject={false} onRefresh={() => {}} />
  </Tile>
);
export const AllSpaces = () => (
  <Tile width={520} height={760}>
    <Journal days={DAYS} now={NOW} onRefresh={() => {}} />
  </Tile>
);
export const Opened = () => (
  <Tile width={420} height={760}>
    <Journal days={DAYS.slice(1)} now={NOW} showProject={false} initialOpen="db" />
  </Tile>
);
export const Writing = () => (
  <Tile width={360} height={420}>
    <Journal days={DAYS.slice(0, 1)} now={NOW} summarising="Writing up the last hour…" showProject={false} />
  </Tile>
);
export const Empty = () => (
  <Tile width={360} height={300}>
    <Journal days={[]} now={NOW} />
  </Tile>
);
