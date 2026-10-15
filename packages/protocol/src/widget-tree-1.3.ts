// The data of API 1.3's verbs: storage (docs/56, "Storage"). A widget keeps JSON values under
// keys in three scopes: its window, its package in the window's workspace, and its package
// everywhere. Which window, workspace and package a call is about comes from the core's own
// knowledge of the caller, never from the call: a scope here is only its name. Within API 1
// these only grow. Their verbs are rows of widget-verbs.ts and entries of widget-tree.ts's
// ApiMethods; the core keeps them in widgets/storage.ts.

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
 * The core's answer to hello says a migration is due (`ready.migrate`): package.json's
 * `cmd.storage.version` (`to`) is newer than the version the package's stored data has (`from`).
 * The process runs the migration it registered (`cmd.storage.migrate`), then says `migrated`.
 */
export interface ApiStorageMigrate {
  from: number;
  to: number;
}

/** The process ran (or had no) migration: ok, and the core keeps what it wrote and the new version; or it threw, and nothing it wrote is kept. */
export interface WidgetMigrated {
  kind: "migrated";
  ok: boolean;
  /** What the migration threw (ok: false). */
  message?: string;
}
