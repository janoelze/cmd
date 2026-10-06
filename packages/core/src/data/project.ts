// A project's identity for the event log (docs/28 §2, entities): a repository's
// main worktree, so every worktree, branch and subfolder of one repository is
// one project; a folder that isn't a repository is its own. Recorded with every
// event at the time, never inferred from a path later.

import { repoOfSync } from "../journal/git.ts";

/** The project a folder belongs to: its repository's main worktree, else the folder. Null for nothing. */
export function projectOf(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  return repoOfSync(cwd)?.repo ?? cwd;
}

/** The project id for a folder ("dir:<project>"), or null. */
export function projectIdOf(cwd: string | null | undefined): string | null {
  const p = projectOf(cwd);
  return p ? `dir:${p}` : null;
}
