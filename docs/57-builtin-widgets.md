# Built-in widgets as packages

**Status:** partly built: a brief for porting cmd's native widgets to widget packages (docs/56) and shipping them as cmd's standard set. Agents, Recent Commands and Countdown are ported; API 1.2's elements are built, and wave 1 (Event Log, Run Scripts) is ported on them; API 1.2's verbs were decided by Jan (2026-10-15) and are built, and wave 1 uses them; the wave 2 ports are next.

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
| Now Playing | `nowplaying` | 93 | `nowPlaying.get/control` | **wave 2**: on `media.get` and `media.control` (built) |
| Navigator | `navigator` | 335 | `search.query` (transcripts) | **stays native**: decided, no `search.query`; it is the board's sidebar for sessions, a window |
| Visualizer | `visualizer` | 162 | a frame with presets | **wave 3**: a frame package, if the frame `cmd` (state, theme, open) is enough |
| YouTube | `youtube` | 175 | an embedded player, the window's state | **wave 3**: a frame package with `net` to YouTube's hosts, if its embed works in the frame's CSP; else stays native |
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

What the wave 2 ports wanted and the API doesn't have. None is built; each port works around it or leaves the feature out, as said.

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

## Wave 3: frames

The Visualizer and YouTube as `"surface": "frame"` packages on the one frame host (docs/56, phase 2b). Port one only if it keeps its job with the frame's `cmd` (state, config, theme, open after a press); otherwise record why it stays native.

## After the ports: retiring native views

For each ported widget, separately and only on Jan's word: delete its native view (renderer folder, core `WindowType`, its commands and settings), move open windows of the old kind to the package's `pkg:<name>/<id>` kind with their state (a startup job, as phase 2b did for old widgets), and update the e2e scenarios. The list of retired kinds goes here.

## Brief for the agent doing the port

- **Start:** `git -C ~/src/cmd worktree add ~/src/cmd-builtin-<wave> -b builtin-<wave> master`, `pnpm install`, `export CMD_HOME=$PWD/.cmd-dev CMD_WIDGETS_HOME=$PWD/.cmd-dev/widgets`.
- **Learn the shape from the three done:** `packages/widgets/agents`, `commands` and `timer` are the reference for folder layout, tests, stories and README. `cmd widget new` gives the same shape.
- **First the 1.2 elements** above, as their own commits (spec rows, overrides for `TextField` and `DataGrid`, stories, the generated files).
- **Then wave 1 completely**, on those elements. Then write the 1.2 verb proposal and stop: report the proposal, don't build it.
- **Report:** the branch's commits, each widget with its evidence (test names, `cmd widget check` and `preview` output, the e2e scenario, a screenshot per theme pair), what each does differently from the native one, and the 1.2 proposal.
- **Don't:** delete a native view, add a verb or an element beyond the list above, import anything from cmd but `@cmd/widget-api`, merge, push or release.
