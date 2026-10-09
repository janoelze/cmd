# Workspace Actions

> Status (2026-10-09): plan, not built. Branch `workspace-actions`. From a #feedback idea (2026-10-08): "A widget that uses AI to gather the project's run commands and CLIs and make files to offer intelligent actions." The name may change; it lives in one string (`ACTIONS_TITLE`) and the internal id is `actions`.

A widget that knows how to run the project in its Space: `pnpm dev`, `make test`, `just release`, `docker compose up api`, the GitHub workflow that deploys. It finds them in the folder's own files, keeps them current as those files change, describes each in a few words, ranks them by what you actually run, and runs one with a click in the right place: long-running ones in a terminal of their own, a dev server's URL in a browser window, a deploy only after you confirm.

Read first: this doc, docs/16-widgets.md (built-in widgets), docs/17-ai.md (the AI service), docs/30-data-capabilities.md (the `command` events), the Commands widget (`renderer/src/components/CommandsView.tsx`), which already runs a command again in a terminal.

## Why

Every project has a dozen ways to run it, spread over package.json, a Makefile, a justfile, the README and the person's memory. Today you `cat package.json` or press ↑ until the command shows up. Agents have the same problem and read the same files every session. cmd already sees the folder, the terminals and every command run in them, so it can answer "how do I run this?" once, for people and agents alike.

## Prior art

| Tool | What it does | Take |
|---|---|---|
| VS Code | Auto-detects npm, Gulp, Grunt, Jake tasks; the NPM Scripts explorer: one tree per package.json, Run/Debug per row, `scriptExplorerExclude` (people hide `pre*`/`post*`) | A tree per package in a monorepo; hide lifecycle scripts by default |
| JetBrains | Run widget: the selected configuration with Run/Stop and a live running state; run icons beside scripts in package.json | Running state on the row, Stop beside it |
| Zed | `.zed/tasks.json`; `task: spawn` (fuzzy, ordered by recent use), `task: rerun`; `reveal`/`hide: on_success`; a task with an unresolved variable is hidden | Rerun Last Action; one-shot terminals that can go away on success |
| Conductor | `conductor.json` `setup`/`run`/`archive` scripts; one big Run button per workspace; 10 ports per workspace (`$CONDUCTOR_PORT`) | One primary action shown big; a port block per worktree (later) |
| Warp workflows / Raycast script commands | Parameterised commands with `{{arg}}` and a description; Warp's AI fills title, description and params | Precedent for model-written descriptions; arguments (later) |
| Atuin, Raycast | History by directory and by git repository; frecency ranking with decay | Rank by runs in this repository, recent ones higher |
| Warp Next Command | A model suggests the next command from history, exit code and output | Later: "lockfile changed → install" |
| `ni` / package-manager-detector | Lockfile → package manager, then the `packageManager` field, then walk up | Copy the order |

Sources: research notes from 2026-10-09 (VS Code tasks docs, zed.dev/docs/tasks, docs.conductor.build/core/scripts, just.systems, taskfile.dev, mise.jdx.dev, docs.atuin.sh, raycast changelog, antfu-collective/package-manager-detector).

## What counts as an action, and where it comes from

An **action** is a command line that does something useful in this folder, with a name. Sources, each a small parser registered like transcript sources (`actions/sources.ts`, `builtin.ts`):

| Source | Files | Gives | Hide |
|---|---|---|---|
| npm / pnpm / yarn / bun | `package.json` `scripts`, workspace packages (`pnpm-workspace.yaml`, `workspaces`) | `<pm> run <name>`, `<pm> --filter <pkg> run <name>` per package | `pre*`/`post*` with a matching script, `install`, `preinstall`, `postinstall`, `prepare`, `prepublishOnly`, `prepack`, `postpack` |
| Make | `Makefile`, `GNUmakefile` | `make <target>`; `## comment` after the target is its description | `.PHONY`, `.`-targets, pattern rules (`%`), variables, file targets with a `/` or `.` |
| just | `justfile`, `.justfile` | `just <recipe>`; doc comments and `[doc]`, `[group]` | `[private]`, `_`-recipes |
| Task | `Taskfile.yml` | `task <name>`; `desc` | `internal: true` |
| mise | `mise.toml` `[tasks]`, `mise-tasks/`, `.mise/tasks/` | `mise run <name>`; `description` | `hide = true` |
| Deno | `deno.json(c)` `tasks` | `deno task <name>`; `description` | |
| Composer | `composer.json` `scripts`, `scripts-descriptions` | `composer run <name>` | event hooks (`pre-*-cmd`, `post-*-cmd`) |
| Python | `pyproject.toml`: `[tool.poe.tasks]`, `[tool.pdm.scripts]`, `[tool.hatch.envs.*.scripts]`, `[project.scripts]` | `poe x`, `pdm run x`, `hatch run x`, `uv run x` (uv if `uv.lock`) | |
| Cargo | `Cargo.toml`, `.cargo/config.toml` `[alias]` | build, test, run (per `[[bin]]`), clippy; aliases (`cargo xtask`) | |
| Procfile | `Procfile`, `Procfile.dev` | each line, long-running | |
| Docker Compose | `compose.y(a)ml`, `docker-compose.y(a)ml` | `docker compose up`, per service `up <svc>`, `logs -f <svc>`, `down`; `ports:` give URLs | |
| VS Code | `.vscode/tasks.json` (JSONC) | `shell` and `process` tasks with a `label` | tasks with `${…}` variables we can't fill |
| Scripts | executables in `scripts/`, `bin/` (one level) | `./scripts/x.sh`; the first comment line is its description | non-executables, `bin/` files that are build output |
| GitHub Actions | `.github/workflows/*.y(a)ml` with `on: workflow_dispatch` | `gh workflow run <file>` (only if `gh` is on PATH); risky | |
| README | `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `AGENTS.md`: fenced `sh`/`bash`/`console` blocks under setup/development/usage headings | Suggestions only, through the model (see AI) | anything already found above |

**Parse, never run.** Every source reads files; none runs the project's tools. `make -qp`, `gradle tasks`, `nx show`, `rake -T` and friends evaluate project code, can be slow, and the folder may be one you just cloned. The parsers miss some cases (Makefile includes, Nx inferred targets); that is the price. A later, opt-in "Ask the tools" step can run the safe listers (`just --dump --dump-format json`, `task --list-all --json`, `mise tasks ls --json`) with a timeout.

New dependencies: `yaml` and `smol-toml` (both small, no dependencies) in `packages/core`. JSONC: strip comments and trailing commas ourselves.

**The package manager** follows package-manager-detector: lockfile in the folder (`bun.lock(b)`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`), else the `packageManager` field, else walk up to the repository root, else npm.

**Which folder.** The widget's folder is its Space's root (`cwdFor`), or a path set in its state (as Live Diff does). A monorepo's root actions come first, then one section per workspace package, collapsed. Sources look only at the root and the declared workspace packages, never a recursive scan (node_modules, vendored repos).

### The action

```ts
type WorkspaceAction = {
  id: string;            // "<source>:<relative file>:<name>", stable across edits
  name: string;          // "dev", "test:e2e", "release"
  command: string;       // what is typed: "pnpm run dev"
  cwd: string;           // the package's folder
  source: { kind: string; file: string; line?: number };
  package?: string;      // workspace package, in a monorepo
  kind: "dev" | "test" | "build" | "check" | "deploy" | "setup" | "clean" | "run";
  long: boolean;         // a server or watcher: never "done"
  risky: boolean;        // deploy, publish, release, db reset/drop/migrate: confirm first
  description?: string;  // author's (doc comment, desc) or the model's
  describedBy?: "author" | "model";
  url?: string;          // known before running: compose ports, a --port in the script
  hidden?: boolean;      // lifecycle scripts; shown under "More"
};
```

`kind`, `long` and `risky` come first from rules (name: `dev|start|serve|watch` → dev, long; `test|spec|e2e` → test; `build|dist|bundle` → build; `lint|fmt|format|check|typecheck` → check; `deploy|release|publish|ship` → deploy, risky; `clean|reset` → clean; `migrate|seed|db:*` → setup, risky when `reset|drop`. Command: `vite`, `next dev`, `astro dev`, `rails s`, `uvicorn`, `manage.py runserver`, `nodemon`, `--watch`, `docker compose up` → long), then the model may correct them.

## Keeping it current

The core has an `ActionsService` (`packages/core/src/actions/`), holding one **catalog** per folder that someone is looking at (refcounted: a widget showing it, a palette open, a CLI call caches it for a minute).

- **Watch** each source file through `WatchService` (it watches the parent folder, so creating a justfile is seen), plus `.git/HEAD` so a branch switch rescans. Debounce 300 ms, re-parse only the files that changed, then diff: if the set of actions changed, emit `actions.changed { root }`.
- **Hash** each action (`command` + `name` + `source`) to know which ones the model needs to describe.
- Parsing runs as a scheduler job and yields between sources; a whole scan should take under 20 ms on cmd's own repo. Measure and log it.
- Malformed files (half-saved package.json) keep the last good actions from that file and flag the source with its error instead of emptying the list.

## AI: descriptions, groups and suggestions

The widget works without AI. With a provider set up (`ai.status().ready`), the fast tier fills in what rules can't:

- **Input** (through `buildContext`, so it is redacted and recorded as an `ai.call`): the actions without an author description (name, command, file, package, the rules' guess at kind), the package.json `description`/README's first paragraph, and the fenced command blocks from the README/CLAUDE.md/AGENTS.md. Budget ~6k tokens.
- **Output** (`AiService.object` with a schema), per action: `description` (2–6 words, a verb first: "Start the dev server", "Run unit tests once", "Ship a signed release"), `kind`, `long`, `risky`, and one `primary` action for the folder (the big Run button: usually dev). Plus up to 5 `suggestions` from the README blocks that no source covers (e.g. `docker run …`, `ngrok http 3000`), each with a name and description.
- **Cache** in a table on `core.store.db`: `(root, action hash) → description, kind, long, risky, model, at`, so a restart or another widget costs nothing, and an edit re-describes only the changed actions. One call per folder per change, `background: true`, after a 2 s quiet period.
- Author descriptions always win; the model never rewrites them. The UI shows the command under every description, so a wrong description can't hide what runs.
- Setting `actions.describe` (on): off means rules only and no calls.

## Ranking

Order within a section: pinned first, then by use, then file order.

**Use** comes from the data log: `command` events with this folder's `projectId` (or under the root), the last 90 days. A run counts for an action when the typed command matches it after normalising (`pnpm dev` = `pnpm run dev`, `npm run dev`, `pnpm --filter app dev` for that package, `make test`, `just test`, `./scripts/x.sh` = `scripts/x.sh`). Score = Σ 0.5^(age/14 days), so last week's habits beat last year's.

**From your history** (a section after the rest): commands run here at least 3 times, that succeeded, and match no action (`docker compose up api`, `cargo run -- --port 9000`), up to 5. They can be pinned, which saves them as actions of this folder (stored per root; later maybe written to a file).

## Running

| The action | Click runs it… |
|---|---|
| long (dev server, watcher) | in its own terminal named after it ("dev"), in this Space. Running already: the row shows Running, and the click goes to it. Stop sends ⌃C; Restart sends ⌃C, waits for the prompt, runs again |
| one-shot (test, build, lint) | in its last terminal if it is back at its prompt, else a new one |
| risky | the same, after a confirmation that shows the command |
| ⌥-click | types it into the focused terminal without Return (as `typeInTerminal` does), to edit first |

The core tracks runs: `actions.run { root, actionId, spaceId }` creates the pane with `pane.create { cwd, command, spaceId }`, remembers `actionId → paneId`, and follows the pane's OSC 133 marks (`PaneManager.command`, `command` events) for running, exit code and duration. The row shows ● running, ✓ passed, ✕ failed (status 130/137/143 count as stopped), with the time.

**URLs.** For terminals started by an action, the core scans their output (ANSI stripped) for `http://(localhost|127.0.0.1|0.0.0.0|[::1]|*.local):port`, the first one after start wins, and puts it on the run. The row gets a chip `localhost:5173` that opens a browser window in the same Space (`window.open { kind: "browser" }`). Setting `actions.openBrowser` (off): open it by itself the first time. Later: listening ports from procinfo for servers that print nothing.

## The widget

Kind `actions`, role widget, in the Widget Library as "Workspace Actions", state `{ path?: string, pinned: string[], collapsed: string[] }`. Built from `@cmd/ui` `ListSection`/`ListRow`, like the Commands widget:

```
 Workspace Actions · cmd                      [⌕]
 ┌──────────────────────────────────────────────┐
 │ ▶  dev        Start the app with HMR    ● 2m │  primary, big
 │    pnpm dev               localhost:5173 ↗   │
 └──────────────────────────────────────────────┘
 Test                                          3
   ▶ test        Run all unit tests      ✓ 12s
   ▶ e2e         Drive the built app
 Build                                         2
 Check                                         1
 Deploy                                        1
   ▶ release     Bump, tag and push   ⚠
 From your history                             2
   ▶ pnpm core:stop --terminals             ×14
 More (lifecycle, hidden)                      4
```

- A row: name, description (dimmed), command in mono on hover or when selected, the status at the end; hover buttons Run/Stop, Open Source (the file at its line in a text window), Pin.
- A search field when there are more than 12 actions; the arrow keys and ⏎ work.
- Monorepo: root first, packages as collapsed sections.
- Empty: "No scripts in ~/src/foo" and a line on what it looks for. A source with an error: a small Callout "package.json can't be read: line 12".
- No AI: rows show the name and the command; a quiet "Set Up AI for descriptions" (as the Journal does).
- The title bar summary (`useWidgetStatus`): "1 running".

## Beyond the widget

- **Palette:** an "Actions" group with the focused Space's actions ("Run dev", "Run test"), ranked the same way. "Rerun Last Action" is a command with a shortcut and a menu item (Terminal menu).
- **CLI:** `cmd actions [--json] [path]` lists, `cmd actions run <name>` runs one in a new terminal in the Space. Agents get "how do I run this project" without reading four files; the hook's session-start context could mention it.
- **Remote:** `actions.list` read, `actions.run`/`stop` control, in `REMOTE_ACCESS`.

## Protocol

Methods: `actions.list { path?, spaceId? } → { root, actions, suggestions, sources: {file, error?}[], describing: boolean }`, `actions.run { root, actionId, spaceId, mode?: "new" | "type" }`, `actions.stop { root, actionId }`, `actions.pin { root, command, name? }`. Event: `actions.changed { root }` (lists and run states). Settings: `actions.describe`, `actions.openBrowser`, `actions.hide` (regexes of names to hide, default `^(pre|post)`).

## Phases

1. **Discovery.** `ActionsService`, sources for npm-family (with workspaces and package manager), Make, just, Task, mise, Deno, Composer, Python, Cargo, Procfile, Compose, VS Code, scripts/; rules for kind/long/risky; watching; `actions.list` + `actions.changed`; `cmd actions`. Tests with fixture folders per source, plus a watch test.
2. **Widget and running.** The `actions` widget, runs tracked in the core, Stop/Restart, ⌥-click, confirmation for risky ones, palette group, Rerun Last Action.
3. **AI.** Descriptions, primary, corrections, README suggestions, the cache table, the setting. A small eval on 10 real repositories under `~/src` (descriptions read well, nothing risky marked safe).
4. **History.** Ranking from `command` events, "From your history", pinning.
5. **URLs.** Output scan, the chip, `actions.openBrowser`.
6. **Later.** GitHub workflows with inputs; opt-in tool listers; arguments (`{{name}}`, Zed-style variables like the focused file); listening ports from procinfo; a port block per worktree (docs/11-spaces.md `CMD_SPACE_PORT`); suggestions from state ("the lockfile changed: install?", "the build failed: run test?").

## Open questions

- The name: "Workspace Actions" in the library. cmd's word for a folder is Space; "Actions" alone may be enough inside a Space.
- Should the primary action also sit outside the widget (a Run button on the Space in the sidebar, Conductor-style)?
- Where pinned "From your history" commands are stored: cmd's database (private, per Mac) or a file in the repository (shared, e.g. `.cmd/actions.json`)? Database first.
- One-shot terminals: keep them, or close on success after a few seconds (Zed's `hide: on_success`)? Keep first; closing loses the output.
