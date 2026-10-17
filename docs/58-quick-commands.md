# Quick Commands

**Status:** partly built (2026-10-17): phases 1 and 2; project commands and Save as Quick Command… not yet.

> Status (2026-10-17), branch `quick-commands`: built as proposed, with these differences. Choices are `{{pick:name=a,b}}` (commas), a modifier goes after a pipe (`{{selection | raw}}`, `{{x | url}}`), and `{{x?}}` is optional. Only what looks meant as a variable is one: `{{.Names}}` and other templates' braces stay text, a misspelt `{{fiel}}` is an error. `type` with no terminal selected runs in a new one. `{{file}}` is a text-like window's file (not a file browser's selected row). The core reads the clipboard (`pbpaste`) only when a body uses it. The palette's ask step is a sheet (`shell/quick/QuickSheet.tsx`) that also asks for the yes of an "Ask before running" command and shows the text it will run. Hotkeys stay on the command: main puts them on the Session → Quick Commands items (`quick:<id>`) and leaves out any an app command has, so `resolveKeybindings` is unchanged; Settings says whose a shortcut is. Reordering is Move Up/Down, not drag. The editor is a page in the list's place (the title bar shows the command's name with a back chevron, `TitleBand`'s `back`; Esc goes back), not a sheet: a sheet was cramped by the Settings window. The page starts with a `PageIntro` (the kit's explainer for a settings page whose feature needs one), and the variables are `Pill`s under the command box (`ask…`/`pick…` insert one with its name selected), not a menu. Loading checks every known key's type (`readQuickCommands`): a command with one wrong (`"confirm": "yes"`) is left out and named in Settings and `cmd quick`, and `null` counts as left out. Added `quick.resolve` (the text, what's missing, the asks) and `quick.move`. No tool runs them for agents (`TOOL_ACCESS` and `REMOTE_ACCESS` say never); the CLI runs them as `cmd actions run` does. Code: protocol `quick.ts`, `jsonc.ts` `editJsoncItem`, core `quick/`, CLI `quick.ts`, renderer `shell/quick/`, `settings/QuickCommands.tsx`, main `menu-template.ts`; e2e `quick`.

Commands and prompts you save once and run from anywhere in cmd: `git push -u origin {{branch}}` in the focused terminal, `docker compose logs -f {{ask:service}}` in a new one, `claude "Review {{file}} for missing tests"` in a new terminal, "Review {{file}} for missing tests" typed into the Claude session you are looking at, `https://github.com/acme/app/pull/{{ask:number}}` in a browser window. You keep them in Settings → Quick Commands, run them from the palette, the menu bar, a hotkey or the CLI, and fill in what they need from what you are looking at.

Read first: docs/39-workspace-actions.md (the commands cmd finds in a folder; Quick Commands are the ones you write yourself), `apps/desktop/src/shared/commands.ts` (app commands, the menu bar, keybindings), docs/55-approvals.md (when an agent runs one).

## Why

Everyone has a handful of lines they type every day that no file in the project names: the SSH hop, the log tail, the "push this branch and open a PR", the same review prompt to an agent. Today they live in shell history, aliases or a notes file. Workspace Actions covers what the project's files say; this covers what the person says. cmd also knows what they are looking at (the folder, the file, the branch, the selection), so a saved command can take that in instead of being retyped around it.

## The name

"Quick Commands". "Shortcuts" is taken twice over: Settings → Keyboard Shortcuts (the name macOS, VS Code, Warp and most Mac apps use for key combos; `keybindings.json` is only the file) and Shortcuts.app. "Commands" alone is the app commands' word (the palette's Commands group, `COMMANDS`, `registerCommands`). Tabby uses "Quick commands" for the same idea.

In code the feature's id is `quick`: methods `quick.*`, event `quick.changed`, core folder `packages/core/src/quick/`, protocol `quick.ts`, command ids `quick.<id>`. The user-facing string lives in one constant (`QUICK_TITLE`), as `ACTIONS_TITLE` does.

## Prior art

| Tool | What it does | Take |
|---|---|---|
| Raycast | Script Commands (files with `@raycast.*` headers, up to 3 typed arguments, output modes silent/compact/full); Snippets and Quicklinks with `{clipboard}`, `{cursor}`, `{date}`, `{argument name="…" default="…"}`, modifiers (`{clipboard \| trim}`); an alias and a global hotkey per item | Context and prompt variables in one syntax; a hotkey per item; a misspelt placeholder is inserted as text without a word, which we don't copy |
| Warp | Workflows (YAML in `~/.warp/workflows` and `.warp/workflows`, now Warp Drive): name, `{{arg}}` command, description, arguments with `default_value`; picking one types it in for editing, tab between the fields | `{{…}}` (shell code is full of `{…}`); "type it in" as a choice beside "run it" |
| Zed | `tasks.json`, global and per project; `$ZED_FILE`, `$ZED_WORKTREE_ROOT`, `$ZED_SELECTED_TEXT`; `use_new_terminal`, `reveal`, `hide: on_success`, `allow_concurrent_runs`; a task whose variable can't be filled is hidden | Where it runs is a field; no context, no command (disabled, not run with a blank) |
| VS Code | `tasks.json` with `${file}`, `${workspaceFolder}`, `${input:x}` (`promptString`, `pickString`); keybindings to `terminal.sendSequence` with a `when` clause | Pick lists as well as free text |
| iTerm2, kitty, WezTerm, Ghostty | A key that sends text (iTerm2 also a snippet library) | The usual complaint: a global key that can't tell where you are |
| Claude Code, Cursor | Saved prompts as Markdown in `.claude/commands/`, `$ARGUMENTS` | A prompt is no target of its own: `claude "…"` is a command, and a running agent's terminal takes typed text |
| Tabby, Termius | Quick commands / snippets sent to the current tab (Termius: to several hosts) | The name |

Sources: research notes from 2026-10-17 (manual.raycast.com/dynamic-placeholders, docs.warp.dev/features/workflows, zed.dev/docs/tasks, code.visualstudio.com/docs/editor/tasks, docs.claude.com slash commands; iTerm2, kitty, WezTerm, Tabby and Termius from memory, unchecked).

What keeps coming back: a name, a body and parameters in a plain file; a personal scope and a project scope; variables that are both context and prompts; run it or type it in; where it runs as a field; one list behind every surface. All of that is phase 1 here except the project scope.

## The quick command

```ts
interface QuickCommand {
  /** Stable across renames: a slug made once from the first name ("push-branch"). */
  id: string;
  name: string;
  description?: string;
  /** The command line, prompt or URL, with {{variables}}. */
  body: string;
  target: QuickTarget;
  /** "type": press Return after it (default true). Off: left for you to edit. */
  submit?: boolean;
  /** "terminal": the folder it starts in, may use variables (default {{folder}}). */
  cwd?: string;
  /** Shortcuts, Electron accelerator syntax, as in keybindings.json. */
  keys?: string[];
  /** Ask before running, showing the resolved text (a deploy, a force push). */
  confirm?: boolean;
  /** Only in the workspace with this folder (its root; ~ allowed). Unset: in every workspace. */
  workspace?: string;
}

type QuickTarget =
  | "terminal"  // a new terminal in the workspace runs it (pane.create { command })
  | "type"      // typed into the selected terminal (pane.write), Return if submit
  | "open";     // a URL or path opened in a cmd window (window.openTarget: routing.ts picks the type)
```

`type` needs a selected terminal (a shell or an agent in it): without one the command is disabled (menu, palette) and the CLI says why. Several steps in one command, and output modes (run hidden, show the last line as a toast, as Raycast's silent/compact), are later.

**Prompts are commands.** A new agent with a prompt is a `terminal` command (`claude "Review {{file}}"`, `codex "…"`): cmd detects the agent from the terminal's process, as for any it didn't start. A prompt to an agent already running is `type` into its terminal: Return sends it. So there is no agent target. What changes when the selected terminal runs an agent is only the quoting (below).

## Where they are kept

`~/.config/cmd/quick-commands.json` (`configDir()`, so a worktree's instance has its own), JSONC with a header that says what it is, like `keybindings.json`:

```jsonc
// cmd Quick Commands. Edit them in Settings → Quick Commands, or here; changes apply live.
// Variables: {{folder}}, {{file}}, {{selection}}, {{ask:name}}… (Settings lists them all).
[
  { "id": "push-branch", "name": "Push Branch", "body": "git push -u origin {{branch}}", "target": "type", "keys": ["Ctrl+Alt+P"] },
  { "id": "review-file", "name": "Review File", "body": "Review {{file}} for missing tests.", "target": "type" }
]
```

- **The core owns it**: `QuickService` reads it, watches it (`lib/watch.ts`), keeps the last good list and an error when a save leaves it broken (as Workspace Actions' sources do), and writes it through `editJsonc` so comments and order survive. Main and the renderer read it with `quick.list` and hear `quick.changed`.
- **Why a file, not SQLite**: it can be edited by hand, kept in dotfiles and copied to another Mac; it is small and only the person writes it. Pins and history in Workspace Actions stay in the database: those are cmd's bookkeeping, not the person's text.
- **Hotkeys are kept on the command** (`keys`), not in `keybindings.json`, so a command and its key are added and removed together. Main merges them into the bindings as `quick.<id>`.
- **Project commands** (phase 2): `.cmd/quick-commands.json` in a repository, the same format, committed and shared. They come in as a Workspace Actions source (`actions/sources`, kind `quick`), so they get its ranking, run tracking, Stop/Restart and URL chips, and they show in the palette's Actions group of that workspace only. This also answers docs/39's open question about where saved history commands go.

## Variables

`{{name}}`, as Warp: shell code is full of single braces (`${HOME}`, `{a,b}`, `awk '{print $1}'`), double ones are rare. A `{{` that isn't a variable is an error shown in the editor, never inserted as text (Raycast's silent typo).

**From what you are looking at** (the `CommandContext` the command runs in: the selected window, or the row a context menu is on):

| Variable | Value | None when |
|---|---|---|
| `{{folder}}` | the selected window's folder (`CommandContext.folder`: a terminal's cwd, a file browser's folder, a file's) | nothing selected: falls back to `{{workspace}}` |
| `{{workspace}}` | the workspace's root | never |
| `{{file}}` | the text window's file, a file browser's selected file | no file |
| `{{selection}}` | the selected text in a terminal or editor | nothing selected |
| `{{clipboard}}` | the clipboard's text | empty |
| `{{branch}}` | the folder's branch (`lib/checkout.ts`) | not a repository |
| `{{repo}}` | the repository's top folder | not a repository |
| `{{url}}` | the browser window's page | not a browser |
| `{{date}}`, `{{time}}` | now, `2026-10-17`, `15:49` | never |

**Asked for when it runs:**

- `{{ask:service}}`, `{{ask:service=api}}`: a text field, with a default.
- `{{pick:env=dev|staging|prod}}`: a choice, the first one picked.

The same name twice is asked once. A command with asks opens a second step in the palette (one field per ask, Tab between them, ⏎ runs, the resolved text shown under them), whether it was started from the palette, the menu or its hotkey. The palette has no such step today; it is new kit work (`Palette.tsx`).

**When a variable has no value**, the command doesn't apply: disabled in the menu, left out of the palette (its `when`), refused by the CLI with the variable named. `{{name?}}` makes it optional (empty instead).

**Quoting.** Values go into a shell command shell-quoted (`'…'`, `'\''` inside), so a copied `$(rm -rf ~)` is text, not a command: every `terminal` body, and a `type` body when the selected terminal is at a shell prompt. `{{selection:raw}}` opts out per use, and the editor marks raw uses. A `type` body typed into an agent (the pane's foreground process is one, `agents/`) is prose: values go in as they are. `open` bodies URL-encode values in a URL (`{{selection:url}}` explicitly). A `terminal` run also gets the values as environment (`CMD_QUICK_FILE`, `CMD_QUICK_SELECTION`…, `pane.create { env }`), so a script it starts can read them without quoting at all.

**Where they are resolved.** One parser in protocol `quick.ts` (pure: the variables and asks a body uses, and filling them in with the quoting above), used by the editor (errors, preview), the renderer (what to ask, `when`), the core and the CLI. The renderer sends what only it knows (selection, clipboard, the selected window's file and URL, the folder) with the run; the core adds the branch and repository and runs it. The CLI passes `--var name=value` and gets the folder from its pane.

## Running it

`quick.run { id, context, values, confirmed? }`, in the core, by target: `pane.create` in the workspace (named after the command), `pane.write` to the selected pane, `window.openTarget`. A `confirm` command is refused unless `confirmed`; the renderer asks first with the resolved text (the same confirm Workspace Actions uses for risky actions).

Who runs it matters (docs/55): the person running their own command from the menu, the palette or a key is not asked anything beyond `confirm`. An agent running one through the CLI or MCP is asked as for what the target does: "Type into terminals and agents" for `type`, "Run project commands" for `terminal`, "Open websites" for a URL; `confirm` commands as risky Workspace Actions (never auto-approved), and the deny-list applies to the resolved text.

## Where they show up

- **Settings → Quick Commands.** A page of its own beside Keyboard Shortcuts (`NAV` in `SettingsWindow.tsx`, not generated from the schema; the component in `settings/QuickCommands.tsx`). A list (name, body in mono, hotkey) with Add, reorder by drag, and an editor for the selected one: Name, Description, Body (a code field with an Insert Variable menu and inline errors), Target (with Submit, Folder or Agent as the target needs), Hotkey (the recorder Keyboard Shortcuts uses, with clashes named), Ask Before Running, and a preview of the body resolved against the window that was selected when Settings opened. "Open quick-commands.json" at the bottom, as Keyboard Shortcuts has for its file. Built from `@cmd/ui` (the `window-design` and `prototype` skills; a story per state). Wording follows the `copywriting` skill.
- **Palette.** A Quick Commands group before Actions (`quickItems()` beside `actionItems()` in `shell/palette.ts`): the name, the description or body as meta, the hotkey as hint. Only those that apply.
- **Menu bar.** A Quick Commands submenu of the Session menu (decided 2026-10-17), with every command in the file's order, its hotkey as a real key equivalent (so it beats the terminal, like every app command), disabled when it doesn't apply, then New Quick Command… and Edit Quick Commands…. Built like Open Recent: a `{ quick: true }` part in `menu-template.ts` fed through `MenuLists`, rebuilt on `quick.changed`. Enabled state comes from the renderer as for other commands (the registry's `when` for `quick.<id>`).
- **Hotkeys.** `resolveKeybindings` learns `quick.<id>` ids (today it rejects ids outside `COMMANDS`). A key a command already has, or another quick command, is a clash shown in both Settings pages; the app command keeps it.
- **CLI.** `cmd quick` lists them (`--json`), `cmd quick run <name or id> [--var k=v…] [--yes]`. Through `quick.list` and `quick.run`.
- **Saving one** (phase 2): "Save as Quick Command…" on a terminal's command (its context menu, from the `command` events), on a "From your history" row in Workspace Actions, and on a prompt typed to an agent. It opens the editor filled in.

## Protocol

As Workspace Actions does, kept out of the shared registries: protocol `quick.ts` declares `QuickMethods`, `QuickEvent` and the types (`Methods` and `CoreEvent` take them in); the core's `quick/feature.ts` makes the service, its handlers and teardown and is listed in `kernel/features.ts`.

- `quick.list {} → { commands: QuickCommand[]; path: string; error?: string }`
- `quick.save { command: QuickCommand; before?: string } → QuickCommand` (add or replace; `before` places it)
- `quick.remove { id } → null`
- `quick.run { id; context?: QuickContext; values?: Record<string, string>; confirmed?: boolean } → { paneId?: PaneId; windowId?: WindowId }`
- Event `quick.changed {}`.

No settings keys in phase 1. Remote access (the phone: list and run) later, in `REMOTE_ACCESS`, with `type` and `terminal` as control.

## Phases

1. **The file and the service.** `quick.ts` (types, parser, quoting; unit tests for every variable, quoting and error), `QuickService` (read, watch, last good list, write with comments kept), `quick.list/save/remove/run`, `cmd quick`. Core tests with a temporary config dir.
2. **The app.** Settings → Quick Commands, the palette group and its ask step, the menu, hotkeys through `resolveKeybindings`, `confirm`. e2e: add one in Settings, run it from the palette into a terminal and see it typed; its hotkey from the menu bar.
3. **Project commands and saving.** `.cmd/quick-commands.json` as a Workspace Actions source, Save as Quick Command…, agents' approvals.
4. **Later.** Several steps, output modes, remote access, App Intents (Shortcuts.app and Spotlight run them).

## Decided

- (2026-10-17) The menu: a Quick Commands submenu of Session, not a menu of its own.
- (2026-10-17) Commands are global by default. One can be kept to a workspace (`workspace`: its root folder, chosen in the editor's Workspace menu or `cmd quick add --workspace .`): it is only in that workspace's Session menu and palette, the core refuses to run it elsewhere, and two kept to different workspaces may share a shortcut. A folder rather than the workspace's id, so the file reads well and survives a workspace closed and opened again.
- (2026-10-17) Project commands aren't confirmed on their first run.

- (2026-10-17) No agent targets: a prompt is a command (`claude "…"`) or text typed into an agent's terminal.
