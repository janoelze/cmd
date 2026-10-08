// Spaces (docs/11-spaces.md): constants and helpers shared by core, CLI and UI.

import type { GitPlace, Space } from "./model.ts";

/** The Space that always exists, rooted at the home folder; it catches everything without a better Space. */
export const HOME_SPACE_ID = "home";

/** A Space's icon: its own SF Symbol, else a house for Home and a folder for the rest. */
export function spaceIcon(s: { icon: string | null; home: boolean }): string {
  return s.icon ?? (s.home ? "house" : "folder");
}

/** SF Symbol names: lowercase words joined by dots. */
export const ICON_NAME = /^[a-z0-9]+(\.[a-z0-9]+)*$/;

/**
 * Where something is, as far as it differs from its Space (docs/35): null in
 * the Space's own checkout (or, outside a repository, inside the Space's
 * folder); else its checkout, or the folder outside any. The UI's chips and
 * `cmd ls` say it in their own words.
 */
export function placeAgainst(
  git: GitPlace | null | undefined,
  cwd: string | null | undefined,
  space: Pick<Space, "root" | "home" | "git"> | undefined,
): { git: GitPlace; sameProject: boolean } | { folder: string } | null {
  if (!git) {
    if (!cwd || (space && (space.home ? cwd === space.root : cwd === space.root || cwd.startsWith(space.root + "/")))) return null;
    return { folder: cwd };
  }
  if (space?.git && git.top === space.git.top) return null;
  return { git, sameProject: space?.git?.project === git.project };
}
