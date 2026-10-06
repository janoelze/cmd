// The event log (docs/28-data-plan.md): everything that happens, as events with
// one envelope and a payload typed by kind; classes of data with their
// retention; the query shape every client uses. The core's data/ implements it.
//
// Adding a kind: a payload type in EventPayloads and its version in EVENT_V, a
// class in CLASS_OF (else it's "system"), a recorder in the core. Changing a
// payload's shape: raise its EVENT_V and add an upcaster in core/src/data/upcast.ts;
// stored rows keep their `v`, readers see the current shape.

import type { AgentKind, CommandRun, PaneId, SpaceId, WindowId } from "./model.ts";

/** The events file's schema version (tables), not the payloads'. */
export const EVENTS_SCHEMA = 1;

export interface EventPayloads {
  /** A hook event as the agent sent it (the activity log's raw row). */
  "agent.hook": { name: string; agent: AgentKind | null; env?: Record<string, string>; hook?: number | null; payload: Record<string, unknown> };
  /** Something the core inferred about an agent (an interrupt) or couldn't make sense of (an anomaly). */
  "agent.note": { name: "interrupt" | "anomaly"; agent: AgentKind | null; text: string };
  /** A shell command in a terminal (not an agent's), once it ended. Its output is the blob. */
  command: { command: string | null; exitCode: number | null; cwd: string; output: { chars: number; cut: boolean } | null };
  "git.commit": { hash: string; subject: string; branch: string | null; worktree: string | null; repo: string };
  "git.merge": { branch: string; into: string | null; fastForward: boolean; hash: string; worktree: string | null; repo: string };
  "git.checkout": { from: string; to: string; worktree: string | null; repo: string };
  "git.branch": { branch: string; from: string | null; worktree: string | null; repo: string };
  "git.tag": { tag: string; hash: string; repo: string };
  "git.rebase": { branch: string | null; onto: string | null; worktree: string | null; repo: string };
  "git.reset": { to: string; worktree: string | null; repo: string };
  /** A page a browser window showed (one per page per half hour). */
  "browser.visit": { url: string; title: string | null };
  /** A file shown in a window (text, Markdown, PDF, files). */
  "file.open": { path: string; windowKind: string };
  "window.open": { kind: string; title: string };
  "window.close": { kind: string; title: string };
  "space.open": { name: string; root: string };
  "space.close": { name: string; root: string };
  /** The person looked at an agent (its "unseen" mark cleared). */
  "user.look": { agentId: string };
  /** An app command ran (palette, menu, shortcut, CLI). */
  "user.command": { command: string; via: "palette" | "menu" | "shortcut" | "cli" | "other" };
  /** A pane or window had the focus (a span: extended while it keeps it). */
  "user.focus": { paneId?: PaneId; windowId?: WindowId };
  /** A notification shown by cmd. */
  notification: { source: string; title: string; body: string; urgent: boolean };
  /** A model call: what for, which model, how long, how many tokens. Input and output are blobs on child events. */
  "ai.call": {
    purpose: string;
    provider: string;
    model: string;
    tier: string;
    ms: number;
    tokens: { in: number; out: number };
    ok: boolean;
    error?: string;
    /** What the input was made of (core/src/ai/context.ts): parts, sizes, cuts, redactions, source events, hash. */
    context?: { budget: number; chars: number; hash: string; parts: { name: string; chars: number; of: number; cut: boolean; redacted: number; events?: number }[]; events: string[] };
  };
  /** Something a person or an agent wrote down on purpose. */
  note: { by: "user" | "agent"; agentSession: string | null };
  /** Agent transcripts, one line each (docs/28 §2); shapes per agent in core/src/data/sources/transcripts.ts. */
  "transcript.message": Record<string, unknown>;
  "transcript.tool_use": Record<string, unknown>;
  "transcript.tool_result": Record<string, unknown>;
  "transcript.compaction": Record<string, unknown>;
  "transcript.summary": Record<string, unknown>;
  "transcript.title": Record<string, unknown>;
  "transcript.system": Record<string, unknown>;
  "transcript.session": Record<string, unknown>;
  "transcript.other": Record<string, unknown>;
  /** The data layer about itself: a rebuild, a prune, an import, a forget. */
  "data.op": { op: "import" | "prune" | "rebuild" | "forget"; detail: Record<string, unknown> };
}

export type DataEventType = keyof EventPayloads;

/** Each payload's current version. Raise when a shape changes incompatibly. */
export const EVENT_V: Record<DataEventType, number> = {
  "agent.hook": 1,
  "agent.note": 1,
  command: 1,
  "git.commit": 1,
  "git.merge": 1,
  "git.checkout": 1,
  "git.branch": 1,
  "git.tag": 1,
  "git.rebase": 1,
  "git.reset": 1,
  "browser.visit": 1,
  "file.open": 1,
  "window.open": 1,
  "window.close": 1,
  "space.open": 1,
  "space.close": 1,
  "user.look": 1,
  "user.command": 1,
  "user.focus": 1,
  notification: 1,
  "ai.call": 1,
  note: 1,
  "transcript.message": 1,
  "transcript.tool_use": 1,
  "transcript.tool_result": 1,
  "transcript.compaction": 1,
  "transcript.summary": 1,
  "transcript.title": 1,
  "transcript.system": 1,
  "transcript.session": 1,
  "transcript.other": 1,
  "data.op": 1,
};

/** An event as stored and as every client sees it. */
export interface DataEvent<T extends DataEventType = DataEventType> {
  /** Order of recording: identity for cursors and subscriptions. */
  seq: number;
  /** Stable across re-recording: the source's own id, or a key. */
  id: string;
  /** When it happened, ms. */
  at: number;
  /** A span's end; null for moments. */
  until: number | null;
  type: T;
  /** The payload's version when written. */
  v: number;
  /** Who produced it: "hook:claude@2.1.289", "osc", "git", "window", "user", "cmd@0.16.0". */
  source: string;
  /** The cmd that wrote it. */
  recorded: string;
  parentId: string | null;
  spaceId: SpaceId | null;
  projectId: string | null;
  sessionId: string | null;
  agentId: string | null;
  paneId: PaneId | null;
  windowId: WindowId | null;
  deviceId: string | null;
  /** One line for people, search and models. */
  text: string | null;
  data: EventPayloads[T];
  /** Hash of the offloaded content (data.blob), when there is some. */
  blob: string | null;
  /** DATA_FLAGS bits. */
  flags: number;
}

export const DATA_FLAGS = { redacted: 1, cut: 2, imported: 4, tombstone: 8 } as const;

/** What a recorder (or `data.record`) hands in. */
export interface NewDataEvent<T extends DataEventType = DataEventType> {
  id: string;
  at: number;
  until?: number | null;
  type: T;
  source: string;
  parentId?: string | null;
  spaceId?: SpaceId | null;
  projectId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  paneId?: PaneId | null;
  windowId?: WindowId | null;
  deviceId?: string | null;
  text?: string | null;
  data: EventPayloads[T];
  /** Big text kept as a blob, not in the row (output, a transcript line). */
  content?: string | null;
  /** Words for full text beyond `text`. */
  body?: string | null;
}

/** One query shape over events (docs/28 §4). Type prefixes end in a dot: "git.". */
export interface DataQuery {
  types?: string[];
  /** [from, to) in ms. */
  at?: [number, number];
  spaceId?: SpaceId;
  projectId?: string;
  sessionId?: string;
  agentId?: string;
  paneId?: PaneId;
  windowId?: WindowId;
  parentId?: string;
  /** Full text over text and body (FTS5 syntax). */
  text?: string;
  order?: "asc" | "desc";
  limit?: number;
  /** Only events after this seq (paging, cursors). */
  after?: number;
}

/** Classes of data: what a retention rule, a switch and a privacy line are about. */
export type DataClass = "agents" | "transcripts" | "output" | "browsing" | "actions" | "ai" | "git" | "notes" | "system";

export interface DataClassInfo {
  class: DataClass;
  title: string;
  description: string;
  /** Type names and prefixes in the class. */
  types: string[];
  /** Days kept; null: forever. Set from data.keepDays unless fixed. */
  keepDays: number | null;
  /** Blob content cut here (chars); null: whole. */
  cap: number | null;
  /** The setting that turns recording of the class off, if any. */
  setting: string | null;
  /** Whether and how this data ever leaves the Mac. */
  leaves: string | null;
}

export const DATA_CLASSES: Record<DataClass, Omit<DataClassInfo, "class" | "keepDays"> & { keepDays: number | null | "setting" }> = {
  agents: { title: "Agent events", description: "What agents' hooks report: prompts, tool calls, questions, stops.", types: ["agent."], keepDays: "setting", cap: 64_000, setting: null, leaves: "Only to a model you set up, when a feature asks (journal, summaries)." },
  transcripts: { title: "Transcripts", description: "cmd's copy of each agent session: messages, tool calls and results.", types: ["transcript."], keepDays: "setting", cap: 64_000, setting: "data.record.transcripts", leaves: "Only to a model you set up, when a feature asks." },
  output: { title: "Command output", description: "What commands printed in your terminals, after they ended.", types: ["command"], keepDays: 90, cap: 256_000, setting: "data.record.output", leaves: "Only to a model you set up, when a feature asks." },
  browsing: { title: "Pages and files", description: "Pages browser windows showed, files opened in windows.", types: ["browser.", "file.", "window."], keepDays: "setting", cap: null, setting: "data.record.browsing", leaves: "Only to a model you set up, when a feature asks." },
  actions: { title: "Your actions", description: "What you focused, opened, closed and ran in cmd.", types: ["user.", "space."], keepDays: "setting", cap: null, setting: "data.record.actions", leaves: null },
  ai: { title: "Model calls", description: "Each call cmd made to a model: purpose, model, tokens, what was sent and what came back.", types: ["ai."], keepDays: "setting", cap: 1_000_000, setting: null, leaves: "The call itself goes to the provider; the record stays here." },
  git: { title: "Git", description: "Commits, merges, branches and tags in your projects.", types: ["git."], keepDays: null, cap: null, setting: null, leaves: null },
  notes: { title: "Notes and notifications", description: "Notes you or agents wrote down; notifications shown.", types: ["note", "notification"], keepDays: null, cap: null, setting: null, leaves: null },
  system: { title: "The data layer", description: "Imports, prunes, rebuilds.", types: ["data."], keepDays: null, cap: null, setting: null, leaves: null },
};

/** The class of an event type ("system" for kinds no class names). */
export function classOf(type: string): DataClass {
  for (const [c, info] of Object.entries(DATA_CLASSES) as [DataClass, (typeof DATA_CLASSES)[DataClass]][]) {
    for (const t of info.types) if (t.endsWith(".") ? type.startsWith(t) : type === t) return c;
  }
  return "system";
}

/** A command event as the CommandRun the Commands widget shows (runs are recorded when they start, updated when they end). */
export function commandRunOf(e: DataEvent): CommandRun {
  const d = e.data as EventPayloads["command"];
  return { id: e.id.replace(/^command:/, ""), paneId: e.paneId ?? "", spaceId: e.spaceId ?? "", command: d.command, cwd: d.cwd, startedAt: e.at, endedAt: e.until, exitCode: d.exitCode };
}

export interface DataStats {
  file: string | null;
  fileBytes: number;
  events: number;
  blobs: { count: number; size: number; stored: number };
  /** Rows and inline bytes per type. */
  types: { type: string; rows: number; bytes: number; blobs: number }[];
  /** Events in the last 24 hours and 7 days. */
  recent: { day: number; week: number };
  oldest: number | null;
}
