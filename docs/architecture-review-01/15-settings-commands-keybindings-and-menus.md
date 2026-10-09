# 15 Settings, commands, keybindings and menus

**Score: 6/10** · reviewed 2026-10-10 against commit ddb7832 · scope: the settings schema and file, the generated Settings window, the command list, menu bar, keybindings, palette and context menus

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 6/10 | One schema and one command list drive everything, but enablement, handlers and context menus sit in `App.tsx`, not with the commands |
| Correctness & robustness | 4/10 | A settings.json with a syntax error drops to defaults, and the next change from the UI or CLI deletes every other setting |
| Performance | 8/10 | Menu state is sent only when it changes; reloads compare snapshots; nothing here is hot |
| Security | 7/10 | API keys are kept out of settings.json and the CLI reads them from stdin; storage itself is doc 03's (AR1-03-08) |
| Testability & tests | 6/10 | Good schema, layout and keybinding tests; no test of a broken file, of enablement, or of palette ranking |
| Extensibility | 5/10 | Four god lists (schema, layout, commands, handlers); no `when`, no list or map types, no command contributions |
| Code health | 7/10 | Small, readable files with clear top comments; key-specific branches creep into the generic form |

## What this system is

**Settings** are a flat dotted-key schema, `SETTINGS_SCHEMA` in `packages/protocol/src/settings.ts` (572 lines): 101 keys (43 boolean, 23 number, 20 string, 15 enum), each with a default, a description, optional `details`, display hints (`unit`, `labels`, `code`, `control`: font/theme/model) and an optional `applies` (`newTerminals` on 3 keys, `firstLaunch` on 1). The same file holds validation (`validateSetting`, `resolveSettings`), a hand-written JSONC parser, 8 renamed keys (`RENAMED_SETTINGS`) and 3 removed ones. The core's `SettingsService` (`packages/core/src/settings.ts`, 152 lines) loads `~/.config/cmd/settings.json`, watches it (FSEvents plus a 1 s poll), writes it atomically, and lets consumers `bind(keys, fn)`. Clients get `settings.get/set/reset` and the `settings.updated` event. The CLI has `cmd settings [get|set|reset|path|secret]` (`packages/cli/src/main.ts:384-436`). API keys live in a separate secrets service (doc 03).

**The Settings window** (`renderer/src/settings/`, its own page) builds each row from the schema: `SettingsWindow.tsx` (550), page and section placement in `layout.ts` (165, with `when` predicates for provider-dependent rows), live state in `useSettings.ts` (55), and four hand-made panels: `About.tsx` (247), `Remote.tsx` (216), `AgentHooks.tsx` (64), `NotifyPermission.tsx` (81). It also hosts Keyboard Shortcuts, with a recorder.

**Commands** are one list, `COMMANDS` in `apps/desktop/src/shared/commands.ts` (262 lines): 99 commands (67 with default keys, 18 hidden from the palette), plus the macOS-to-Windows key mapping and the keybindings.json overlay. Main builds the menu bar from it (`main/menu.ts`, 251) and loads and watches `keybindings.json` (`main/keybindings.ts`, 87). Menu clicks and accelerators go to the focused app window's renderer as `command` IPC (`commandSender`, `menu.ts:230-250`). There `App.tsx` runs them from a typed `handlers: Record<CommandId, () => void>` (`App.tsx:410-549`) and logs each run as a `user.command` event. The palette (`components/Palette.tsx`, 317) lists commands, actions and sessions with a subsequence scorer and recents. Context menus (`context.ts`, 23 lines; 22 call sites in 13 files) are ad hoc lists of `{label, run}` that main shows natively.

Design docs: docs/07-ui-vision.md (palette prefixes), docs/39-workspace-actions.md (the palette's Actions group), README's shortcuts and settings sections, and the copywriting skill (Title Case for titles, descriptions of 60 characters or less). `CommandsView.tsx` is the shell-command history widget and has nothing to do with app commands. It belongs to doc 16.

## What is good

- **One schema, many surfaces.** The Settings window, the CLI listing (`cmd settings`), validation, defaults and the `Settings` type all derive from `SETTINGS_SCHEMA`; adding a key is one entry plus one placement. Copy this pattern for any other config.
- **Live apply holds up.** I traced all 101 keys to their consumers. The renderer reads settings from the store when it renders or acts (`terminals.ts:239-269` diffs the previous settings and reconfigures live terminals). The core uses `settings.bind` (`core.ts:270, 288, 289, 335-336, 383, 480, 559`), and main mirrors `updates.mode`, `diagnostics.crashReports` and `workspaces.ownWindow` from the event. The three `newTerminals` keys are honest (they only matter when `panes.ts` spawns). Only small mismatches are left (AR1-15-07).
- **Errors are reported, not thrown.** An invalid value or an unknown key falls back to the default and shows as a red callout at the top of the Settings window (`SettingsWindow.tsx:149, 238`), and `cmd settings` prints it too (`main.ts:434`).
- **Renames are handled.** `RENAMED_SETTINGS` reads old names, and writing a key drops its old names (`settings.ts:83-99`). Keybinding ids get the same treatment (`space.*` → `workspace.*`, `commands.ts:189`).
- **Keybindings are well thought out.** `resolveKeybindings` takes over a shortcut from the command that had it. The Settings recorder says so ("⌘K was Command Palette's; it no longer has it"), refuses unmodified keys, works by physical key (`acceleratorOf` uses `e.code`), turns menu accelerators off while recording, and writes only the diff from the defaults (`editKeybindings`). `writeKeybinding` refuses to rewrite a file that doesn't parse (`keybindings.ts:65-72`); settings.json should do the same (AR1-15-01).
- **The Windows/Linux keymap is principled:** the Windows Terminal convention (`otherPlatformKey`, `commands.ts:158-167`), with collisions resolved and tested (`commands.test.ts:26`).
- **The handler map is typed** against `CommandId`, so a command without a handler fails tsc. The settings layout test makes every key appear exactly once.

## Issues

### AR1-15-01 · Never write settings.json from a failed parse, and edit it in place

- **Status:** done (7e25ce90)
- **Severity:** high
- **Effort:** S (< ½ day)
- **Where:** `packages/core/src/settings.ts:107-124`, `packages/core/src/settings.ts:126-142`, `packages/protocol/src/settings.ts:550-572`

**Outcome.** `scripts/stage-runtime.mjs` now stages workspace packages' own dependencies (jsonc-parser).

**Problem.** When settings.json doesn't parse (a missing comma while someone edits it by hand), `#load` sets `#raw = {}`, and every setting jumps to its default while the file is broken: fonts, theme and paddings change under the user. If anything then calls `settings.set` (a toggle in the Settings window, `cmd settings set`, `remote.enable`, which writes `remote.enabled`), `#write` builds the new file from that empty `#raw` and atomically replaces the user's file. Every other setting and every comment is gone. Comments are also lost on every ordinary write (the code says so at line 126). Separately, the trailing-comma regex in `parseJsonc` runs over string contents too, so a value containing `, ]` or `, }` is silently changed.

**Evidence.** Reproduced against the real `SettingsService` (a script in the review's scratchpad): a file holding `font.codeSize: 16`, `terminal.cursorStyle: "bar"`, `shell.program: "/bin/zsh"` and a `// my notes` comment, with one comma removed; then `s.set("ui.gutter", 12)`. The file afterwards contains only the template header and `"ui.gutter": 12`. While broken, `font.codeSize` read 14 (the default). `parseJsonc('{ "data.exclude": "a, ]b" , }')` yields `"a ]b"`. No test covers a broken file followed by a write (`packages/core/test/settings.test.ts` has 10 tests, none for this).

**Proposal.** (1) On a parse failure, keep the last good `#raw` and snapshot and add the error, so values don't jump. (2) Make `set`/`reset` refuse to write while the file doesn't parse, with the same wording keybindings already use ("settings.json: … Fix it first."). The UI already shows `settings.set` errors as a callout. (3) Replace `parseJsonc` and the rewrite with `jsonc-parser` (VS Code's own: `parse` with `allowTrailingComma`, and `modify` + `applyEdits` to change one key in the text). Comments, order and formatting then survive every write, and both the comment in `settings.ts:126` and the one in `keybindings.ts:62` go away. Use the same helper for keybindings.json.

**Success criteria.**
- [x] A test writes a valid file, breaks it, calls `set`: the call throws, and the file's bytes are unchanged.
- [x] A test breaks the file and checks `settings` still holds the last good values and `errors` names the parse error.
- [x] A test sets a key in a file with comments and a trailing comma: the comments and the other keys' lines are unchanged.
- [x] `parseJsonc` (or its replacement) returns `"a, ]b"` for that string value.
- [x] `grep -n "drops comments" packages/core/src/settings.ts apps/desktop/src/main/keybindings.ts` returns nothing.

### AR1-15-02 · Give commands a `when` and derive menu, palette and context-menu state from it

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `apps/desktop/src/renderer/src/App.tsx:572-623`, `apps/desktop/src/renderer/src/App.tsx:831-838`, `apps/desktop/src/renderer/src/App.tsx:627-760`, `apps/desktop/src/shared/commands.ts:5-17`, `apps/desktop/src/shared/commands.ts:141-143`

**Problem.** `CommandSpec` has no notion of when a command applies. Enablement is a hand-kept map in one `useEffect` in `App.tsx` that covers 28 of 99 commands and is sent only to the menu bar. The palette ignores it: with no agent selected, "Copy Session ID", "Summarize Session" and "Rename Agent" are listed and do nothing when chosen (their handlers start with `currentAgent &&`, `App.tsx:509-515`). The other 71 commands are always enabled, even where they can't act (⌘S Save on a terminal, Refresh Widget with no widget). Context menus don't use the command list at all. Thirteen entries re-implement commands under the same labels ("Copy Session ID", "Copy Resume Command", "Summarize Session", "Clear Buffer", "Find…", "Copy Last Command Output", "Show Folder in Finder" ×2, "Move to Board", "Close Workspace…"…). They don't show the shortcut, and they work out enablement again, differently: "Summarize Session" reads `aiStatus()?.ready` at `App.tsx:653`, the menu reads `aiReady` at `App.tsx:577`. So CLAUDE.md's "one list drives the menu bar, the palette and context menus" holds for the menu bar only.

**Evidence.** `cmd.setMenuState({ enabled: { … } })` at `App.tsx:582-622` has 28 keys and a 15-item dependency list with an eslint-disable. `paletteItems` (`App.tsx:831-838`) filters only on `paletteHidden`. A script over the 13 files that call `showContextMenu` found 101 literal labels, 13 of them equal to a command's label. `ContextItem` (`commands.ts:143`) has no accelerator or command id.

**Proposal.** Use VS Code's context-key idea, but typed and without a string expression language. The renderer keeps one small `CommandContext` (selection kind, has agent, has session, ai ready, workspace count, dock side…), computed once per render in a hook. Each command gets `when?: (c: CommandContext) => boolean`. Menu state is then `COMMANDS.map(c => [c.id, c.when?.(ctx) ?? true])`, sent when it changes. The palette drops commands whose `when` is false. Context-menu entries can name a command, `{ command: "session.copyId", args }`, and inherit its label, accelerator (add `accelerator` to `ContextItem`) and enablement. Ad hoc entries remain only for one-off actions. `when` lives with the handler (AR1-15-03), not in `shared/commands.ts`, so main stays free of renderer state. Doc 09 (AR1-09-09) covers menu roles and bindable-but-not-in-menu commands. Doc 08 (AR1-08-11) covers terminal-owned ⌘-keys.

**Success criteria.**
- [ ] `grep -n "setMenuState" apps/desktop/src/renderer/src/App.tsx` shows a generic call with no per-command literal map.
- [ ] A unit test builds the palette items for a context with no agent and checks that `session.copyId`, `session.summarize` and `session.rename` are absent.
- [ ] Context menus for a sidebar row and a terminal reference command ids for the 13 duplicated entries, and the script above reports 0 labels equal to a command label.
- [ ] Native context menus show the shortcut for entries backed by a command (checked in `pnpm e2e` or by a unit test on the built `ContextItem`s).

### AR1-15-03 · Let features and window types contribute their commands and handlers

- **Status:** open
- **Severity:** medium
- **Effort:** L (> 2 days)
- **Where:** `apps/desktop/src/renderer/src/App.tsx:410-556`, `apps/desktop/src/shared/commands.ts:21-129`, `apps/desktop/src/renderer/src/components/FilesView.tsx:500-512`, `apps/desktop/src/main/menu.ts:36-201`
- **Depends on:** AR1-15-02

**Problem.** Every command's behaviour is a closure in a 140-line object inside `App.tsx` (998 lines) and depends on App's local state. A feature (widgets, actions, sidebars) can't own its commands. Each new one edits three central places: `COMMANDS`, the `handlers` map and the menu template, which CLAUDE.md lists among the registries that conflict most on rebase. Window types already contribute context-menu entries (`viewFor(kind).menu`, `.actions`), but not commands. So views bind their own ⌘-keys outside the list, where users can't see or remap them. The file browser handles ⌘D, ⌘⌫, ⌘↑, ⌘↓ and ⇧⌘N (new folder, `FilesView.tsx:506-511`). ⇧⌘N is also File › New Window…, so one of the two can't fire, and nothing in the menu or the Keyboard Shortcuts page says which. This breaks "every shortcut must be a real menu item".

**Evidence.** `handlers: Record<CommandId, () => void>` spans `App.tsx:410-549`. `menu.ts` places all 99 ids by hand in `buildMenu`. `grep -c metaKey` finds ⌘-key handling in `FilesView.tsx` (6) and `terminals.ts` (6); `json-view.tsx` and `image-view.tsx` only pass ⌘-keys on. `"Shift+Cmd+N"` is `file.newWindow`'s default (`commands.ts:40`).

**Proposal.** Keep a static manifest of ids, labels, default keys and menu placement (`shared/commands.ts`, extended with `menu: "File/2"`) so main can build the menu before any renderer runs and keybindings.json ids stay stable. Move behaviour into contributions: `registerCommands(feature, { "files.newFolder": { when: c => c.selectionKind === "files", run } })`, called from each feature's or window type's module (00-research §10: VS Code's `.contribution.ts` pattern). `App.tsx` keeps only the app-shell commands. The menu template is generated from `menu` placement and checked by a test. Window-type commands (`files.newFolder`, `files.duplicate`, `files.trash`, `text.save`) become real menu items under their window's name. With `when` (AR1-15-02), the same key can mean different things in different windows, which lets ⇧⌘N stay New Window while a files-only binding takes over in the file browser.

**Success criteria.**
- [ ] `handlers` in `App.tsx` has at most 30 entries; the rest are registered from feature or window-type modules.
- [ ] `grep -nE "e\.metaKey && " apps/desktop/src/renderer/src/components/FilesView.tsx` returns nothing; its shortcuts are commands listed under Settings → Keyboard Shortcuts.
- [ ] A test asserts that every command id appears in the generated menu template exactly once (shown or hidden).
- [ ] Adding a command to a window type touches only that window type's files and `shared/commands.ts` (demonstrated by the first migrated window type's diff).

### AR1-15-04 · Lock the shipped setting keys so a removal can't skip its migration

- **Status:** open
- **Severity:** medium
- **Effort:** S (< ½ day)
- **Where:** `packages/protocol/src/settings.ts:442-462`, `packages/protocol/src/settings.ts:534-547`

**Problem.** Migrations are two hand-kept lists: a rename map (key to key) and a removed set. Nothing enforces them, and neither can change a value. When a key leaves the schema without an entry in one of them, anyone who had set it gets a permanent red "unknown setting" callout at the top of every Settings page, with no way to fix it in the UI. That has already happened once. A rename that changes a value's type (a comma string becoming a list, AR1-15-05; an enum losing an option) has no mechanism at all: the old value fails validation and silently reverts to the default.

**Evidence.** Across the 857 commits, 113 distinct keys have appeared in the schema. All but one are in the schema now, in `RENAMED_SETTINGS` or in `REMOVED_SETTINGS`. `canvas.cardZoom` was added in c275292 and removed in 98e7664 ("Canvas: no read-only cards") without either entry, so a user's `"canvas.cardZoom": 0.5` now reports `unknown setting "canvas.cardZoom"`.

**Proposal.** Add `packages/protocol/settings-keys.lock` (one key per line, every key ever shipped) and a test that fails when a locked key is in neither the schema, `RENAMED_SETTINGS` nor `REMOVED_SETTINGS`, and when a schema key is missing from the lock (append it). Replace the rename map with an ordered `SETTINGS_MIGRATIONS: { from, to?, value?: (old) => unknown }[]` applied in `resolveSettings`, so a type change can carry the user's value over. A file `$version` is not needed while every migration is idempotent and keyed by name. Also show unknown keys in the Settings window as a quiet note with a "Remove from settings.json" button, not as a danger callout.

**Success criteria.**
- [ ] `settings-keys.lock` exists with 113+ keys, and a test fails if `canvas.cardZoom` is taken out of `REMOVED_SETTINGS`.
- [ ] A test migrates a value through a `value` transform (e.g. a comma string to a list) and checks the resolved setting.
- [ ] `resolveSettings({ "canvas.cardZoom": 0.5 }).errors` is empty.
- [ ] An unknown key in settings.json shows in the Settings window with a working remove action (unit test on the snapshot plus the row).

### AR1-15-05 · Add list and map setting types instead of comma-separated mini-languages

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `packages/protocol/src/settings.ts:20-43`, `packages/protocol/src/settings.ts:180-185`, `packages/core/src/windows/types.ts:109-116`, `packages/core/src/core.ts:144`, `packages/core/src/core.ts:987`, `packages/core/src/data/service.ts:260-264`
- **Depends on:** AR1-15-04

**Problem.** The schema has four types (string, number, boolean, enum). Four settings that are really lists or maps are encoded as comma-separated strings, each with its own parser and no validation: `open.handlers` (`"md: browser, log: text"`), `data.exclude` (folders, `host:` and `cmd:<regex>` rules), `agents.homes` and `search.archiveDirs` (paths). A typo such as `md: brower` is accepted and silently does nothing, since `parseOverrides` never checks the window type. A folder whose name has a comma can't be listed. A `cmd:` regex containing a comma is split in half. The UI is a single-line text field, and the CLI round-trips a string the user has to quote.

**Evidence.** Four separate parsers: `parseOverrides` (`windows/types.ts:109`), `splitList` (`core.ts:144`), an inline split (`core.ts:987`) and `parseExclude` (`data/exclude.ts`, read at `data/service.ts:262`). `validateSetting` (`settings.ts:503-522`) checks only `typeof value === "string"` for all four. VS Code models the same idea as a map (`files.associations`) and lists (`files.exclude`), with per-item validation and a list editor in its settings UI.

**Proposal.** Add `{ type: "list"; item: "string" | "path" | "pattern"; default: string[] }` and `{ type: "map"; keys: "extension"; values: readonly string[] | "windowType"; default: Record<string,string> }` to `Def`. Validate per item; window-type values are checked in the core, where the registry lives. Migrate the four keys with a `value` transform (AR1-15-04), so existing strings become arrays and objects. The Settings window gets a list control and a key/value control, added to `@cmd/ui` with gallery specimens as CLAUDE.md requires. `cmd settings set` accepts JSON for these types. Per-workspace or per-window overrides are not needed yet: nothing in the 101 keys asks for them, and per-workspace view state already lives in `ui.*`. Leave them out until a concrete key needs one.

**Success criteria.**
- [ ] `SETTINGS_SCHEMA["open.handlers"].type === "map"`, and the three other keys have `type: "list"`.
- [ ] `grep -n "split(\",\")" packages/core/src/core.ts packages/core/src/windows/types.ts` returns nothing for these settings.
- [ ] A test: `{ "open.handlers": { "md": "brower" } }` yields an error naming the unknown window type.
- [ ] A test: an old comma string for each of the four keys resolves to the equivalent list or map.
- [ ] The gallery has specimens for the new list and map controls.

### AR1-15-06 · Move the Settings window's per-key special cases into layout.ts

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `apps/desktop/src/renderer/src/settings/SettingsWindow.tsx:169-194`, `apps/desktop/src/renderer/src/settings/SettingsWindow.tsx:257-273`, `apps/desktop/src/renderer/src/settings/layout.ts:9-22`

**Problem.** The form is mostly generated, but the generic page loop knows specific keys. It adds the index status row after the section that contains `search.archiveDirs`, the hooks panel before the one that contains `agents.peers`, and the macOS permission panel before the one that contains `notifications.needsInput`. `ItemRow` swaps in custom rows for the two API keys and `ai.provider`, and the Remote and About pages are separate branches. Moving a key to another section moves the panel with it by accident, and the next special row adds another `if`.

**Evidence.** I count six key-specific branches in `SettingsWindow.tsx` (lines 170, 172, 187, 191, 193, 262) plus `aiKeyOf`. The schema-driven part handles the 4 types and 3 `control` hints in `SettingRow` (`:292-321`).

**Proposal.** Let a `layout.ts` item also be `{ panel: ComponentType<RowContext> }` and `{ key, row: ComponentType<…> }`, so sections declare their extra panels and custom rows where they are placed (VS Code does the same with custom setting renderers keyed in the layout, not in the list). `SettingsWindow` keeps one loop with no setting names in it, and the placement test grows to cover panels.

**Success criteria.**
- [ ] `grep -nE '"(search\.archiveDirs|agents\.peers|notifications\.needsInput|ai\.provider)"' apps/desktop/src/renderer/src/settings/SettingsWindow.tsx` returns nothing.
- [ ] `settings-layout.test.ts` still passes and checks that each panel is placed exactly once.
- [ ] The Settings window looks the same (gallery or `pnpm e2e` screenshot of the AI & Agents and Notifications pages).

### AR1-15-07 · Make `applies` say when each key really takes effect, and check that every key is read

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `packages/protocol/src/settings.ts:10`, `packages/protocol/src/settings.ts:195`, `packages/protocol/src/settings.ts:344-349`, `apps/desktop/src/renderer/src/App.tsx:115`, `apps/desktop/test/settings-layout.test.ts:12-17`

**Problem.** `applies` has two values, and two keys don't fit either. `ui.defaultView` is marked `firstLaunch`, but it is the default view mode for every workspace without a stored one (`useWorkspaceView("view.mode", cfg["ui.defaultView"])`), so it applies to new workspaces, not only to the first launch. `agents.peers` affects only agents started after the change ("Each new agent hears…") but isn't marked, so the UI and `cmd settings set` don't add their "applies to …" note. The core's headless `terminal.scrollback` is fixed at spawn (doc 04, AR1-04-07). The copy test allows descriptions of 70 characters, while the copywriting skill says 60; three are longer (`workspaces.ownWindow` 62, `actions.openBrowser` 64, `remote.enabled` 64).

**Evidence.** I mapped every key to the files that read it: 101 keys, 100 with a live consumer or an honest mark, plus `ui.defaultView` and `agents.peers` as above. No test fails when a schema key has no reader at all.

**Proposal.** Rename `firstLaunch` to `newWorkspaces` and add `newAgents`. Mark `ui.defaultView` and `agents.peers`. Add a test that greps the sources for each key's literal and fails on a key no non-test file reads (a dead setting). Set the description limit in the test to the skill's 60.

**Success criteria.**
- [ ] `SettingApplies` includes `newWorkspaces` and `newAgents`; `ui.defaultView` and `agents.peers` carry them.
- [ ] A test lists keys with no reader outside the schema, layout and tests, and expects none.
- [ ] The description-length test uses 60, and the three long descriptions are shortened.

### AR1-15-08 · Rank the palette by word starts, and let it find settings and synonyms

- **Status:** open
- **Severity:** low
- **Effort:** M (1–2 days)
- **Where:** `apps/desktop/src/renderer/src/components/Palette.tsx:29-44`, `apps/desktop/src/renderer/src/App.tsx:831-838`

**Problem.** `score` returns 100 minus the position of a plain substring match and otherwise counts gaps. It gives no bonus for word starts or acronyms and ignores ids and synonyms, so the obvious result often loses: "nt" ranks Rename Agent first (the substring in "Age**nt**") and New Terminal outside the top three, and "rc" puts Search and Workspace Actions above Restart Core. "preferences" finds nothing (Settings), and "zoom" doesn't find Bigger, Smaller or Actual Size. Settings can't be reached from the palette at all, though "Toggle blinking cursor" or "Appearance: light" is the kind of thing people type into a palette.

**Evidence.** I ran the palette's `score` over the 81 visible command labels: `"nt"` gave 21 matches with Rename Agent, cmd Documentation and Next Needing Attention on top; `"rc"` gave Search, Workspace Actions, Restart Core; `"preferences"` gave 0. There are no tests of the scorer (`grep -rn "score" apps/desktop/test` returns nothing).

**Proposal.** Replace `score` with a word-boundary scorer that gives first-letter and camel-case matches a large bonus and penalises gaps. VS Code's `fuzzyScore` and fzf's v2 scoring do this; either is about 80 lines to port. Score `label`, then `aliases?: string[]` on `CommandSpec` ("preferences", "zoom in"), then the id. Add a "Settings" group: booleans and enums toggle or cycle in place, and other types open the Settings window at the key (`openSettings(page)` already takes a page). Recents already work and stay as they are.

**Success criteria.**
- [ ] A table test: "nt" → New Terminal first, "rc" → Restart Core first, "nw" → New Window… in the top two, "preferences" → Settings… first, "zoom" → Bigger in the top three.
- [ ] Typing "blinking" in the palette lists the Blinking cursor setting, and choosing it flips `terminal.cursorBlink` (unit test on the generated item).
- [ ] The scorer has its own test file in `apps/desktop/test`.

### AR1-15-09 · Show keybindings.json errors where people look, and let the CLI read shortcuts

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `apps/desktop/src/main/keybindings.ts:27-49`, `apps/desktop/src/renderer/src/settings/SettingsWindow.tsx:435-439`, `packages/cli/src/main.ts:384-436`

**Problem.** keybindings.json is loaded by main and settings.json by the core, so they have two watchers, two error paths and two surfaces. A keybindings.json that doesn't parse, or names an unknown command, shows its errors only on the Keyboard Shortcuts page, and only when no search is active (`{!q && …}`). Nothing tells the user that their file was ignored. `cmd` has no way to list or check shortcuts, though agents edit these files for the user. The keybindings watcher, unlike the settings one, has no poll backstop for missed FSEvents (`settings.ts:69-72` explains why the backstop exists).

**Evidence.** `loadKeybindings` collects `errors` and only `SettingsWindow.tsx:435` displays them. `grep -n keybinding packages/cli/src/main.ts` returns nothing. `watchKeybindings` uses `fs.watch` alone.

**Proposal.** When keybindings.json or settings.json has errors after a change, show one toast in the focused app window ("settings.json has an error. Fix It…" opens the file), following the copywriting skill. Add `cmd keybindings [--json]`, which prints the resolved bindings and errors (main already exposes them over IPC; route them through a core method, or have the CLI read the file with the shared `resolveKeybindings`). Give the keybindings watcher the same poll backstop as settings.

**Success criteria.**
- [ ] Breaking keybindings.json while cmd runs shows a toast in the app window (`pnpm e2e` step or a renderer unit test on the event).
- [ ] `cmd keybindings --json` prints `{ bindings, errors }`, and a CLI test covers an unknown command id.
- [ ] `watchKeybindings` uses `fs.watchFile` as a backstop, as `SettingsService.watch` does.

## Course corrections

1. **Stop the settings file from losing data** (AR1-15-01). This is the one defect that destroys user state, and the fix is small and has a ready model in `writeKeybinding` and `jsonc-parser`.
2. **Give commands a context and let features own them** (AR1-15-02, then AR1-15-03). Enablement, palette filtering and context menus would then come from one place, the 140-line handler object leaves `App.tsx`, and view-local shortcuts become real, remappable menu items. This is the structural change the next dozen commands will otherwise pay for. It pairs with AR1-08-11 (terminal keys) and AR1-09-09 (menu roles).
3. **Make the schema able to evolve** (AR1-15-04, then AR1-15-05): a key lock with value migrations, then list and map types that carry the four comma-string settings over without losing anyone's value.
4. **Keep the form generic** (AR1-15-06), and make `applies` and the copy limits exact (AR1-15-07).

## Quick wins

AR1-15-01, AR1-15-04, AR1-15-06, AR1-15-07, AR1-15-09.
