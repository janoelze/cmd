# __TITLE__: a cmd widget package

This folder is a widget for cmd (a Mac app for terminals and coding agents side by side). A widget is a React component made of cmd's own elements; it runs in a process of its own and the app draws it with its kit. cmd reads `package.json`'s `cmd` block: the widgets, their config fields and the permissions it asks for.

## Read first

- **The API reference**: `node_modules/@cmd/widget-api/README.md` (the version you build against; `cmd widget new` and `dev` link it), also at https://endtime-instruments.org/cmd/widgets/. Every verb with the permission it needs, every hook, every element with its props. Use only what's there: there is no DOM, no HTML, no CSS.
- **The example**: `src/__ID__.tsx`, its test and its story.

## Commands

- `npm test` or `cmd widget test`: Vitest with `@cmd/widget-api/testing`. Run it after every change.
- `cmd widget check`: package.json, permissions, and TypeScript over `src/`. It writes `cmd-env.d.ts`, which types `useConfig()` from the config fields: rename a field in package.json and check names every line that still uses the old one.
- `cmd widget preview . --themes all --sizes all`: draws each state of the story in every theme and size, and fails on content that overflows, an empty state where the story has data, or console errors. Shots go to `.cmd-preview/`.
- `cmd widget dev`: puts it on the board in cmd and prints its console; saves reload it.

Done means `cmd widget check` and `npm test` pass, and `cmd widget preview . --themes all --sizes all` exits 0.

## Files

- `package.json`: `cmd.widgets[]` (id, title, SF Symbol icon, `main`, `size`, `config` fields), `cmd.permissions` (what it asks for; ask for no more than it uses): <!-- gen:permission-keys -->`net: [<host>]`, `run: [<program>]`, `read: [<folder>]`, `workspace: ["read"]` (`["read", "all"]` for every workspace), `events: [<class>]` ("operator", "tools", "output", "agents", "transcripts", "ai", "browsing", "system"; git, notes and actions need none), `act: [<namespace>]` ("agents", "terminals", "actions", "windows", or one verb like "terminals.open"), `ai: ["complete"]`<!-- /gen:permission-keys -->. A permission it lacks makes a call fail with the line to add, like `net: ["api.github.com"]`.
- `src/<id>.tsx`: the widget, its default export. Keep parsing and sorting in plain exported functions, and test them.
- `src/<id>.test.tsx`: `createHost({ terminals, agents, events, config, fetch, state })` is a fake cmd; `render(<Widget />, host)` returns the tree. Finders: `find(type, title?)`, `findAll`, `rows()`, `sections()`, `text()`. Hands: `press(node)`, `change(node, value)`, `submit`, `choose(node, label)` (a menu entry or a state's action). Matchers: `toHaveRow`, `toHaveSection(title, { count })`, `toHaveTitle`, `toHaveStat(label, value)`, `toShowState(kind, title)`. What it did: `host.calls` (acts, fetches, notifications), `host.requests` (every call). Fixtures: `fixtures.agent()`, `pane()`, `window()`, `event()`, `workspace()`.
- `src/<id>.story.tsx`: the widget as the default export, and one fake host's data per state (`HostData`, plus `size: "narrow" | "regular" | "wide"`), a comment above each. Import from `@cmd/widget-api/testing/host` and `/testing/fixtures` here, not `/testing` (that one needs Vitest).

## How a widget looks

It reads like one of cmd's own windows because it's made of the same pieces. The rules (the full ones, for cmd's own windows: https://github.com/janoelze/cmd/blob/master/.claude/skills/window-design/SKILL.md):

- `<Window status menu>` around a `<View state>`. The title bar, its icon and name, Refresh and Remove are cmd's: never draw your own title, refresh button or "updated" line. The answer at a glance goes in `status` ("2 running").
- Controls go in a `WindowToolbar` at the top of the View (<!-- gen:toolbar -->`ToolbarButton`, `ToolbarField`, `ToolbarSearchField`, `ToolbarSegmented`, `ToolbarMenu`, `ToolbarText`, `ToolbarSpacer`<!-- /gen:toolbar -->), never in a line of the body. The body opens with content.
- One list for things: `List` → `ListSection title count` → `ListRow onClick menu` with `ListRowIcon`, `ListRowContent title place detail`, `ListRowEnd` (a `Chip`, a `Badge`, `Text`). The name first, details dimmer, an age or count at the end. A row's `onClick` is its main action.
- Numbers: `Stat`, side by side in `Tiles` or an `Inline`; `Sparkline` for a recent series.
- States replace the body: `View state={{ kind, icon, title, text, action }}` for empty (what goes here, and how to get some), loading, no results (with a way back) and error (plain words). Never a spinner placed by hand.
- No boxes in the box: no cards around a section or list. Spacing is `Stack gap` / `Inline gap` in steps of the scale (`gap={2}`), `pad="inset"` around content that isn't a list.
- Tones, not colours (`tone="success" | "warning" | "danger" | "accent" | "dim"`); sizes as steps, never pixels; icons are SF Symbol names.
- Small choices a person makes (a filter, a tab) are `useStoredState(key, initial)`, kept per window across restarts.
- cmd's own data is live: <!-- gen:hooks -->`useWorkspace()`, `useAgents({ scope })`, `useTerminals({ scope })`, `useWindows({ scope })`, `useEvents({ types, since, limit, scope })`, `useGit()`, `useActions()`<!-- /gen:hooks -->. Never poll cmd. The outside world: `useData(fn, { every })` with `cmd.net.fetch`.
- Text: friendly and compact. Title Case for buttons and menu items, sentence case for the rest, no exclamation marks.
