# Repositories, worktrees and branches

> Status (2026-10-08): steps 1 and 2 built on branch `checkouts`: `GitPlace` on panes, agents and Spaces (`checkout.ts` `placeOf`; an agent's from where it writes, `tracker.ts#placeAfter`), peer briefings from it, `whereOf` for the sidebar chip, Agent Activity and an agent's place. Not yet: the Commands widget (a `CommandRun` has only its cwd), history rows, steps 3–5. A user asked for "worktree support" (Discord #feedback, 2026-10-07). Jan: cmd stays unopinionated about workflow; showing worktrees when they're used is fine, managing them is not cmd's job. Read first: this doc, `packages/core/src/checkout.ts`, `apps/desktop/src/renderer/src/model.ts` (`project`, `place`), docs/11 (Spaces), docs/32 (names from branches).

**The rule.** cmd shows where something is only where it differs from what you're looking at. A terminal or agent in the Space's own checkout says nothing about it; one in a linked worktree says which branch; one in another project says which project. Someone who never makes a worktree sees no change, except fewer repeated labels.

**Not cmd's job:** creating, removing or cleaning up worktrees, setup scripts, port blocks, "merge and archive". Agents and people already do that their own way (`git worktree`, `claude --worktree`, scripts); a widget or a `cmd` alias can add a button for someone who wants one.

## What there is today

### Core: one reader, four shapes

`checkout.ts` reads `.git` without running git and is the only place that answers "which repository, which worktree, which branch". Its `Checkout` is `{ top, repo, common, gitDir, branch }`: `top` the worktree, `repo` the main worktree's folder (equal for every worktree of a repository), `common` the shared `.git`. Its callers wrap it again:

| Where | Shape | Note |
|---|---|---|
| `spaces/paths.ts` `gitRoot` | `top` | `--git-root` means the worktree's own top, so a worktree is its own Space |
| `data/project.ts` `projectOf` | `repo`, via `journal/git.ts` `repoOfSync` | the event log's project id `dir:<main worktree>`: all worktrees are one project |
| `journal/git.ts` `RepoInfo`, `repoOfSync` | `{ repo, top, common, branch }`, `{ repo, top }` | two more copies of the same fields |
| `agents/peers.ts` `Checkout` | `{ repo: realpath(common), root: top, branch }` | same name as checkout.ts's type, but `repo` means the `.git` folder here and `root` means `top` |
| `agents/names.ts` `worktreeName` | `{ name, top, branch, wrote }` | from where the agent **works** (files it writes, `cd`, `git -C`), not its cwd |
| `git.ts` `gitStatus` | `GitStatus` (runs `git status`) | branch, upstream, ahead/behind, changed files; Files and Live Diff only |
| `core.ts` `#searchRoot` | `top` | Home's file search uses the selected window's worktree |

### Protocol: nothing reaches the UI

`Space`, `Pane` and `Agent` carry a path (`root`, `cwd`) and nothing about git. `GitStatus` (on request, for one folder), `SearchHit.branch`, `SessionInfo.branch/projectId`, `JournalEvent.repo` and the git event payloads (`repo`, `worktree`, `branch`) are the only git fields clients see.

### UI and CLI: four meanings of "project"

| Surface | Shows | From |
|---|---|---|
| Sidebar agent and terminal rows, chip | last segment of the cwd (`project()`, `model.ts:314`) | `cwd` |
| Title bars, sidebar place line | `shortPath(cwd)` | `cwd` |
| Commands widget, Agent Activity | the same basename chip | `cwd` |
| Navigator history rows | basename · branch | `SessionInfo` |
| Palette session hits | agent · path · branch · when | `SearchHit` |
| Journal chip | basename of the main worktree, only when there are several | `JournalEvent.repo` |
| Space switcher, ⌘O picker | Space name, `shortPath(root)` | `Space` |
| Files, Live Diff | branch, ↑↓, changed count | `git.status` |
| `cmd ls` | agents without a folder; terminals with the raw cwd | |
| `cmd search` | no branch, no folder | `SearchHit` has both |
| `cmd journal --repo`, `cmd data --project` | the same thing, two flag names | |

### Loose ends

1. **Repeated chips.** In the `cmd` Space every agent row says `cmd`: the chip is the cwd's folder name, which is the Space's own name. It never says anything the Space switcher doesn't. In a subfolder it says the subfolder (`core`), in a sibling worktree the worktree's folder (`cmd-windows`) while the Journal says `cmd` for the same terminal.
2. **An agent's place is where it started.** Agents mostly start in the main checkout and `cd` into a worktree; their `cwd` stays. Naming knows better (`names.ts` reads where they write), the chip, title bar and peer briefings don't. The briefing that opens every session in this repository says "same checkout as you on master" for agents that each work in their own worktree, because `tracker.ts#checkout` reads `a.cwd`.
3. **Names from branches don't say so.** An agent named `Search design` after its branch shows no branch anywhere while it runs; its past session, in Navigator history, does.
4. **Worktrees of one repository look unrelated.** A sibling worktree (`~/src/cmd-windows`) is its own Space or falls into Home, with nothing tying it to `cmd`; the picker lists it under Folders. A worktree nested inside the repository (`.claude/worktrees/x`) silently belongs to the main Space, and its files show up in that Space's file search next to the originals.
5. **The journal guesses a workflow.** `journal/threads.ts` places a branch's work in the worktree git recorded, else in `<repo>-<branch>` beside the repository: this repository's own convention (CLAUDE.md), assumed for everyone.
6. **A removed worktree leaves things behind.** After `git worktree remove`, a Space on it stays open on a folder that isn't there, and a terminal resurrected in it silently starts in the Space's root instead (`restore.ts:113`). Nothing says the folder is gone or the branch merged.
7. **Names.** "project" (UI: a folder's name; log: the repository), "repo" (journal), "checkout" (core), "work tree" (`GitStatus.root`), `--git-root` (the worktree, not the repository). Two `Checkout` types with different meanings of `repo`.
8. **The CLI says less than the app.** `cmd ls` shows no folder or branch for agents, `cmd search` drops the branch.

## Words

Used the same way in code, UI and CLI from now on:

- **Project:** a repository (all its worktrees and branches), or a folder outside one. Its id stays `dir:<main worktree>` (docs/28). Shown by its folder's name.
- **Worktree:** a linked git worktree. The main checkout is not called a worktree in the UI; it's just the project.
- **Branch:** what a worktree is shown by. Its folder name only when HEAD is detached.
- **Space:** unchanged, a folder you work in (docs/11). A Space can be a project, a worktree or any folder; cmd doesn't decide which.

In code, `Checkout` is checkout.ts's type and nothing else is called that.

## The plan

### 1. One checkout per pane and agent (core, protocol)

- `checkout.ts` gains a small cache (`checkouts.of(dir)`, keyed by folder, a stat of `HEAD` to revalidate) and `linked: boolean` (`gitDir !== common`). `peers.ts`, `journal/git.ts` and `data/project.ts` use `Checkout` directly; their copies go.
- `Pane.at` and `Agent.at`: `{ project: string; top: string; branch: string | null; linked: boolean } | null`, where it is now. A pane's from its cwd (OSC 7), re-read when a command ends, since `git switch` changes the branch without a cwd change. An agent's from where it works: the folder `worktreeName` already finds (a write moves it there, a `cd` only when nothing was written), else its cwd. Updates go out as the usual `pane.updated` / `agent.updated`.
- Peer briefings read `Agent.at`, so "same checkout as you" is true again.
- `Space.at`: the same, from its root, so the UI can compare without asking.

### 2. Show the difference (renderer)

One function, `whereOf(item.at, space.at)`, used by every row and title bar:

| The item is in | Chip | Place line |
|---|---|---|
| the Space's own checkout | none | path below the Space's root, if any (`packages/core`) |
| a linked worktree of the Space's project | the branch | the worktree's path |
| another project | that project's name (and branch, if a worktree) | its path |
| no repository | the folder's name, only if outside the Space | its path |

In Home every project differs from the Space, so chips show there as today, but by project (`cmd`), not by subfolder (`core`). The branch chip's tooltip says where the worktree is; an agent named after its branch says so in its title bar's tooltip ("Named after its branch, search-design").

Same rule for the Commands widget, Agent Activity and notifications (docs/32 already keeps the project out of notification titles; a worktree's branch is the name there anyway).

### 3. Worktrees together, where they're listed (picker, switcher)

Only where a project has more than one Space open or recent: the ⌘O picker and the switcher group a project's Spaces, the main checkout first, worktrees by branch beneath it. Folders that are worktrees of an open project show their branch instead of their path. No grouping for a project with one Space.

Nested worktrees: the file search of a Space skips folders that are other worktrees (a `.git` file below the root), as git itself does.

### 4. Gone

- A Space whose root no longer exists says so ("Folder removed") in the switcher and picker, with Close; it isn't opened as if empty.
- A terminal resurrected in a missing folder still starts in the Space's root, but its first line says why.
- The journal stops guessing `<repo>-<branch>`: a branch's work is placed in the worktree git recorded at the time (`git.*` events carry it), else not placed.

### 5. CLI

- `cmd ls` shows each agent's and terminal's place by the same rule as the sidebar, relative to the Space (`on search-design`, `in ~/src/other`).
- `cmd search` shows branch and folder like the palette.
- `cmd journal --project` as the name, `--repo` kept as an alias.

## Size and order

1, 2 and the briefing fix are the bulk and what the user sees: about a day. 3 is half a day. 4 and 5 are small and independent. Each step stands alone; 2 needs 1.

## Decided (2026-10-08)

1. **One chip at most, about where, never about git state.** The main checkout gets no chip even off the default branch: a `git switch` in one terminal would change every row, and branch state lives in Files and Live Diff.
2. **Text says the most specific difference, the hue says the project.** A worktree shows its branch in its project's colour, so in Home `search-design`, `checkouts` and `cmd` read as one project without repeating its name.
3. **Home follows the same rule:** a worktree's branch, else the project's name.
4. **The tooltip says the rest:** `cmd · worktree on search-design · ~/src/cmd-search-design`.
5. **No bulk actions for removed worktrees:** "Folder removed" and Close.
6. **Where an agent works:** the checkout it last wrote in; before its first write, the last one it went to (`cd`, `git -C`) or its cwd. Going somewhere after writing doesn't move it (that's often a look at another agent's work).
