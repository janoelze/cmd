// Workspace Actions (docs/39-workspace-actions.md): the ways to run the project
// in a folder, found in its own files (package.json, Makefile, justfile…), with
// what they do, how often they ran and whether one is running now.

import type { PaneId } from "./model.ts";

/** What the widget, the library and the palette call it; one place to rename. */
export const ACTIONS_TITLE = "Workspace Actions";

export const ACTION_KINDS = ["dev", "test", "build", "check", "deploy", "setup", "clean", "run"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface WorkspaceAction {
  /** "<source>:<file relative to the root>:<name>", stable across edits. */
  id: string;
  /** "dev", "test:e2e", "release". */
  name: string;
  /** What is typed in the terminal: "pnpm run dev". */
  command: string;
  /** What it runs when that isn't `command`: a package.json script's text ("vite --port 3000"). */
  script?: string;
  /** Where it runs (a package's folder in a monorepo). */
  cwd: string;
  /** Where it was found; `kind` is the source's id ("npm", "make", "just"…); `file` is relative to the root. */
  source: { kind: string; file: string; line?: number };
  /** Workspace package (monorepos); undefined at the root. */
  package?: string;
  kind: ActionKind;
  /** A server or watcher: it doesn't finish by itself. */
  long: boolean;
  /** Deploys, publishes, drops data: confirm before running. */
  risky: boolean;
  description?: string;
  /** "author": from the file (a doc comment, desc); "cmd": cmd's own (cargo build); "model": written by the fast tier. */
  describedBy?: "author" | "cmd" | "model";
  /** Needs arguments (a just recipe's parameters): typed into the terminal, not run. */
  args?: boolean;
  /** A local server's address known before it runs (a compose service's port). */
  url?: string;
  /** Lifecycle scripts and the like: listed under More. */
  hidden?: boolean;
  /** How often it ran here lately (decayed: last week counts more than last year); 0 if never. */
  use?: number;
  /** A command from history rather than a file: what was typed, how often. */
  history?: { runs: number };
  /** Pinned in this folder: listed first. */
  pinned?: boolean;
}

/** An action's latest run in a terminal started from Workspace Actions. */
export interface ActionRun {
  actionId: string;
  paneId: PaneId;
  startedAt: number;
  /** null while running. */
  endedAt: number | null;
  exitCode: number | null;
  /** A local server's address printed by it (http://localhost:5173/). */
  url: string | null;
}

export interface ActionsList {
  /** The folder the actions are for. */
  root: string;
  /** Ordered: pinned, then by use, then file order. */
  actions: WorkspaceAction[];
  /** Commands run here often that no file names, ranked (at most a few). */
  history: WorkspaceAction[];
  /** Commands from the README and similar that no file names, picked by the model. */
  suggested: WorkspaceAction[];
  /** The one to show big (usually dev); null when nothing stands out. */
  primary: string | null;
  /** Files read, and an error for one that couldn't be (its last good actions are kept). */
  sources: { file: string; error?: string }[];
  runs: ActionRun[];
  /** The model is writing descriptions. */
  describing: boolean;
}
