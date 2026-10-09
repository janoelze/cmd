# 17 Repo layout and project structure

**Score: 6/10** · reviewed 2026-10-10 against commit `94563de` · scope: how the monorepo is split into packages, how code is grouped inside `packages/core/src` and the renderer, and where docs and tooling live. Reorganising a feature's code is covered here; changing its wiring is covered by docs 03, 08 and 15.

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 6/10 | Packages follow process boundaries cleanly; inside the two big packages, grouping has stopped tracking features |
| Correctness & robustness | n/a | |
| Performance | n/a | |
| Security | n/a | |
| Testability & tests | 6/10 | Tests sit in `packages/*/test` as CLAUDE.md says, but 63 flat files in `core/test` don't show which feature they cover |
| Extensibility | 5/10 | A feature is spread over about 9 places in 4 packages; no folder is "the journal" |
| Code health | 6/10 | Coherent naming, but window types live in two folders, and docs reuse numbers |

## What this system is

The repo is a pnpm workspace (`pnpm-workspace.yaml`: `packages/*`, `apps/*`).

**Process packages:**
- `packages/protocol` (21 files, 3.8k lines) is the contract.
- `packages/core` (222 files, 37.4k lines) is the core and the PTY host.
- `packages/cli` (9 files, 2.2k lines) is the CLI.
- `apps/desktop` (198 files, 27.3k lines) is Electron main, preload and renderer.
- `apps/web` (10 files, 1.0k lines) and `apps/relay` (3 files, 0.3k lines) are the remote client and the relay.

**Libraries:**
- `packages/ui` (51 files, 8.8k lines) is the kit and tokens.
- `packages/remote-crypto` (0.8k lines).
- `packages/tours` (3.1k lines) is demo-video tooling.

**Outside the packages:** `scripts/` (19 entries), `e2e/` (10 harnesses) and `docs/` (43 design docs plus this folder).

Inside the two big packages, grouping has drifted:

- **`packages/core/src`:** 27 flat files sit next to 15 feature folders. The flat files are `core.ts` (1,640 lines), `panes.ts` (788), `osc.ts`, `restore.ts`, `shells.ts`, `shell.ts`, `loginpath.ts`, `commands.ts`, `notifications.ts`, `timers.ts`, `usage.ts`, `checkout.ts`, `git.ts`, `store.ts`, `stored.ts`, `scheduler.ts`, `settings.ts` and others.
- **The renderer (`apps/desktop/src/renderer/src`):** 38 flat files, a `components/` folder of 60 entries, and a `windows/` folder of 18.

## What is good

- **Packages follow process boundaries.**
  - `protocol` is the only thing processes share.
  - No package imports another by relative path.
  - `apps/desktop` never imports `packages/core` (doc 14, AR1-14-07).
  - Most Electron apps this size can't say this; keep it.
- **No build step in development.** Running `.ts` directly is why the dev loop is fast. Bundling belongs at packaging time (AR1-14-03), not in dev.
- **`@cmd/ui` is its own package.** It has DTCG tokens, a gallery and ratchet tests, so the design system is a dependency, not a folder of CSS.
- **Some features already have the target shape.**
  - `core/src/search/`, `windows/`, `terminals/`, `journal/`, `magic/`, `remote/` and `data/` each hold one concern with a registry (`search/sources.ts`, `windows/types.ts`).
  - In the renderer, `windows/` with `registerWindowView` is the shape the rest should copy.
- **Tests live in one predictable place per package** (`packages/*/test`, `apps/*/test`), as CLAUDE.md says.

## Issues

### AR1-17-01 · Add a layout ratchet before moving anything

- **Status:** open
- **Severity:** medium
- **Effort:** S (< ½ day)
- **Where:** `apps/desktop/test/design-css.test.ts` (the model), new `test/layout.test.ts`
- **Depends on:** shares a harness with AR1-13-02 and AR1-14-07

**Problem.** Nothing says where new code goes. While several agents add features in parallel, each picks the nearest folder. That is how `components/` reached 60 entries and `core/src` 27 flat files. A move made today will drift back.

**Evidence.**
- `ls packages/core/src/*.ts | wc -l` → 27.
- `ls apps/desktop/src/renderer/src/*.ts* | wc -l` → 38.
- `ls apps/desktop/src/renderer/src/components | wc -l` → 60.
- No test or lint rule mentions file placement.

**Proposal.** Add a count-only-goes-down test in the `design-css.test.ts` style, with a committed `layout-debt.json`. Count the flat files in `core/src` and the renderer root, the entries in `components/`, and the files over 600 lines per package. The test fails when a count rises and asks for `pnpm layout-debt` when it falls. The import rules from AR1-14-07 go into the same harness.

**Success criteria.**
- [ ] `test/layout.test.ts` exists and fails on a new flat file in `packages/core/src`.
- [ ] It fails on a new file in `renderer/src/components/`.
- [ ] `layout-debt.json` is committed; a script lowers it.
- [ ] CLAUDE.md's Conventions section names the target folders (AR1-17-02..04).

### AR1-17-02 · Group the core by feature: a kernel, terminals, and one folder per feature

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days, spread over several commits)
- **Where:** `packages/core/src/*.ts` (27 files)
- **Depends on:** AR1-17-01

**Problem.** The flat root mixes three kinds of file:

- **Infrastructure:** `core.ts`, `connection.ts`, `scheduler.ts`, `store.ts`, `stored.ts`, `settings.ts`, `lock.ts`, `main.ts`.
- **Terminal internals:** `panes.ts`, `osc.ts`, `restore.ts`, `shells.ts`, `shell.ts`, `loginpath.ts`, `commands.ts`, which belong beside `terminals/`.
- **Whole features as single files:** `notifications.ts`, `timers.ts`, `usage.ts`, `checkout.ts`, `git.ts`, `fileops.ts`.

A reader can't tell from the tree what the core is made of, and doc 04's terminal path spans `src/` and `src/terminals/` for no reason.

**Evidence.** `panes.ts` (788 lines) and `osc.ts` (215) are imported almost only from `terminals/` and `core.ts`. Doc 04's scope list has to name 14 files in four places.

**Proposal.**

```
packages/core/src/
  kernel/      core.ts (composition root), connection, scheduler, store, stored, settings, lock, main, index
  terminals/   + panes, osc, restore, shells, shell, loginpath, commands (the OSC 133 log)
  agents/  data/  search/  windows/  workspaces/  remote/  sqlite/     (as today)
  features/    journal/ actions/ summaries/ notifications/ timers/ magic/ jam/ widgets/ usage/ checkout/
  lib/         git, fileops, redact, secrets, watch, resources
```

- Only `git mv`, one folder per commit, with no edits beyond import paths. tsc flags every broken `.ts` import.
- `core/test/` keeps its flat layout; renaming 63 test files buys little.

**Success criteria.**
- [ ] `packages/core/src` has no `.ts` files besides `index.ts`.
- [ ] Every move commit is rename-only apart from import lines (`git show --stat -M` shows renames at ≥ 90 % similarity).
- [ ] `pnpm typecheck && pnpm test` pass after each commit.
- [ ] Doc 04's scope list fits in one folder plus `agents/procinfo.ts`.

### AR1-17-03 · One folder per window type in the renderer, the terminal included

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `renderer/src/windows/builtin.tsx:9-25`, `renderer/src/components/*View.tsx`
- **Depends on:** AR1-17-01; pairs with AR1-07-03

**Problem.** Window types live in two places:

- **`windows/`:** JSON, SQLite, Image, Markdown, Visualizer and Jam each have their own files.
- **`components/`:** Terminal, Browser, Files, Text, PDF, Journal, Magic, Actions, Commands, Events, Notifications, Resources, Timer, YouTube, Navigator, AgentActivity and LiveDiff. `builtin.tsx` imports them from there (lines 9–25).

Their `.story.tsx` and feature CSS (`magic.css`, `jam.css`, `widgets.css`, `library.css`) sit in `components/` too. Adding a window type means picking one of the two conventions; the newest types (docs 35–38) went to `windows/`.

**Evidence.**
- `components/` has 60 entries: 17 are window views, about 15 are app chrome, and the rest are stories and CSS.
- `windows/` has 18 entries.

**Proposal.** `windows/<type>/` holds one window type each: `view.tsx`, `register.ts`, `*.story.tsx`, and CSS if any.

- `builtin.tsx` becomes a list of imports.
- `components/` keeps only components shared by several windows; after the move that is a handful.
- With AR1-07-03, `register.ts` is also where the type's typed state and its core-side definition meet.

**Success criteria.**
- [ ] Every `registerWindowView` call lives in a `windows/<type>/` folder; `builtin.tsx` contains only imports.
- [ ] No file in `components/` is a window type's root view (`git grep -l registerWindowView -- '*/components/*'` is empty).
- [ ] Stories move with their view, and `pnpm workbench <story>` still finds them.
- [ ] `pnpm e2e` smoke passes (once, at the end).

### AR1-17-04 · Split the renderer root into shell, lib and features

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `apps/desktop/src/renderer/src/*.ts*` (38 files), `components/` app chrome
- **Depends on:** AR1-17-03; lands best together with AR1-08-02 (split `App.tsx`)

**Problem.** The renderer root holds three kinds of file side by side:

- **App shell:** `App.tsx` (1,003 lines), `main.tsx`, `store.ts`, `bridge.ts`, `model.ts`, `theme.ts`, `keybindings.ts`.
- **Feature logic:** `actions.ts`, `magic.ts`, `widgets.ts`, `devices.ts`, `workspaceActions.ts`, `notify.ts`, `audio.ts`.
- **Utilities:** `motion.ts`, `drags.ts`, `drops.ts`, `find-dom.ts`, `pixels.ts`, `strip.ts`, `links.ts`, `paste.ts`, `fonts.ts`, `terminals.ts`.

App chrome (TopBar, StatusBar, Dock, WorkspaceBar, Palette, WindowsView) sits in `components/`.

**Evidence.** 38 root files. `terminals.ts` (859 lines) and `WindowsView.tsx` (1,177) are the two largest renderer files after `App.tsx`, and neither sits with what it belongs to.

**Proposal.**

```
renderer/src/
  shell/      App (after AR1-08-02: a composition root), TopBar, StatusBar, Dock, WorkspaceBar, Palette, board/ (WindowsView split per AR1-07-01)
  windows/    per AR1-17-03; terminal/ takes terminals.ts, fonts, paste, links
  features/   magic/ actions/ widgets/ devices/ notifications/ … each the renderer half of a core feature: its commands, settings rows, controllers
  lib/        store, bridge, model, motion, drags, drops, find, pixels, strip, keybindings, theme
  settings/ onboarding/ editor/ pdf/ reference/ workbench/   (as today)
```

As with AR1-17-02: rename-only commits, one folder at a time.

**Success criteria.**
- [ ] The renderer root contains only `main.tsx` and `styles.css`.
- [ ] `components/` has ≤ 15 entries, all used by more than one window or shell part.
- [ ] `pnpm typecheck && pnpm test` pass after each commit; the smoke e2e passes at the end.

### AR1-17-05 · Make a feature one folder per side, with one contribution entry

- **Status:** open
- **Severity:** medium
- **Effort:** L (> 2 days; the layout half of wave 3)
- **Where:** for the journal today: `core/src/journal/`, `core/src/core.ts`, `protocol/src/{rpc,journal,settings,events}.ts`, `renderer/src/settings/layout.ts`, `shared/commands.ts`, `renderer/src/App.tsx`, `components/Journal*.tsx`, `windows/builtin.tsx`, `cli/src/journal.ts`
- **Depends on:** AR1-17-02..04, AR1-03-01, AR1-08-02, AR1-15-03, AR1-16-08

**Problem.** The journal is one feature, but `git grep -il journal` outside tests and docs hits 40 files in 4 packages, 31 of them outside the `journal/` folders. Adding Workspace Actions touched about 9 shared registries (AR1-16-08). This scatter is why parallel agents conflict on `rpc.ts`, `core.ts`, `SETTINGS_SCHEMA` and `commands.ts`, the files CLAUDE.md lists as needing both sides kept on rebase.

**Evidence.** CLAUDE.md, "Work style": "Append-only registries conflict most: `Methods` in `rpc.ts`, `Handlers` in `core.ts`, `SETTINGS_SCHEMA`, `settings/layout.ts`, `shared/commands.ts`."

**Proposal.** Each feature becomes:

- `protocol/src/features/<name>.ts`: its methods, events and settings keys, merged into `Methods` and `SETTINGS_SCHEMA` by spread.
- `core/src/features/<name>/`: `service.ts`, `handlers.ts`, `contribution.ts`.
- `renderer/src/features/<name>/`: commands, settings placement, views.

The central files import a list of contributions instead of holding entries. The wiring (typed context, handler registration, command contributions) is designed in AR1-03-01, AR1-08-02 and AR1-15-03; this issue is the folder shape they land in. Do the journal first, as the template for the rest.

**Success criteria.**
- [ ] For the journal, `git grep -il journal -- packages apps ':!*test*'` lists only files under `features/journal` folders (plus `cli/src/journal.ts`) and one line each in the contribution lists.
- [ ] Adding a new setting or command to the journal changes no file outside its feature folders.
- [ ] CLAUDE.md's "append-only registries" note is updated to say which lists remain central.

### AR1-17-06 · Give docs/ unique numbers, an index and a status per doc

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `docs/`, `docs/00-overview.md`

**Problem.** Three numbers are used twice: `10-window-titles.md` and `10-windows.md`, `14-magic-v2.md` and `14-performance.md`, `35-checkouts.md` and `35-json-viewer.md`. So "docs/14" in code comments and in this review is ambiguous. `00-overview.md` links 32 of the 43 docs, and no doc says whether it is a proposal, the current design, or superseded. Agents read superseded designs as current.

**Evidence.** `ls docs | awk -F- '{print $1}' | sort | uniq -d` → `10 14 35`.

**Proposal.**
- Renumber the second of each pair to the next free numbers, and fix references with `git grep`.
- Add a `**Status:**` line under each title: `proposal`, `current`, `implemented (<commit>)` or `superseded by NN`.
- Make `00-overview.md` (or `docs/README.md`) list every doc with its status.
- Add a small test that fails on a duplicate number or a doc missing from the index.

**Success criteria.**
- [ ] `ls docs | awk -F- '{print $1}' | sort | uniq -d` prints nothing.
- [ ] Every `docs/NN-*.md` has a Status line, and the index lists every one.
- [ ] A test fails on a duplicate number or an unindexed doc.

### AR1-17-07 · Put dev-only tooling apart from product packages

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `packages/tours`, `scripts/`, `e2e/`

**Problem.** `packages/tours` is demo-video tooling that drives the app with real input. It sits among product packages, so it is picked up by `pnpm typecheck` and the root `tsconfig` like runtime code, and it is easy to mistake for something the app ships. `scripts/` (19 entries) and `e2e/` (10 harnesses) are already apart from product code; tours belongs with them.

**Evidence.** No product package imports `@cmd/tours` (`git grep -l @cmd/tours -- ':!packages/tours'` is empty).

**Proposal.** Move it to `tools/tours`, and add `tools/*` to `pnpm-workspace.yaml`. Optionally move `e2e/` and `scripts/perf` under `tools/` as well, so the top level reads apps / packages / tools / docs. Keep `pnpm tour` working.

**Success criteria.**
- [ ] `packages/` contains only code that ships in the app, CLI, relay or web client.
- [ ] `pnpm tour <file>` and the tours skill work unchanged.
- [ ] The staged runtime (`scripts/stage-runtime.mjs`) contains nothing from `tools/`.

## Not issues

- **Splitting `core` into more npm packages.** Package boundaries pay off between processes, which cmd already has. Inside one process, they add workspace and `exports` overhead without adding enforcement that folders plus the import rules of AR1-14-07 can't give. Don't.
- **`apps/web` not using `@cmd/ui`**: see doc 10 (AR1-10-05).
- **File sizes of `core.ts`, `App.tsx`, `WindowsView.tsx`, `tracker.ts`**: see docs 03, 08, 07 and 05. Moving them is this doc's job; splitting them is theirs.

## Course corrections

1. **Ratchet first** (AR1-17-01). Without it, every move drifts back within a week of parallel work.
2. **Move by folder, never all at once** (AR1-17-02, AR1-17-03, AR1-17-04). Rename-only commits, one folder each, merged quickly, so the running agents rebase over small renames instead of one repo-wide move. Announce each move to agents in flight (`cmd ls`, `cmd send`) before merging it.
3. **Then make a feature one folder per side** (AR1-17-05), together with wave 3 of the index (AR1-03-01, AR1-08-02, AR1-15-03). Start with the journal.

## Quick wins

AR1-17-01, AR1-17-06, AR1-17-07.
