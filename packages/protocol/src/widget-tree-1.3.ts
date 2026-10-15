// The data of API 1.3's verbs: storage (docs/56, "Storage"). A widget keeps JSON values under
// keys in three scopes: its window, its package in the window's workspace, and its package
// everywhere. Which window, workspace and package a call is about comes from the core's own
// knowledge of the caller, never from the call: a scope here is only its name. Within API 1
// these only grow. Their verbs are rows of widget-verbs.ts and entries of widget-tree.ts's
// ApiMethods; the core keeps them in widgets/storage.ts.

import type { ApiNowPlaying } from "./widget-tree-1.2.ts";

/**
 * Where a stored value lives:
 * - "window": this window (`cmd.state` is the same data), gone when the window is.
 * - "workspace": this package, in the window's workspace now; every window of the package there sees it.
 * - "package": this package, every window in every workspace.
 */
export type ApiStorageScope = "window" | "workspace" | "package";

/** The scopes, in the order `cmd.storage` lists them. */
export const API_STORAGE_SCOPES = ["window", "workspace", "package"] as const satisfies readonly ApiStorageScope[];

/** The live `storage` topic: one key of one scope (`useStorage(scope, key, initial)`); its data is the value, or null. */
export interface ApiStorageQuery {
  scope: ApiStorageScope;
  key: string;
}

/**
 * One place of the window whose stored data is older than package.json's `cmd.storage.version`
 * (`to`): the package's, the window's workspace's or the window's own, each with its own version
 * (`from`). The core's answer to hello lists them (`ready.migrate`), in that order; the process
 * runs the migration it registered (`cmd.storage.migrate`) for each and says `migrated` after each.
 */
export interface ApiStorageMigrate {
  /** The scope being migrated: the migration reshapes only that store. */
  scope: ApiStorageScope;
  from: number;
  to: number;
}

/** One place's migration ran (or there was none): ok, and the core keeps what it wrote there with the new version; or it threw, and nothing of that place changed (places migrated before it stay migrated). */
export interface WidgetMigrated {
  kind: "migrated";
  scope: ApiStorageScope;
  ok: boolean;
  /** What the migration threw (ok: false). */
  message?: string;
}

// ── what the native views read (docs/57, "1.3 additions" C4–C12) ──

/** Which week (`journal.week`): this one, of this workspace's journal or, with `workspace: ["all"]`, the one of everything. */
export interface ApiJournalWeekQuery {
  scope?: "workspace" | "all";
}

/** The week the Journal rolled up from its days (`journal.week`): a headline and the week's threads of work. */
export interface ApiJournalWeek {
  /** Monday 00:00 (local) of the week. */
  start: number;
  headline: string;
  /** The week's main threads of work. */
  themes: { title: string; summary: string }[];
  /** When it was written (ms). */
  writtenAt: number;
}

/** A workspace by name (`workspaces.list`, `useWorkspaces`): what says where something is, never its folder. */
export interface ApiWorkspaceName {
  id: string;
  name: string;
}

/** CPU (percent of one core, can pass 100) and memory (bytes) of a group of processes. */
export interface ApiProcessUse {
  cpu: number;
  memory: number;
}

/**
 * What cmd itself uses (`app.usage`, `useAppUsage`), as the Task Manager adds it up: the app's
 * processes (its windows, pages and helpers), and the background process that keeps terminals
 * and agents running (with the terminals' host, not what runs in them). Null where cmd can't
 * tell (no app open, or sampling unavailable).
 */
export interface ApiAppUsage {
  app: ApiProcessUse | null;
  background: ApiProcessUse | null;
  /** When it was sampled (ms). */
  at: number;
}

/** A command run again (`terminals.rerun`): the terminal it was typed into. */
export interface ApiRerun {
  terminalId: string;
}

/** `cmd.env`'s locale (WidgetEnv, widget-tree.ts): the app's, so `fmt` writes numbers as the app beside it does. */
export interface WidgetEnvLocale {
  /** 1.3: the app's locale ("de-DE"), which `fmt.value` and `fmt.delta` write numbers in; a cmd before 1.3 sends none. */
  locale?: string;
}

/** The live `media` topic's query (1.3, `useMedia`): none. Part of TopicQuery. */
export interface MediaTopicQuery {
  media: null;
}

/** The live `media` topic's data (1.3): what plays, or null. On the wire a value without `artwork` keeps the last one sent: the cover crosses only when it changes. Part of TopicData. */
export interface MediaTopicData {
  media: ApiNowPlaying | null;
}

// ── Workspace Actions as the native view has them (docs/57, "1.3 additions" C14) ──

/**
 * Which actions (`actions.list`, `useActions`): those of `root`, a worktree of the workspace's
 * repository (a `path` from `cmd.git.worktrees`; the workspace's folder by default), and with
 * `include` the commands from the person's history and the README's suggestions beside the files'.
 */
export interface ApiActionsQuery {
  /** A worktree of the workspace's repository, as `cmd.git.worktrees` gives its path; anything else is refused. */
  root?: string;
  /** "history": commands run here often that no file names; "suggested": commands the README shows (described by the person's AI). */
  include?: ("history" | "suggested")[];
}

/** Which folder `actions.info` is about: `root` as in ApiActionsQuery. */
export type ApiActionsInfoQuery = Pick<ApiActionsQuery, "root">;

/** Where an action was found: a file (relative to the root, with its line when known), the person's history, or the README. */
export interface ApiActionSource {
  kind: "file" | "history" | "readme";
  /** Relative to the root ("package.json", "apps/web/package.json"); null for history. */
  file: string | null;
  line: number | null;
}

/** The same action running in another worktree of the repository: its branch, terminal and address. */
export interface ApiActionElsewhere {
  branch: string | null;
  terminalId: string;
  url: string | null;
}

/** About a folder's actions (`actions.info`, `useActionsInfo`): its checkout, whether the AI is describing, and files that couldn't be read. */
export interface ApiActionsInfo {
  /** The folder the actions are of (the workspace's, or the worktree asked for). */
  root: string;
  /** Its checkout's branch; null outside a repository or with HEAD detached. */
  branch: string | null;
  /** A linked worktree, not the repository's main checkout. */
  linked: boolean;
  /** The person's AI is writing the actions' descriptions now. */
  describing: boolean;
  /** Source files that couldn't be read (relative to the root): their last good actions are kept. */
  errors: { file: string; error: string }[];
}

/** What an action says since 1.3 (ApiAction, widget-tree.ts, extends it): every field optional, as an older cmd sends none. */
export interface ApiActionMore {
  /** What it runs when that isn't `command`: a package.json script's text ("vite --port 3000"); null when the same. */
  script?: string | null;
  /** It needs arguments (a just recipe's parameters): `cmd.actions.run` types it into a new terminal for the person to finish, never runs it. */
  args?: boolean;
  /** A lifecycle script and the like, which Workspace Actions lists under More. */
  hidden?: boolean;
  /** Where it was found; a file's path is relative to the root. */
  source?: ApiActionSource;
  /** A command from the person's history: how often it ran in this folder; null for any other. */
  history?: { runs: number } | null;
  /** When its latest run here started (ms), null when it hasn't run. */
  startedAt?: number | null;
  /** When its latest run here ended (ms), null while it runs or when it hasn't. */
  endedAt?: number | null;
  /** The same action running now in other worktrees of the repository. */
  elsewhere?: ApiActionElsewhere[];
}

/** How `cmd.actions.run` runs an action (here since 1.3, beside its new options). */
export interface ApiActionRunOptions {
  /** 1.2: one that is running is stopped (⌃C) and run again in its terminal: Restart. An older cmd runs it only when it isn't running. */
  restart?: boolean;
  /** 1.3: in a new terminal, even when its last one is back at its prompt (Run in New Terminal). */
  fresh?: boolean;
  /** 1.3: the worktree it is an action of, as `useActions({ root })` was given; the workspace's folder by default. */
  root?: string;
}
