# Live Diff across worktrees

**Status:** built: the overview, the diff pane, `git.worktrees` and `git.fileVersions`; next: a review mode ("since you last looked"), side by side in the pane when it is wide.

From feedback (2026-10-12): Live Diff only showed the checkout it followed, so agents working in worktrees were invisible to it. With up to five agents in worktrees at once, the widget now answers three questions, in this order:

1. **Will anything collide?** Files more than one checkout changed come first, as **Clashes**; those where their changes cover the same lines of the base sort to the top and get an orange `!`. Only that is coloured.
2. **What is each agent doing?** One row per checkout, named after the agent working there (its status light, branch, +/−, when it last wrote), newest first; its files under it, newest first, four and then "N more".
3. **What exactly changed?** A file opens in a pane under the list, the whole file (`FileDiff`), one agent's change at a time; the window's footer says whose change it is, its branch, committed or not, how many changes.

A second lens, **Areas**, groups the same files by part of the codebase (`apps/desktop`, `packages/core`, `docs`), each with the agents that touch it.

## What it shows

- **Which checkouts.** The repository's main checkout, and every linked worktree with a terminal or agent of this core in it, or whose git state (index, HEAD, its log) changed in the last day; finished and abandoned ones are left out. Worktrees come from the shared git folder (`<repo>/.git/worktrees/*/gitdir`, `worktreesOf`), so ones made outside cmd count too. Live Diff switches to this view when a checkout other than the main one has work; with only the main checkout it is the single-checkout view it always was.
- **Against what.** A linked worktree is compared with its **merge base** with the main branch (`main` or `master`, else origin's HEAD), committed or not: agents commit as they go, so uncommitted changes alone would show almost nothing. The main checkout is compared with HEAD, as before. A worktree on the main branch itself too.
- **Clashes.** For a file more than one checkout changed, the core sends the base lines each one's changes cover (`git diff -U0`); the UI compares them. Bases differ between branches that left at different times, so on long-lived branches this is a heads-up, not a merge check.
- **The diff** (`windows/diff/FileDiff.tsx`): the file whole at the base and now (`git.fileVersions`), in a read-only CodeMirror (`@codemirror/merge`) in the file's language: unified (split for a wide pane, not wired yet), unchanged stretches folded to one line, changed words marked (not in lines that are only added), lines another agent changes too with an orange number. When the agent writes again, only what differs changes, lit for a moment; the scroll stays.

## Data

- `git.worktrees { path }` → `{ repo, mainBranch, worktrees: WorktreeChanges[] }`: per checkout its top, git folder, branch, base, commits since it, and files (`BranchFile`: path, state, +/−, binary, uncommitted, mtime, `hunks` for shared files). About five git runs per active checkout (`status`, two `diff`s, `merge-base`, `rev-list`), in parallel; ~80 ms for this repository's nine worktrees.
- `git.fileVersions { top, file, base }` → the texts; none for binary files or over 2 MB.
- The renderer polls every 3 s while cmd is in front and at once when a checkout's index or HEAD changes (`worktrees.ts`), and names each checkout after its agent (the store's agents, by `git.top`).
- Both are `never` for remote devices.

## Decisions

- **A table, not chips.** The first prototype gave every agent and branch a hue and every count green and red; it was hard to read. The overview is a `DataGrid` with nested rows, aligned columns, no header, and one colour: the clash's.
- **The diff under the list, not in it.** Inline diffs pushed the overview off screen; the pane (a bottom `Split`, sliding in on the glide) keeps the list whole and its columns.
- **No change ruler.** A strip of marks pinned beside the scrollbar read as a stray highlight; the gutter's bars scroll with their lines, and the header steps through changes.
