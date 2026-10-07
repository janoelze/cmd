# Widgets and the Widget Library

> Status (2026-10-05), branch `widget-library`: built: widgets apart from windows in the core; the library's protocol and CLI; the library sheet, the Widgets menu and the sidebar's Widgets section; Agent Activity and Live Diff. Examples in the library were built and dropped (phase 5). Next: a store (see 14-magic-v2.md). It builds on [14-magic-v2.md](14-magic-v2.md) (widget folders, revisions, the edit view) and replaces its "Toward a store → A library" step. Naming here supersedes the Magic line in [15-positioning.md](15-positioning.md).

Magic widgets are windows today, in the code and to the people using them. "New Magic Widget" sits in File next to New Terminal, closing one throws it away (after 30 days in `widgets/closed/`), and nothing ships with cmd except the ability to make one. This proposal makes widgets their own thing for people, while the code keeps treating them almost like windows.

## What people already expect

Most people have used widgets before, on iOS, in macOS Notification Center and on the macOS desktop, and they bring that model with them:

- **Windows are where you work.** You open one, type in it, close it, and it's gone.
- **Widgets are things you keep an eye on.** You pick one from a gallery and put it somewhere. Taking it off the desktop doesn't destroy it: it is still in the gallery.
- **Finding and making are separate acts**, each with its own button.

What cmd adds is that you can make your own widget by describing it. That is one delightful extra in a model people already know, not a different model. An earlier draft made the library's search field also the prompt for a new widget (search, and ⏎ makes one if nothing matches). It was dropped: one field doing two jobs makes people guess which one they will get.

## The story

> **Windows** are where you work: terminals, agents, browsers, files, editors.
> **Widgets** show you something at a glance. They come from the **Widget Library**: some ship with cmd, and with **Magic** you make your own by describing what you want to see.
> Widgets you make stay in your library, so you can put them back whenever you like.

Every entry point, label and menu follows from these three sentences.

## Naming

- **Widget** is the one noun. There aren't two kinds of thing: a widget either comes with cmd or is one you made.
- **Magic** is how you make one. It names the act and the moment, the part that should feel delightful: the ✦, the prompt, watching it get built. "New Widget with Magic", "Made with Magic".
- **Workspace**: widgets and windows share it. Taking a widget away is **Remove from Workspace**, and getting rid of it is **Delete Widget**.
- Wire and storage names stay as they are (`magic` window kind, `magic.*` settings and RPC methods, `cmd magic`). New library methods are `widget.*`.

## The UI

### Where Magic shows

Magic is the brand of making, so it appears wherever a widget is being made or was made, and nowhere else:

- the ✦ on **New Widget with Magic…** (⇧⌘M, the shortcut New Magic Widget has today), in the menu, the palette and New… (⌘N);
- the library's own button, **✦ New Widget** (the sparkle icon says Magic), beside its search field (first a card in the grid; a button keeps making apart from finding);
- the making window itself: the prompt field, the live steps, the view drawing itself in. It is unchanged; it already feels right;
- "Made with Magic" under the name of widgets you made in the library (a ✦ on their avatar was tried and dropped: it read as noise); their title bars keep the sparkle icon of the Magic type;
- Edit Widget (⌘E) and Change (⌘L), which are Magic again: asking for a change.

### Entry points

Each action has one place and does one thing.

| Intent | How |
|---|---|
| "Open something new" | **New…** (⌘N, the top bar's +): windows, then widgets, then Magic (below) |
| "What's available?" | **Widget Library…** (⇧⌘L): a gallery. Its search field only searches. |
| "Make a new one" | **New Widget with Magic…** (⇧⌘M), ✦ New Widget in the library, or a request typed into New… |
| "Change this one" | **Edit Widget** (⌘E), **Change…** (⌘L) |
| "Take it off my workspace" | ⌘W: **Remove from Workspace** |
| "Get rid of it" | **Delete Widget**, only in the library or the widget's edit view, with a confirmation |

### Menus and sidebar

The library is ⇧⌘L, as Xcode's Library is: L for Library. ⌥⌘M looks natural next to ⇧⌘M but is taken: the Window menu's Minimize (⌘M) gets Minimize All (⌥⌘M) as its macOS alternate. ⌃⌘M would collide with ⇧⌘M on Windows (both become Ctrl+Alt+Shift+M, `otherPlatformKey`). ⇧⌘L becomes Ctrl+Alt+Shift+L there, also free.


- **File** starts with **New…** (⌘N), then holds windows only: Terminal (⌘T), Claude, Codex, Browser, File Browser, Text.
- A **Widgets** menu (after Space, before Window) holds Widget Library…, New Widget with Magic…, then the selected widget's commands: Change Widget…, Refresh Widget, Stop Making Widget, Remove from Workspace. The Magic View-menu items moved here; their ids (`file.newMagic`, `view.magic*`) stay, since keybindings.json uses them. Edit stays ⌘E in View (Toggle Preview / Edit), which already serves every window.
- The top bar's + is New…, as ⌘N is.

### New…

One picker for everything new, in the command palette's frame (`renderer/src/newItems.ts`, `components/NewPicker.tsx`), so the menu, the + and ⌘N offer the same things in the same order:

1. **Windows**, in the File menu's order, each with its own shortcut: Terminal, Claude Session, Codex Session, Browser Window, File Browser, Text Window. ⌘N ⏎ is a new terminal, as ⌘N was before.
2. **Widgets**: yours by last use, then the built-in ones. A pick is the library's Add (`widget.add`).
3. **New Widget with Magic** last. With text typed it becomes **Make “…” with Magic**, which opens a Magic window and starts making that request.

Groups keep this order whatever is typed; a query only ranks within a group, so "t" offers Terminal and Text Window before Timer. A typed URL or path offers **Open …** first (the palette's `window.openTarget`), and no Magic. Each window runs its own command, so it opens in the same Space and folder as from the menu. The direct shortcuts (⌘T, ⌥⌘N, ⇧⌘B, ⇧⌘O, ⇧⌘E, ⇧⌘M) skip the picker.
- The sidebar lists widgets in the Space in their own **Widgets** section, after Windows.

### The library

A sheet, like the palette or Settings, with a grid of tall cards, three to a row: an avatar top left (a built-in widget's icon, else the widget's initial, in a colour of its own from its name, like projects' chips in the sidebar), the name and where it comes from beside it ("Made with Magic" or "Built-in"), open space, and the description or what was asked for at the bottom. Screenshots (the latest revision's `shot.png`) are still listed (`WidgetEntry.shot`) but not shown: a hover preview could use them.

- **Your Widgets**: by last use. (A "Here" badge on widgets already in this Space was tried and dropped: unclear.) ✦ New Widget is a button beside the search field, not a card among them.
- **Built-in**: Agent Activity, Live Diff, and more over time.
- No **Examples** section. It was built (the Magic prompt's examples as widgets to add and change) and dropped: examples already live as the chips under the prompt when making a widget, and the library is for widgets you have.

Clicking a card adds the widget to the current Space and closes the sheet; ⏎ in the search field adds the first match. A card's menu (right-click, or its … button) has Add to Space, and for yours Rename…, Duplicate, Show in Finder and Delete…. Deleting a widget that is in a Space says its windows close too, closes them, then deletes (the core itself still refuses while a window shows it). The sheet asks the core for a fresh list when it opens; `widget.library` events keep it current. Built: `renderer/src/components/WidgetLibrary.tsx`.

### Making a widget

As today: the widget appears in the Space right away, as a prompt; you describe it and watch it being built. Two additions:

- Once it works for the first time it joins Your Widgets. A draft that was never built goes away when it is closed, so the library doesn't fill with attempts.
- The first time a made widget is removed from the workspace, a toast says where it went: "Removed “…” from the workspace. It's in your Widget Library." with Undo (a toast has one action). The flag is the `widgets.removedHint` UI state.

### Closing and deleting

⌘W on a widget is Remove from Workspace (the Widgets menu has it by name; File's item still reads Close Window, since menu labels are static). Widgets you made are kept until you delete them; there is no automatic cleanup, since that would break "it's still in the library". Sorting by last use keeps the library tidy enough. `widgets/closed/` goes away: its folders join the library on migration.

### Copies

The same widget can be on the workspace more than once (Agent Activity in every Space, the CI widget for two repositories). Each copy has its own settings (config, refresh, `cmd.state`) and runs in its own Space (`cwdFor(w)` already uses the window's Space). What the widget *is* (its files, revisions, problems) is shared: a change made from one copy updates all of them. Duplicate in the library is how you make a separate widget to change on its own.

### Terminal answers

When Magic decides a request is a command (`btop`, `watch …`), it opens a real terminal window with the command typed in and saves nothing to the library. A terminal is a window; a "widget that is a terminal" would blur the line again.

## Under the hood: widgets are windows

People see two things; the code mostly sees one. A widget on the workspace is an `AppWindow` like any other: same layouts, title bar, focus, persistence, sync and `viewFor`. What is new is that a widget also exists *without* a window.

Three layers:

1. **Widget type**: a `WindowType` with `role: "widget"` (default `"window"`), plus `description` and an optional `config` schema (same field shape as a manifest's `config`), exposed through `WindowTypeInfo`. Built-in widgets are their own types (`agents`, `diff`); every Magic widget shares the `magic` type. Plugins add widgets the same way later.
2. **Widget definition**: what the library lists. A built-in is its type. A Magic widget is its folder (`$CMD_HOME/widgets/<widget id>/`), with an id of its own, kept until deleted, plus library metadata (title, description, last used, made at).
3. **Widget instance**: a window. Its `MagicState` has what this copy needs (`widgetId`, `config`, `kv`, `refresh`, `health`, `status`, `lastData`) plus what it draws from the widget (the composed `html`, `revision`, `problems`, `steps`, `history`, `summary`). The folder is where those live: `widget.json` (title, history, summary, made, last used; agents can't write it) and the revisions. The window's copy is a cache, so it draws at once, and the core updates every copy when the widget changes.

Opening a widget from the library is `window.open({ kind, input })`, as for any window: `{ kind: "magic", input: { widgetId } }` or `{ kind: "agents" }`. For a Magic widget the core then fills the window from the folder (`MagicService.opened`).

What phase 1 settled in the core (`magic/service.ts`):

- A new widget gets a random id. A new request in a window whose widget is in the library makes another widget; it never overwrites one.
- One window at a time changes a widget; another window asking meanwhile is refused ("being changed in another window").
- A finished change, a restore and a hand edit reach every window showing the widget. The folder watcher is per widget and stays while any window shows it.
- Secrets (`widget-secrets.json`) are per widget, so every copy, and a later one, has them. Config, `cmd.state`, refresh, health and notifications are per window.
- Closing a window keeps its widget (last used is updated). A draft that never built is deleted with its last window.
- `deleteWidget` refuses while a window shows the widget.

### Built-in widgets are native

Built-ins are React views from `@cmd/ui`, registered like the other window types, not widget folders. They need data the core pushes as it changes (`agent.updated`, `fs.changed`, `git.status`), and a folder widget's data.ts is a Deno process on a timer in a sandbox with no way to reach the core. Native views also look first-party, which built-ins should.

The folder format reaches the library through the store, later (14-magic-v2.md, "Toward a store").

### First built-ins

Built in phase 4 (core types in `windows/builtin.ts`, views in `renderer/src/components/AgentActivity.tsx` and `LiveDiff.tsx`):

- **Agent Activity** (`agents`, state `{ scope: "space" | "all" }`): the agents of its Space or of all of them, waiting for you first, then working, then the rest by recency; subagents under their host. Each row says what the sidebar says (`fieldsOf`: name, status line, light), plus its project and how long ago its state changed; a click goes to the agent's terminal (a subagent's: its host's), in its Space. The bar counts who waits, works and is done, and switches scope (also in the window's menu). The data is the renderer's store (`agent.updated`), nothing new in the core.
- **Live Diff** (`diff`, state `{ path }`, default the Space's root; titled "Changes · <folder>"): the branch, ahead/behind, and each changed file with its state, +/− counts and its hunks (open when there are 6 files or fewer; a click toggles, a double-click opens the file). Files come from `git.status`, lines from the new `git.diff { path, file? }` (staged and unstaged against HEAD; with `file`, one file, an untracked one as all added). It refreshes at once when git's index or HEAD changes (fs.watch on them: stage, commit, checkout) and every 3 s while cmd is in front. Outside a repository it offers Choose Folder…, as its window menu does.
- **YouTube** (`youtube`, state `{ video?, list?, start?, fill? }`): a player filling the window. Empty, it asks for a link, video id or `<iframe>` embed code (`parseYouTube` in the core: watch, youtu.be, shorts, live, embed and playlist links, `t=`/`start=`). The player is youtube.com's embed page in a `<webview>` in the browser windows' session (an iframe would need the app's CSP opened, and YouTube refuses embeds without a Referer, error 153; the webview sends one). Signed out, YouTube may ask to "confirm you're not a bot": its Sign in opens a browser window, and the sign-in then holds for every webview. The video covers the window, cropped, by default; unchecking Fill Window (menu) letterboxes it instead (`fill: false`).
- No `config` schema on window types yet: both keep their one setting in their window state and change it in place. A schema is worth it when the edit view serves built-ins too.
- **Commands** (`commands`, state `{ scope, failedOnly? }`): every command the terminals ran, from OSC 133 C/D and the shell's exec request (`core/commands.ts`, `command.list`, event `command.updated`; in memory, the newest 300). Running first, then finished, newest first; failed ones say their exit status (130/137/143 count as stopped). A click goes to the terminal; Run Again types the command there when it is back at its prompt. Terminals cmd started an agent in are left out.
- **Notifications** (`notifications`, state `{ scope }`): the notifications sent since the core started, shown or not (`notify.list`, `notify.clear`, event `notifications.cleared`; the newest 200; `AppNotification.at`). Today, then Earlier; a click goes to the terminal or window it is about.
- **Resources** (`resources`, state `{ scope }`): CPU and memory per terminal's process tree (`Pane.usage`), busiest first, each expanding to its largest processes, then cmd itself (app, background). Polled every 2 s like the Task Manager.
- **Timer** (`timer`, state `{ duration, endsAt, left, rang }`): a countdown, changed with `{ duration }` or `{ action: start | pause | reset }`. The core rings it (`core/timers.ts`), so it ends on time in any Space, and sends a `timer` notification.
- The list widgets have no header of their own: the title bar names them, its status is their summary ("1 failed", "ends 14:30") and its menu button (`titleMenu`) switches This Space / All Spaces and has their options. Their lists are `@cmd/ui`'s Panel, ListSection, ListRow and Chip, the kit's version of the Navigator's and the file browser's look.
- Later, cheap: Listening Ports.

### Protocol

Built in phase 2:

- `WindowType.role` (`"window"` by default, `"widget"`) and `description`, the same in `WindowTypeInfo`. `magic`, `agents` and `diff` are widget types.
- Refs: `magic:<widget id>` for widgets made with Magic, `type:<kind>` for built-in widgets.
- `widget.list` → `WidgetEntry[]` (`{ ref, source: "builtin" | "yours", kind, title, description?, icon, shot?, createdAt?, usedAt?, windows }`): built-in widget types (every type with role `widget` but `magic`, which is the New Widget button), then yours by last use.
- `widget.add { ref, spaceId? | callerPaneId? }` → the new window. Refuses types that aren't widgets.
- `widget.rename { ref, title }`: the name sticks (`named` in widget.json); changes and hand edits keep it instead of the manifest's title.
- `widget.duplicate { ref }` → the new entry, titled "… copy": files, revisions and secrets copied.
- `widget.delete { ref }`: refused while a window shows it.
- Event `widget.library { entries }`, at most once per 50 ms burst, when a widget is made, changed, renamed, duplicated or deleted, or a window showing one opens or closes.
- Remote sessions get none of these yet (screenshots are file paths).
- `magic.*` methods keep addressing the window (instance). Those that change the widget (`magic.run` when changing, `magic.restore`) reach every window that shows it; `magic.secret` is per widget.
- CLI: `cmd widget list [--json]`, `cmd widget add <widget>` (a ref, an id or kind, or a title), in the terminal's Space.

### Migration

Built in phase 1. Folders of existing windows are named after their window's id, and those windows already have `widgetId`, so they keep working as they are. A folder without `widget.json` is described from its revisions and manifest until something writes one. `widgets/closed/<id>-<time>` folders that were built move into the library at startup (under `<id>`); the rest are deleted, and so is `closed/`. Secrets were keyed by window id, which is the widget id of every existing widget. v1 windows (a `source` in their state) get no library entry until their first change rebuilds them.

## Plan

One worktree per phase; each ends green.

1. **Widgets apart from windows** (core only, no visible change), built: widget ids, `widget.json`, no `closed/`, every copy updated on change, migration; `MagicService.library()`, `opened()`, `deleteWidget()`. Tests in `widgets.test.ts`.
2. **Registry and protocol**, built: `role`/`description` on window types; `widget.*` methods and event; `cmd widget list/add`.
3. **The library and the split**, built: the sheet, the Widgets menu, the sidebar's + and Widgets section, Remove from Workspace and its toast, new labels in `shared/commands.ts`.
4. **Built-ins**, built: Agent Activity, then Live Diff with `git.diff`.
5. **Examples**: built, then dropped (see The library). The changelog is written at release time (the changelog skill); a draft is below.

## Release notes (draft)

For whoever cuts the release with these changes in it; it passes `lintChangelog`. Renumber and redate it, and check it against what else the release has.

```markdown
### New

- **Widget Library.** ⇧⌘L shows your widgets and the built-in ones. A widget you take off the workspace stays there, ready to put back in any Space.
- **Agent Activity.** A built-in widget with every agent at a glance: who waits for you, who is working and what just finished.
- **Live Diff.** A built-in widget with the uncommitted changes in a project, updated as you work.

### Improved

- Widgets have their own menu and their own section in the sidebar, apart from your windows.
- New Magic Widget is now New Widget with Magic, still on ⇧⌘M.
```

## Open questions

- **A Widgets menu or a group in File?** The menu makes the split plainest, at the cost of one more menu bar item. Proposed: the menu.
- **Shared refreshes:** two copies with the same config and folder could share one data run. Not needed at first.
- **Per-Space libraries:** not proposed. A widget runs in the Space it's in, so one library serves every project.
