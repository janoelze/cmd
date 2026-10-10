# Testing: why the e2e flakes, and how to test cmd faster and more reliably

What went wrong with the smoke e2e and the test suite in the first week of October 2026,
the root causes behind every incident, what that says about how we test, and the plan.
Companion to DEVELOPMENT.md ("Tests"), docs/34 (the scheduler stress test) and docs/37
(the motion harness). Sources: `git log`, the `build` workflow's runs, and the session
transcripts of the agents who fought the failures.

## The short version

- The smoke e2e (`e2e/smoke.mjs`) joined the macOS CI job on 2026-10-10 at 03:33 UTC
  (a3e3eb90). It had been written and run only on one machine: a Mac with a big screen,
  a fast GPU, zsh, and a developer watching. CI is a 1024 × 674 work area at 1x, slow to
  paint, loaded, bash by default. Master has not been green since the step went in.
- Every CI-only failure so far has one shape: **a fixed wait that is long enough on the
  Mac and too short on the runner**, followed by a read of state that isn't there yet.
  Each push gets past the previous one and stops at the next. One check per push, five
  to six minutes a cycle.
- The script is one 1768-line file with 184 checks that stops at the first failure. So
  each CI run reveals exactly one problem, and nothing after the smoke step (packaging,
  signature verification, the packaged-app check) has run on CI since.
- The deeper problem isn't e2e. It's that the real-app e2e became the regression suite
  for everything (layout, selection, settings, workspaces, widgets, remote), grown by
  many agents each appending a check for their feature, while the behaviour it checks
  mostly lives in code that can be tested in-process in milliseconds.

## Timeline

| When (UTC) | What | Cause | Fix |
|---|---|---|---|
| Oct 3 01:28 | First CI: `ingests hooks for a pane` got `agent: null` | Tests took the shell from `$SHELL`; runners have bash | zsh pinned in the test (b4225828) |
| Oct 3 12:57 | `notifications.test.ts` expected the pane title `zsh`, got `bash` | Same, missed by the first fix | Pinned too |
| Oct 3 01:48–03:07 | The Windows smoke job hung for good at `app.close()` | The detached core inherited Electron's stdio pipes (Windows) | 90 s watchdog, wait for Electron's exit (b87a724e, 970cda67). ~12 push→CI cycles in 1.5 h; Windows e2e later switched off |
| Oct 3 02:04 | Local `posix_spawnp failed`, the machine out of PTYs (~500) | ~37 orphaned cores: a failed smoke run never stopped its core, the next deleted its pid file | The script stops the last run's core and its own on exit (156141a9) |
| Oct 4 | Runs stole the user's focus; stale expectations (corner radius 9→12, line height), WebGL renderer vs DOM reads, a drag "that depends on animation timing", 4–5 terminals where 1 was expected | Visible runs; defaults changed under the tests; the last run's core still alive | `CMD_BACKGROUND=1`; expectations updated; terminals read through the DOM renderer (af04252f, 4648ab68) |
| Oct 9 | Overlay and sidebar "gone" checks flaked on a loaded Mac since the motion work | Counted at once or after a fixed 300 ms while a fade or slide played | Wait for the element to detach (7d3d0e89) |
| Oct 10 02:35 | `drops.mjs` timed out on `.file-list .file-row` | The Files window moved onto the kit Tree (dabe14c4); smoke was updated, drops wasn't, and drops isn't in CI | Selectors (7ef8698b) |
| Oct 10 ~03:00 | `dragging back swaps the slots again`: passed once, then failed 4 runs in a row under load | Drag released while tiles still glide; one move + release in the same frame dropped nothing on a fast machine | Drags in steps (d18aa33e); possibly a product bug too, see "Open" |
| Oct 10 04:14 | `dialog.test.ts › fades out on close`: `expected 2 to be greater than or equal to 3` | Counted real frames in a 120 ms fade; a busy runner painted one or two | Playwright's clock seeks through the fade (ca6cf88e, PR #3) |
| Oct 10 07:11–07:28 | PR #3, three CI cycles: `with one window broken … a terminal takes input` (3 s to echo), `locator.click: Timeout 30000ms` on Magic's Settings tab, `Select All and Copy work in a browser page ("")` | Echo slower than 3 s; tabs compact into a popup at CI's width; page not focused 200 ms after the click | 108c2b5b, 200da18a; the third came back on master |
| Oct 10 11:45 | master 3d1ae132: `strip: 9 windows, all full height` | Tiles read mid-glide: at 12x CPU throttle a 382 ms glide settles at 685 ms, height 553 < 562 | `still()` waits until nothing moves; `E2E_CPU_THROTTLE`; `failed.png` (1ed33190) |
| Oct 10 12:52 | master 1ed33190: `Select All and Copy work in a browser page ("")` | As above: a fixed 200 ms for focus | Wait for focus, retry until text arrives (72c8bcb4) |
| Oct 10 13:01 | master 72c8bcb4: `re-attached terminal shows its output exactly once (0×)` | A fixed 600 ms after switching the terminal renderer | `until()` everywhere (13ed0ea2, the `smoke-robust` branch) |
| Oct 10 13:19–13:21 | master: the smoke step made a warning instead of a gate (67220e9b), reverted two minutes later (749fa2c1) | | |
| Oct 10 13:27 | master 13ed0ea2: `⌘↑ goes back up and re-selects where you were (e2e, bin)`; fails the same way locally, twice in a row, in CI's screen shape | The rewrite's own regression or a product one: after ⌘↓ into `sub-folder`, ⌘↑ lands two levels up, in the e2e home | Open |

Vitest on CI, Oct 3 to Oct 10 (the runs a sibling run on the same commit passed, so flakes):
`agent detection with the native helper … timed out` (3 runs, an 8 s deadline), the
Dialog fade frame count (3 consecutive pushes), `scheduler … expected 1827 to be less than
1500` (a wall-time upper bound), `statement has been finalized` (a late SQLite write after
the store closed, after every test had passed), the first zsh start timing out (3 runs on
day one), and the packaged check's `waiting for locator('.sidebar-status')` (v0.13.0, both
runs, gone in v0.13.1). Eighteen more runs were cancelled by the workflow's
`cancel-in-progress` when a newer push landed, which is intended.

Not e2e, but the same push-to-find-out pattern: the relay deploy in the same push took
`relay.endtime-instruments.org` down for 13 minutes (jsonc-parser's ESM build missing from
the bundle, 555a349b), and signing needed its own keychain (35af7e13).

## Root causes

Ranked by incidents. The first two account for nearly every red run.

1. **Fixed waits before reading state** (6+ incidents, all in `smoke.mjs`). The script has
   about 130 `waitForTimeout` calls (21 × 100 ms, 20 × 200, 17 × 500, 12 × 400, 11 × 300,
   8 × 800, 7 × 600, 6 × 1500) and until yesterday no polling helper. A wait tuned on an
   idle Mac encodes that machine's speed. On CI, or on the same Mac with four agents
   building, it is wrong in both directions: too short (strip, Select All, re-attach, echo)
   or, as d18aa33e showed, too fast (drag and release in one frame).
2. **The runner is a different machine, and the tests never ran on anything like it**
   (4 incidents). A 1024 × 674 work area where tabs compact and paths wrap; a frame rate
   that stretches a 382 ms glide past 500 ms and paints two frames of a 120 ms fade; load
   from the build that just ran. Until 0afddb3f (`E2E_SCREEN=ci`) there was no way to run
   as CI does, so every CI-only failure meant a push to find out.
3. **Focus races** (3). Typing into a terminal, Select All on a browser page, and Copy all
   assume the target has focus a fixed moment after a click. Focus is asynchronous in
   Electron and depends on whether the app is active, which is also why runs stole the
   user's focus until `CMD_BACKGROUND`.
4. **Selectors and expectations rot behind UI refactors** (5). `.file-row` → kit Tree
   rows, Markdown prose → `.ui-doc`, default radius and line height, DOM → WebGL renderer.
   The e2e scripts find things by CSS class; the kit migration renamed them wholesale.
   Scripts not in CI (`drops.mjs`, `motion.mjs`, `remote.mjs`, `web.mjs`, `a11y-audit.mjs`,
   `perf.mjs`) rot silently: `drops.mjs` was broken for a day.
5. **Leaked processes** (3). Cores and PTY hosts outlive the app by design, so a run
   that dies leaves them; 37 cores exhausted the machine's PTYs. Fixed in the script,
   but every new e2e script re-implements launch and cleanup, so the next one can leak
   again. The sandbox blocking `ps`/`kill` made cleanup a user task.
6. **Environment differences other than the screen** (2). `$SHELL`, Windows stdio
   inheritance. Each cost two to twelve cycles because they were discovered on CI.
7. **One script, fail-fast, no report** (structural, behind every incident's cost). 184
   checks run in order in one process; the first failure throws and the run ends with one
   screenshot. Each CI run reveals one problem; later checks, and the packaging steps after
   the smoke step, never run. Fixing took "three pushes, three fixes" twice in one day.
8. **Local runs cost too much to be the first run** (structural). `pnpm e2e` rebuilds the
   app every time, takes minutes, is flaky under the load of parallel agents, and used to
   take focus. The prototype and manager skills say to run it once at the end; agents
   often don't, and CI becomes the first run.

Vitest had the same disease in miniature: tests that assumed an idle machine (a frame
count in 120 ms, a wall-time upper bound, an 8 s deadline for a helper process, a sleep
before a read). The cure there was right: 3a8d5790 split the suite into a `unit` project
(in-process, fully parallel) and a `system` project (real PTYs, Deno, Chromium, two files
at a time), replaced every sleep with `until()`, and sized deadlines for a busy machine
("a deadline only decides how long a broken test takes to say so"). The scheduler test
lost its wall-time upper bound (2449ce98) and the Dialog test seeks through its fade with
Playwright's clock (ca6cf88e). The nine CI runs since had no vitest failure. The e2e needs
the same treatment, and more.

### Where the time goes

A green macOS job, before the smoke step existed (five master runs, Oct 9):

| Step | Seconds |
|---|---|
| checkout, pnpm, install | 40–50 |
| typecheck | 16–21 |
| test (1133 tests) | 16–29 |
| build and stage | 9–16 |
| package (electron-builder, ad-hoc signed) | 84–131 |
| packaged-app check | 19–24 |
| whole job | 190–295 |

Packaging is 40 to 50 % of the job. Building the app is 15 seconds, so a local rebuild
isn't what makes `pnpm e2e` slow: driving the whole script is (the release skill says
about 2 minutes; the failed CI runs died 29 to 135 s in). A push-to-red cycle on Oct 10
took 4 to 5.5 minutes of CI plus the fix, 9 minutes in the best case between pushes.

## What we're doing wrong

**We test behaviour at the top of the pyramid that lives at the bottom.** Of the 184 smoke
checks, most assert on things the renderer store or the core decides: grid order after a
drag, which pane is selected after ⌘W (MRU), strip heights, workspace switching, sidebar
docking, settings applying live, widget state surviving a reload, re-attach showing output
once. The app is built so that state lives in the core and the renderer reads it over RPC
(and many checks already read `window.cmd.call("pane.list")` rather than the DOM). That
means those behaviours can be tested in-process: core tests with `fakeFactory()` for
anything the core owns, store or reducer tests for layout and selection, kit tests in
Playwright-in-vitest for a control's behaviour. Each runs in milliseconds, in parallel,
without a screen. The e2e is left to check what only the real app can: the menu reaches
the renderer, the renderer reaches the core, a terminal echoes, each window type paints,
webviews get permissions, the packaged app boots.

**We wrote a script, not tests.** A test runner gives independent cases, fixtures, retries,
timeouts per case, a report of everything that failed, traces and screenshots per action,
and parallel workers. The script gives one stack trace and `failed.png`. The "strong
inference rather than a confirmed CI repro" phase of the strip failure would have been a
Playwright trace: the DOM snapshot at the failing assertion shows the tile mid-glide.

**We wait for time instead of for the app.** The app knows when it is idle: `TileMotion`
knows when no window glides, `usePresence` knows when nothing is leaving, the store knows
when a debounced save is pending, the core knows when a pane's screen changed. The tests
guess with `waitForTimeout(400)`. `still()` (1ed33190) polls the DOM for the glide to end,
which is better, but still infers idleness from outside. The app should say so.

**We test motion with a wall clock.** Glides step at most 34 ms a frame, so their duration
depends on the frame rate, which depends on the machine. A functional check ("the window
is now on the left") should not depend on a 382 ms animation finishing; it should run on
a controlled clock (`page.clock`, as the Dialog test now does) or with motion made
instant for that check. Only `e2e/motion.mjs` should measure real frames, and it should
report, not gate.

**We found out on CI.** The tests ran on one screen at one speed with one shell for a
week, then met another machine. `E2E_SCREEN=ci` and `E2E_CPU_THROTTLE` now exist but are
opt-in; the default local run is still the one that passes and CI's is the one that
fails. And because `pnpm e2e` is slow and rebuilds, the local run is skipped, so the first
run of a new check is CI's.

**We let the suite grow by appending.** Every feature commit added a section to
`smoke.mjs`; nothing was ever removed or moved down. It is now the slowest, flakiest and
least reportable test we have, and the one gating releases.

## What others do

Checked against VS Code's smoke suite and flakiness wiki, Playwright's docs, and Google's
flakiness study. Nothing contradicts the plan; four points sharpen it.

- **Focus is never assumed.** VS Code's smoke README: "Never depend on DOM elements having
  focus using `.focused` classes or `:focus` pseudo-classes"; tests call
  `waitForActiveElement` first. Three of our incidents were exactly that assumption.
  "Don't use `setTimeout` just because. Think about what you should wait for in the DOM to
  be ready and wait for that instead." Also: don't run two smoke runners in one checkout
  (they share output and data dirs), which is our `.cmd-dev/e2e` lock.
- **Retries are a stopgap; a flaky test is disabled, not tolerated.** VS Code's wiki:
  "Retrying a test can work around a flaky test temporarily, but should generally not be
  used in the long term", and "if you have a flaky test, you should disable it ASAP to keep
  the build green." Reproduce by looping the test about 100 times locally, with verbose
  logs; "polling is almost always a better approach" than timeouts, because timeouts depend
  on "CPU speed, core count, and other running processes". Playwright traces are the
  diagnostic: CI uploads `playwright-trace-*.zip`, opened at trace.playwright.dev. A
  separate "Flaky Smoke Tests" pipeline runs the whole suite N times with
  `continueOnError`, a reliability run rather than a gate.
- **Timing is the cause, size is the predictor.** Google's study of its continuously run
  tests found flake rate grows with test size, and an engineer on it: "much of the
  flakiness in these tests comes from absolute timing" and relative thread timing. One team
  found that when a stable test turned flaky after a code change, it was a real product
  bug a sixth of the time: "if the default is to ignore the flaky tests then you will
  eventually be ignoring a real bug." Our same-frame drag release is that case.
- **The clock can be faked, including frames.** Playwright's `page.clock.install()`
  overrides `Date`, timers, `requestAnimationFrame`, `requestIdleCallback` and
  `performance`; `runFor(ms)` ticks them deterministically. Our motion engine
  (`renderer/src/motion.ts`, `packages/ui/src/motion.ts`) runs on exactly
  `requestAnimationFrame` and `performance.now`, so a glide can be stepped to its end in a
  test on any machine. The install must precede any other clock call, so the fixture does
  it at launch. `electron.launch` also takes `tracesDir` and `recordVideo`. The kit already
  honours `prefers-reduced-motion` (`reducedMotion()` in `packages/ui/src/motion.ts`), so
  `reducedMotion: "reduce"` is a second, coarser way to make functional checks instant.

## The plan

### Now: stop the bleeding (days)

1. **No fixed waits before a read.** Landed in 13ed0ea2: every `waitForTimeout` before
   reading state became `until(read, ok, deadline)`, and the check prints what it last saw. Deadlines are generous (10 s): they decide how long a
   broken check takes to fail, nothing else. The remaining fixed waits are the ones that
   give an input time to land, and each says why.
2. **Keep going after a failure.** Wrap each top-level section in a `scenario(name, fn)`
   that catches, screenshots, logs and continues; exit non-zero at the end with the list.
   One CI run then shows every broken check, not the first.
3. **Smoke in its own job.** Build and stage in one job, upload the build; smoke,
   packaging and the packaged check in jobs that need it. A red smoke no longer hides
   whether the app packages and signs. Add `drops.mjs` to CI so it stops rotting.
4. **Local default = CI shape, and runnable in parts.** `pnpm e2e` runs with
   `E2E_SCREEN=ci` (full-screen is the opt-in) and takes `--only <section>` like
   `motion.mjs` does, so a check can be iterated on in seconds instead of minutes. A
   `pnpm ci` script runs typecheck, test, build and smoke the way the workflow does, so
   "it passes locally" means the same thing.
5. **Traces on failure.** `electron.launch({ tracesDir })` plus `context.tracing.start()`
   at launch; on failure, stop and upload `trace.zip` with the screenshots and core logs.
   Open with `pnpm exec playwright show-trace` or trace.playwright.dev. A trace shows the
   DOM at the failing assertion, so "tiles still gliding" is seen, not inferred.

### Next: the app says when it is settled (a week)

6. **An idle signal.** The renderer exposes `window.cmd.e2e.settled()`: a promise that
   resolves when `TileMotion` has no active glides, no `usePresence` exit is pending, no
   debounced store write is waiting, and the last RPC round trip has returned. `still()`
   and most `until()` loops become `await settled()`. Available only with `CMD_DEV_KEYS`
   or an `CMD_E2E=1` env, like the existing e2e-only toggles.
7. **Motion under a clock.** Functional checks install Playwright's clock before an action
   that glides and `runFor(400)` after it, so a glide completes deterministically on any
   machine. `e2e/motion.mjs` keeps the real clock and stays a measurement, run on demand
   and in a nightly job, never a merge gate.
8. **Find things by role and name.** The a11y work gave every view steady accessible
   names (5661012a, 8660539f) and the tours skill already forbids CSS classes. The e2e
   scripts follow: `getByRole("group", { name: /terminal/ })`, not `.windows-track > .tile`.
   Kit migrations then stop breaking tests.

### Then: the pyramid (ongoing, per area)

9. **Move checks down.** For each smoke section, ask where the behaviour is decided and
   test it there:
   - Core: pane restore shows output once, workspace.open, OSC 8 handling, settings
     applying live, agent detection, notifications. Core tests with `fakeFactory()`,
     already the convention.
   - Renderer store and layout: grid order after a drop, MRU selection after close,
     strip sizing, sidebar docking, workspace switch. Pure reducer and layout functions
     tested in `apps/desktop/test` with vitest; where React is needed, Testing Library on
     the component with a fake `window.cmd`.
   - Kit: control behaviour (Dialog focus, Tabs compacting into a popup, Menu keyboard)
     in `packages/ui/test` with the existing Playwright-in-vitest setup.
   - Real app: one scenario per integration seam. Launch and onboarding; a terminal
     echoes and re-attaches; one window of each type opens and paints; a webview asks for
     a permission; Settings opens and one change applies; drag a tile; dock a window;
     switch a workspace; Magic builds a widget; the packaged app boots. About 15
     scenarios, each under 20 s, independent, on a controlled clock.
10. **Adopt `@playwright/test`.** One `electronApp` fixture (launch, isolated `CMD_HOME`,
    fixture transcripts, background mode, screen preset, cleanup of core and host) shared
    by every spec; `expect(locator)` assertions that retry by themselves; `retries: 1` on
    CI with `trace: "on-first-retry"`; two to three shards. The eleven `e2e/*.mjs` scripts
    become specs, and the duplicated launch and cleanup code goes away, with it the next
    leak.
11. **The e2e as a design pressure.** A check that needs the e2e to be testable is a
    hint the behaviour is in the wrong place (a layout decision taken in a component, a
    debounce the test can't observe). Fix the seam, then test below it.

### Rules for new tests

- Never `waitForTimeout` before reading state. Wait for the condition, or for `settled()`.
- A deadline is how long a broken test takes to say so, not how long the thing takes.
  Size it for a busy machine.
- Never assume focus. Wait for the active element (or the pane's `focused` flag) before
  typing or sending an edit command.
- A check prints what it saw when it fails, not just that it failed.
- Find UI by role and accessible name, or by a `data-*` attribute put there for tests.
  Never by a styling class.
- A new behaviour gets its test where the behaviour is decided. The e2e gets a line only
  when the test needs the real menu, a real PTY, a real webview or the packaged app.
- Run the e2e in CI's shape before a push (`pnpm e2e`, the default); a CI-only failure is
  reproduced locally (`E2E_SCREEN=ci`, `E2E_CPU_THROTTLE`, a trace) before a fix is pushed.
- Every e2e script is in CI or in a nightly job. A script in neither is deleted.
- A check that flakes is disabled the same day with an issue naming an owner, and the
  failure is reproduced (loop it 20 to 100 times under load, or with a trace) before the
  fix. Retries are allowed only as a marked, dated stopgap.
- A reliability run, not a gate: a nightly job runs the smoke suite several times in CI's
  shape and reports the per-check flake rate, so flakes are found there, not on a push.

## Speed hacks

Measured on 2026-10-10 against master in CI's screen shape (`E2E_SCREEN=ci`): `pnpm build`
5 s, `e2e/smoke.mjs` 71 s for 184 checks. Most of it is waiting:

| Where the 71 s go | About |
|---|---|
| `still()` minimums (29 calls × 300–800 ms) plus their 200 ms "read twice" confirmation | 19 s |
| Literal `waitForTimeout`s | 5 s |
| 38 screenshots at about 200 ms each | 7 s |
| The app restart block: debounced-save polls, quit, relaunch with 9 restored windows | 12 s |
| Checks that take 1–3 s each (Select All's retry, drags, resizing) | 15 s |
| Actual work: 138 steps under 300 ms | 10 s |

Launch to a ready core is 0.6 s. Electron exits in 141 ms; `app.close()` resolving takes
4 s because Playwright waits for stdio pipes the detached core inherited, which the script
sidesteps by waiting for the exit event instead. A broken check takes 20–30 s to report
(two 10 s `until()` deadlines, or Playwright's 30 s locator default).

Biggest payoff first:

1. **Shard across app instances.** The sections are independent. Four Playwright workers,
   each launching its own app with its own `CMD_HOME` (what worktrees already do), turn
   71 s into about 20 s wall with no per-check work. In CI, 2–3 shards in a job that runs
   beside packaging.
2. **Fake the clock.** `page.clock.install()` at launch, `clock.runFor(400)` after anything
   that glides or debounces. The motion engine runs on `requestAnimationFrame` and
   `performance.now`, which the clock fakes, so a glide completes at once and the same way
   on every machine. Removes the 19 s of `still()` and the 250 ms view-save debounce waits,
   and is also the fix for the timing flakes.
3. **Screenshots off by default.** On failure only, or behind `E2E_SHOTS=1` for the docs
   run. 7 s.
4. **Seed state, don't click it into existence.** Nine windows for the strip check come
   from one `window.open` loop over RPC; onboarding is seeded as seen for every scenario
   but the onboarding one (the remote e2e does this already). Only the check that is about
   the menu goes through the menu.
5. **Cheap shells.** Each new terminal starts a login zsh with the user's rc. For the test
   home, `shell.login` false and `ZDOTDIR` on an empty fixture: a terminal is ready in tens
   of milliseconds, not a second, and the same on every machine.
6. **Fail fast.** Default locator timeout 5 s, `until()` deadlines 5 s. A broken check then
   reports in 5 s instead of 20–30. Doesn't speed up a pass; halves every iteration on a
   failure.
7. **Run one section.** `--only <section>` as `motion.mjs` has, and skip the build when the
   output is newer than the sources. One check iterates in under 10 s.
8. **Keep the app warm while iterating.** Launch once with `--remote-debugging-port`,
   attach with `chromium.connectOverCDP` and rerun only the section being edited against
   the live app: 1–2 s per iteration. Local only.
9. **CI plumbing.** Cache the Electron download with the pnpm store; run smoke in its own
   job so its minutes overlap packaging's two instead of preceding them.

Items 1 to 3 alone take the suite from 71 s to roughly 15 s wall. The measurement recipe:
pipe the run through a script that prefixes each line with the time since the previous
one, and make `step()` print any gap over 500 ms with the step before and after.

### What landed (Oct 10)

On top of the scenarios and Reduce Motion (cc01e49b), measured the same way
(`E2E_SCREEN=ci`, all 35 scenarios green):

| Change | One app | Notes |
|---|---|---|
| Start (smoke-root merged) | 66 s | |
| The restart scenario waited for a renamed UI key (`sidebar.collapsed` → `sidebar.sections`) | 53 s | Sat out a 10 s deadline every run while the check after it passed. `E2E_GAPS=ms` found it |
| `still()` waits for the menu command to reach the renderer (it counts `onCommand`) and two frames, not a fixed 300–800 ms; reads every 30 ms | 36 s | Real motion (`E2E_MOTION=1`) keeps the fixed wait |
| Select All waits for the webview to be the app's focused element | 33 s | `getFocusedWebContents()` is always empty in the background, so the wait ran 3 s every time |
| Screenshots only with `E2E_SHOTS=1` | 30.5 s | A failure still saves one |
| Bare zsh in test terminals (`shell.login` false, empty `ZDOTDIR`) | 30 s | Mostly for sameness across machines |
| `--shards 3` / `--shards 4` | **15 s / 13 s wall** | `pnpm e2e` uses 3, CI 2 |

`pnpm e2e` also skips the build when nothing under `apps/desktop`, `packages` or the
lockfile is newer than `apps/desktop/out` (`scripts/build-if-stale.mjs`), so a rerun
costs only the run.

Shards deal the scenarios longest-first (a rough cost table in `smoke.mjs`), each with what
it needs, so `terminals` and `files` run in more than one. `browser` and what needs it stay
in one shard: Select All and Copy use the system clipboard.

Going faster removed the time some checks had relied on, and showed three races:
- **⌘↑ right after ⌘↓ in a file window went up two levels** (the "Open" ⌘↑ incident above).
  A product bug: the root's parent was set when the root's listing came back, and the rows
  can show sooner, from the cache. FilesView now keeps the parent with the root it was
  listed for, and falls back to the path's parent.
- **Settings → Browser, Remove:** the check read the rows once the file changed; Settings
  re-renders a moment later. A screenshot in between had hidden it.
- **The OSC 8 http link** failed under load (4 shards). xterm keeps its link lookup for the
  row under the pointer until the pointer leaves the row, and each retry stayed on row 0, so
  a first hover that came before the text was drawn made all three miss. Each attempt now
  comes in from another row. 8 of 8 alone and 3 of 3 under load since; not proven to be the
  whole story.

Not done: the fake clock (Reduce Motion already makes glides jump, and `still()` now costs
frames, not hundreds of ms), seeding state over RPC, shorter deadlines (they only shorten
a failure, and CI's runner needed the 10 s), and a warm app over CDP. The remaining gaps
are about 1 s each and real work: the memory sampler's tick, Restart Core, a deliberate
1 s "nothing else closed" check.

## Open

- **Same-frame drag release ignored.** d18aa33e slowed the test's drag because a move and
  a release in the same frame dropped nothing. A fast trackpad flick could do the same.
  Check whether the drop handler needs the pointer to have moved in a frame before
  release, and fix the product if so.
- **The intermittent OSC 8 link check** (`an OSC 8 http link opens in a browser window`,
  about 2 in 6 local runs). Probably xterm's per-row link lookup (see "What landed"); watch
  CI before calling it fixed.
- **Load on the development Mac.** Several agents run builds and tests at once; the
  `system` vitest project runs two files at a time for this reason. The e2e has no such
  guard and nothing stops two `pnpm e2e` from running together (they share `.cmd-dev/e2e`
  in the main checkout; worktrees have their own). Per-worktree homes already help; a lock
  on `.cmd-dev/e2e` would stop the rest.
- **Stale worktrees** from these fights: `swap-e2e` (debug logging, no commits),
  `dist-instance`. Remove them once their owners confirm.
