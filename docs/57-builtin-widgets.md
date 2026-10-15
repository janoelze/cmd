# Built-in widgets as packages

**Status:** proposal: a brief for porting cmd's native widgets to widget packages (docs/56) and shipping them as cmd's standard set. Agents, Recent Commands and Countdown are ported; the rest is the plan below.

Date: 2026-10-15. Read first: [56-widgets-v3.md](56-widgets-v3.md) (the package format, the API, "Built-ins and dogfooding", the decisions table, and the as-built notes of phases 1–4), [16-widgets.md](16-widgets.md) (the Widget Library), [40-window-design.md](40-window-design.md) and the `window-design` skill.

## The idea

cmd's own widgets are written the way anyone else's are: a package in `packages/widgets/<name>/`, on the public `@cmd/widget-api`, drawn by the kit as a tree. They ship inside the app. The built-ins are what proves the API: if Event Stream can't be written on it, no one's widget can either, and that's a gap in the API, not a reason for a side door.

## How the standard set ships

All of this is already built (phases 1 and 4). A port adds a folder; it touches none of these mechanics.

- **Tracked in this repository, as packages.** Each built-in is `packages/widgets/<name>/`: `package.json` with its `cmd` block, `src/`, tests, a story, README and LICENSE (AGPL, as the repo). `"private": true`: nothing is published to npm.
- **Shipped inside the app.** `scripts/stage-runtime.mjs` copies every `packages/widgets/<name>` (package.json, src, README, LICENSE; no node_modules) into the staged runtime; the core reads it as a second root beside `~/.cmd/widgets` (`widgets/packages.ts`, `builtinWidgets()`, `CMD_BUILTIN_WIDGETS` overrides it in tests). A release ships the set that's in the tree at its tag.
- **Listed as Built-in, granted what they declare.** The Library shows them under Built-in. They run under their declared permissions without a grants sheet (cmd ships them, which the person already trusts), and their acts follow the approval levels like cmd's own callers do.
- **Versioned with cmd.** A built-in's `version` moves when its behaviour changes, but it is released only as part of a cmd release; `engines.cmd` is the cmd it was written for. There is no separate update path.
- **The person's copy wins.** A package in `~/.cmd/widgets` with the same name replaces the built-in (the core logs it). That's how someone forks one: copy the folder, link it, change it.
- **Later, maybe in the index too.** docs/56's open question (publish built-ins under a `cmd` publisher so the index's CI runs on them) stays open until distribution exists. Nothing here depends on it.

The answer to "do we track them just in this codebase as widget packages?" is yes. One folder per widget in `packages/widgets/`, tested by `pnpm test`, staged by the release, and nothing elsewhere.

## Rules for every port

1. **The public API only.** A built-in imports `@cmd/widget-api` and nothing else from cmd: no `@cmd/protocol`, no renderer store, no RPC methods outside the API. `test/imports.test.ts` should hold this for `packages/widgets/*` (add the rule if it isn't there).
2. **A missing verb is an API change, proposed first.** API 1 is frozen at 1.1. A verb a port needs goes into a proposed **API 1.2** list in this doc (name, signature, permission, access row, why), not into code. Ports that need none go first (wave 1); the 1.2 list is decided by Jan before anyone builds it.
3. **Judged by its own scenarios, not by matching the native view row for row** (docs/56). Write down what the widget is for, test that, and list what it does differently in the package's README and in this doc.
4. **The native view stays beside it** until the package has been used on the board for a while (docs/56's decisions, as for Agent Activity). Deleting native views is its own step, after Jan's word, listed per widget below.
5. **Each port is complete:** `cmd widget check` passes, tests with `@cmd/widget-api/testing` cover its states (empty, loading, error, data, many rows), a story per state renders in the Workbench in every theme, `cmd widget preview` exits 0 at every size, an e2e scenario adds it from the Library and sees it draw live data, and it uses only the 30 API elements.
6. CLAUDE.md's rules hold: worktree per task, `pnpm typecheck && pnpm test && pnpm e2e` before handing back, `copywriting` for every string, `window-design` for the view.

## The inventory

Sixteen native window types have `role: "widget"`. Lines are the renderer's view folder without stories.

| Widget | Kind | Lines | What it reads or does | Plan |
|---|---|---|---|---|
| Agent Activity | `agents` | 167 | agents, mark seen | **done** (`packages/widgets/agents`); native stays |
| Commands | `commands` | 144 | command events, Run Again | **done** (`commands`, "Recent Commands"); native stays |
| Timer | `timer` | 123 | a countdown, rings | **done** (`timer`, "Countdown"); native stays |
| Event Stream | `events` | 240 | `events.query`, live events; `data.explain` | **wave 1**; "explain" is left out or waits for 1.2 |
| Workspace Actions | `actions` | 522 | `actions.list`, `actions.run`; pin, stop, settings | **wave 1** for list and run; pin and stop wait for 1.2 |
| Stats | `stats` | 324 | `stats.query`, `stats.queryMany` | **wave 2**: `events.stats` covers part; the rest needs a `stats` verb |
| Journal | `journal` | 307 | `journal.day/days/week` | **wave 2**: needs `journal.*` read verbs |
| Notifications | `notifications` | 138 | the notification list, clear | **wave 2**: needs `notify.list` and `notify.clear` |
| Resources | `resources` | 218 | `core.processes`, panes' CPU and memory | **wave 2**: needs a `terminals.resources` read verb |
| Now Playing | `nowplaying` | 93 | `nowPlaying.get/control` | **wave 2**: needs `media.get` and a `media.control` act |
| Navigator | `navigator` | 335 | `search.query` (transcripts) | **wave 2**: needs a `search.query` read verb; check first that it is a widget and not a window |
| Visualizer | `visualizer` | 162 | a frame with presets | **wave 3**: a frame package, if the frame `cmd` (state, theme, open) is enough |
| YouTube | `youtube` | 175 | an embedded player, the window's state | **wave 3**: a frame package with `net` to YouTube's hosts, if its embed works in the frame's CSP; else stays native |
| Jam | `jam` | 476 | files, `jam.change`, windows | **stays native for now**: it writes files and has its own core feature |
| Operator | `operator` | 433 | the Operator's agent, approvals | **stays native**: it is part of cmd, not a widget anyone would write |
| Diff | `diff` | 1047 | git, fs watches | **stays native**: a tool window; reconsider its `role` |

## Wave 1: no new verbs

Port **Event Stream** and **Workspace Actions** as `packages/widgets/events` and `packages/widgets/actions`.

- **Event Stream**: the event log of this workspace, live (`useEvents`), filterable by class with the toolbar, each row's details on select. `events` permission for the classes it shows. "Explain this event" uses an AI call today: leave it out, or rebuild it on `cmd.ai.complete` if the event's text is enough (`ai: ["complete"]` in its manifest), and say which.
- **Workspace Actions**: the workspace's actions (`useActions`), Run on a row (`cmd.actions.run`, which asks or follows the levels as a built-in), the running state from events. Pin, Stop and its settings link are what the API lacks: list them under 1.2, and show the package without them.

Acceptance, per widget: the rules above, plus a line in this doc's table saying it's done and what differs.

## Wave 2: API 1.2, proposed then built

The port agent writes the 1.2 proposal into this doc first, one row per verb:

| Verb | Signature | Mode | Permission | For |
|---|---|---|---|---|
| … | | read / act / confirm | | |

Candidates from the inventory: `notify.list`, `notify.clear`, `journal.day/days/week`, `stats.query`, `terminals.resources`, `media.get`, `media.control`, `search.query`, `actions.pin`, `actions.stop`. Each has to pass docs/56's bar: it is in product words, it is scoped to the widget's workspace, it has an access row and a remote row, it doesn't expose a private path or a secret, and a widget other than the built-in would plausibly want it. A verb only one built-in will ever use is a sign that widget should stay native.

After Jan approves the list: build 1.2 (`@since 1.2` in the d.ts, `cmd.env.has`, the minor reported by the core, a 1.1 package unchanged, the reference regenerated), then port the wave 2 widgets on it.

## Wave 3: frames

The Visualizer and YouTube as `"surface": "frame"` packages on the one frame host (docs/56, phase 2b). Port one only if it keeps its job with the frame's `cmd` (state, config, theme, open after a press); otherwise record why it stays native.

## After the ports: retiring native views

For each ported widget, separately and only on Jan's word: delete its native view (renderer folder, core `WindowType`, its commands and settings), move open windows of the old kind to the package's `pkg:<name>/<id>` kind with their state (a startup job, as phase 2b did for old widgets), and update the e2e scenarios. The list of retired kinds goes here.

## Brief for the agent doing the port

- **Start:** `git -C ~/src/cmd worktree add ~/src/cmd-builtin-<wave> -b builtin-<wave> master`, `pnpm install`, `export CMD_HOME=$PWD/.cmd-dev CMD_WIDGETS_HOME=$PWD/.cmd-dev/widgets`.
- **Learn the shape from the three done:** `packages/widgets/agents`, `commands` and `timer` are the reference for folder layout, tests, stories and README. `cmd widget new` gives the same shape.
- **Do wave 1 completely.** Then write the 1.2 proposal and stop: report the proposal, don't build it.
- **Report:** the branch's commits, each widget with its evidence (test names, `cmd widget check` and `preview` output, the e2e scenario, a screenshot per theme pair), what each does differently from the native one, and the 1.2 proposal.
- **Don't:** delete a native view, add a verb or element, import anything from cmd but `@cmd/widget-api`, merge, push or release.
