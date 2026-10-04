# Magic widgets v2: widgets that keep working

> Status (2026-10-04), branch `magic-v2`: built as described here. Not yet: a widget library and store (see "Toward a store"), images sent to models that don't take them, and pausing refreshes while a window is hidden. [12-magic-widgets.md](12-magic-widgets.md) is the v1 design; this replaces its output contract, data sources and data model.

v1 asked the model for one answer: a JSON header naming a data source (a URL or a shell command), then an HTML page that parsed whatever came back. It looked good in a demo and went stale in use. v2 makes a widget a small typed app that cmd builds, runs and checks like code.

## What went wrong in v1 (from real windows)

Looking at the Magic widgets and logs on Jan's Mac (2026-10-04):

1. **Stale meant the source was failing, and the window didn't say why.**
   - "live listing of the ci jobs of cmd project" fetched `api.github.com` without logging in, although `gh` was installed and logged in. The prompt itself listed api.github.com among "public APIs without keys".
   - Its first try (`curl … | xargs curl`) was refused by the policy, and it fell back to unauthenticated curl.
   - It then hit GitHub's rate limit (HTTP 403) on every refresh from 13:18 to 16:40, backing off at most 10×. All the window showed was "Stale".
2. **Views were written against one sample.** "show local git changes" tested its source on a clean repository, so the view never saw a changed file.
3. **Views parsed raw text in the browser**: RSS through `DOMParser`, `git status` split on `@@` markers, `scutil` output by regex. A small change in a tool's output broke the view without an error.
4. **`cmd.state` never persisted.** The frame is sandboxed without `allow-same-origin`, so `localStorage` throws a `SecurityError`. `host.js` fell back to memory without saying so, and volumes, "seen" markers, sparkline history and timer starts were lost on every reload.
5. **Internal text leaked into the UI.** A repair prompt meant for the model ("You didn't test the source…") stayed in a window's error line for good, because successful refreshes never cleared `state.error`.
6. **Nothing rendered the widget before it was shown.** Only the CLI's eval took screenshots. Script errors went to a `main.log` that starts over at every launch.
7. **No history.** Closing a window deleted its widget, and a change overwrote the only copy.

## What others do (research, 2026)

- **agent-widgets** ([Surdeddd/agent-widgets](https://github.com/Surdeddd/agent-widgets)) is the closest match to what Magic wants to be:
  - an agent writes a typed model, a SwiftUI view and a feed script in any language;
  - the tool validates the feed's JSON against the model;
  - `aw preview` renders every size × theme × sample into one contact sheet, with flags for overflow, truncation and decode errors;
  - the agent loops on that report until it is clean.
- **Run, observe, repair** is now standard in AI app builders:
  - Replit Agent 3 tests in a browser;
  - Lovable feeds console and network errors back;
  - Bolt shows preview errors as fixable alerts;
  - Claude Artifacts has "Try fixing with Claude".

  v0 measured that LLM code fails about 10% of the time without deterministic fixers after streaming ([Vercel](https://vercel.com/blog/how-we-made-v0-an-effective-coding-agent)). tldraw found that iterations get much more stable when the model sees a screenshot of its last result.
- **Typed contracts between data and view** (MCP Apps' `tool-result`, OpenAI Apps SDK's `structuredContent`, agent-widgets' models) keep views away from raw text.
- **Golden fixtures** make a view testable without a live source: WidgetKit's placeholder and snapshot, agent-widgets' samples.
- **Stores** (Raycast, Grafana, Home Assistant/HACS, SwiftBar, MCP Apps) share the same parts:
  - a manifest;
  - declared permissions shown at install;
  - a config schema with secret fields;
  - an automated validator, plus review;
  - signing or hash pinning;
  - semver and changelogs.
- **Runtimes on macOS:**
  - Deno has per-host network and per-path file permissions; `--allow-run=<bin>` still escapes them, hence the sandbox around it.
  - Node's permission model can't gate the network usefully.
  - Bun has no sandbox.
  - Python works best through `uv run --script` (PEP 723, a lock file), but needs an OS sandbox.
  - `sandbox-exec` is still the only general sandbox on macOS (Claude Code and Codex use it).

## The design

### A widget is a folder

`$CMD_HOME/widgets/<window id>/`:

| File | What it is |
|---|---|
| `manifest.json` | `title`, `size`, `refresh`, `permissions {net, run, env, read}`, `config` (fields a person sets, `secret` ones kept by cmd), `media`, `kind` (`widget` or `terminal` + `command`) |
| `data.ts` | Deno TypeScript: `export const schema = s.object({…})`, `export default async function data(config): Promise<Data>` |
| `view.html` | the markup and a short `<style>` |
| `view.ts` | the view's script: `import type { Data } from "./data.ts"; cmd.onData<Data>(…)` |
| `fixtures/*.json` | data the view must also handle; `live.json` is the last real data |
| `static.json` | data that never changes (pasted JSON) |
| `revisions/NNNN/` | each version: its files, `meta.json` (what was asked, checks passed, model), `shot.png` |

The window's state keeps only what it needs to draw: `widgetId`, `revision`, the composed view, the last data, `health`, `config`, `kv` (`cmd.state`). Closing a window moves its folder to `widgets/closed/`, where it is kept for 30 days.

### data.ts: typed, permissioned, sandboxed

- **The `cmd` module** (`packages/core/widget-runtime/cmd.ts`) has no dependencies, so widgets start in milliseconds and work offline. It provides:
  - schemas: `s.object/array/string/number/enum/union/…`, `Infer`;
  - `run(program, args)` / `runJson`: no shell, so arguments are an array and the parsing happens in TypeScript;
  - `fetchJson` / `fetchText` / `get`, which throw an `HttpError` carrying `Retry-After` and rate-limit resets;
  - `xmlItems` for feeds, `columns` for text tables, `home` / `expandHome`.
- **The runner** (`widget-runtime/runner.ts`) imports data.ts, calls it with the config, validates the result against `schema`, and prints one result line. The function's own `console.log` goes to stderr.
- **Deno runs with flags built from the manifest:**
  - `--allow-net=<hosts>`, `--allow-run=<programs>`, `--allow-env=<names>`;
  - `--allow-read=` limited to the widget folder, the runtime and the folders the manifest lists;
  - `--no-remote --no-npm --no-prompt`, and no writes.
- **The whole process also runs under the `sandbox-exec` profile.** It allows no writes except Deno's cache, and hides private paths. Programs that use a login (`gh`, `glab`, `kubectl`, `docker`, `tailscale`) get their config folder and keychain, as in v1.
- **Shells and interpreters can't be declared** (`sh`, `python`, `osascript`, …), because they would turn `--allow-run` into "run anything".
- Deno is found in this order: the `magic.deno` setting, cmd's own copy (`magic.installRuntime` downloads it into `$CMD_HOME/runtime/deno`), PATH, Homebrew, `~/.deno`.

### view.ts: checked against the data

`deno check` type-checks `view.ts` together with `data.ts`, using a `deno.json` that cmd writes into the folder: `cmd` resolves to the runtime, and the frame's `cmd` object is typed (`widget-runtime/view.d.ts`). A view that reads a field the schema doesn't have fails the check, the bug behind "written against one sample". Node's `stripTypeScriptTypes` then turns view.ts into the frame's script. Only `import type` is allowed.

### Building: the agent checks its own work, then cmd checks it again

`buildWidget` (`packages/core/src/magic/build.ts`):

- **Tools:**
  - `run`, `read`, `list`, `fetch` to look around (read-only, as in v1);
  - `write_file`, `edit_file` and `read_file` on the widget folder only;
  - `check`: the manifest, and types for both files;
  - `run_data`: data.ts exactly as cmd will run it, saved as `fixtures/live.json`;
  - `preview`: renders and returns a screenshot.
- **The prompt** (`prompt/prompt.md`, plus whole example widgets in `prompt/examples/<name>/`) asks for one way of working: find out first, write the files, check, run_data and read the data, preview and look at it, finish with one sentence. It also asks for:
  - logged-in CLIs before raw APIs;
  - slow refreshes for rate-limited services;
  - a fixture for the case the live data doesn't show (a clean repo gets `fixtures/busy.json`);
  - data that reports "missing" instead of throwing;
  - ambiguous choices made into config fields.
- **After the agent finishes**, cmd runs `verifyWidget` itself: manifest, types, a data run, and renders.
  - Problems go back to the agent, twice at most.
  - The build is accepted when it passes, or kept with "problems left" when it renders without script errors.
  - Anything worse brings back the previous version's files.
- Fast paths are unchanged: pasted JSON becomes the JSON view with `static.json`, and an obvious command becomes a terminal widget.

### Previews

`widgets/preview.ts` renders these cases:

- live data, dark and light, at the widget's size;
- live data at 240×150;
- every fixture.

Each render reports script errors, whether anything was drawn, and overflow.

- **In the app**, the main process renders offscreen (`main/preview.ts`). It registers as the core's previewer (`magic.previewer`) and answers `magic.previewRequest` events, which are sent only to it. It uses its own session with every request blocked.
- **The CLI, and a core without the app**, use Playwright's Chromium when it is installed.
- The live-dark screenshot goes back to the model as an image (AI SDK `toModelOutput` → `image-data`) and becomes the revision's thumbnail.

### Running: health, not just "stale"

- **Each refresh** runs data.ts and validates the result.
  - **Success:** `magic.data` to the UI; `lastData` and `health` saved at most once a minute, or at once when recovering.
  - **Failure:** the last good data stays on screen, with `health {ok: false, error, failures, retryAt, permission}`. The next run waits as long as the server asked (`Retry-After`, `x-ratelimit-reset`), else it backs off up to 10×.
- **The title bar** says "Stale · HTTP 403 (rate limited?)"; its tooltip has the full error, and a click refreshes.
- **A line under the widget** offers Fix and Details when a build left problems or data keeps failing. Fix (`magic.fix`) runs the agent with the error and the widget's files.
- **With `magic.autoFix`**, data that fails three times in a row, for a reason other than a busy server or the network, gets one automatic fix per version.
- **`cmd.state` / `cmd.history`** are posted from the frame to the renderer, which saves them with `magic.state`; they come back to the frame in its `render` message.
- **Hand edits**: the core watches each widget folder. A save in an editor, or by Claude Code, becomes a revision ("Edited by hand") and reloads the window.

### The edit view (⌘E)

⌘E (or Edit Widget in the window's menu) turns the window around:

- **Changes:** ask for a change; Check and Fix; every version with its screenshot, what was asked, whether its checks passed, and Restore.
- **Settings:**
  - the refresh interval;
  - the widget's own fields from its manifest (secret fields are stored by the core in `widget-secrets.json`, mode 0600, and only data.ts gets them);
  - what its data may use.
- **Files:** the folder, files open in cmd, Show in Finder.
- **Health:**
  - whether data is coming, and the error if not;
  - problems the last build left;
  - Fix It;
  - how it was made (the agent's steps);
  - the runtime: Deno with Install, the sandbox, the previewer.

### The toolchain: `cmd widget`

`cmd widget new | check | run | preview | list` exposes the same checks for any folder. `new` writes a starter widget plus `CLAUDE.md`/`AGENTS.md` pointing to the prompt and examples, so Claude Code or Codex can build widgets with cmd's rules. `cmd magic "…"` builds into `$CMD_HOME/magic/runs/<time>-<request>/widget`; `cmd magic eval` builds the cases and judges them by cmd's checks plus each case's expectations (data via `net` or `run`, `runs: ["gh"]`, `noNet: ["api.github.com"]`).

### v1 windows

Windows made before v2 keep their HTML and refresh their v1 source. The first Change rebuilds them as widgets: the request includes their old view and source.

## Toward a store

The folder already is the package. What's missing:

1. **A library**: widgets outside windows ("Open Widget…", duplicate, reopen a closed one), and per-Space widget folders.
2. **Packaging**:
   - semver and a changelog in the manifest;
   - a content hash over the files;
   - a signature;
   - screenshots taken from the revisions.
3. **Install and consent**: show the permissions (hosts, programs, folders) at install. An update that adds permissions asks again, Chrome-style.
4. **A validator**: `cmd widget check` plus static rules:
   - no `s.unknown()` at the top;
   - fixtures for every config branch;
   - lint for literal colours;
   - size limits.

   Then human review for listing.
5. **Config schemas for parameters** (already in the manifest), so one widget serves many people. Secrets never ship.

## Files

- `packages/core/widget-runtime/`: `cmd.ts`, `runner.ts`, `view.d.ts` (Deno side).
- `packages/core/src/widgets/`:
  - `manifest.ts`, `store.ts` (folders, compose, revisions);
  - `deno.ts` (find/install, check, run), `verify.ts`, `preview.ts`;
  - `secrets.ts`, `templates.ts`.
- `packages/core/src/magic/`: `build.ts` (the loop), `widget-tools.ts`, `service.ts` (windows, refresh, health, edits), `prompt/` (prompt.md, kit.css, host.js, examples/).
- `apps/desktop/src/main/preview.ts`; `renderer/src/components/MagicView.tsx`, `MagicEditor.tsx`.
- `packages/cli/src/magic.ts`, `widget.ts`, `magic-eval.ts`.
- Tests: `packages/core/test/widgets.test.ts`, plus the v2 block in `e2e/smoke.mjs`.
