// The journal (docs/23-journal.md): what happened in a workspace, as data.
// Three layers, each derived from the one before and re-derivable:
// - JournalEvent: a fact, recorded as it happens (or backfilled from git, the
//   activity log and transcripts), kept for months. Never rewritten by readers.
// - JournalThread: events that belong together by identity (one agent session,
//   one git branch, one terminal's burst of commands), linked by explicit rules
//   that say why. Deterministic, so the same events always give the same threads.
// - JournalEntry / JournalDay: the work as a person would name it ("Released
//   v0.14.4", "Investigated a corrupt search index"), written by a model from a
//   digest of a day's threads. Each entry names the threads it was made from.

import type { AgentKind, WorkspaceId } from "./model.ts";

/**
 * Versions of the journal's layers (docs/24-journal-versions.md). Each says
 * which rules made a piece of data, so a revision never has to guess.
 * - JOURNAL_SCHEMA: the stored event (table columns, JournalData per kind).
 *   Raise when a kind's data changes shape; readers keep reading older rows.
 * - SOURCES_FORMAT: how pulled sources (turns, sessions, git) map to events.
 *   Raise when that mapping changes: the next sync reads them all again (keys
 *   are stable, so events are updated in place).
 * - THREADS_FORMAT: the threading rules and the digest's text (threads.ts, digest.ts).
 * - WRITER_FORMAT: the prompt, the answer's schema and its checks (writer.ts).
 * A written day records all of them; one written by older rules is kept as
 * written unless its events changed, it's recent, or it's asked for again.
 */
export const JOURNAL_SCHEMA = 1;
export const SOURCES_FORMAT = 1;
export const THREADS_FORMAT = 1;
export const WRITER_FORMAT = 1;

/** Which versions of the rules a day was written with. */
export interface JournalFormat {
  schema: number;
  threads: number;
  writer: number;
}

export type JournalEventKind =
  /** An agent session: a span from its first to its latest activity. Upserted as it grows. */
  | "agent.session"
  /** One prompt and what came of it (AgentTurn, condensed). */
  | "agent.turn"
  /** A shell command in a terminal (not an agent's), once it ended. */
  | "command"
  | "git.commit"
  /** A branch merged into the one checked out (fast-forward or not). */
  | "git.merge"
  | "git.checkout"
  /** A branch created, with the worktree it was created in when there is one. */
  | "git.branch"
  | "git.tag"
  | "git.rebase"
  | "git.reset"
  /** A page a browser window showed (coalesced: one per page, with its title). */
  | "browser.visit"
  /** A file shown in a window (text, Markdown, PDF, files). */
  | "file.open"
  /** Something a person or an agent wrote down on purpose (`cmd journal note`). */
  | "note"
  | "workspace.open"
  | "workspace.close";

export interface JournalEvent {
  /** Order of recording (row id). */
  id: number;
  /** When it happened (a span's start), ms. */
  at: number;
  /** A span's end (sessions, turns, commands); null for moments. */
  until: number | null;
  kind: JournalEventKind;
  /** What makes it the same event when seen twice (live and backfill, or a growing session). */
  key: string;
  workspaceId: WorkspaceId | null;
  /** The project: a repository's main worktree, else the folder. Worktrees of one repository share it. */
  repo: string | null;
  cwd: string | null;
  /**
   * The identity it was recorded under, the threads' seed: "session:<id>",
   * "branch:<repo>#<name>", "pane:<id>", "window:<id>". null: none (a note, a tag).
   */
  thread: string | null;
  /** One line for people and models. */
  text: string;
  data: JournalData;
  source: "live" | "backfill";
}

export type JournalData =
  | { kind: "agent.session"; agent: AgentKind; sessionId: string; title: string | null; firstPrompt: string | null; branch: string | null; turns?: number }
  | {
      kind: "agent.turn";
      agent: AgentKind;
      sessionId: string | null;
      agentId: string | null;
      prompt: string | null;
      /** Sent by the agent itself (a background task reporting back). */
      auto: boolean;
      followUps: string[];
      final: string | null;
      outcome: string;
      error: string | null;
      /** Absolute paths (worktrees show which branch). */
      files: string[];
      commands: string[];
      tools: number;
    }
  | { kind: "command"; command: string; exitCode: number | null; paneId: string | null }
  | { kind: "git.commit"; hash: string; subject: string; branch: string | null; worktree: string | null }
  | { kind: "git.merge"; branch: string; into: string | null; fastForward: boolean; hash: string; worktree: string | null }
  | { kind: "git.checkout"; from: string; to: string; worktree: string | null }
  | { kind: "git.branch"; branch: string; from: string | null; worktree: string | null }
  | { kind: "git.tag"; tag: string; hash: string }
  | { kind: "git.rebase"; branch: string | null; onto: string | null; worktree: string | null }
  | { kind: "git.reset"; to: string; worktree: string | null }
  | { kind: "browser.visit"; url: string; title: string | null; windowId: string | null }
  | { kind: "file.open"; path: string; windowKind: string; windowId: string | null }
  | { kind: "note"; by: "user" | "agent"; agentSession: string | null }
  | { kind: "workspace.open" | "workspace.close"; name: string };

export type JournalThreadKind = "session" | "branch" | "release" | "terminal" | "browsing" | "note" | "other";

/** Why two things were put together: shown with the thread, so a wrong link can be explained and fixed. */
export interface JournalLink {
  /** The thread it links to. */
  to: string;
  rule: string;
}

export interface JournalThread {
  /** Stable for the same events: the seed identity ("session:…", "branch:cmd#dnd", "release:cmd#v0.14.4"). */
  id: string;
  kind: JournalThreadKind;
  repo: string | null;
  workspaceId: WorkspaceId | null;
  start: number;
  end: number;
  /** A label from the data (a session's title, a branch name, a tag), for the digest and fallbacks. */
  label: string;
  events: number[];
  links: JournalLink[];
  /** Too small to be an entry of its own ("say hi", a 10-second session in a temp folder). */
  minor: boolean;
  /**
   * The piece of work it's part of: threads joined by strong links (a session and
   * the branch it built, a release and the session that cut it) share a group, the
   * id of the group's first thread. A suggestion the writer may override.
   */
  group: string;
}

export type JournalEntryKind = "release" | "investigation" | "feature" | "fix" | "design" | "refactor" | "research" | "review" | "ops" | "chore";
export type JournalOutcome = "shipped" | "merged" | "fixed" | "answered" | "open" | "dropped";

export interface JournalEntry {
  /** Stable across rewrites: from its first thread. */
  id: string;
  kind: JournalEntryKind;
  title: string;
  summary: string;
  outcome: JournalOutcome | null;
  start: number;
  end: number;
  repo: string | null;
  threads: string[];
  counts: { agents: number; prompts: number; commands: number; commits: number; pages: number; files: number };
}

export interface JournalDay {
  /** Local midnight of the work day (it runs 04:00 to 04:00). */
  date: number;
  /** "workspace:<id>", "repo:<path>" or "all". */
  scope: string;
  headline: string;
  entries: JournalEntry[];
  /** The model that wrote it, and when. */
  writtenBy: string | null;
  writtenAt: number;
  /** The rules it was written with. Missing: written before days carried it (format 1). */
  format: JournalFormat;
  /** What happened that day, hashed: when it changes, the day is written again. Independent of the rules. */
  eventsHash: string;
  /** The digest the model got, hashed (for comparing revisions). */
  inputHash: string;
  /** Written by older rules than this cmd's (set when read, not stored). */
  outdated?: boolean;
  /** Threads left out as minor, counted. */
  minor: number;
}

/** A week rolled up from its days (core/src/journal/weeks.ts). */
export interface JournalWeek {
  /** Monday 00:00 (local) of the week; work days run 04:00 to 04:00. */
  start: number;
  scope: string;
  headline: string;
  /** The week's main threads of work, each with the day entries it covers. */
  themes: { title: string; summary: string; entries: { day: number; entry: string }[] }[];
  /** The work days it was written from. */
  days: number[];
  writtenBy: string | null;
  writtenAt: number;
  /** WEEK_FORMAT it was written with. */
  format: number;
  /** What its days said, hashed: written again when it changes. */
  daysHash: string;
}
