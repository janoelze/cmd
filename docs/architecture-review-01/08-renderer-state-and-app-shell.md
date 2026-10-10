# 08 Renderer state and app shell

**Score: 5/10** · reviewed 2026-10-10 against commit ddb7832 · scope: the renderer's store, `App.tsx` and the shell around it (pages, bootstrapping, errors, notifications, keybinding dispatch), not the tiling engine (07), terminal view (04) or UI kit (10)

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 4/10 | A 998-line `App` owns ten concerns; module singletons wired by mutable globals; one runtime import cycle; no layering rule |
| Correctness & robustness | 5/10 | No error boundary anywhere; notifications decided per window; view writes lost across a reconnect |
| Performance | 6/10 | Measured and much improved (docs/14), but 7 whole-store subscribers and every window mirrors every pane |
| Security | n/a | CSP and the unsandboxed preload are another reviewer's |
| Testability & tests | 5/10 | Pure helpers are tested (46 tests pass); the store reducer, reconciliation and `App` logic have none |
| Extensibility | 5/10 | Window types register themselves; a new command still means editing `App`'s 80-entry handler map |
| Code health | 6/10 | 0 `any`, 0 `ts-ignore`, good top comments; 33 `eslint-disable` lines for a linter that is not installed |

## What this system is

The renderer is React 19.3 (`apps/desktop/package.json`) on four HTML pages built by electron-vite (`electron.vite.config.ts`): the app (`index.html` → `main.tsx`, 41 lines), Settings (`settings/main.tsx`), the Task Manager (`tasks/main.tsx`) and the dev-only Workbench (`workbench/main.tsx`, deliberately not in the build inputs). The app's state is `store.ts` (601 lines): a hand-rolled module singleton exposed through `useSyncExternalStore`, holding a mirror of the core (panes, agents, windows, workspaces, settings, remote, library) plus client state (`workspaceId`, `ui`, `remoteInput`). It is fed by `cmd.onEvent(handle)` (a `switch` over `CoreEvent` that copies the touched `Map` and calls `set`) and rebuilt from `events.subscribe` on every connect, after which every pane's screen is fetched with `pane.snapshot`, the selected one first. Writes to persisted UI state (`setUi`, `usePersisted`) and per-workspace view state (`setWorkspaceView`, `useWorkspaceView`) apply locally at once and reach the core debounced at 250 ms, with pending values re-applied over echoes (`withPending`, `store.ts:251`). Seven smaller stores follow the same pattern (`keybindings.ts`, `magic.ts`, `coreHealth.ts`, `windowActions.ts`, `ai/status.ts`, `onboarding/Onboarding.tsx`, `settings/useSettings.ts`). `model.ts` (477 lines) is the pure view model (rows, fields, ordering, focus-after-close). `App.tsx` (998 lines) is the shell: it subscribes to the whole store, derives the workspace's rows, keeps selection, sheets, palette, notifications, menu state, context menus and the command handlers. Shortcuts are menu accelerators owned by main (`shared/commands.ts`, 81 commands) that arrive as `cmd.onCommand` and run `App`'s handler. Errors go to main through `errors.ts` (`window` `error`/`unhandledrejection` → `renderer-error` IPC → `main/index.ts:709` → crash report). Startup is marked with `boot:*` marks and measured by `e2e/startup.mjs` (docs/14: terminals filled at ~815 ms warm). Design docs: docs/07, 14, 21, 31, 37.

## What is good

- **Terminal output bypasses React entirely** (`store.ts:414`): `pane.output` goes straight to `terminals.write`, and the snapshot hold (`awaitingSnapshot`, `store.ts:409`) relies on the single ordered socket, which is correct and simple.
- **Snapshot-then-events with resync on reconnect** (`store.ts:545-601`): the whole mirror is replaced from `events.subscribe` on every connect and data/view subscriptions are reopened. This is the VS Code Agent Host contract [VSC-AGENT].
- **The spinner filter** (`looksSame`, `store.ts:376`) and the `usageShown` trick cut renders from 686/s to 18/s with four spinning agents (docs/14, win 6). That was measured, fixed and logged with numbers; other systems should copy that.
- **Pure view model**: `model.ts`, `strip.ts`, `notify.ts`, `find-dom.ts`, `docks.ts` and `links.ts` hold no React or bridge state and are tested (9 test files import `model.ts`). `notify.ts` (`Looks`, `DoneBatch`) is a good example of policy pulled out of a component.
- **One shortcut path**: every shortcut is a menu accelerator in main, so on macOS a command reaches the renderer once, through `cmd.onCommand`. `handlers: Record<CommandId, () => void>` (`App.tsx:410`) is typed against the command list, so tsc flags a missing handler.
- **Type hygiene**: 0 `any`, 0 `@ts-ignore`, 9 `as unknown as` (test hooks, webview casts) across ~20k renderer lines.
- **Echo-safe optimistic view writes**: `withPending` + `sameWorkspace` keep identity for unchanged keys, so a drag isn't re-laid out by its own echo.

## Issues

### AR1-08-01 · Add error boundaries so one broken view can't blank the window

- **Status:** done (c435d9a4)
- **Severity:** high
- **Effort:** S (< ½ day)
- **Where:** `apps/desktop/src/renderer/src/main.tsx:28`, `apps/desktop/src/renderer/src/windows/registry.ts:51-55`, `apps/desktop/src/renderer/src/errors.ts:9-18`

**Problem.** The renderer has no error boundary at all. Under React 19, an error thrown while rendering any component unmounts the whole root, so one throwing window view (a Magic widget's host view, a Markdown file that trips the renderer, a `lazyView` chunk that fails to load) leaves the app window blank, with all terminals, sidebars and the footer gone, until the user knows to press ⌘R. `errors.ts` reports the error to main, but nothing in the UI recovers. Window views are the extension point plugins will use (CLAUDE.md, "windows/"), so this risk grows with each new view.

**Evidence.** `grep -rn "ErrorBoundary\|componentDidCatch\|getDerivedStateFromError" apps/desktop/src packages/ui/src` returns nothing. `createRoot(...)` in all four page entries passes no `onUncaughtError`/`onCaughtError`. `lazyView` wraps views in `Suspense` only (`registry.ts:54`), so a rejected `import()` throws to the root.

**Proposal.** Put a boundary in the kit (`@cmd/ui`, an `ErrorBoundary` with an `EmptyState` fallback: "This window stopped working" · Reload Window) and use it at two levels. First, per tile: wrap the view in `lazyView` and wherever `viewFor(kind)` renders, so a broken window shows its fallback and the rest stays live. Second, one shell boundary per page whose fallback offers Reload. Pass `onCaughtError`/`onUncaughtError` to `createRoot` and send both to `cmd.reportError` with `kind: "render"` and the component stack, so crash reports keep what `errors.ts` sends today.

**Success criteria.**
- [x] `grep -rn "ErrorBoundary" apps/desktop/src/renderer/src` finds the tile wrapper and the page shell (all four entries).
- [x] `createRoot` in every entry passes `onUncaughtError` and `onCaughtError` that call `cmd.reportError` with the component stack.
- [x] An e2e step (in `e2e/smoke.mjs`, through a test-only window kind or `__cmd` hook) makes one window's view throw and asserts another terminal tile still renders and accepts input.
- [x] The kit gallery shows the boundary's fallback specimen.

### AR1-08-02 · Split App.tsx into a shell, controllers and feature modules

- **Status:** open
- **Severity:** high
- **Effort:** L (> 2 days)
- **Where:** `apps/desktop/src/renderer/src/App.tsx:98-960`
- **Depends on:** AR1-08-03 (can go first, but lands better after it)

**Problem.** `App` is one 860-line function component with at least ten concerns: (1) whole-store subscription and workspace derivation (`inWorkspace`, rows, `flat`, `viewOrder`); (2) selection, history and focus-after-close; (3) ten persisted view keys (mode, layoutMode, gridOrder, strip widths, canvas rects, camera, docks, zoom, recent, sidebar carry-over); (4) seven sheet/overlay states (palette, paletteActions, feedback, library, whatsNew, setup, picker) plus the ⌘W precedence chain; (5) notification presentation, seen-marking, Dock badge and progress; (6) 80 command handlers; (7) menu-state sync; (8) four context-menu builders; (9) palette search across four RPCs; (10) sidebar sliding, first-Navigator migration, window width, onboarding/What's New sequencing, test hooks. Any change to one of them re-reads all of it, every command added edits this file (an append-only list, the conflict pattern CLAUDE.md warns about), and the handlers close over render-scoped values, so `handlersRef` has to be patched on every render.

**Evidence.** `wc -l App.tsx` = 998; `useEffect(` ×25, `useState` ×12, `useMemo` ×14, `useCallback` ×8, `useRef` ×10, 44 imports; 80 handler keys at `App.tsx:410-536` for 81 commands; 4 `eslint-disable-line react-hooks/exhaustive-deps` inside it; `searchAll` alone is 63 lines (`App.tsx:765-828`).

**Proposal.** Keep `App` as layout only (< 250 lines) and move each concern next to what it serves, following VS Code's contribution pattern [VSC-ORG] (each feature registers itself instead of editing a central map):
- `shell/selection.ts`: a small store (`select`, `deselect`, history, focus-after-close as an effect over `model.nextAfterClose`). It replaces `bindSelection` / `selectPane` in `actions.ts:10-22`, which wire React state into a module through mutable globals.
- `shell/sheets.ts`: one `sheet: { kind: "palette" | "feedback" | "library" | "whatsNew" | "setup" | "picker"; ... } | null` reducer; ⌘W becomes "close the top sheet". This deletes the six-branch chain at `App.tsx:435-445`.
- `commands/registry.ts`: `registerCommand(id, handler, { enabled?, checked? })` with handlers in feature files (`view/commands.ts`, `session/commands.ts`, `workspace/commands.ts`…). `setMenuState` derives from the registry, which replaces the hand-kept dependency list at `App.tsx:623`. Handlers read state through `getState()`/selectors, not render closures.
- `notifications/presenter.ts` (see AR1-08-04), `palette/search.ts` (pure item builders, testable), `menus/rows.ts` (context menus).

**Success criteria.**
- [ ] `wc -l apps/desktop/src/renderer/src/App.tsx` ≤ 250 and `grep -c "useEffect(" App.tsx` ≤ 5.
- [ ] Adding a command touches `shared/commands.ts` and one feature file, not `App.tsx` (shown by the diff of one new command in the PR).
- [ ] `bindSelection` is gone from `actions.ts`; selection has unit tests for focus-after-close and history without a DOM.
- [ ] Palette item builders have a vitest file; `pnpm e2e` and `pnpm e2e:motion` pass unchanged.

### AR1-08-03 · Replace whole-store subscriptions with memoised selectors

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `apps/desktop/src/renderer/src/store.ts:178-198`, `store.ts:365-369`, `store.ts:422`, `App.tsx:101-106`, `App.tsx:862-871`, `components/NotificationsView.tsx:57`, `components/CommandsView.tsx:41`, `components/ResourcesView.tsx:164`, `components/ActionsView.tsx:50,278`, `components/AgentActivity.tsx:31`

**Problem.** `set()` notifies every listener for every change. `App` calls `useStore()`, so any agent hook event, `pane.updated` that passes `looksSame`, workspace echo or remote update re-renders the shell. It then rebuilds `inWorkspace` (three filtered Maps), `buildRows`, two `flatten`s, `paletteItems` and a new `navigatorData` object, which makes every Navigator context consumer re-render too. Six widgets also subscribe to everything, though they read one or two maps (NotificationsView reads `s.panes`/`s.windows` only for lookups). Two workarounds show the store lacks selectors. `setUsageShown` calls `set({})` to force a notify (`store.ts:368`). `looksSame` mutates the live `Map` in place (`state.panes.set`, `store.ts:422`), so any `useMemo` keyed on `all.panes` silently stays stale for the skipped fields. That is safe today only because the skipped fields are not read by those memos.

**Evidence.** `grep -rn "useStore()"` = 7 callers outside `store.ts` (App + 6 widgets). `memo(` is used in 2 of 57 components (`TerminalView`, `WindowsView`). `navigatorData` is a fresh object literal per render (`App.tsx:862`). docs/14 still measures 18 renders/s with four spinning agents after the fix, and lists "Canvas pan and drag re-render every title on every frame" as open (renderer 3).

**Proposal.** Give the store selector hooks with equality, `useStore(selector, equal = Object.is)` built on `useSyncExternalStoreWithSelector` (React's `use-sync-external-store/with-selector`, the mechanism Zustand and Redux use), plus `shallow` for arrays and records. Move derivations into memoised selectors in a `store/selectors.ts` keyed on input identities (`rowsOf(workspaceId)` recomputes only when that workspace's panes, agents or windows change, `attentionCount`, `dockProgress`). Keep the core mirror strictly immutable (no in-place `Map.set`): store the spinner-only update in a side `Map` that `getState()` readers consult, or accept a copy and let the selector equality drop the re-render. Wrap `navigatorData` in `useMemo`. Remove `set({})`.

**Success criteria.**
- [ ] `grep -rn "useStore()" apps/desktop/src/renderer/src` returns only the definition (or nothing).
- [ ] `grep -n "state.panes.set\|set({})" store.ts` returns nothing.
- [ ] `e2e/perf.mjs` with four spinning agents reports `__cmdPerf.renders.App` ≤ 2/s (from ~18/s), recorded in docs/14's Wins table.
- [ ] A vitest checks that `rowsOf(ws)` keeps its identity across a `pane.updated` for a pane of another workspace.

### AR1-08-04 · Decide notification presentation once per app, not once per window

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `apps/desktop/src/renderer/src/App.tsx:268-357`, `apps/desktop/src/main/index.ts:573-593`, `packages/core/src/core.ts:339`, `apps/desktop/src/renderer/src/components/Remote.tsx:209-236`

**Problem.** The core broadcasts every `notification` to every connection, and every app window runs its own `onNotification` handler with its own `Looks` and `DoneBatch`. With two app windows (Open in New Window), the focused one suppresses a notification about the terminal you are looking at, and the other window, which is unfocused and not looking, posts it anyway with sound and a Dock bounce. "Agents done" batching is per window too, so the sum differs by window and a replaced notification can play its sound twice. Pair-request and remote-session notifications in `useRemoteNotifications` have the same per-window shape. docs/31's rule 2 ("never about what you're looking at") is therefore broken in multi-window use, and only main or the core can know which window is in front.

**Evidence.** `core.ts:339` `#broadcast({ type: "notification" })` to all connections; `App.tsx:328` `const looking = document.hasFocus() && from === selectedRef.current` is per window; `App.tsx:278-279` creates `Looks`/`DoneBatch` per `App`; `main/index.ts:576` closes and re-creates by tag, so a second `notify` with the same tag shows again (sound included).

**Proposal.** Move the presentation decision to main, which knows the focused `BrowserWindow`. Each renderer reports what it looks at (`cmd.reportLook({ selected, focused })`, already computed at `App.tsx:280-283`). Main runs `notify.ts`'s `Looks` and `DoneBatch` once (move `notify.ts` to `apps/desktop/src/shared/`, it is pure and tested), receives notifications from one place (its own core connection, or the renderer forwards them and main de-duplicates by `n.id`), and applies `notifications.when`, sound and bounce. The visual bell stays in the renderer that shows the pane. The alternative of letting the core filter on `user.focus` (`core.ts:1031`) also works, but the core doesn't know app focus or which macOS window is in front, so main is the better owner.

**Success criteria.**
- [ ] With two app windows, a notification about the pane selected in the focused window posts nothing (a test in main over the moved `notify.ts` logic, or an e2e step with two windows).
- [ ] One `Looks`/`DoneBatch` instance per app: `grep -rn "new Looks\|new DoneBatch" apps/desktop/src` finds only main.
- [ ] Each `n.id` reaches `new Notification` at most once (unit test of the presenter).
- [ ] The two windows' remote pair prompts post one system notification, not two.

### AR1-08-05 · Make the store a pure reducer that tests can import

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `apps/desktop/src/renderer/src/store.ts:49-64`, `store.ts:235`, `store.ts:322-338`, `store.ts:411-601`

**Problem.** The rules that matter most for correctness are untested because the module can't be imported outside the app: event application (`handle`), the echo/pending merge (`withPending`, `sameWorkspace`), the spinner filter (`looksSame`) and the snapshot hold. Importing `store.ts` registers `cmd.onEvent`, `cmd.onStatus` and `cmd.onShowWorkspace`, adds a `beforeunload` listener and reads `location.search`, all at module scope, so a test has no bridge to give it. The two test files that mention it import `type State` only. The same side effects make the import graph matter: `store.ts → terminals.ts → drops.ts → actions.ts → store.ts` is a runtime import cycle.

**Evidence.** `grep -l "store.ts" apps/desktop/test/*.ts` gives `sidebar.test.ts` and `workspaces.test.ts`, both `import type`. Top-level side-effect statements (`^cmd.on|^window.addEventListener|^void cmd.`) appear in 7 renderer modules (19 statements). The cycle was found with a Tarjan pass over value imports (scratch script; `dependency-cruiser --validate` would report the same).

**Proposal.** Split `store.ts` into three files. `store/reduce.ts` holds `reduce(state, event): { state, effects }`, pure, with `looksSame`, `withPending` and `sameWorkspace` as exported functions. `store/sync.ts` holds the connection lifecycle and the outbox (AR1-08-06). `store/index.ts` holds the singleton, hooks and the `install(bridge)` wiring, called from `main.tsx`. Side effects of an event (`terminals.write`, `applyFonts`, listener fan-out) become a returned list or an injected port, so the reducer is testable with plain data. This is the AHP shape: immutable state plus pure reducers, with the host as the source of truth [VSC-AGENT]. Breaking the module-scope wiring also breaks the cycle.

**Success criteria.**
- [ ] `apps/desktop/test/store-reduce.test.ts` exists and covers: spinner-only `pane.updated` causes no change, a `workspace.updated` echo keeps view identity, a pending key survives an older echo, `pane.removed` and `agent.removed` drop entries.
- [ ] `grep -nE "^(cmd\.on|window\.addEventListener)" apps/desktop/src/renderer/src/store*` returns nothing.
- [ ] No runtime import cycle in `apps/desktop/src/renderer/src` (dependency-cruiser `no-circular`, or the boundaries lint of AR1-08-07).
- [ ] `pnpm typecheck && pnpm test` pass.

### AR1-08-06 · Re-send pending UI and view writes after a reconnect

- **Status:** open
- **Severity:** medium
- **Effort:** S (< ½ day)
- **Where:** `apps/desktop/src/renderer/src/store.ts:214-234`, `store.ts:251-291`, `store.ts:567-576`
- **Depends on:** AR1-08-05 (optional; can be fixed in place)

**Problem.** Optimistic writes have no outbox. A layout change made while the core restarts (Restart Core, an outdated core replaced at launch) is applied locally, then `workspace.update` fails and is swallowed by `.catch(() => {})`. The key stays in `pendingView`, so `withPending` keeps overriding that key in this window forever, and the core never gets it: other windows and the next launch see the old layout, and this window ignores changes to that key from elsewhere. `setUi` loses the value outright: the call fails, and the reconnect snapshot (`ui: snap.ui`, `store.ts:571`) reverts the local value without telling the user. `flushUi` on `beforeunload` fires async calls during unload with no guarantee they leave the process.

**Evidence.** `sendView` never deletes or retries on failure (`store.ts:268-274`); `withPending` deletes a pending key only when the core echoes an equal value (`store.ts:253`); the reconnect path (`store.ts:545-601`) calls `reopenDataSubs()` but never `sendView`/`flushUi`.

**Proposal.** Keep an outbox of `{ kind: "ui" | "view", key, value }`, cleared on a successful call (not only on echo). On `connected`, after the snapshot: re-apply the outbox over `snap.ui` and the workspaces, then send it. That is local-first write-then-sync with replay after offline, as Linear does [LIN-SYNC]. For unload, flush synchronously through main (`ipcRenderer.sendSync` to a main-side writer), or have main flush on `before-quit` from a copy it already holds.

**Success criteria.**
- [ ] A reducer/outbox test: a view write made while disconnected is sent once on reconnect and then cleared from pending.
- [ ] A `setUi` value set while disconnected survives the reconnect snapshot (test).
- [ ] Manual or e2e: move a sidebar, Restart Core within 250 ms, relaunch the app, and the moved sidebar is kept.

### AR1-08-07 · Install ESLint with react-hooks and a renderer layering rule

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** repo root (no `eslint.config.*`), `apps/desktop/src/renderer/src/**`

**Problem.** The renderer depends on hook rules and dependency lists that nothing checks. There are 33 `// eslint-disable-line react-hooks/exhaustive-deps` comments, but ESLint isn't installed or configured anywhere, so they suppress nothing and missing dependencies elsewhere go unnoticed. Several stale-closure workarounds (`handlersRef`, `terminalMenuRef`, `selectedRef`) exist because of this. There is no layering rule either. 33 renderer files import `store.ts` directly, including utilities, 10 non-component `.ts` modules import React, and the cycle in AR1-08-05 went unnoticed. 00-research.md §9 recommends exactly this kind of fitness function, rolled out as a ratchet.

**Evidence.** `find . -maxdepth 3 -name "eslint.config*" -not -path "*/node_modules/*"` → none; `ls node_modules/.pnpm | grep ^eslint` → none; `grep -rn eslint-disable apps/desktop/src/renderer/src | wc -l` = 33; `grep -rlE 'from "(\./|\.\./)+store\.ts"' … | wc -l` = 33.

**Proposal.** Add a flat ESLint config with `eslint-plugin-react-hooks` (`rules-of-hooks: error`, `exhaustive-deps: warn`) for `apps/desktop/src/renderer` and `packages/ui`. Add `eslint-plugin-boundaries` [BOUNDARIES] (or dependency-cruiser [DEPCRUISE]) with three element types. `lib` (pure: `model`, `strip`, `notify`, `links`, `paste`, `docks`, `layouts`) may import only `@cmd/protocol` and other `lib`. `services` (`store`, `terminals`, `bridge`, `actions`) may not import `components`. `components` may import anything below them. Commit a baseline file of today's violations and ratchet it down the way `design-debt.json` works (00-research.md §9). Run it in `pnpm test` (a vitest that shells out) or CI.

**Success criteria.**
- [ ] `pnpm lint` exists and runs in CI; `rules-of-hooks` violations = 0.
- [ ] The boundaries baseline exists and a test fails when it grows.
- [ ] `lib` modules import neither `react` nor `store.ts` nor `bridge.ts` (enforced, not by convention).
- [ ] No `no-circular` violations in the renderer.

### AR1-08-08 · Scope each window's mirror to its workspace

- **Status:** open
- **Severity:** medium
- **Effort:** L (> 2 days)
- **Where:** `apps/desktop/src/renderer/src/store.ts:553`, `store.ts:561-598`, `App.tsx:101-106`

**Problem.** Every app window subscribes to every event (`events.subscribe {}`) and fetches and holds the screen of every pane of every workspace at startup. A user with three workspaces in three windows parses each terminal's output three times and holds three xterm buffers per terminal. docs/14 lists this as an open decision (renderer 6) and measures ~45 ms of main-thread work per terminal before "terminals filled". The renderer needs metadata (titles, attention, agents) for all workspaces to draw the switcher badge and run "next attention", but output and screens only for the panes it shows.

**Evidence.** `store.ts:553` `cmd.call("events.subscribe", {})` with no filter; `store.ts:587-598` snapshots `snap.panes` (all workspaces) ranked but not filtered; docs/14 "Every window mirrors every pane of every workspace… Needs a decision".

**Proposal.** Split the subscription in two channels, as AHP does with URI-addressed subscriptions [VSC-AGENT]. The metadata channel (pane, agent, window, workspace events) stays global. The output channel (`pane.output`, `pane.snapshot`) covers this window's workspace only and is re-subscribed on switch, so the incoming workspace's terminals fill on the View Transition (snapshot first, as the selected one is today). The protocol side belongs to doc 02, the terminal side to doc 04; the store's part is the channel bookkeeping and the hold logic. Decide with a measurement of the switch delay (snapshot of a 5,000-line pane ≈ the 56 ms for six panes in docs/14).

**Success criteria.**
- [ ] With two windows on different workspaces, the renderer of window A receives no `pane.output` for panes of window B's workspace (`__cmdPerf.events["pane.output"]` in an e2e).
- [ ] `e2e/startup.mjs` "terminals filled" with six terminals split over two workspaces drops by the other workspace's share.
- [ ] A workspace switch shows its terminals' content within one glide (≤ 382 ms, docs/37) in `pnpm e2e:motion`.

### AR1-08-09 · Show failed actions as toasts instead of filing them as crash reports

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `apps/desktop/src/renderer/src/App.tsx:410-536`, `App.tsx:553-556`, `apps/desktop/src/renderer/src/actions.ts:78-258`, `errors.ts:17`

**Problem.** Command handlers discard their promises (`() => void newTerminal()`), so when `pane.create`, `window.open` or `agent.spawn` fails (old core, bad cwd, core restarting) the user sees nothing. The rejection becomes an `unhandledrejection`, which `errors.ts` files as a crash report and main sends to the crash webhook. Bugs and expected failures end up in one channel, and the person gets no feedback.

**Evidence.** 125 `void cmd.call(` in the renderer, 61 without `.catch` on the same line; 7 of those in `App.tsx` (`223`, `292-294`, `648`, `727`, `746`); `run` (`App.tsx:553`) calls `handlersRef.current[id]?.()` and ignores the result.

**Proposal.** Let handlers return `void | Promise<void>`. `run` awaits the result and catches: it shows `toast(message, { tone: "danger" })` worded by the copywriting skill and logs it as a warning, not a crash. Mark expected RPC failures in `bridge.ts` (`CoreCallError` carrying `method`), so `errors.ts` can skip them and keep crash reports for real bugs.

**Success criteria.**
- [ ] `grep -n "() => void " App.tsx` no longer matches handlers that start async actions (they return the promise).
- [ ] A test of `run` with a rejecting handler shows a toast and does not call `cmd.reportError`.
- [ ] `errors.ts` ignores `CoreCallError` rejections (test).

### AR1-08-10 · Share one page bootstrap and one core-mirror factory between pages

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `apps/desktop/src/renderer/src/main.tsx:18-33`, `settings/main.tsx:15-33`, `tasks/main.tsx:15-32`, `workbench/main.tsx:16-27`, `settings/useSettings.ts:11-55`

**Problem.** Four entries repeat the same ten lines (error reporting, `bootTheme`, scrollbars, tooltips, platform class, `UIProvider icon={Symbol}`); Settings and Tasks repeat the same `onCommand` edit fallback. `useSettings.ts` is a second hand-written core mirror (connect → `events.subscribe` → apply theme/look → `useSyncExternalStore`) with its own reconnect logic, and the Workbench has a third (`Workbench.tsx:45-46`). A fix to one (an error boundary, a reconnect bug, a new theme hook) has to be made three or four times. Settings and Tasks also import the app's whole 1,206-line `styles.css`.

**Evidence.** `diff <(sed -n 15,24p settings/main.tsx) <(sed -n 15,24p tasks/main.tsx)` is empty; `cmd.onStatus` appears in `store.ts`, `settings/useSettings.ts`, `ai/status.ts`, `workbench/Workbench.tsx`.

**Proposal.** `renderer/src/page.tsx`: `bootPage(root: ReactNode, { editFallback?: boolean })` does the shared setup and wraps the root in the AR1-08-01 boundary. `createCoreMirror({ types, onSnapshot, reduce })` returns a `useSyncExternalStore`-backed hook. Both the app store (after AR1-08-05) and Settings use it, so reconnect and snapshot handling exist once.

**Success criteria.**
- [ ] Each `*/main.tsx` is ≤ 12 lines and calls `bootPage`.
- [ ] `grep -rn "cmd.onStatus" apps/desktop/src/renderer/src` finds one implementation (the factory) plus `ai/status.ts` at most.
- [ ] The Settings bundle no longer includes the app's `styles.css` (or only a split shared part).

### AR1-08-11 · Route the terminal's ⌘-key shortcuts through keybindings.json

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `apps/desktop/src/renderer/src/terminals.ts:28`, `terminals.ts:368-379`, `apps/desktop/src/shared/commands.ts:64-65`

**Problem.** Dispatch is clean on macOS: main's menu accelerators win and reach `App` as commands. But xterm's custom key handler also hard-codes ⌘↑/⌘↓ (jump to prompt), ⌘Home/End/PageUp/PageDown and ⌘←/⌘→/⌘⌫ (line editing). The menu items `terminal.prevPrompt`/`nextPrompt` have no default keys, so the menu shows no shortcut for them, users can't remap them in `keybindings.json`, and a user binding ⌘↑ to another command gets both actions. This breaks the CLAUDE.md rule that every shortcut must be a real menu item. The terminal file belongs to doc 04; this issue covers only the dispatch rule.

**Evidence.** `terminals.ts:372-373` `else if (e.key === "ArrowUp") this.jumpToPrompt(paneId, -1)`; `shared/commands.ts:64-65` define the two commands without `keys`.

**Proposal.** Give `terminal.prevPrompt`/`nextPrompt` (and new `terminal.scrollTop/Bottom/PageUp/PageDown`) default keys in `commands.ts` and delete the branches in xterm's handler, leaving only the byte-sequence keys (⌘←/⌘→/⌘⌫) that are terminal input, not commands. Those can be listed in a `TERMINAL_KEYS` table shown in Settings → Keyboard.

**Success criteria.**
- [ ] `grep -n "jumpToPrompt\|scrollToTop\|scrollPages" terminals.ts` finds no call inside `attachCustomKeyEventHandler`.
- [ ] `commands.test.ts` asserts every command reachable by a key has a menu item with that accelerator.
- [ ] Rebinding Jump to Previous Prompt in `keybindings.json` works and ⌘↑ then does nothing extra.

### AR1-08-12 · Turn the startup and render measurements into CI budgets

- **Status:** open
- **Severity:** low
- **Effort:** M (1–2 days)
- **Where:** `e2e/startup.mjs`, `e2e/perf.mjs`, `apps/desktop/src/renderer/src/perf.ts`, `.github/workflows/build.yml:216`

**Problem.** Startup is well instrumented. `boot:*` marks run from `boot:renderer-script` to `boot:terminals`, and `e2e/startup.mjs` and `e2e/perf.mjs` time them and count renders per component through `window.__cmdPerf`. But neither runs in CI and neither has a threshold, so the 815 ms warm start and the 18 renders/s exist only as numbers in docs/14 and can regress without anyone noticing. docs/14's "Still to add" (long-animation-frame recording, per-frame commit counts) is also open.

**Evidence.** `grep -n "budget\|assert\|exit(1" e2e/startup.mjs e2e/perf.mjs` finds no thresholds; `.github/workflows/build.yml` runs `pnpm e2e` (smoke) and `e2e/packaged.mjs` only.

**Proposal.** Add `e2e/budgets.json` (warm "terminals filled" ≤ 900 ms for six terminals; `App` renders ≤ N/s with four spinners; no long animation frame > 50 ms while flooding). Make both scripts exit non-zero over budget and run them in CI on macOS with three runs and the median, as a ratchet like `design-debt.json` (00-research.md §5 and §9). Add a renderer long-task observer to `perf.ts` (`PerformanceObserver` on `long-animation-frame`) so the counters cover blocking time as well as renders.

**Success criteria.**
- [ ] `e2e/budgets.json` exists; `node e2e/startup.mjs --check` and `node e2e/perf.mjs --check` exit 1 over budget.
- [ ] CI runs both on every push to master.
- [ ] `__cmdPerf.longFrames` exists and `e2e/perf.mjs` reports it.

## Course corrections

1. **Contain failures** (AR1-08-01, then AR1-08-09). A blank window is the worst user-facing outcome this system can produce today, and the fix is half a day.
2. **Make the store a tested, pure core mirror with selectors** (AR1-08-05, AR1-08-03, AR1-08-06). One reducer with tests, selector hooks with equality and an outbox. This removes the remaining whole-tree renders, the in-place mutation and the lost writes, and it is the base that the App split builds on.
3. **Dissolve App.tsx into controllers and a command registry** (AR1-08-02). This turns the busiest append-only file in the renderer into feature-owned contributions.
4. **Move cross-window decisions out of the windows** (AR1-08-04, then AR1-08-08). Notification presentation goes to main, and output channels are scoped per workspace.
5. **Enforce it** (AR1-08-07, AR1-08-12). Lint, layering and performance budgets as ratchets, so the next 1,000 lines don't recreate the problems.

## Quick wins

AR1-08-01, AR1-08-06, AR1-08-09, AR1-08-10, AR1-08-11.

Neighbours: the tiling engine and `WindowsView` re-render on pan (docs/14 renderer 3), see doc 07. Terminal flow control and the xterm key handler beyond dispatch, see doc 04. `events.subscribe` returning the full snapshot even with `types`, and event versioning, see doc 02. The Settings window's schema-driven content, see doc 16. The kit's components and themes, see doc 10.
