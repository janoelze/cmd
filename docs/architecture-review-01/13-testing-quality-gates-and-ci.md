# 13 Testing, quality gates and CI

**Score: 5/10** · reviewed 2026-10-10 against commit ddb7832 · scope: how the project knows it works: vitest suites, e2e scripts, perf scripts, model evals, CI workflows, tsconfig strictness, the missing linters, process skills as gates

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 5/10 | One vitest config for everything; layering holds by convention only, no rule checks it |
| Correctness & robustness | 5/10 | The 1,524-line smoke e2e has never gated a merge on macOS; one real-PTY test flakes under full-suite load |
| Performance | 8/10 | 889 tests in 13.9 s wall; typecheck 7 s; cheap enough to run on every commit |
| Security | 5/10 | No dependency audit, no lockfile review; relay deploys from master without the main CI passing |
| Testability & tests | 5/10 | Core is well tested through a constructible `Core`; 14.6k lines of renderer `.tsx` have zero tests |
| Extensibility | 6/10 | The design-debt ratchet is the right pattern; it exists for CSS only |
| Code health | 6/10 | `strict` + `noUncheckedIndexedAccess`, almost no `any`; no linter, 165 swallowed errors, ~250 exports nothing imports |

## What this system is

One root `vitest.config.ts` (8 lines) runs every `packages/*/test`, `apps/*/test` and `website/test` file with a 15 s timeout and `vitest.setup.ts` (redirects logs to a temp dir). The measured suite: **99 files, 889 tests** (840 `it`, 9 `skipIf`, 4 `runIf`, 1 `each`), **13.9 s wall** (46.5 s summed per file, 285% CPU) on this machine. Per package, test lines vs source lines: core 10,271 / 26,484 (60 files), desktop 1,673 / 25,482 (29 files, none `.tsx`), ui 289 / 6,519 (5 files), cli 63 / 2,127, protocol 0 / 3,782, web 0 / 1,029, relay 109 / 232, remote-crypto 157 / 651, tours 221 / 2,254. Core tests construct a real `Core` (20 files) with `dbPath: null` and `fakeFactory()` (`packages/core/test/fake-pty.ts`, 38 lines; 28 files use it); 4 files spawn real PTYs (`core`, `detection`, `pty-leak`, `shells`); 41 files touch the filesystem through `tmp.ts`/`mkdtemp`.

Above the unit layer sit ten hand-rolled Playwright-Electron scripts in `e2e/` (4,357 lines): `smoke.mjs` (1,524 lines, 165 `check(...)` calls, ~2 min per the release skill), `motion.mjs` (580), `a11y-audit.mjs` (281), `web.mjs`, `drops.mjs`, `perf.mjs`, `remote.mjs`, `startup.mjs`, `startup-profile.mjs`, `packaged.mjs` (67). Perf tooling is `scripts/perf/bench.ts`, `stress-core.mjs`, `index-mem.ts`, which append to a local `.cmd-dev/perf/results.jsonl`. Model evals exist for four features, each with its own CLI and store: journal (`scripts/evals/journal.ts` + `core/src/journal/eval.ts`), names (`scripts/evals/names.ts` + `core/src/agents/names-eval.ts`), Magic (`cmd magic eval` in `packages/cli/src/magic-eval.ts` over `core/src/magic/evals/cases.json`), Jam (`pnpm jam eval`, `scripts/jam/eval.ts`).

CI is `.github/workflows/build.yml`: one macOS arm64 job runs `pnpm typecheck`, `pnpm test`, build, `check-runtime.mjs`, package, signature checks and `e2e/packaged.mjs`; tags add the changelog check, notarization and the release. The Windows job (the only one that ran `pnpm e2e`) is `if: false`. `remote.yml` and `website.yml` deploy on master pushes to their paths. TypeScript: `tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`; there is no ESLint, Biome, oxlint, Prettier (deliberately, see memory), knip, dependency-cruiser, husky or lint-staged anywhere. Process gates live in skills: `release` (typecheck, test, e2e before tagging), `changelog` (enforced by `scripts/changelog.mjs` in `release.mjs` and CI), `motion` (`pnpm e2e:motion` after motion changes).

## What is good

- **The suite is fast and honest.** 889 tests in 14 s with real SQLite, real sockets and a real `Core` per file is a rare combination; it is cheap enough for a pre-commit hook as is.
- **`Core` is constructible with fakes** (`new Core({ socketPath, dbPath: null, terminals: fakeFactory().factory })`): exactly the DI seam 00-research §10 asks for. Other systems (renderer store, main) should copy it (see docs 08 and 01).
- **Ratchet tests as fitness functions.** `design-css.test.ts` + `design-debt.json` (counts only go down, `pnpm design-debt` locks in the lower count), `motion-css.test.ts`, `tokens.test.ts` (generated files not stale), `settings-layout.test.ts` (every key placed once), `commands.test.ts`, `changelog.test.ts`. This is the 00-research §9 recommendation ("every architectural rule a ratchet that can only go down") already working; this doc mostly asks for more of it.
- **Release gating is real where it matters most:** the changelog section is required in three places, the signature is verified with `codesign --verify --deep --strict` and `spctl`, the staged core is booted (`check-runtime.mjs`) and the packaged app is launched (`packaged.mjs`) before upload.
- **Deterministic scorers for model evals** (`journal/eval.ts`: "the same answer always scores the same"), unit-tested in `journal-eval.test.ts` and `names.test.ts`, with corpora kept out of the repo for privacy.
- **Type discipline without a linter:** 5 `any` in all of `src/`, 0 `@ts-ignore`, `noImplicitOverride` would pass today with 0 errors.
- **Commit hygiene:** 857 commits, median subject 69 characters, none of "wip"/"fix"/"update"; subjects say what changed for the user.

## Issues

### AR1-13-01 · Run the smoke e2e on macOS in CI

- **Status:** done (483e6f28)
- **Severity:** high
- **Effort:** M (1–2 days)
- **Where:** `.github/workflows/build.yml:67-69`, `.github/workflows/build.yml:190-216`, `e2e/smoke.mjs:1-60`, `DEVELOPMENT.md:85`, `e2e/packaged.mjs:4`

**Problem.** The one test that drives the real app (menu bar, onboarding, windows, terminals, the palette, transcripts) has never run in CI on the platform cmd ships on. Only the Windows job ran `pnpm e2e` and it is disabled; the mac job has never had an e2e step since the workflow was created. So a renderer or main change that breaks the app reaches master, and a tag, if the developer skipped the ~2 min local run. Two docs claim otherwise.

**Evidence.** `build.yml` mac job: `pnpm typecheck` (l.67), `pnpm test` (l.69), build, package, `node e2e/packaged.mjs` (l.177): 67 lines that check a window, a core and a prompt. `pnpm e2e` appears only at l.216 inside `windows: if: false`. `git show <first build.yml>` has no e2e step for macOS. `e2e/smoke.mjs` holds 165 `check(...)` assertions. `DEVELOPMENT.md:85` says "CI's `windows` job runs the tests and the e2e on Windows"; `packaged.mjs:4` says "CI runs it after packaging, on macOS and Windows". Since the desktop app has no component tests (AR1-13-03), smoke is the only automated check on ~25k lines of `apps/desktop/src`.

**Proposal.** Add a `Smoke` step to the mac job after `Build and stage` (the build is already there, so it costs the ~2 min run, not a rebuild): `CMD_NO_SANDBOX=1 node e2e/smoke.mjs`, then upload `.cmd-dev/shots` and `.cmd-dev/e2e/logs` with `if: failure()`, the way the Windows job did. The script already has its own watchdog and isolated `CMD_HOME`. Playwright's Electron support is experimental [PW-ELEC], so keep the watchdog and give the step `timeout-minutes: 10`. Fix the two stale sentences in the same commit. Packaged-app lifecycle coverage beyond this is doc 01 (AR1-01-10).

**Success criteria.**
- [x] `build.yml`'s mac job runs `e2e/smoke.mjs` on every push and PR, with screenshots and core logs uploaded on failure
- [ ] Ten consecutive green runs on master (no retries) before it is made required
- [x] `grep -n "e2e on Windows\|on macOS and Windows" DEVELOPMENT.md e2e/packaged.mjs` returns nothing, or the text matches the workflow
- [ ] A deliberately broken menu command on a branch turns the job red

### AR1-13-02 · Add architecture fitness tests in the style of design-css.test.ts

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `vitest.config.ts:5`, `apps/desktop/test/design-css.test.ts:1-88`, `scripts/evals/journal.ts:19-34`, `apps/desktop/src/renderer/src/bridge.ts:2`, `apps/desktop/src/renderer/src/keybindings.ts:6`

**Problem.** The layering (protocol ← core ← cli/desktop; renderer never imports node, core or main at runtime) holds today, but only because everyone remembers it; one value import of `@cmd/core` in the renderer would pull SQLite into the bundle and nothing would say so. File size has no budget, so the god files other reviewers flag keep growing. The registries have one-off exhaustiveness tests (settings layout, commands) but no general rule.

**Evidence.** Measured at ddb7832: renderer imports `@cmd/core` 0 times; it imports `electron` 3 times and `main/`/`preload/` 3 times, all `import type` (clean, unenforced). `scripts/evals/journal.ts` imports 16 modules from `../../packages/core/src/...`, bypassing `@cmd/core`'s `exports` map. Files over 600 lines: 18, led by `core.ts` 1,640, `Gallery.tsx` 1,574, `WindowsView.tsx` 1,177, `main/index.ts` 1,046, `App.tsx` 998, `tracker.ts` 876, `magic/service.ts` 864, `terminals.ts` 859. No dependency-cruiser, eslint-plugin-boundaries or equivalent is installed.

**Proposal.** One test file per rule under `apps/desktop/test/architecture/` (or a root `test/` added to `vitest.config.ts` `include`), each a ratchet with its baseline JSON next to it, written like `design-css.test.ts` and updated with an env flag (`UPDATE_ARCH_DEBT=1`):
1. `imports.test.ts`: parse `import`/`export … from` with a regex or `ts.preProcessFile` (no new dependency), resolve relative paths, and check an allowlist of edges: `protocol` imports nothing in-repo; `ui` imports nothing but itself; renderer may value-import only `@cmd/protocol`, `@cmd/ui`, `@cmd/remote-crypto` and type-import `main/`, `preload/`, `electron`; nothing outside a package imports its `src/` except through its `exports`. Today's exceptions (the eval scripts) go in the baseline. This is the VS Code `code-import-patterns` idea [VSC-ORG] without ESLint; dependency-cruiser [DEPCRUISE] is the upgrade if cycles need checking too.
2. `file-size.test.ts`: every `.ts/.tsx/.mjs` in `src/` under 600 lines, today's 18 offenders listed with their current count, which may only fall.
3. `registries.test.ts`: every `Methods` key has a handler and a CLI or renderer caller; every `WindowType` registered in core has a renderer view; every command id with a shortcut is a menu item (extend `commands.test.ts`).

**Success criteria.**
- [ ] The three test files exist and pass in `pnpm test`, adding under 1 s to the suite
- [ ] Adding `import { Core } from "@cmd/core"` to any renderer file fails `imports.test.ts`
- [ ] Adding a line to a file already over 600 lines fails `file-size.test.ts`, and splitting it fails until the baseline is lowered
- [ ] A `Methods` entry without a handler or caller fails `registries.test.ts`

### AR1-13-03 · Give the renderer a component test layer

- **Status:** open
- **Severity:** high
- **Effort:** L (> 2 days)
- **Where:** `vitest.config.ts:1-8`, `apps/desktop/src/renderer/src/components/WindowsView.tsx`, `apps/desktop/src/renderer/src/App.tsx`, `apps/desktop/src/renderer/src/store.ts`, `apps/desktop/src/renderer/src/terminals.ts`
- **Depends on:** AR1-07-01, AR1-08-05

**Problem.** The renderer is the largest untested surface in the repo: every desktop test imports a pure `.ts` helper (model, layouts, docks, paste, links), none renders a component. There is no DOM environment configured, no Testing Library, no Playwright component testing. A regression in how WindowsView lays out, scrolls or docks, how FilesView lists, or how the palette filters is caught only by smoke (which CI doesn't run, AR1-13-01) or by the user.

**Evidence.** 73 renderer `.tsx` files, 14,577 lines, 0 tests. Untested by any import or reference: `WindowsView.tsx` 1,177, `App.tsx` 998, `FilesView.tsx` 743, `SettingsWindow.tsx` 550, `json-view.tsx` 521, `MagicView.tsx` 508, `PdfView.tsx` 458, `sqlite-view.tsx` 452, `Palette.tsx` 317 (35 desktop files over 150 lines, 11,793 lines in total). `store.ts` (601) is imported by 2 tests, `terminals.ts` (859) by none, `preload/index.ts` (244) by none, `main/index.ts` (1,046) by none (main has 4 tested pure helpers). No `jsdom`, `happy-dom` or `@testing-library/*` in any `package.json`. The kit's own missing behaviour tests are doc 10 (AR1-10-04).

**Proposal.** Use vitest's `projects` so DOM tests run in their own environment without slowing the node suite: a `dom` project with `environment: "happy-dom"`, `include: ["apps/desktop/test/**/*.test.tsx", "packages/ui/test/**/*.test.tsx"]`, `@testing-library/react` and `@testing-library/user-event`, plus a `fakeBridge()` that implements `window.cmd` over an in-memory `Core` (the same move `fakeFactory()` made for PTYs, and the reason core tests are good). Start with the components whose logic is not layout: Palette filtering and `?` search mode, Navigator, SettingsWindow rows generated from `SETTINGS_SCHEMA`, json-view, ActionsView, error boundaries (AR1-08-01). For WindowsView, test the layout hook and scroll controllers that AR1-07-01 extracts, not the 1,177-line component; real geometry stays with `e2e/motion.mjs`. Prefer happy-dom over Playwright component testing: it reuses vitest, needs no build, and stays inside the 15 s budget; add vitest browser mode only if a component needs real layout.

**Success criteria.**
- [ ] `vitest.config.ts` defines `node` and `dom` projects; `pnpm test` runs both
- [ ] A `fakeBridge()` helper exists and at least 8 renderer components have `.test.tsx` files that render through it
- [ ] Palette, SettingsWindow and Navigator each have tests for keyboard selection and their empty state
- [ ] `pnpm test` stays under 25 s wall on this machine with the DOM project included

### AR1-13-04 · Stop the real-process tests flaking, and make CI say what it skipped

- **Status:** done (483e6f28)
- **Severity:** medium
- **Effort:** S (< ½ day)
- **Where:** `packages/core/test/core.test.ts:107-122`, `packages/core/test/widgets.test.ts:28`, `packages/core/test/widgets.test.ts:143`, `packages/core/test/widgets.test.ts:312`, `packages/core/test/widgets.test.ts:355`, `vitest.config.ts:6`

**Problem.** Tests that spawn real processes (PTYs, the procinfo helper, Deno) run in parallel with the other 95 files at 285% CPU, with fixed `until(…, 8000)` deadlines, so they fail under load and pass alone: a developer sees red, reruns, sees green, and learns to ignore red. Separately, capability skips are silent: a machine without Deno or zsh reports the suite green with whole areas untested, and CI is such a machine for Deno.

**Evidence.** Full `pnpm test` at ddb7832: 886 passed, 1 failed, 2 skipped; the failure is `core.test.ts` "reports the real foreground program" (`Error: timed out` from `until` at l.48). The same file run alone: 11/11 passed, twice. Slowest files: `widgets.test.ts` 13.0 s, `core.test.ts` 10.8 s, `shells.test.ts` 5.2 s, `actions.test.ts` 2.6 s, `activity.test.ts` 2.0 s. 23 of the 28 tests in `widgets.test.ts` sit in three `describe.skipIf(!DENO)` blocks; `findDeno()` looks on `PATH` and in fixed locations, and `build.yml` installs no Deno, so on a stock runner those 23 tests are skipped without a trace. 27 fixed-delay waits (`setTimeout(r, N)`/`sleep(N)`) in tests; 6 files use fake timers.

**Proposal.** Split by cost with vitest `projects`: a `unit` project (everything without real processes, fully parallel) and a `system` project (`core`, `detection`, `pty-leak`, `shells`, `widgets`, `magic`, `resources`, `loginpath`) with `maxWorkers: 2` and `until` deadlines derived from one `SYSTEM_TIMEOUT` constant. Replace `skipIf(!X)` with a `needs(X)` helper that skips locally but throws when `process.env.CI` is set, and install Deno in `build.yml` (`denoland/setup-deno`, pinned). Silence the per-worker `ExperimentalWarning: SQLite` noise with `--disable-warning=ExperimentalWarning` in the pool's `execArgv` so a real warning is visible.

**Success criteria.**
- [x] `pnpm test` passes 10 runs in a row on this machine with no reruns (`for i in $(seq 10); do pnpm test || break; done`)
- [ ] In CI the `widgets.test.ts` Deno blocks run (the job log shows 28 widgets tests, 0 skipped)
- [x] `grep -rn "skipIf(!" packages/*/test` returns only `needs(...)` call sites or none
- [x] `pnpm test` output contains no `ExperimentalWarning` lines

### AR1-13-05 · Build a tiered pipeline: pre-commit, CI, nightly

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `.github/workflows/build.yml:36-44`, `.github/workflows/remote.yml:1-53`, `package.json:10-40`, `scripts/perf/stress-core.mjs`, `scripts/perf/bench.ts`, `e2e/perf.mjs`, `e2e/motion.mjs`, `e2e/a11y-audit.mjs`
- **Depends on:** AR1-13-01

**Problem.** Every check is either in the one CI job or entirely manual. The perf bench, the core stress run with its `[lag]` watchdog, the motion scorer, the a11y audit, the drag-and-drop, remote and web journeys all exist, score or fail properly, and run only when someone remembers; their results go to a local, gitignored `results.jsonl`, so a regression is found by feel weeks later. Nothing runs before a commit, so several agents in parallel worktrees push typecheck failures that CI catches after the fact. Deploys don't wait for the main CI.

**Evidence.** `build.yml` runs on push/PR/tag only; no `schedule:` trigger in any workflow. `package.json` has 9 `e2e*`/perf entry points; only `packaged.mjs` is in CI. `bench.ts` and `perf.mjs` append to `.cmd-dev/perf/results.jsonl`; no file in the repo stores a baseline or budget. `stress-core.mjs` needs a hand-copied `events.sqlite` (its header). `remote.yml` deploys the relay and web client on a master push after only `vitest run apps/relay packages/remote-crypto` and the web typecheck, in parallel with (not after) `build.yml`. No `npm audit`/`pnpm audit`, Dependabot or Renovate config. No `.git/hooks` beyond samples, no husky.

**Proposal.** Three tiers, each with a wall-time budget:
- **Pre-commit (< 30 s):** a versioned `scripts/hooks/pre-commit` installed by `postinstall` via `git config core.hooksPath scripts/hooks` (no husky): `pnpm typecheck` (7 s) and `vitest related --run <staged files>`. Agents commit often, so keep it under 30 s or it gets bypassed.
- **CI on every push (< 15 min):** today's job + smoke (AR1-13-01) + the fitness tests (AR1-13-02) + `pnpm audit --audit-level high` (warn first) + an `e2e/a11y-audit.mjs` run, which already fails on an unnamed control. `remote.yml` and `website.yml` become `workflow_run` after `build` succeeds on master.
- **Nightly (`schedule:`, macOS):** `bench.ts all`, `perf.mjs`, `motion.mjs`, `drops.mjs`, `remote.mjs`, `web.mjs`, and `stress-core.mjs` against a synthetic log generated by a script (never a copy of real state, see memory "No real state copies"). Each writes a JSON summary that a small `scripts/perf/compare.mjs` checks against `perf/budgets.json` in the repo (e.g. core idle CPU, flood p95 latency, max `[lag]` ms, motion score) and fails over budget. Startup phase budgets are doc 08 (AR1-08-12). Keep 30 days of results as artifacts so trends are visible.

**Success criteria.**
- [ ] `scripts/hooks/pre-commit` exists, is installed by `pnpm install`, and finishes in under 30 s on a one-file change
- [ ] A `nightly.yml` with a `schedule:` trigger runs the perf, motion, drops, remote and web scripts and fails when `perf/budgets.json` is exceeded
- [ ] `remote.yml` and `website.yml` run only after `build` passes on the same commit
- [ ] CI runs a dependency audit and an a11y audit on every push

### AR1-13-06 · Lint the whole repo with one config, and find dead code with knip

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `package.json:41-46`, `packages/core/src`, `apps/desktop/src`
- **Depends on:** AR1-08-07

**Problem.** There is no linter at all, so the classes of bug only a linter sees accumulate silently: swallowed errors, stale React hook dependencies (doc 08), floating promises, unused exports and dependencies. Doc 08 proposes ESLint for the renderer; the gap is repo-wide.

**Evidence.** No `eslint`, `biome`, `oxlint`, `knip` or `dependency-cruiser` in any `package.json` or config file. Empty or comment-only `catch` blocks and `.catch(() => {})`: 59 in core, 106 in desktop, 10 in web (175 total). `as unknown as`: 26 core, 10 desktop, 4 tours. Non-null assertions (approximate grep): 140 core, 91 desktop, 58 tours. Exports referenced in no file but their own (crude grep, knip will be exact): core 146 of 694, desktop 73 of 594, protocol 20 of 242, cli 6 of 32, ui 2 of 237. On the good side: `any` 5 in all `src/`, `@ts-ignore` 0.

**Proposal.** One root ESLint flat config (the one AR1-08-07 adds, not a second) with `typescript-eslint`'s type-aware `no-floating-promises`, `no-misused-promises`, `no-unnecessary-type-assertion`, plus `no-empty` with `allowEmptyCatch: false` relaxed by an `// ignore: <reason>` comment convention, and `react-hooks` for `.tsx`. No stylistic rules (no Prettier, by choice). Roll out as 00-research §9 advises: warnings with a per-rule count ratchet (`lint-debt.json`, like `design-debt.json`), then errors. Add `knip` with a config naming the entry points (`main.ts`, `host-main.ts`, the CLI, the renderer pages, `e2e/*`, `scripts/**`) and fail CI on new unused files and dependencies; unused exports start as a ratchet. If ESLint's type-aware run is too slow for pre-commit, run oxlint there and ESLint in CI.

**Success criteria.**
- [ ] `pnpm lint` exists, covers every package, and runs in CI
- [ ] `lint-debt.json` records per-rule counts and a new violation fails CI
- [ ] `pnpm knip` runs in CI; unused files and unused dependencies are 0
- [ ] Empty `catch` blocks without a reason comment are down from 175 to under 50

### AR1-13-07 · Turn on the strictness flags that are already nearly free

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `tsconfig.base.json:1-16`, `packages/cli/src/data.ts:161`

**Problem.** `strict` and `noUncheckedIndexedAccess` are on, but several flags that catch real mistakes are off although the code nearly passes them. Without them, unused locals and fallthrough cases (the kind of leftovers parallel agents produce) accumulate.

**Evidence.** Errors when each flag is added (root project / desktop): `noImplicitOverride` 0/0, `noImplicitReturns` 0/2, `noFallthroughCasesInSwitch` 1/0 (`packages/cli/src/data.ts:161`), `noUnusedParameters` 3/2, `noUnusedLocals` 12/6, `exactOptionalPropertyTypes` 189/132. `pnpm typecheck` takes 7 s, so the flags cost nothing at run time.

**Proposal.** Add `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters` to `tsconfig.base.json` and fix the 26 sites (an intended fallthrough gets `// falls through`). Leave `exactOptionalPropertyTypes` (321 errors) for later; it mostly matters at the protocol boundary, where validation (doc 02, AR1-02-04) is the better fix.

**Success criteria.**
- [ ] `tsconfig.base.json` sets the five flags
- [ ] `pnpm typecheck` passes
- [ ] No `// @ts-ignore` or `@ts-expect-error` added to get there (`grep -rn "@ts-" packages/*/src apps/*/src` still 0)

### AR1-13-08 · One eval runner with committed baselines for the four model features

- **Status:** open
- **Severity:** low
- **Effort:** M (1–2 days)
- **Where:** `scripts/evals/journal.ts:1-34`, `scripts/evals/names.ts:1-20`, `packages/cli/src/magic-eval.ts:1-51`, `scripts/jam/eval.ts:1-20`, `packages/core/src/magic/evals/cases.json`

**Problem.** The four AI features each have a careful, deterministic scorer, but four harnesses with four CLIs and four result folders, and no record of the last accepted score anywhere in the repo. So "did this prompt change make names worse?" means finding an old run on someone's disk. They are ad hoc by design (they cost tokens and read private corpora), but the comparison step needn't be.

**Evidence.** Entry points: `node scripts/evals/journal.ts`, `node scripts/evals/names.ts`, `cmd magic eval` (dev tooling shipped in the user-facing CLI), `pnpm jam eval`. Result stores: `$CMD_HOME/evals/journal`, `$CMD_HOME/evals/names`, `$CMD_HOME/magic/evals/<time>`, `.cmd-dev/jam/evals`. `cases.json` for Magic has 20 lines; journal and names corpora are private and out of the repo. No baseline file under version control for any of them. Scorers are tested (`journal-eval.test.ts`, `names.test.ts`, `jam-analyze.test.ts`).

**Proposal.** `pnpm evals <journal|names|magic|jam> run|corpus|accept`, a thin dispatcher over the existing scripts, each writing one summary `{ model, promptHash, cases, mean, perCase }` (scores only, no corpus text). `accept` writes it to `evals/baselines/<name>.json` in the repo; `run` prints the delta against it and exits non-zero below a per-feature threshold. Synthetic case sets (journal already has `--synthetic`, Magic's `cases.json` is public) can then run in the nightly tier (AR1-13-05) behind a manual-dispatch workflow with an API key secret and a token cap. Move `cmd magic eval` out of the shipped CLI into the dispatcher (see doc 11 for Magic itself).

**Success criteria.**
- [ ] `pnpm evals` exists and dispatches to all four harnesses
- [ ] `evals/baselines/` holds a committed summary for each feature, with no transcript or prompt text in it
- [ ] `pnpm evals names run --synthetic` (or equivalent) prints the delta against the baseline and fails below the threshold
- [ ] `cmd magic eval` is no longer a subcommand of the shipped CLI

### AR1-13-09 · Report coverage per package so the gaps are visible

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `vitest.config.ts:1-8`, `package.json:24`

**Problem.** Nobody can say what the suite covers without a manual grep like the one in this doc. That hides the protocol package (3,782 lines, 0 test files; `settings.ts` and `instance.ts` carry logic), the CLI (63 test lines for 2,127; doc 02, AR1-02-10), the web client (1,029, 0) and the renderer (AR1-13-03).

**Evidence.** No `@vitest/coverage-v8` or `coverage` block in `vitest.config.ts`. Test-to-source line ratios: core 0.39, desktop 0.07, ui 0.04, cli 0.03, protocol 0, web 0. Core's large modules are all referenced by tests (only `widgets/deno.ts` 209 and `data/sources/ingest-worker.ts` 155 of its files over 150 lines are not); desktop has 35 such files.

**Proposal.** Add `@vitest/coverage-v8` and `pnpm test:coverage` (`--coverage.reporter=text-summary --coverage.reporter=json-summary`), run it in CI and upload the summary as an artifact; no gate at first. Once AR1-13-03 lands, add per-package floors (`thresholds` with `perFile: false`) set at the current numbers, so coverage is a ratchet like design debt, not a target.

**Success criteria.**
- [ ] `pnpm test:coverage` prints line coverage per package
- [ ] CI uploads the coverage summary on every push
- [ ] `vitest.config.ts` has thresholds for core and desktop at or just below the measured values

## Course corrections

1. **Gate merges on the real app** (AR1-13-01): adding smoke to the mac job is the largest correctness gain per hour in this doc; everything in `apps/desktop` currently depends on a manual run.
2. **Make the suite trustworthy** (AR1-13-04): a test that fails under load, and 23 widget tests CI silently skips, teach people to ignore red. Fix before adding more tests.
3. **Ratchets for architecture, not only CSS** (AR1-13-02, AR1-13-06, AR1-13-07): imports, file sizes, registries, lint counts and tsc flags as count-only-goes-down tests in the `design-css.test.ts` style. These are what keep doc 03's, 07's and 08's splits from growing back.
4. **A component layer for the renderer** (AR1-13-03), after AR1-07-01 and AR1-08-05 make WindowsView and the store importable in pieces.
5. **Tiers with budgets** (AR1-13-05, AR1-13-08): the perf, motion and eval tools are good; put them on a schedule with committed baselines.

## Quick wins

AR1-13-04, AR1-13-07, AR1-13-09, and the docs fix inside AR1-13-01.
