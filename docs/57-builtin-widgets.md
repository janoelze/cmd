# Built-in widgets as packages

**Status:** partly built: a brief for porting cmd's native widgets to widget packages (docs/56) and shipping them as cmd's standard set. Agents, Recent Commands and Countdown are ported; API 1.2's elements are built, and wave 1 (Event Log, Run Scripts) is ported on them; API 1.2's verbs were decided by Jan (2026-10-15) and are built, and wave 1 uses them; wave 2 is ported; wave 3 (frames) was tried and both stay native, each with a 1.3 candidate. A parity audit (2026-10-15) compared each port with its native view and proposes API 1.3 to close the gaps, with a build plan in parallel branches.

Date: 2026-10-15. Read first: [56-widgets-v3.md](56-widgets-v3.md) (the package format, the API, "Built-ins and dogfooding", the decisions table, and the as-built notes of phases 1–4), [16-widgets.md](16-widgets.md) (the Widget Library), [40-window-design.md](40-window-design.md) and the `window-design` skill.

## The idea

cmd's own widgets are written the way anyone else's are: a package in `packages/widgets/<name>/`, on the public `@cmd/widget-api`, drawn by the kit as a tree. They ship inside the app. The built-ins are what proves the API: if Event Stream can't be written on it, no one's widget can either, and that's a gap in the API, not a reason for a side door.

## How the standard set ships

All of this is already built (phases 1 and 4). A port adds a folder; it touches none of these mechanics.

- **Tracked in this repository, as packages.** Each built-in is `packages/widgets/<name>/`: `package.json` with its `cmd` block, `src/`, tests, a story, README and LICENSE (AGPL, as the repo). `"private": true`: nothing is published to npm.
- **Shipped inside the app.** `scripts/stage-runtime.mjs` copies every `packages/widgets/<name>` (what its package.json's `files` lists, plus package.json, README and LICENSE; never node_modules or a dot-folder; `scripts/stage-widgets.mjs` fails the staging on a listed file that is missing, or a `main` or a frame widget's view.html left out) into the staged runtime; the core reads it as a second root beside `~/.cmd/widgets` (`widgets/packages.ts`, `builtinWidgets()`, `CMD_BUILTIN_WIDGETS` overrides it in tests). A release ships the set that's in the tree at its tag.
- **Listed as Built-in, granted what they declare.** The Library shows them under Built-in. They run under their declared permissions without a grants sheet (cmd ships them, which the person already trusts), and their acts follow the approval levels like cmd's own callers do.
- **Versioned with cmd.** A built-in's `version` moves when its behaviour changes, but it is released only as part of a cmd release; `engines.cmd` is the cmd it was written for. There is no separate update path.
- **The person's copy wins.** A package in `~/.cmd/widgets` with the same name replaces the built-in (the core logs it). That's how someone forks one: copy the folder, link it, change it.
- **Later, maybe in the index too.** docs/56's open question (publish built-ins under a `cmd` publisher so the index's CI runs on them) stays open until distribution exists. Nothing here depends on it.

The answer to "do we track them just in this codebase as widget packages?" is yes. One folder per widget in `packages/widgets/`, tested by `pnpm test`, staged by the release, and nothing elsewhere.

## Rules for every port

1. **The public API only.** A built-in imports `@cmd/widget-api` and nothing else from cmd: no `@cmd/protocol`, no renderer store, no RPC methods outside the API. `test/imports.test.ts` should hold this for `packages/widgets/*` (add the rule if it isn't there).
2. **A missing verb is an API change, proposed first.** API 1 is frozen at 1.1. A verb a port needs goes into a proposed **API 1.2** list in this doc (name, signature, permission, access row, why), not into code; the 1.2 verb list is decided by Jan before anyone builds it. Elements are different: the set the ports need is decided below ("Elements for the ports") and built first, as API 1.2's elements.
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
| Event Stream | `events` | 240 | `events.query`, live events; `data.explain` | **done** (`events`, "Event Log"); native stays. No AI explain existed to rebuild (`data.explain` is the class list, now `events.classes`); on 1.2: the log's text, its classes, Copy |
| Workspace Actions | `actions` | 522 | `actions.list`, `actions.run`; pin, stop, settings | **done** (`actions`, "Run Scripts"); native stays. On 1.2: Stop, Restart, run state, kinds and the address from cmd, Copy Command; no Pin (not a verb), no settings link |
| Stats | `stats` | 324 | `stats.query`, `stats.queryMany` | **done** (`stats`, "Usage Stats"); native stays. One `stats.query` per pane; This Workspace by default, All Workspaces adds active time, projects and cmd's model calls; no "cmd" pane (core memory, stalls: the `system` class), no quantiles, counts again after a recorded command or turn (no stats topic) |
| Journal | `journal` | 307 | `journal.day/days/week` | **done** (`journal`, "Work Log"); native stays. Read only on `journal.days`: the written days, no Write Again, week, All Workspaces or project chips; looks again every 5 min |
| Notifications | `notifications` | 138 | the notification list, clear | **done** (`notifications`, "Notification Log"); native stays. On `useEvents({ types: ["notification"] })`, Clear its own "cleared at"; only notifications about a workspace; a click goes to a terminal, not to a window |
| Resources | `resources` | 218 | `core.processes`, panes' CPU and memory | **done** (`resources`, "Terminal Usage"); native stays. On `useTerminalUsage` and `DataGrid`; its "cmd" pane (`core.processes`) and the Task Manager link stay native; other workspaces' terminals show their folder, not the workspace's name |
| Now Playing | `nowplaying` | 93 | `nowPlaying.get/control` | **done** (`nowplaying`, "Media Controls"); native stays. On `media.get` every 2 s and `media.control` per press; no cover (no picture element), one layout at every size |
| Navigator | `navigator` | 335 | `search.query` (transcripts) | **stays native**: decided, no `search.query`; it is the board's sidebar for sessions, a window |
| Visualizer | `visualizer` | 162 | a frame with presets | **stays native for now** (wave 3): a frame page can draw the presets (WebGL2, a running `AudioContext`, a library from its package) but hears nothing: no microphone, no system audio, no Jam window's sound. Needs an audio-levels feed (1.3 candidate) |
| YouTube | `youtube` | 175 | an embedded player, the window's state | **stays native for now** (wave 3): the frame's `frame-src 'none'` blocks the embed, and a watch page is no media file; a frame can show the thumbnail and title, not play. Needs a player element the app draws (1.3 candidate) |
| Jam | `jam` | 476 | files, `jam.change`, windows | **stays native for now**: it writes files and has its own core feature |
| Operator | `operator` | 433 | the Operator's agent, approvals | **stays native**: it is part of cmd, not a widget anyone would write |
| Diff | `diff` | 1047 | git, fs watches | **stays native**: a tool window; reconsider its `role` |

## Elements for the ports

The ports should draw with the same kit pieces as the native views, so a ported widget looks like the one it replaces. API 1.1 has 30 elements; the native widgets import about 30 more. Since the element spec is the one place an element is written (`packages/protocol/src/widget-elements.ts`, with `elements.ts` generated and the renderer's pass-through checked against the kit), adding one is a spec row and a story, and a renderer override only when it has behaviour of its own. Decided 2026-10-15: API 1.2 adds the window-content kit the built-ins use, not the whole kit.

| Group | Elements (API 1.2) | Used by | Notes |
|---|---|---|---|
| Layout | `Panes`, `Pane`, `Panel`, `PanelBody`, `ListGroup` | Stats, Resources, Event Stream, Notifications, Workspace Actions | pass-through |
| Lists | `ListRowActions`, `ListValue` | Workspace Actions, Event Stream, Notifications | `ListRowActions` holds Buttons shown on hover |
| Content | `CodeBlock`, `Icon`, `Mark`, `Delta`, `Spinner`, `StatusLine` | most | `StatusLine` is the view's footer line; `Icon` takes SF Symbol names only |
| Controls | `IconButton`, `LinkButton`, `TextField` | Workspace Actions, Journal, Now Playing | `TextField` gets the same local caret and debounced `onChange` as `ToolbarField` (an override) |
| Charts | `TimeSeries`, `TimeBars`, `TimeBar`, `Ranking`, `Proportion`, `PunchCard`, `Calendar`, `Timeline`, `TimelineEntry`, `Ribbon` | Stats, Journal, Now Playing | data props only; values are numbers and strings, never functions |
| Data | `DataGrid` | Resources | the largest: columns, sort and selection as props, rows as data; one override; virtualised rows if the kit's grid is |

Not elements, on purpose:

- **Overlays** (`Dialog`, `ConfirmDialog`, `Popover`, `Menu`, sheets): a widget asks the person through the API (an act's approval sheet), and menus are element props (`menu` on `ListRow`, `ToolbarMenu`). Workspace Actions' "Stop?" confirmation becomes the act's sheet.
- **App chrome** (`WindowFrame`, the approval and chat components, settings pages, `FindBar`): the app's own, not a widget's.
- **`Stage`** (Visualizer, YouTube): that is the frame surface (wave 3), not an element.

Each new element: its spec row with docs and `since: "1.2"`, its story in every theme, its kit assignability check, the generated reference, and a line in Magic's prompt only if Magic should reach for it (charts yes, `DataGrid` yes, `StatusLine` yes). `cmd.env.has()` answers for elements as for verbs, so a 1.2 widget can tell an older cmd.

**As built (2026-10-15).** The 27 elements are protocol `widget-elements-1.2.ts` (`since: "1.2"`), merged into `API_ELEMENTS` by `widget-elements.ts`; the vocabulary they share moved to `widget-spec.ts`. `WIDGET_API_MINOR` is 2; `ready.env.elements` lists what this cmd draws and `cmd.env.has("DataGrid")` reads it (a cmd before 1.2 sends none, so `has` answers by its minor from the generated `elements-since.gen.ts`); a 1.0 and a 1.1 process run unchanged (`widget-act.test.ts`: "serves a process built for 1.1 unchanged, and tells it the elements this cmd draws"). New prop types, because charts and tables take data the 1.0 types couldn't say: records (`ApiShape`: a list of named fields, or one, named in the d.ts as `ChartSeries`, `RankingRow`, `ProportionPart`, `RibbonItem`, `RibbonTick`, `GridColumn`, `GridRow`, `GridSort`), `strings`, `matrix`, `cells`; the sanitiser checks each field and leaves out fields the spec doesn't name. A `pick` gesture carries a value (a row's key, a bucket's index, a bar's id, a time; the testing tree's `pick(node, value, event?)`), and an event says when it is `typing` (ToolbarField, ToolbarSearchField and TextField's `onChange`: not a press, so no act after it; the core reads it from the spec instead of a list of names). Charts take a `unit` (protocol format.ts's, as the Stats window formats) and labels as strings, never a function. `elements.ts` is now `elements.gen.ts` (generated, so not counted against the 600-line rule), and the reference lists the records under "Records". Then `Frame` (docs/56, the Frame element) joined 1.2 with the `value` prop type and the `message` gesture.

| Element | Drawn by | Why |
|---|---|---|
| `Panes`, `Pane`, `Panel`, `PanelBody`, `ListGroup`, `ListRowActions`, `ListValue`, `CodeBlock`, `Icon`, `Mark`, `Delta`, `Spinner`, `IconButton`, `LinkButton`, `Timeline`, `TimelineEntry`, `Ribbon`, `TimeBar` | pass-through (`KIT`, checked against the kit's props) | the kit takes plain data; a pick event passes its value through (`Ribbon onPick`, `TimeBar onSeek`). `ListRowActions` needed no override: the kit's already stops a press on its buttons from pressing the row |
| `StatusLine` | override | its `action` is data, drawn as a dim `LinkButton` at its end; a `View` puts it in its footer |
| `TextField` | override | the caret and draft stay in the renderer, the value goes debounced (`useDraft`, as `ToolbarField`) |
| `TimeSeries`, `TimeBars`, `Ranking`, `Proportion`, `PunchCard`, `Calendar` | override | the kit takes `format`, `xLabel`, `dayLabel` functions: the API's `unit` and string labels become them |
| `DataGrid` | override | columns, rows, sort and selection are data (a row by its key); an icon column's cell is a `Mark` with the row's `light`; rows aren't virtualised (the kit's grid isn't), and rows have no context menu in 1.2 |

## Wave 1: no new verbs

Port **Event Stream** and **Workspace Actions** as `packages/widgets/events` and `packages/widgets/actions`.

- **Event Stream**: the event log of this workspace, live (`useEvents`), filterable by class with the toolbar, each row's details on select. `events` permission for the classes it shows. "Explain this event" uses an AI call today: leave it out, or rebuild it on `cmd.ai.complete` if the event's text is enough (`ai: ["complete"]` in its manifest), and say which.
- **Workspace Actions**: the workspace's actions (`useActions`), Run on a row (`cmd.actions.run`, which asks or follows the levels as a built-in), the running state from events. Pin, Stop and its settings link are what the API lacks: list them under 1.2, and show the package without them.

Acceptance, per widget: the rules above, plus a line in this doc's table saying it's done and what differs.

**As built (2026-10-15).** Both are packages titled apart from the native views, as the earlier ports are: **Event Log** (`packages/widgets/events`) and **Run Scripts** (`packages/widgets/actions`). Each has tests for its states (`events.test.tsx`, 10; `actions.test.tsx`, 7), a story per state (Busy, Paused, Hidden, AllHidden, Narrow, Many, Empty; Scripts, Running, Many, Narrow, Empty, NoFolder), `cmd widget check` and `cmd widget preview --themes all --sizes all` exiting 0 (522 shots each), and an e2e scenario that adds it from the Widget Library: `widget-events` (a command typed in its workspace shows as recorded, the filter, an event opened whole; `.cmd-dev/shots/widget-events*.png`) and `widget-actions` (a folder's scripts, the risky one apart, Run, the row from running to done; `.cmd-dev/shots/widget-actions*.png`). What each does differently is in its README:

- **Event Log.** "Explain this event" isn't in the native view: its `data.explain` call reads the log's classes (their titles and types) for the class menu and chips. So there is nothing to rebuild on `cmd.ai.complete`; the package filters by the *kinds* of type it has seen (`agent`, `command`, `git`) instead of the classes, and `events.classes` is proposed below. It reads its workspace's events, or every workspace's from the title menu, never those of no workspace; a row's title is the event's type (the log's one-line text isn't in `ApiEvent`); Pause holds by time, so it holds across a reload; no Copy Event or Copy ID.
- **Run Scripts.** List and Run only: no Pin, Stop or Restart (`actions.pin`, `actions.stop` below), so no "Stop?" confirmation either (it becomes Stop's own sheet); risky actions are listed but not run (cmd refuses them from widgets). `ApiAction` is a name, a description and `risky`, so no sections by kind, no history or suggestions, no dev server address or "in <branch>", no Copy Command or Open <file>; the first action that isn't risky is the main one. The run state follows the terminal a run from this window went to (its command events, kept in the window's state), so a server started elsewhere doesn't show as running. No Settings link.

## Wave 2: API 1.2, proposed then built

The port agent writes the 1.2 proposal into this doc first, one row per verb:

**Decided by Jan (2026-10-15), and built the same day; the table keeps the proposal's reasoning.** Approved: `actions.stop`, `events.classes`, `terminals.usage`, `stats.query`, the journal's read, `media.get`/`media.control`, `clipboard.write`, and the data additions. Not approved: `actions.pin`, `notify.clear`, `notify.list` (never proposed as a verb: the list is `useEvents`) and `search.query`. Each row against the bar below: product words, the widget's workspace, an access row (its `API` row: mode and permission) and a remote row (`remote/policy.ts`: a paired device), no private path or secret, and a widget other than the built-in would plausibly want it. "Remote" says what a press from a paired device does: reads never cross (the device gets the tree); acts confirm on the Mac for control scope, and nothing for view scope, as 1.1's do.

| Verb | Signature | Mode | Permission | Remote | For | Against the bar | Decided |
|---|---|---|---|---|---|---|---|
| `actions.stop` | `stop(name): null` | confirm, ask `stop` | `act: ["actions"]` | confirm on the Mac | Run Scripts' Stop on a running action (and Restart: stop, then run) | passes: product words, the workspace's own actions, a CI or dev-server widget would want it. Its sheet replaces the native "Stop?" dialog | built |
| `actions.pin` | `pin(name, pinned): null` | act, right after a press | `workspace: ["read"]` | control scope only, no sheet | Pin to Top | weak: it changes cmd's ranking for the folder, which only an actions list shows. Recommend: leave out, keep Pin in the native view | **no**: Pin stays in the native view |
| `events.classes` | `classes(): { class, title, types }[]` | read | none (it says what exists, not what happened) | n/a | Event Log's class menu and chips, as `data.explain` gives the native view; a widget can then say which class a refused query needs | passes: product words (the log's classes, as Settings names them), no data, useful to any log viewer | built |
| `terminals.usage` | `usage({ scope }): { id, cpu, memory, processes, top }[]` | read, live as a topic | `workspace: ["read"]` (`"all"` for every workspace) | n/a | Resources' table and stats | passes: the workspace's own terminals; a "what's busy" widget would want it. cmd's own processes (`core.processes`: app, background) are left out: only a built-in wants them, so that part of Resources stays native | built, live as `useTerminalUsage` |
| `stats.query` | `query({ stat, range, grain, by, compare }): StatResult` | read | `events: [<class>]` for the classes the stat reads (`readsClass`); the workspace forced as a filter | n/a | Stats' charts | passes, with care: the stats are product words (Agent time, Commands, Tokens); scoped like `events.stats`; Stats' cross-workspace and AI-cost panes need `workspace: ["all"]` and `events: ["ai"]` | built |
| `journal.days` / `journal.day` / `journal.week` | `days({ count }) / day(date) / week(date): JournalDay[] / JournalDay \| null / JournalWeek \| null` | read; never writes (no AI run from a widget) | `workspace: ["read"]` and `events: ["agents"]` (a day is written from agents' prompts and work) | n/a | Journal | passes if the days read are this workspace's only; one verb with a `range` may be enough | built as one verb, `journal.days({ count })` |
| `notify.clear` | `clear(): null` | act, right after a press | none | control scope only | Notifications' Clear | fails the workspace bar: it clears every workspace's list. Recommend: a widget keeps its own "cleared at" in `useStoredState`, as Event Log does; no verb. The list needs none either: `useEvents({ types: ["notification"] })` reads a workspace's notifications already (notes need no class); the native Clear (`notification.clear`) is recorded with no workspace, so a widget never sees it, which is one more reason for its own | **no**: a widget keeps its own "cleared at" |
| `media.get` / `media.control` | `get(): NowPlaying \| null` / `control(command, { seek }): null` | read / act, right after a press | a new `media: ["read", "control"]` | control scope only | Now Playing | passes for other widgets (a lyrics or a focus widget), but isn't workspace data: it needs a permission of its own and a grants line ("See and control what's playing") | built |
| `search.query` | `query(text, { limit }): { session, title, snippet, at }[]` | read | `events: ["transcripts"]`, the workspace's sessions | n/a | Navigator | doubtful: Navigator is the board's sidebar for opening and resuming sessions, a window, not a widget. Recommend: Navigator stays native; no verb | **no**: Navigator stays native |
| `clipboard.write` | `write(text): null` | act, right after a press | none (as `notify.send`) | never for a device | Copy Event, Copy Command, Copy ID in both natives | passes: every list widget wants Copy; one write per press, text only, clipped | built |

Not verbs, but what the ports found missing from the API's data (additions within API 1, as 1.1 added `key`, `until` and `terminalId` to events):

- **`ApiEvent.text`**: the log's one-line text for an event, so a log viewer's row reads like the native one.
- **`ApiAction`**: `command`, `kind` (dev, test, build…), `package`, `pinned`, `primary`, and its run (`running`, `terminalId`, `url`, `exitCode`), so an actions widget can group, show the address and know a run it didn't start. With these, Run Scripts' run state would come from cmd, not from following a terminal.

Considered and left out: a way to open Settings (`windows.open("settings:…")`): a widget never opens the app's own windows; Run Scripts' "Set up AI" link stays in the native view.

Candidates from the inventory (each answered in the table above): `notify.list`, `notify.clear`, `journal.day/days/week`, `stats.query`, `terminals.resources`, `media.get`, `media.control`, `search.query`, `actions.pin`, `actions.stop`. Each has to pass docs/56's bar: it is in product words, it is scoped to the widget's workspace, it has an access row and a remote row, it doesn't expose a private path or a secret, and a widget other than the built-in would plausibly want it. A verb only one built-in will ever use is a sign that widget should stay native.

**As built (2026-10-15).** Each verb is a row of protocol `widget-verbs.ts` with `since: "1.2"`; their data is `widget-tree-1.2.ts` (`ApiEventClass`, `ApiTerminalUsage`, `ApiStatQuery`/`ApiStatResult`, `ApiJournalDay`, `ApiNowPlaying`), the core's reads are `widgets/api/reads.ts`, the clipboard `widgets/api/clipboard.ts`, `actions.stop` an act in `act.ts`. Two row fields are new: `class` (a read that needs `events: [<class>]` beside its `needs`: the journal's `"agents"`) and `local` (never for a paired device's press: `media.control`, `clipboard.write`), and a `media` permission (`media: ["read", "control"]`; the grants sheet says "See what's playing" or "See and control what's playing"). Per verb:

| Verb | Shape | Permission | Scope | Tests |
|---|---|---|---|---|
| `actions.stop(name)` | `null` | `act: ["actions"]` or `"actions.stop"`; asks under "stop", after a press | the workspace's actions; only a running one (else "isn't running"); the sheet names it and its command; marks its terminal | `widget-act.test.ts` (asked and done, ⌃C reaches the terminal) |
| `events.classes()` | `{ class, title, types }[]` | none | the classes a widget may name (`declarable("widget")`: every one but `remote`) | `widget-api-12.test.ts` |
| `terminals.usage({ scope })` | `{ id, workspaceId, cpu, memory, processes, top: { name, memory }[], at }[]`; live as the `terminalUsage` topic (`useTerminalUsage`) | `workspace: ["read"]` (`"all"` for every workspace's) | the workspace's running terminals with a sample; no pids, none of cmd's own processes | `widget-api-12.test.ts`, widget-api `testing.test.tsx` (the hook, live) |
| `stats.query(q)` | the Stats window's `StatQuery` minus `workspaceId`, plus `scope`; `ApiStatResult` without `kind`, `available`, `asOf` | `events: [<the stat's class>]`, by `readsClass` (a class anyone reads, like commands' lines, needs none) | the workspace forced (`workspaceId`: its workspace, else its folder's project); a filter can't name `workspace` or `project`; `by: "workspace"`, `scope: "all"` and a stat with neither dimension (model calls, cmd's memory) need `workspace: ["all"]`; a key that is a folder (`dir:/…`, a file's path) comes back as its label | `widget-api-12.test.ts` |
| `journal.days({ count })` | `{ date, headline, entries, writtenAt }[]`, newest first; an entry without its `repo` or threads | `workspace: ["read"]` and `events: ["agents"]` (the row's `class`) | `workspace:<id>` only; `write: "never"` (a widget never has a day written, which would run the person's model); at most 30 days, 10 reads a minute | `widget-api-12.test.ts` |
| `media.get()` | `ApiNowPlaying \| null` | `media: ["read"]` | the Mac's; the first read holds the Now Playing stream running until the widget stops (`holdNowPlaying`), waiting up to 1.5 s for its first word | `widget-api-12.test.ts` |
| `media.control(command, { seek })` | `null` | `media: ["control"]` | right after a press, one per press, never a paired device's (`local`) | `widget-api-12.test.ts` (press, taken, remote refused, bad command) |
| `clipboard.write(text)` | `null` | none | right after a press, one per press, never a paired device's; text only, cut at 64 KB (`CLIPBOARD_MAX`), through `pbcopy` | `widget-api-12.test.ts` |

Why one journal verb: the widget reads what the Journal wrote, and a list of the last days covers a day (the first) and a week (seven); `journal.day(date)` and `journal.week` would add the native's paging and its model-written week, which a port can add as `journal.days({ before })` later without a new verb.

One addition beyond the list, to keep Restart one press: `actions.run(name, { restart: true })` (1.2, optional, an older cmd ignores it and leaves a running one running) stops a running action and runs it again in its terminal, one act and one sheet ("Restart “dev”"), as Workspace Actions' Restart does. Stop, then run would be two acts, and a press is one act (docs/56's decision). Data within API 1: `ApiEvent.text` and `ApiAction`'s `command`, `kind`, `package`, `pinned`, `primary`, `running`, `terminalId`, `url` (while it runs), `exitCode`, all optional in the d.ts so a 1.1 cmd's answers still type. A 1.1 package runs unchanged and is told the new verbs (`widget-act.test.ts`); `cmd.env.has("actions.stop")` is false on a cmd whose `env.verbs` lacks it (widget-api `testing.test.tsx`). `PROTOCOL` is unchanged: no RPC method or event changed (the verbs ride `widget.frame` and the widget wire as data).

Wave 1 on 1.2: Run Scripts (`actions` 1.1.0, `act: ["actions.run", "actions.stop"]`) and Event Log (`events` 1.1.0); what still differs is in their READMEs. Then port the wave 2 widgets on it.

## 1.3 candidates

What the wave 2 ports wanted and the API doesn't have. None is built; each port works around it or leaves the feature out, as said. The parity audit below folds each into its 1.3 list or rejects it.

| Candidate | Wanted by | Today |
|---|---|---|
| `Stat` with children (a `Sparkline` in the tile) and a `delta` that is a trend with `good` (the kit's `Delta`) | Usage Stats, Terminal Usage | the `Sparkline` sits under the `Stat` in a `Stack`; the change is `delta` text with `deltaTone` (green when it went the good way) |
| A live stats topic (`useStat(query)`, the core's `stats.changed`) | Usage Stats | the widget asks again 2.5 s after a `command` or `agent.stop` event (its own `useEvents`; cmd counts a second or two after the event) and once a minute |
| Quantiles in `ApiStatResult` (`p50`, `p90` beside `total`) | Usage Stats | the waiting line's "at a time" is a second query with `measure: "p50"`; a stat's detail has no "median …, 90% under …" |
| `fmt.value(v, unit)` and `fmt.delta(cur, prev, unit)`: a number in a chart `unit`, as the charts write it | Usage Stats | the package keeps its own copy of the Stats window's formatters |
| Other workspaces' names (`workspaces.list`, or `workspaceName` on a terminal) | Terminal Usage (All Workspaces) | a terminal of another workspace shows its folder's name |
| ~~The fake host refusing a topic (`deny` covers calls only)~~ built with Notification Log (testing only, no API change): `deny` on a verb refuses its live hook too | Terminal Usage's refused test, Notification Log | Terminal Usage's test still delivers the refusal by hand (`host.deliver`); it could use `deny` now |
| A live journal (`useJournal`, a `journal` topic pushed when a day is written) | Work Log | it reads `journal.days` every 5 minutes and from its title menu (Read Again) |
| `journal.week`, `journal.days({ before })` and an entry's project label | Work Log | no week, no paging back past 7 days, no project chips (`ApiJournalEntry` has no `repo`, and a path would be private; a folder's name would do) |
| `ApiEvent.windowId` (data within API 1, as `terminalId` was in 1.1): the window an event is about | Notification Log | a click goes to a notification's terminal; one about a window (a widget's) has nowhere to go |
| A picture element (`Picture src`: a data: URL or a granted host's image, sized by the kit) | Media Controls | no cover, though `ApiNowPlaying.artwork` carries it; a music note stands in (a `Frame` could draw it, but a page for one image is the wrong tool) |
| A live media topic (`useMedia`, pushed on the core's `nowPlaying.changed`) | Media Controls | it asks `media.get` every 2 seconds, so a change from elsewhere shows up to 2 seconds late; its own controls look again at once |
| An audio-levels feed into frames (`audio` permission; `cmd.audio.subscribe({ source }, fn)` in a page) | Visualizer (wave 3) | stays native: a frame hears nothing (below) |
| A YouTube player element (`Video provider="youtube" video list start fill`), drawn by the app | YouTube (wave 3) | stays native: a frame can't embed it (below) |

**An audio-levels feed into frames.** *What:* a live topic a frame page subscribes to, `cmd.audio.subscribe({ source: "mic" | "system" | "window:<id>" }, fn)`, pushed every animation frame with the three 1024-sample byte arrays the native view already reads (`tap()` in renderer `lib/audio.ts`: mono, left, right; 128 is silence), plus `cmd.audio.sources()` (the window sources as `{ id, label }`, the ones `publishedSources()` lists). The renderer opens the source as it does for the native Visualizer, in the app's own page, and posts the samples into the page (the frame host's `post`), as `VisualizerView` posts them into butterchurn's frame today. *Why:* the page can't open any source itself (the spike below), and the Visualizer's job is moving to what the person hears. *Security cost:* the microphone is a recording of the room: a page that hears it can lift speech from the waveform (1024 samples at 48 kHz is ~21 ms of audio, every frame: the whole signal, not a summary), and system audio carries calls and anything playing. So it needs its own permission with a grants line ("Hear the microphone", "Hear what the Mac plays"), never for a paired device, never granted to a Magic widget without asking, shown while open (macOS's orange dot shows for the mic already; system audio has no such sign, so the window's title bar should), and the samples should never leave the renderer for the core or the widget's process. A smaller shape that leaks less: send only the spectrum (64 bands, a few times coarser than the samples), which drives most visualizers and can't be turned back into speech; butterchurn wants the waveform, so the Visualizer would draw slightly differently. *Smallest shape:* `audio: ["window"]` first (Jam's and other windows' sound, which is cmd's own and the person already hears), then `"mic"` and `"system"` as separate grants.

**A YouTube player element.** *What:* an element `Video provider="youtube" video list start fill onTitle` the renderer draws as the native YouTube window's `Player` (a `<webview>` of `https://www.youtube.com/embed/…` in the browser session with its Referer), from ids only: the widget never gives a URL, never runs code in the player and never reads it; `onTitle` (a `message`-like gesture, never a press) tells it the video's name. The rest of the native window (asking for a link, Change Video…, Fill Window, Open on YouTube, Copy Link) is already the API: `TextField`, `ToolbarMenu`, `useStoredState`, `windows.open`, `clipboard.write`. *Why:* a frame page can't embed a web page (`frame-src 'none'`), main refuses a webview outside the browser partition, and YouTube refuses embeds that send no Referer (error 153), so no frame-side workaround exists short of opening the CSP. *Security cost:* a third-party page in a widget's window with the browser session's cookies (the person's YouTube sign-in, which the native player needs for the "not a bot" check): the widget can't reach it (no ids beyond YouTube's, no script, no events but the title), but it picks what plays, and YouTube learns which videos a widget shows. Opening `frame-src` to a granted host instead would let a page put any page of that host in its frame, read nothing from it but drive it by URL, and give it the person's cookies only if the frame shares the browser partition, which an iframe in the app's page doesn't (it would be signed out, and refused as a bot): weaker for the same cost, so not that. *Smallest shape:* YouTube only, one provider in an enum the app knows, no generic embed.

## Wave 3: frames

The Visualizer and YouTube as `"surface": "frame"` packages on the one frame host (docs/56, phase 2b). Port one only if it keeps its job with the frame's `cmd` (state, config, theme, open after a press); otherwise record why it stays native.

**Tried (2026-10-15): both stay native.** A spike package (`"surface": "frame"`, `net: ["i.ytimg.com", "www.youtube.com"]`, granted) drawn in the built app, its page asking for everything the two need; what came back:

| Probe in the page | Result | For |
|---|---|---|
| `new AudioContext()` | `running`, 44100 Hz | Visualizer: the page can analyse sound it has |
| `canvas.getContext("webgl2")` | a context | Visualizer: butterchurn draws |
| `<script src="lib.js">` from the package | loaded | Visualizer: butterchurn and its presets could ship in the package (listed in its `files`, which staging copies) |
| `getUserMedia({ audio: true })`, on load and after a click | `SecurityError: Invalid security origin` | Visualizer's Microphone: the opaque origin, `featurePolicy.allowsFeature("microphone")` is false (the iframe has no `allow`), and main's permission handler refuses `cmd-widget:` pages anyway |
| `getDisplayMedia({ video: true, audio: true })` after a click | `NotAllowedError: … "display-capture" is disallowed by permissions policy` | Visualizer's System Audio (main's display-media handler also refuses `cmd-widget:` frames: loopback is the app page's only) |
| a Jam window's sound | not reachable | Visualizer: Jam publishes its samples into the renderer's page (`publishLevels`), which no frame can read |
| `<iframe src="https://www.youtube.com/embed/…">` | blocked: `frame-src` violation, the child frame is `chrome-error://chromewebdata/` | YouTube's player |
| `fetch("https://www.youtube.com/oembed…")` | blocked: `connect-src` violation | YouTube |
| `<video src="https://www.youtube.com/watch?v=…">` | `MEDIA_ERR_SRC_NOT_SUPPORTED` (4): a page, not a media file | YouTube |
| `<img src="https://i.ytimg.com/vi/…/hqdefault.jpg">` (a granted host) | loaded, 480 px | YouTube: a thumbnail is possible |
| `cmd.net.fetch("https://www.youtube.com/oembed…")` | 200 | YouTube: the title is possible |

So a **Visualizer** package would draw its presets moving to silence (or to a stream of its own, as the radio example plays one): not its job, which is moving to what the person hears. A **YouTube** package could show a video's thumbnail and title and open it on YouTube after a press, but never play it in the window. Neither is ported; neither sandbox nor CSP was changed; the native views stay as they are. What each would need is a 1.3 candidate above (an audio-levels feed into frames; a player element the app draws). The e2e `widget-frame` scenario now checks the sandbox keeps those out (no microphone, no system audio, no web page in a frame), so loosening it is a decision, not an accident.

## Parity audit (2026-10-15)

Jan wants the ports to match the native views, not just do their job, and the API to give a widget what that takes. Every pair was compared in its code (what the native reads and draws, how it responds to its size, its interactions) and side by side in the UI Workbench, at the same states and sizes, in Light and Dark: `.cmd-dev/shots/parity/<widget>/{native,package}-<variant>-{light,dark}.png` in the `widget-parity` worktree (246 shots; each `Sizes` shot is the 320×520, 560×460 and 900×560 windows `cmd widget preview` uses). Commands, Event Stream and Notifications have no native story, so those three were compared from their code only.

Each difference has a class: **(a)** an element or element prop is missing, **(b)** layout or size awareness, **(c)** a verb, a live topic or a data field is missing, **(d)** a port bug that today's API can fix, **(e)** intentional, with the reason it would be wrong for a widget to match. "Fix" names the 1.3 addition (numbered as in the list below) or the change to the port.

### Per widget

**Now Playing → Media Controls**

| Difference | Class | Fix |
|---|---|---|
| No cover: a music note stands in, though `ApiNowPlaying.artwork` carries it | a | `Picture` (A5), with its `icon` placeholder for the native "no cover" box in the track's colour |
| Three layouts by size: short (< 280 px tall) puts a 44 px thumbnail in front of the title with the player at the bottom; medium lets the cover fill the room above the track; large (≥ 340×440) is an iPod column (cover at 80% of the width up to 360 px, centred title, controls spread with `--space-6`). The package has one layout, a stack at the top, empty below | b | `Adapt`/`Case` (A1) for the three layouts; `Picture size="fill"` (A5) for "the cover takes what's left" |
| The title grows with the column (`clamp(--text-lg, column / chars, 0.8 × --text-display)`) | b | `Text fit` (A3) |
| Controls: spread across the width when small, centred with a wide gap when large; the package centres three `lg` IconButtons always | b | inside each `Case`: `Inline justify="between"`, or centred |
| A change of track or a pause from elsewhere shows at once natively, up to 2 s late here | c | `media` topic, `useMedia()` (C1) |
| A footer "Playing in Spotify" the native doesn't have | d | drop it, or keep it as the one deliberate addition; the native says the app nowhere. Fixed (widget-port-fixes). Dropped; a footer shows only when a control didn't go through. |
| The `Sizes` story draws every box at the same size class (the fake host's `env.size` is "regular"), so the narrow box shows the title-bar status it would hide | d | tooling: the fake host's `Sizes` passes each box its own `env` (A2). Left for A2 (widget-port-fixes): the fake host and the Workbench's `Sizes` are `@cmd/widget-api` and renderer code, outside a package |

**Timer → Countdown**

| Difference | Class | Fix |
|---|---|---|
| A ring (`Dial`) that empties as it runs and fills the window, the time inside sized to it (`min(15cqw, 15cqh)`); the package has display text and a `Progress` bar at the top of the body, with the room below empty | a, b | `Dial` (A6) |
| Click the time to type a length ("10", "1:30", "90s"); the package has a `ToolbarField` for it instead | a | `Dial editable` + `onSubmit` (A6); then the toolbar loses the field |
| Done in the `needs` colour; the package's is `warning` | a | `Dial tone="needs"` (A6) |
| The body is centred in the window; `Stack` can't centre on its main axis | a | `Stack justify` (A3); moot once it's a `Dial` |
| A title menu "Options" (Pause, Reset) the native window doesn't have | d | move them to `Window actions` (the window's context menu), no `menu`. Fixed (widget-port-fixes). |

**Agent Activity → Agents**

| Difference | Class | Fix |
|---|---|---|
| One ranked list (waiting, working, finished-unseen, the rest) with no headings; the package has three headed sections and loses the "unseen" rank | d | one `List` sorted by the same rank (`bucket` is there: "needs", "unseen", "rest"). Fixed (widget-port-fixes). |
| A row's end is two dim lines, where it works over how long ago, right-aligned; the package puts the place after the title and the age in a `Chip` | d | `ListRowEnd` > `Stack align="end" gap={0}` > two `Text size="xs" tone="dim"`. Fixed (widget-port-fixes). |
| The place's tooltip (the full folder or worktree) | d | `ListRow tip={agent.cwd}`. Fixed (widget-port-fixes). |
| With All Workspaces the place says which workspace | c | `workspaces` topic (C6): built (widget-data) |
| A click marks the clicked agent seen (a subagent too); the package selects the host's window, which marks only the host | c | `agents.select(id)` (C9): built (widget-data) |
| Empty: a "New Claude Session" button | c | `agents.start` without a prompt (C10): built (widget-data) |

**Commands → Recent Commands** (ported on 1.1 and not moved to 1.2)

| Difference | Class | Fix |
|---|---|---|
| A list to the window's edges (`Panel`/`PanelBody`); the package's sits in an inset `View` | d | `Panel` > `PanelBody` (1.2). Fixed (widget-port-fixes). |
| Run Again on hover (`ListRowActions`) | d | `ListRowActions` > `IconButton` (1.2). Fixed (widget-port-fixes). |
| Run Again types the command into its own terminal and runs it, when that terminal is open and at a prompt; the package opens a new terminal with it typed, not run | c | `terminals.rerun(key)` (C11): built (widget-data) |
| Copy Command and New Terminal Here in a row's menu | d | `cmd.clipboard.write` (1.2) and `cmd.terminals.open({ cwd })`. Fixed (widget-port-fixes). |
| The place chip is the project's hue with the worktree or branch (`whereOf`); the package's is a neutral chip with the branch | a | `fmt.hue(name)` (A11), the app's `projectHue`; the place from the event's `git` |
| The age is a `ListValue`; the package's is a `Chip` | d | `ListValue`. Fixed (widget-port-fixes). |
| All Workspaces adds the workspace's name to the detail | c | `workspaces` topic (C6): built (widget-data) |
| The README has no "How it differs" section | d | write it. Fixed (widget-port-fixes). |

**Event Stream → Event Log**

| Difference | Class | Fix |
|---|---|---|
| Edge-to-edge `Panel` | d | `Panel` > `WindowToolbar` + `PanelBody`. Fixed (widget-port-fixes). |
| The classes are in the title menu, whose button says "All Events" or "3 hidden"; the package's title menu says "This Workspace" and the classes are a toolbar `Show` menu | a | `Window menuLabel` (A7); then classes and scope share the title menu as natively |
| A chip says the class's title ("Agents") in `projectHue(class)`; the package's says the class id in its own hash's hue | d, a | `titleOf(fam)`; `fmt.hue` (A11). Fixed (widget-port-fixes). The title part (d); the hue waits for A11. |
| "recorded again ×n" in the detail | d | count the events per key before `newestFirst` drops them. Fixed (widget-port-fixes). Counted from `cmd.events.subscribe` (`useEvents` merges them away). Since API 1.3 `useEvents`' events carry `again` (`LiveEvent`): how often the key was recorded again while subscribed; built (widget-data), the re-port drops its own count (`useLog`) for it. |
| Events of no workspace (the data layer's own) are shown | e | a widget reads its workspace's, or every workspace's with `workspace: ["all"]`, never what belongs to none: matching would hand any widget with an events grant cmd's own records |

**Notifications → Notification Log**

| Difference | Class | Fix |
|---|---|---|
| Edge-to-edge `Panel` | d | `Panel` > `PanelBody`. Fixed (widget-port-fixes). |
| A click goes to the window a notification is about (a widget's), and its menu says Show Window | c | `ApiEvent.windowId` (C8): built (widget-data) |
| Notifications about nothing in particular (the CLI's) show in every workspace | e | the same rule as Event Log: no workspace, no widget |
| A terminal moved since counts for the workspace it is in now, not the one it was sent in | e | the log's `workspaceId` is what was recorded; rewriting it per read would make two readers disagree |
| Clear clears the app's list for every workspace; the package's Clear is its window's own | e | decided for 1.2 (no `notify.clear`). With `cmd.storage` (the other 1.3 branch) its "cleared at" can move to the `package` scope, which clears every Notification Log at once, the closest a widget can come to the native without a verb |

**Resources → Terminal Usage**

| Difference | Class | Fix |
|---|---|---|
| The sparkline is inside the stat's tile, in the chart palette (CPU series 0, memory series 1, green); the package's sits under the tile in accent and neutral | a | `Stat` children and `Sparkline series` (A8) |
| A terminal's name and icon are the sidebar's (an agent's name and its kind's icon: "Codex · sqlite viewer", ✦); the package's are the terminal's title and a generic `sparkles` | d | `useAgents` by `agentId`: `agent.name`, `agent.icon`. Fixed (widget-port-fixes). |
| Other workspaces' terminals say the workspace's name; the package's say their folder | c | `workspaces` topic (C6): built (widget-data) |
| A "cmd" pane: the app and the background process | c | `app.usage` (C12): built (widget-data) |
| A Task Manager link in the footer | c | `app.open("taskManager")` (C13): rejected by Jan (2026-10-15), widgets never open cmd's own windows |
| The package's header sorts; the native is always busiest first | e | an improvement, kept: the default without a sort is the native order |

**Stats → Usage Stats**

| Difference | Class | Fix |
|---|---|---|
| A tile's change is the kit's `Delta` (▲ 22%, green or red by the stat's `good`, dim when flat); the package's is "+100%" text in a tone | a | `Stat trend` + `good` (A8) |
| The sparkline is inside the tile, as wide as it | a | `Stat` children (A8) |
| The "cmd" pane (core memory, stalls, the log's size) | d | `stats.query` can read them today: `events: ["system"]` (a declarable class) and `workspace: ["all"]` for a stat with no workspace; add both grants and the pane. Fixed (widget-port-fixes). The package now declares `events: ["system"]`. |
| In This Workspace the native page still shows your active time and when you work (they have no workspace) | d | query `you.active` with `scope: "all"` beside the workspace's stats (the package already holds `workspace: ["all"]`). Fixed (widget-port-fixes). |
| A detail's header: the value bold, a `Delta`, "median 4m, 90% under 12m" | a, c | a chart's `delta` and `note` (A9); `quantiles` (C3): built (widget-data) |
| Counted again when the core says a stat it shows changed; the package follows `command` and `agent.stop` events and a minute's timer | c | `stats` topic, `useStat(query)` (C2): built (widget-data) |
| A detail ranks by the stat's "many" dimension ("By command"); `ApiStatInfo.dims` doesn't say which | c | `dims[].many` and `kind` (C3): built (widget-data) |
| "Updated" is when cmd counted (`asOf`); the package's is when it asked | c | `asOf` (C3): built (widget-data) |
| The package keeps its own copy of the Stats window's formatters | a | `fmt.value`, `fmt.delta` (A11) |

**Journal → Work Log**

| Difference | Class | Fix |
|---|---|---|
| Writes the days that are stale when it opens ("Writing up what happened…"), Write Again on today's heading, and an empty state that sets up AI | c | `journal.write` (C5) and `app.open("settings:ai")` (C13): both rejected by Jan (2026-10-15), Work Log stays read-only and widgets never open cmd's own windows; the package stays a reader that points at the Journal |
| "This week" above the days: the week's headline and threads | c | `journal.week()` (C4): built (widget-data) |
| All Workspaces, with a project chip per entry when there is more than one | c | `journal.days({ scope: "all" })` and `ApiJournalEntry.project` (a folder's name, never a path) (C4): built (widget-data); `fmt.hue` (A11) |
| Reads again when something it reads is recorded, and at the day's turn; the package every 5 minutes | c | `journal` topic, `useJournal()` (C4): built (widget-data) |
| A picked bar in the ribbon scrolls its entry into view | a | `reveal` on `TimelineEntry` (A10) |
| The title menu says the scope; the package's says "Options" (Read Again) | d | Read Again as the native's small `IconButton` on Today's heading; the title menu becomes the scope once C4 exists. Fixed (widget-port-fixes). Read Again on the newest day's heading; no title menu until C4. |

**Workspace Actions → Run Scripts**

| Difference | Class | Fix |
|---|---|---|
| The title menu's button names the folder (and the worktree's branch); its menu follows the selected terminal's checkout, lists the repository's worktrees with what runs in each, or uses the workspace's folder | a, c | `Window menuLabel` (A7); `useActions({ root })` for a worktree of the workspace's repository (C14), the worktrees from `cmd.git.worktrees` |
| Sections fold (a click on the heading), packages and More start folded, kept per window | d | `ListSection open` + `onToggle`, the keys in `useStoredState`. Fixed (widget-port-fixes). Packages start folded; there is no More section in 1.2 (C14). |
| From Your History ("12× in this folder", a clock icon), Suggested (from the README), and More (hidden ones) | c | `ApiAction.source`, `hidden`, `history`, and `include` (C14) |
| A recipe that needs arguments is typed into a new terminal ("Type in Terminal", a text cursor icon) | c | `ApiAction.args`; `actions.run` types it (C14) |
| Run in New Terminal | c | `actions.run(name, { fresh })` (C14) |
| A risky action asks with the window's own sheet; the package lists it dimmed under "Run From a Terminal" and can't run it | c | `actions.run` of a risky action asks every time, never kept, instead of refusing (C14), Jan to decide |
| Stop stops at once | e | acts from a widget follow the person's levels; at a level that allows stopping, a built-in stops without a sheet too |
| Pin to Top | e | `actions.pin` was declined for 1.2 (Jan); revisit only with the rest of C14 |
| Describe with AI and Open Dev Servers in a Browser (app settings) in the menu | e | a widget never changes cmd's settings: it would be the one door from a package into every window's behaviour |
| The tooltip: command → script, the file and line it comes from, "Asks before it runs"; Open <file> in the menu | c | `ApiAction.script`, `source` (C14); `windows.open` of the file |
| "in <branch>": the same action running in another worktree, a link to its terminal | c | `ApiAction.elsewhere` (C14) |
| A callout for a source file that can't be read; "Describing actions…" with a spinner, or "Set up AI" in the footer | c | `useActionsInfo()` (C14); `app.open("settings:ai")` (C13): rejected by Jan (2026-10-15), widgets never open cmd's own windows |
| The footer names the branch and folder when they aren't the workspace's | c | `useActionsInfo()` (C14) |
| How long a run took comes from the command events of its terminal (wrong when two runs share it) | c | `ApiAction.startedAt`, `endedAt` (C14) |
| Enter in the filter runs the first match | a | `ToolbarSearchField onSubmit` (A7) |
| Durations read "4 min" (the app's `durationText`); `fmt.dur` says "4m 3s" | a | `fmt.dur(s, { coarse: true })` (A11) |
| The main action's icon is its kind's; the package's is `play.fill` | d | `kindOf(main).icon`. Fixed (widget-port-fixes). |

**Counts by class**

| Widget | a | b | c | d | e |
|---|---|---|---|---|---|
| Media Controls | 1 | 3 | 1 | 2 | 0 |
| Countdown | 4 | 1 | 0 | 1 | 0 |
| Agents | 0 | 0 | 3 | 3 | 0 |
| Recent Commands | 1 | 0 | 2 | 5 | 0 |
| Event Log | 2 | 0 | 0 | 3 | 1 |
| Notification Log | 0 | 0 | 1 | 1 | 3 |
| Terminal Usage | 1 | 0 | 3 | 1 | 1 |
| Usage Stats | 4 | 0 | 4 | 2 | 0 |
| Work Log | 1 | 0 | 4 | 1 | 0 |
| Run Scripts | 3 | 0 | 10 | 2 | 3 |
| **All** | **17** | **4** | **28** | **21** | **8** |

(A row with two classes counts in both.) So most of the gap is data (c) and port work that needs nothing new (d); the elements missing are few but visible (a cover, a ring, a delta, a sparkline in a tile), and size awareness (b) is what makes Now Playing and Timer look like ports.

### 1.3 additions

General primitives first; one-off elements only where the native view is a kit piece with behaviour of its own (`Dial`). Elements go in `widget-elements-1.3.ts` (`since: "1.3"`), verbs and topics in `widget-verbs.ts`, their data in `widget-tree-1.3.ts`. Everything is optional within API 1: a 1.2 package runs unchanged, and `cmd.env.has()` answers for each.

**A. Elements and size** (A1–A11)

1. **`Adapt` and `Case`**: a layout that switches by the room it has, decided in the renderer.
   ```ts
   Adapt: { doc: "Draws the first Case that fits its own box: a layout per size, switched without the widget's process.", since, props: {}, events: {}, children: "elements", childrenDoc: "Cases, the most demanding first; one without conditions is the fallback." },
   Case: { doc: "One layout of an Adapt, drawn while its box meets every condition given.", since, props: {
     minWidth: { type: "number", doc: "In px." }, maxWidth: { type: "number", doc: "In px." },
     minHeight: { type: "number", doc: "In px." }, maxHeight: { type: "number", doc: "In px." } }, events: {}, children: "elements", childrenDoc: "The layout." },
   ```
   Why in the renderer and not `useEnv`: a switch the process makes round-trips (the renderer measures, tells the core, the process re-renders, the patch comes back), so a resize shows the wrong layout for frames and wakes the process on every class change. The cases are in the tree; the renderer measures the `Adapt` (a `ResizeObserver`, as `useSizeClass` does) and mounts one. Its box, not the window's: an `Adapt` in a `Pane` adapts to the pane. Cost: the tree carries every case (small); a field's draft inside a case is lost when the case changes (said in the doc). Security: none. Kit: a new `Adapt` in `@cmd/ui` (`frame.tsx` neighbours), which the native Now Playing can use too, replacing its container queries. Used by: Media Controls; any widget with a small and a large face.
2. **`env.box` and `useSize()`**: `WidgetEnv.box: { width: number; height: number }` (the window content's px, rounded to 8, sent at most every 200 ms while resizing) and `size` unchanged; `useSize()` returns the box. For logic that needs numbers (how many rows fit, a chart's bucket count), not for layouts (that's `Adapt`). The fake host sends each `Sizes` box its own `env` (`size` and `box`), so stories show what a window of that size gets. Cost: none (the renderer already measures). Used by: Media Controls' title-bar status (hidden when short), Usage Stats (heat chart choice in a narrow window).
3. **`Stack justify` and `Text fit`**: `justify: { type: ["start", "center", "end", "between"], doc: "Where the children sit along the column (with grow: centred in the window)." }`; `Text fit: { type: "boolean", doc: "Grows with its container's width, one line, from its size up to display: a title that fills a column." }` (the native title's clamp, in the kit's `Text`). Used by: Media Controls, Countdown.
4. ~~More size classes~~: rejected. Classes are a coarse guess at what a layout needs; `Adapt` takes the numbers the layout actually breaks at (Now Playing's 280, 340×440), and `Hide below` stays for the simple case.
5. **`Picture`**: an image from the widget's data or a host it is granted.
   ```ts
   Picture: { doc: "An image: a cover, a thumbnail, a logo. From a data: URL, or an https URL of a host in the package's net grant, which cmd fetches; never loaded by the page.", since, props: {
     src: { type: "string", nullable: true, doc: "data:image/png|jpeg|webp|gif;base64,… (at most 512 KB), or https://<a granted host>/…; null shows the placeholder." },
     alt: { type: "string", required: true, shows: "title", doc: "What it shows, in words (its accessible name; what stands in on a paired device that draws none)." },
     fit: { type: ["cover", "contain"], doc: "Fills its box, cropped (default), or fits inside it." },
     ratio: { type: [1, 1.333, 1.5, 1.778], doc: "Width over height (default 1: square)." },
     size: { type: [24, 32, 44, 64, 96, 128, "fill"], doc: "Its width in px, or \"fill\": as large as the room left allows (a cover above a player)." },
     radius: { type: ["sm", "md", "none"], doc: "Its corners (default md)." },
     icon: { type: "string", doc: "An SF Symbol on the placeholder box (no src, loading, or failed): the box in the chart track colour." } },
     events: { onClick: press("Pressed.") }, children: "none" },
   ```
   How the host draws it without a leak: the renderer never gets a remote URL. The app page's CSP allows `img-src https:` (the browser windows' favicons), so an `<img src>` from a widget would load with the app session's cookies and tell a host when the window redraws: a tracking pixel. Instead the sanitiser keeps only `data:image/(png|jpeg|webp|gif)` (no SVG: it can carry script and external references) and `https:` URLs; for an `https:` src the core fetches it the way `net.fetch` does (the host checked against the grant per URL, no cookies, no Referer, cmd's user agent, counted against the widget's net budget), checks the type by its magic bytes, refuses more than 2 MB or a side over 4096 px, and hands the renderer a `data:` URL. Fetched pictures are cached by URL for an hour (32 MB, least recently used), so a widget that redraws can't make one beacon per redraw, and one that adds a nonce per URL spends its fetch budget. A paired device gets the same `data:` URL in the tree and fetches nothing. Cost: the granted host learns the widget asked, which `net.fetch` already allows; memory, capped at 4 MB of pictures per tree. Kit: `Picture` (frame.tsx) gains `fit`, `ratio`, `fill` and the placeholder, from Now Playing's `np-art`/`np-nocover` CSS, so the native view draws through it too. Used by: Media Controls (the artwork); YouTube's thumbnail when a player exists (docs/57 above); any widget with a logo or avatar.
6. **`Dial`**: the kit's `Dial` as an element. Props `value` (text, required), `progress` (0–1), `tone` (`["accent", "needs", "dim"]`), `caption`, `label` (required), `editable` (boolean); events `onSubmit` (`submit`: the typed text; Escape or leaving cancels, the draft stays in the renderer as `TextField`'s does). An override, for the draft. Used by: Countdown; a pomodoro, a quota, any "one value across the room".
7. **`Window menuLabel`** (`string`: the title menu's button, default the checked entry or "Options") and **`ToolbarSearchField onSubmit`** (`submit`, Return with the text). Used by: Event Log ("3 hidden"), Run Scripts (the folder · branch), Work Log; Run Scripts' Enter.
8. **`Stat` children, `trend`, `good`; `Sparkline series`**: `Stat` takes elements (a `Sparkline`, drawn inside the tile as wide as it), and `trend: ["up", "down", "flat"]` with `good: ["up", "down"]` draws `delta` as the kit's `Delta` (the 1.0 `deltaTone` stays for text). `Sparkline series: { type: [0, 1, 2, 3, 4, 5, 6, 7], doc: "Draws in the chart palette's nth colour (a stat's own colour)." }`. Folds in the 1.3 candidate "Stat with children". Used by: Usage Stats, Terminal Usage.
9. **A chart header's `delta` and `note`** on `TimeSeries` and `TimeBars`: `delta` a record `{ text, trend, good? }` drawn as a `Delta` after the summary, `note` a dim string after it ("median 4m, 90% under 12m"). Used by: Usage Stats' detail.
10. **`reveal`** on `ListRow` and `TimelineEntry`: `{ type: "boolean", doc: "Scrolled into view (nearest edge) when it becomes true." }` (the renderer's `scrollIntoView`, once per change). Used by: Work Log's ribbon; Event Log opening a row near the bottom.
11. **`fmt` additions** (`@cmd/widget-api`, no wire change): `fmt.value(v, unit)` and `fmt.delta(cur, prev, unit)` (protocol `formatValue`/`formatDelta`, as the charts write them), `fmt.hue(name)` (the app's `projectHue`, so a project's chip has the colour it has in every window), `fmt.dur(s, { coarse: true })` (the app's `durationText`: "4 min"). Folds in the `fmt.value`/`fmt.delta` candidate. Used by: Usage Stats, Recent Commands, Event Log, Work Log, Run Scripts.

**C. Data: topics, verbs and fields** (C1–C15)

1. **`media` topic**, `useMedia()`: `media.get` live, pushed on the core's `nowPlaying.changed`; holds the Now Playing stream while subscribed (`holdNowPlaying`), `media: ["read"]`. The artwork rides only when it changes (the topic's value is diffed like any other; an unchanged `data:` string isn't re-sent). Folds in the candidate. Used by: Media Controls.
2. **`stats` topic**, `useStat(query)`: `stats.query` live, again 1.5 s after a `stats.changed` that names its stat, and once a minute for a stat counted in time. Same permission as the verb. Folds in the candidate. Used by: Usage Stats. **Built (widget-data).**
3. **`ApiStatResult` and `ApiStatInfo`**: `quantiles?: { p50: number; p90: number }` (with `quantiles: true` in the query), `asOf: number`; `ApiStatInfo.kind` (`"count" | "gauge" | "distribution" | "rate"`, what chart a detail draws) and `dims[].many`. Data within API 1. Folds in the quantiles candidate. Used by: Usage Stats. **Built (widget-data).**
4. **Journal**: `journal` topic (`useJournal({ count, scope })`, pushed when a day is written); `journal.days({ scope: "all" })` with `workspace: ["all"]`; `journal.week({ scope }): ApiJournalWeek | null` (`{ headline, themes: { title, summary }[] }`, read only, written by the Journal); `ApiJournalEntry.project: string | null` (a folder's name, never a path). Folds in the live-journal and week candidates; **rejects** `journal.days({ before })`: the native view doesn't page either, so no port needs it. Used by: Work Log. **Built (widget-data).**
5. ~~**`journal.write({ date })`**~~: **rejected by Jan (2026-10-15)**: Work Log stays read-only; a widget never has a day written, so a model run stays out of any package's hands. What was proposed: an act right after a press (and once when the widget opens, for stale days, as the native does), `ai: ["journal"]` (a new value: the grants sheet says "Write your journal with your AI model"), never from a paired device. It writes what the native Journal writes with the person's model. 1.2 said a widget never has a day written; that keeps a model run out of any package's hands, and the grant is the answer to it: only a widget that declares and is granted it can. Without it Work Log stays a reader.
6. **`workspaces` topic**, `useWorkspaces()` / `workspaces.list(): { id, name }[]`, `workspace: ["all"]`: names only, no folders. Folds in the candidate. Used by: Agents, Recent Commands, Terminal Usage. **Built (widget-data).**
7. ~~`ApiAgent.workspaceName`~~: rejected in favour of C6 (one list, not a name copied into every record).
8. **`ApiEvent.windowId`**: the window an event is about. Data within API 1. Folds in the candidate. Used by: Notification Log. **Built (widget-data).**
9. **`agents.select(id)`**: an act like `windows.select` (no permission, within the widget's scope): shows the agent's terminal (a subagent's host's), in its workspace, and marks that agent seen. Used by: Agents. **Built (widget-data).**
10. **`agents.start` without `prompt`**: an interactive session in the workspace's folder; the sheet says "Start a Claude session?". Used by: Agents' empty state. **Built (widget-data).**
11. **`terminals.rerun(key)`**: confirm, ask "type", `typed: "person"` (a built-in follows the levels; a person's package asks every time). The text is the command cmd's log recorded under `key` in that terminal, not the widget's, so the widget can't type its own words; refused when the terminal is gone or not at a prompt ("isn't at a prompt"). Used by: Recent Commands. **Built (widget-data).**
12. **`app.usage()`** and topic `appUsage`: `{ app: { cpu, memory }, background: { cpu, memory } }`, `events: ["system"]` (the class that already holds cmd's own health). Used by: Terminal Usage's "cmd" pane. **Built (widget-data).**
13. ~~**`app.open(place)`**~~: **rejected by Jan (2026-10-15)**: widgets never open cmd's own windows (as 1.2 decided); a port says where a place is in words instead of linking to it. What was proposed: an act right after a press, local only, no permission, `place` one of `"taskManager" | "settings:ai" | "settings:actions"` (a closed list cmd owns, so a widget opens nothing else). 1.2 decided a widget never opens the app's own windows; these three are the only places the ports link to, and each is a link the native view shows.
14. **Actions**: `ApiAction` gains `script`, `args` (it needs arguments: `actions.run` types it into a new terminal), `hidden`, `source: { kind: "file" | "history" | "readme"; file: string | null; line: number | null }` (a path relative to the root), `history: { runs: number } | null`, `startedAt`, `endedAt`, `elsewhere: { branch: string | null; terminalId: string; url: string | null }[]`; `useActions({ root, include: ["history", "suggested"] })` where `root` must be a worktree of the workspace's repository (`git.worktrees`); `useActionsInfo({ root })` → `{ root, branch, linked, describing, errors: { file, error }[] }`; `actions.run(name, { fresh, root })`; and a risky action **asks every time** (its sheet names it and shows its command, never kept) instead of being refused, for Jan to decide. Used by: Run Scripts.
15. Unchanged from docs/57's wave 3: the audio-levels feed and the YouTube player element are not needed by these ten and stay candidates for Visualizer and YouTube.

### Build plan

First, one small commit on master that the branches fork from, so none of them bumps the version or creates the shared files: `ApiMinor` "1.3", `WIDGET_API_MINOR = 3`, empty `widget-elements-1.3.ts` and `widget-tree-1.3.ts` merged into `API_ELEMENTS` and the d.ts. Each branch then appends its rows; the registries (`ELEMENTS_1_3`, `API`, `API_TOPIC`, `ApiMethods`) are append-only, and a rebase keeps both sides' rows. Regenerate `elements.gen.ts` and `elements-since.gen.ts` after each rebase.

| Branch | Builds | Files it owns | Re-ports after it |
|---|---|---|---|
| `widget-size` | A1 `Adapt`/`Case`, A2 `env.box`/`useSize` and the fake host's per-box env, A3 `Stack justify`/`Text fit` | kit `adapt.tsx` (new), `Stack` and `Text` in kit `frame.tsx`; renderer `windows/package/PackageView.tsx` (`useSizeClass` → box), a new `entries-1.3-layout.tsx`; widget-api `hooks.ts` (`useSize`), `testing/host.ts` | Countdown's layout (with `widget-display`), Media Controls (with `widget-picture`) |
| `widget-picture` | A5 `Picture`, C1 `media` topic | kit `picture.tsx` (new, the native Now Playing's cover CSS moves there); core `widgets/api/picture.ts` (fetch, checks, cache), the tree sanitiser's src rule; renderer `entries-1.3-picture.tsx`; `media` row and its read | Media Controls (after `widget-size` too): three `Case`s, the cover, `useMedia` |
| `widget-display` | A6 `Dial`, A7 `menuLabel`/`onSubmit`, A8 `Stat`/`Sparkline series`, A9 chart `delta`/`note`, A10 `reveal`, A11 `fmt` | renderer `entries-1.3-display.tsx`, `chrome.ts` (`menuLabel`); kit `Stat` (`frame.tsx`, its own function), `Dial` unchanged; widget-api `fmt.ts` | Countdown (`Dial`), Event Log (`menuLabel`, `fmt.hue`), Terminal Usage (`Stat`, `series`), Usage Stats (`Stat`, chart `delta`, `fmt`), Recent Commands (`fmt.hue`) |
| `widget-data` | C2 stats topic, C3 stat fields, C4 journal topic/week/scope/project, C6 workspaces, C8 `windowId`, C9 `agents.select`, C10 interactive `agents.start`, C11 `terminals.rerun`, C12 `app.usage` | core `widgets/api/reads.ts`, `model.ts` (agents, events), `act.ts` (the two acts), `stats/`' result shape; `widget-tree-1.3.ts` types | Agents, Recent Commands, Notification Log, Terminal Usage, Usage Stats (with `widget-display`), Work Log (with `widget-display`) |
| `widget-actions` | C14 | core `widgets/api/model.ts` `apiAction` only, `actions/`' list options, `act.ts`'s `actions.run` branch | Run Scripts (with `widget-display`) |
| `widget-port-fixes` | every (d) above, on today's 1.2 | `packages/widgets/*` only | none: it is the first pass; the re-ports above build on it |

`widget-data`, as built (2026-10-16): the stat fields, `ApiJournalEntry.project`, `ApiEvent.windowId` and `asOf` are optional in the types, as every field added within API 1 is; `journal.week` returns `start` and `writtenAt` besides the headline and themes, and needs `events: ["agents"]` as `journal.days` does; `app.usage`'s `app` and `background` are null where cmd can't tell (no app open, no procinfo), and the app tells the core its process on each connect (`app.attach`), which samples the app's process tree, without the core's when the app started it; an interactive `agents.start` carries no typed text, so it follows the levels and a yes can be kept; `terminals.rerun` refuses a command over several lines and one the deny-list names, and checks the terminal again after the person answers. The journal topic reads again 2 s after a write of its scope, and those reads don't count against the widget's ten journal reads a minute.

`widget-data` and `widget-actions` both touch `act.ts` and `model.ts`, in different functions; if that proves noisy, run them one after the other. Jan decided C5 (`journal.write`) and C13 (`app.open`) before `widget-data` started: both rejected (2026-10-15); C14's risky asks are still his to decide before `widget-actions` starts. `widget-port-fixes` can start now and in parallel with all of them.

Re-ports, each in its own branch once its last dependency is merged: **Media Controls** (size, picture), **Countdown** (size, display), **Usage Stats** (display, data), **Work Log** (display, data), **Terminal Usage** (display, data), **Agents** (data), **Recent Commands** (display, data), **Notification Log** (data; `cmd.storage` for a shared Clear when it lands), **Event Log** (display), **Run Scripts** (display, actions). `cmd.storage` (built in `cmd-widget-storage`) also gives Event Log's hidden classes a `package` scope (one preference for every Event Log) and leaves Countdown, Agents and Run Scripts' folds in the window's scope, where they are now.

## After the ports: retiring native views

For each ported widget, separately and only on Jan's word: delete its native view (renderer folder, core `WindowType`, its commands and settings), move open windows of the old kind to the package's `pkg:<name>/<id>` kind with their state (a startup job, as phase 2b did for old widgets), and update the e2e scenarios. The list of retired kinds goes here.

## Brief for the agent doing the port

- **Start:** `git -C ~/src/cmd worktree add ~/src/cmd-builtin-<wave> -b builtin-<wave> master`, `pnpm install`, `export CMD_HOME=$PWD/.cmd-dev CMD_WIDGETS_HOME=$PWD/.cmd-dev/widgets`.
- **Learn the shape from the three done:** `packages/widgets/agents`, `commands` and `timer` are the reference for folder layout, tests, stories and README. `cmd widget new` gives the same shape.
- **First the 1.2 elements** above, as their own commits (spec rows, overrides for `TextField` and `DataGrid`, stories, the generated files).
- **Then wave 1 completely**, on those elements. Then write the 1.2 verb proposal and stop: report the proposal, don't build it.
- **Report:** the branch's commits, each widget with its evidence (test names, `cmd widget check` and `preview` output, the e2e scenario, a screenshot per theme pair), what each does differently from the native one, and the 1.2 proposal.
- **Don't:** delete a native view, add a verb or an element beyond the list above, import anything from cmd but `@cmd/widget-api`, merge, push or release.
