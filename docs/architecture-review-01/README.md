# Architecture review 01

**Overall: 5/10** · 2026-10-10 · reviewed against commit `ddb7832` · 16 systems plus repo layout, 169 issues (2 critical, 37 high, 80 medium, 50 low; 5 done)

cmd's foundations hold up: one core that owns all state, a PTY host that outlives it, a typed RPC contract, an event log with views, a token-driven UI kit, and a scheduler with a stall watchdog. A week of shipping on top of them has left three kinds of debt. **The read side has no single policy.** Phones, widgets and model-written code each reach files and the event log through their own checks, and two of those checks leak. **Terminal and event streams have no positions.** Snapshots and live output can't be joined exactly, and nothing pushes back on a fast producer. **Every feature edits the same central files.** `core.ts`, `App.tsx`, `WindowsView.tsx`, `tracker.ts` and five append-only registries absorb every change, and nothing stops them from growing.

None of this needs a rewrite. The fixes are mostly small for the security and data-loss defects, and medium for the structural ones. They go in the order under "Course corrections" below.

## How to use this folder

- [TEMPLATE.md](TEMPLATE.md) is the format every doc follows, plus the **claim-and-flip workflow**: set an issue's **Status** to `in progress (<branch>)` on master before starting, work in a worktree as CLAUDE.md says, meet every success-criteria box, then set `done (<commit>)`.
- [00-research.md](00-research.md) collects external prior art (VS Code, Ghostty, Electron docs, …) that the proposals cite.
- The code has moved since `ddb7832` (the window migration of docs/40, among others). Check `path:line` references against master before editing; the problem a reference points at is usually still there under a nearby line.
- Pick from "Course corrections" below first, then from a doc's own Course corrections, then by severity.

## Scores

| # | System | Overall | Structure | Correctness | Perf | Security | Tests | Extensib. | Health | Issues (crit/high) |
|---|---|---|---|---|---|---|---|---|---|---|
| 01 | [Process model and lifecycle](01-process-model-and-lifecycle.md) | **7** | 5 | 7 | 7 | n/a | 6 | 7 | 7 | 10 (0/0) |
| 02 | [Protocol, RPC and clients](02-protocol-rpc-and-clients.md) | **5** | 6 | 4 | 6 | n/a | 4 | 5 | 7 | 10 (0/3) |
| 03 | [Core composition and services](03-core-composition-and-services.md) | **5** | 4 | 7 | 8 | 6 | 6 | 5 | 5 | 10 (0/2) |
| 04 | [Terminals and PTYs](04-terminals-and-ptys.md) | **6** | 7 | 5 | 6 | 7 | 6 | 6 | 7 | 9 (0/2) |
| 05 | [Agents: detection, hooks, activity](05-agents-detection-hooks-and-activity.md) | **5** | 5 | 6 | 7 | 6 | 7 | 4 | 6 | 10 (0/3) |
| 06 | [Data: event log, views, search](06-data-event-log-views-and-search.md) | **6** | 6 | 5 | 6 | 5 | 6 | 6 | 6 | 12 (0/5) |
| 07 | [Windows, workspaces, layout](07-windows-workspaces-and-layout.md) | **6** | 6 | 6 | 7 | 7 | 5 | 5 | 6 | 8 (0/1) |
| 08 | [Renderer state and app shell](08-renderer-state-and-app-shell.md) | **5** | 4 | 5 | 6 | n/a | 5 | 5 | 6 | 12 (0/2) |
| 09 | [Electron main, IPC, security](09-electron-main-ipc-and-security.md) | **5** | 5 | 7 | 7 | 4 | 4 | 5 | 6 | 9 (0/4) |
| 10 | [UI kit, tokens, styling](10-ui-kit-tokens-and-styling.md) | **7** | 7 | 5 | 8 | n/a | 4 | 7 | 8 | 10 (0/1) |
| 11 | [Magic widgets, sandbox, AI](11-magic-widgets-sandbox-and-ai.md) | **4** | 6 | 7 | 6 | 3 | 6 | 6 | 6 | 11 (1/4) |
| 12 | [Remote access, relay, web client](12-remote-access-relay-and-web.md) | **4** | 7 | 5 | 6 | 3 | 6 | 6 | 8 | 12 (1/2) |
| 13 | [Testing, quality gates, CI](13-testing-quality-gates-and-ci.md) | **5** | 5 | 5 | 8 | 5 | 5 | 6 | 6 | 9 (0/2) |
| 14 | [Build, packaging, release](14-build-packaging-dependencies-and-release.md) | **6** | 7 | 5 | 6 | 6 | 7 | 6 | 7 | 10 (0/2) |
| 15 | [Settings, commands, keys, menus](15-settings-commands-keybindings-and-menus.md) | **6** | 6 | 4 | 8 | 7 | 6 | 5 | 7 | 9 (0/1) |
| 16 | [Feature services](16-feature-services-actions-journal-summaries-notifications.md) | **6** | 7 | 5 | 5 | 5 | 7 | 5 | 7 | 11 (0/3) |
| 17 | [Repo layout and project structure](17-repo-layout-and-project-structure.md) | **6** | 6 | n/a | n/a | n/a | 6 | 5 | 6 | 7 (0/0) |

The weakest dimensions across the board are **Security** in the systems that face untrusted input (Magic 3, remote 3, Electron main 4) and **Extensibility** (eight systems at 5 or below). Performance is mostly fine. The exceptions are the measured stalls in search and journal sync (themes 5 and 6).

## What to keep

These are the patterns the reviewers independently held up for the rest of the codebase to copy:

- **The core/host split.** The core owns state, and terminals outlive both the app and the core. Doc 01 scores the lifecycle 7, the best in the review.
- **The `Methods` map, typed against `Handlers`.** tsc finds a missing handler, and docs 02 and 03 build on it rather than replacing it.
- **Ratchet tests** (`design-css.test.ts`, `design-debt.json`, token staleness). They are the model for the fitness tests in docs 13 and 14.
- **The scheduler and `[lag]` watchdog** (docs/34). Several issues here exist only because they measured something.
- **The window type registry** (`windows/types.ts`) and the **transcript source registry** (`search/sources.ts`). Both are good registration shapes; theme 3 asks the remaining central lists to work the same way.
- **The command palette's keyboard handling**, the pattern doc 10 asks lists and menus to copy.

## Cross-cutting themes

Several reviewers found these independently from different directions. Each theme lists the issues that make it up.

### 1. One read policy for everything that isn't the person

Phones, widgets and model-written code each decide on their own what they may read, and the checks disagree.

- **Phones:** a "View only" phone can read the home folder, the host key included (**AR1-12-01**, critical). It can also `ATTACH` any SQLite file (**AR1-12-02**).
- **Widgets:** a widget's permissions come from a manifest the model writes (**AR1-11-01**, critical). Any widget can read the whole event log (**AR1-11-02**, **AR1-06-05**), and the sandbox leaves the network open (**AR1-11-03**).
- **Redaction:** secrets stored under a key name are not redacted (**AR1-06-04**).
- **Live events:** remote sessions get bootstrap and events unfiltered (**AR1-12-08**).
- **Electron:** the browser session has no permission policy, and `openExternal` has no allow-list (**AR1-09-01..03**).

The fix is shared: one policy module that maps a caller (person, device, widget, agent) to roots, event types and capabilities. Remote, Magic and the `data.*` handlers all ask that module. `magic/policy.ts`'s deny-list becomes one input to it, not the whole check.

### 2. Streams with positions and backpressure

- **Byte loss:** a window that attaches while a pane prints can lose bytes, because snapshot and stream have no shared offset (**AR1-04-01**, **AR1-02-02**).
- **Duplicate replies:** terminal queries are answered once per window (**AR1-04-03**).
- **No backpressure:** nothing pushes back on a fast producer. The local socket, the host's socket write and the relay all lack it (**AR1-02-01**, **AR1-12-07**).

Doc 04 shows that the offsets must come from the PTY host, because only it knows what a snapshot covers. The fix is one `HOST_PROTOCOL` bump carrying offsets and query replies, then `pty.pause()` on a socket watermark, then the same offset semantics in `pane.output`/`pane.snapshot` on the wire.

### 3. Features register themselves instead of editing central files

Every feature edits these files today:

- the large files `core.ts` (1,640 lines), `App.tsx` and `WindowsView.tsx` (1,177)
- `tracker.ts`, plus the agent tables spread over eleven places
- the append-only lists `SETTINGS_SCHEMA`, `layout.ts`, `COMMANDS` and the handler map
- the window types, which core and renderer match only by string

Adding Workspace Actions touched about 9 registries (**AR1-16-08**), and the SQLite viewer touched over 15 files (**AR1-07-03**). The issues: **AR1-03-01/02**, **AR1-08-02**, **AR1-15-02/03**, **AR1-07-01/03**, **AR1-05-02/05**, **AR1-09-08**, **AR1-16-08**.

The fix is one shape: a feature module that contributes handlers, commands, settings, window types and startup jobs through a typed context, with `core.ts` and `App.tsx` reduced to composition roots. This is also the dry run for the plugin SDK (**AR1-07-08**).

### 4. Persistent state without schema or migrations

- **Untyped JSON:** `window.state`, `workspace.view` and `ui_state` are opaque JSON read by string key. In the real store, 69 of 71 canvas rects belong to closed windows, and layout saves fail silently once the 256 KB cap is reached (**AR1-07-02**, **AR1-07-07**).
- **No migrations:** neither `events.sqlite` nor `cmd.sqlite` has one, and the promised payload upcasters don't exist (**AR1-06-03**, **AR1-03-05**).
- **Settings:** removed keys skip their migration (**AR1-15-04**).
- **Format versions:** the journal changed a format without bumping its version (**AR1-16-04**).
- **Untyped boundaries:** params and payloads cross untyped (**AR1-02-04**, **AR1-16-09**).

The fix is one migration runner per database, typed schemas validated in the core for every persisted JSON blob, and a locked list of shipped keys and event types.

### 5. Deletion doesn't reach derived data

`data.forget` and retention leave session entities, free file pages and open subscriptions behind (**AR1-06-07**). They also leave journal days, weeks and summary files (**AR1-16-02**). The memory feature (docs/29) would be the next store to miss it. Services need a "forget" hook they register with, and a test that forgets a session and finds it nowhere.

### 6. Work on the core thread that the scheduler doesn't cover

- **Journal sync:** median 577 ms, max 3.1 s, 524 `[lag]` lines in two days (**AR1-16-03**).
- **Search:** 0.3–0.6 s per keystroke warm and up to 5 s cold on the real log (**AR1-06-06**).
- **Other blocks:** the checkout snapshots per agent (**AR1-05-04**), screen serialization during bursts (**AR1-04-06**), and an unmarked last 2 s startup block (**AR1-03-07**).
- **Log growth:** the log grows about 50 MB a day, 7–8× the docs/28 estimate, which makes every full read slower each week (**AR1-06-08**).

### 7. One connection per app, not per window

Each window holds its own socket and its own full mirror:

- a full xterm for every pane in every workspace: about 0.8 GB per window at 30 panes (**AR1-04-02**)
- the whole core state: every 225 KB event fans out N times (**AR1-02-06**, **AR1-08-08**)
- its own notification decisions (**AR1-08-04**)
- four reconnect loops in main and five client implementations (**AR1-01-06**, **AR1-02-07**)

One client library and a utility process owning the socket, with MessagePorts per window, fixes all of these. It is also what lets the renderer finally run with `sandbox: true` (**AR1-09-07**).

### 8. Nothing enforces the rules the code follows

- **Package layering:** clean today, by convention only (**AR1-14-07**, **AR1-13-02**).
- **File size:** no limit, and 18 files are over 600 lines.
- **Lint:** no linter outside one corner, and 175 empty `catch` blocks (**AR1-13-06**, **AR1-08-07**).
- **e2e:** the smoke test has never run on the mac CI job, although the docs say it does (**AR1-13-01**).
- **Silent skips:** 23 widget tests skip silently in CI (**AR1-13-04**).
- **Toolchain:** dev, CI and the shipped app run three different Node versions (**AR1-14-01**).

Without count-only-goes-down fitness tests, the splits in theme 3 will grow back.

### 9. Version skew is detected by probing

The app restarts a mismatched core, but neither the RPC hello nor the host handshake carries a protocol number or capabilities (**AR1-01-07**, **AR1-02-03**). This matters once the web client, a second CLI generation or plugins talk to a core of another version.

## Course corrections

This is the recommended order. Each wave can run in parallel worktrees; within a wave, the listed order is the order of value.

### Wave 0: stop the leaks and the data loss (each issue under ½ day, unless marked M)

| Issue | What |
|---|---|
| AR1-12-01 | ~~Home is not a remote root; deny cmd's own dirs~~ done |
| AR1-12-02 | ~~Block `ATTACH` in remote SQLite~~ done |
| AR1-15-01 | ~~Never write settings.json from a failed parse~~ done |
| AR1-06-04 | ~~Key-aware secret redaction~~ done |
| AR1-11-11 | ~~Magic's tools can't read cmd's secrets (follow-up to AR1-12-01)~~ done |
| AR1-06-05 | ~~Widget data policy (interim, before theme 1 lands)~~ done |
| AR1-11-04 | Pin, verify and ask before installing Deno |
| AR1-09-01, AR1-09-02 | Browser permission policy; navigation guards on app windows |
| AR1-08-01 | ~~Error boundaries, so one view can't blank a window~~ done |
| AR1-14-02 | A tag build without signing fails instead of publishing |
| AR1-14-01 | One Node major for dev, CI and release |
| AR1-05-01 | ~~Another agent kind's hooks stay out of the pane's agent~~ done |
| AR1-10-01 | Dialogs trap focus |
| AR1-04-04, AR1-04-05 | ~~Spurious bell on long OSC; zsh OSC 7 encoding~~ done |
| AR1-16-01 (M) | Stop rewriting past journal days with the expensive tier |

### Wave 1: the capability model and the gates

1. **Theme 1.** AR1-11-01 → AR1-11-02 → AR1-11-03, AR1-09-03, AR1-12-08, then AR1-12-03 (separate web client hosting). One policy module, one review of it.
2. **Theme 8 gates.** AR1-13-01 (smoke e2e on mac CI), AR1-13-04 (no flakes, no silent skips), AR1-13-02 (fitness ratchets for imports, file sizes, registries; land these *before* wave 3 so the splits stick).
3. **Theme 6 stalls.** Profile and fix AR1-16-03 and AR1-06-06; then AR1-06-01 (`seq` reuse), which the view cursor in wave 3 needs.

### Wave 2: streams with positions

AR1-04-01 + AR1-04-03 in one `HOST_PROTOCOL` bump → AR1-02-02 (offsets on the wire) → AR1-02-01 (flow control and frame limit) → AR1-12-07. With them, AR1-02-03 + AR1-01-07: version both handshakes while the protocol is open anyway.

### Wave 3: features register themselves

1. Core: AR1-03-02 (typed `CoreContext`) → AR1-03-01 (split `Core`) → AR1-03-03, AR1-03-04.
2. Renderer: AR1-08-05 + AR1-08-03 (pure store, selectors) → AR1-08-02 (split `App.tsx`) with AR1-15-02/03 (commands with `when`, contributed by features).
3. AR1-07-01 (split `WindowsView`), AR1-05-02 + AR1-05-06 (split the tracker, one reducer), AR1-09-08.
4. AR1-16-08 as the first feature declared as one contribution, then AR1-07-03 and AR1-07-08 (window type SDK).
5. Folder moves alongside (doc 17): the layout ratchet AR1-17-01 in wave 1 with the other fitness tests, then rename-only moves AR1-17-02..04, then AR1-17-05 (one folder per feature per side, journal first).

### Wave 4: one connection, schemas, a smaller runtime

- Theme 7: AR1-02-07 → AR1-02-06 → AR1-09-07 (sandboxed renderer), with AR1-04-02 (renderer terminals as a cache) and AR1-08-08.
- Theme 4: AR1-06-03 + AR1-03-05 (migration runners), AR1-07-02, AR1-15-04, then AR1-06-02 (views on a log cursor).
- Theme 5: one forget hook (AR1-06-07, AR1-16-02).
- Build: AR1-14-04 → AR1-14-03 with AR1-01-02 (bundle the runtime: about 15 files instead of 3,063).

## Quick wins

These are the remaining issues of size S (under ½ day), a good first pick for a free agent. Check its **Depends on** line first. Wave 0 above is the urgent subset.

AR1-01-05, AR1-01-08, AR1-01-09, AR1-03-06, AR1-03-09, AR1-03-10, AR1-04-07, AR1-04-09, AR1-05-07, AR1-05-08, AR1-05-09, AR1-05-10, AR1-06-09, AR1-06-10, AR1-06-11, AR1-08-06, AR1-08-09, AR1-08-10, AR1-08-11, AR1-09-09, AR1-10-03, AR1-10-06, AR1-10-07, AR1-10-09, AR1-10-10, AR1-11-09, AR1-11-10, AR1-12-04, AR1-12-05, AR1-12-10, AR1-12-12, AR1-13-07, AR1-13-09, AR1-14-04, AR1-14-06, AR1-14-07, AR1-14-08, AR1-15-06, AR1-15-07, AR1-15-09, AR1-16-04, AR1-16-06, AR1-16-07, AR1-16-09, AR1-16-10, AR1-17-01, AR1-17-06, AR1-17-07, AR1-06-12, AR1-14-10, AR1-16-11.

## Process

- Research ([00-research.md](00-research.md)) ran on Sonnet.
- Docs 01, 02, 03, 05, 08 and 09 were written in the first session; the other ten were rerun on Opus 5.5 after that session hit its usage limit.
- Each reviewer read its scope in full, measured, and wrote only its own doc; no source file was changed.
- Several issues were measured against copies of the release databases (deleted afterwards) or reproduced in a scratch script. A few are marked in their doc as found by reading only, with the check they still need (for example AR1-16-01).
