// Workspaces (docs/11-workspaces.md): constants and helpers shared by core, CLI and UI.

import type { GitPlace, Workspace } from "./model.ts";

/** The workspace that always exists, rooted at the home folder; it catches everything without a better workspace. */
export const HOME_WORKSPACE_ID = "home";

/** A workspace's icon: its own SF Symbol, else a house for Home and a folder for the rest. */
export function workspaceIcon(s: { icon: string | null; home: boolean }): string {
  return s.icon ?? (s.home ? "house" : "folder");
}

/** SF Symbol names: lowercase words joined by dots. */
export const ICON_NAME = /^[a-z0-9]+(\.[a-z0-9]+)*$/;

/**
 * Where something is, as far as it differs from its workspace (docs/35): null in
 * the workspace's own checkout (or, outside a repository, inside the workspace's
 * folder); else its checkout, or the folder outside any. The UI's chips and
 * `cmd ls` say it in their own words.
 */
export function placeAgainst(
  git: GitPlace | null | undefined,
  cwd: string | null | undefined,
  workspace: Pick<Workspace, "root" | "home" | "git"> | undefined,
): { git: GitPlace; sameProject: boolean } | { folder: string } | null {
  if (!git) {
    if (!cwd || (workspace && (workspace.home ? cwd === workspace.root : cwd === workspace.root || cwd.startsWith(workspace.root + "/")))) return null;
    return { folder: cwd };
  }
  if (workspace?.git && git.top === workspace.git.top) return null;
  return { git, sameProject: workspace?.git?.project === git.project };
}
