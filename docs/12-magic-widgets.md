# Magic widgets

> **Superseded in part by [14-magic-v2.md](14-magic-v2.md) (2026-10-04):** widgets are now folders with a typed Deno data.ts, a type-checked view, revisions and checks before they show. The output contract, data sources and data model below are v1.

> Status (2026-10-03), branch `magic-windows`:
> - **Built:** the prompt lab (`cmd magic`, `cmd magic view`, `cmd magic eval`); the AI SDK backend with Anthropic and OpenAI, keys and models set by the user (see Providers); Magic widgets in the app (⇧⌘M, File → New Magic Widget, the sidebar's +): the empty prompt, the live step trace, streaming, the widget frame, refresh scheduling in the core, the refine line (⌘L), Refresh Every (per window, kept across refinements), terminal answers, the magic.* settings.
> - **Not yet:** versions and "How this was made" as a panel, recipes, the palette fallback, paste and drop, attention from widgets, Edit code, pausing refreshes while hidden, Keychain keys (API keys come from ANTHROPIC_API_KEY / CMD_MAGIC_API_KEY).
> - **Found while building:** `sandbox-exec` can't apply a profile inside another sandbox (Agent Safehouse), so there commands are refused unless `CMD_MAGIC_UNSANDBOXED=1`; the AI SDK is v7 (`instructions`, not `system`); an inline frame (`srcdoc`, blob or data URL) inherits the app's CSP, which forbids inline scripts, hence the `cmd-widget://` page; the agent asks nothing while it works (see Agent).

A **Magic widget** turns whatever you type or paste into a live window. "show me the weather", a JSON API URL, a `curl` command, a blob of JSON, "CPU per process as a bar chart, every 2s": the AI decides how to show it, either as a small HTML widget or as a terminal command. When the request is about this Mac ("show my VPN connection status", "disk usage of my projects"), a read-only agent looks around first to find out how to answer it. The result keeps updating and uses the app's theme. It should feel quick, show what it is doing while it works, and never ask how you want it shown.

## What other tools do (research summary)

| Approach | Examples | Speed | Range | Refresh | Theming |
|---|---|---|---|---|---|
| Raw HTML/JS per prompt | Claude Artifacts and inline visuals, Gemini dynamic view, websim, tldraw Make Real | 20–90 s | anything | manual, or the LLM again | only if prompted |
| Pre-built HTML bound to tools | MCP Apps (SEP-1865), OpenAI Apps SDK | instant | only what was built | the view calls tools | host CSS variables |
| Catalog-constrained JSON | Google A2UI, Vercel json-render | 2–5 s, streams | limited to the catalog | data-model patches | free (host renders) |
| Tool calls into fixed components | Perplexity cards, Raycast AI, AI SDK UI | fastest | narrow | app code | native |
| Command suggestion | Warp, Atuin AI, aichat `-e` | instant | text | re-run | terminal |
| Generated view + generated data script | agent-widgets (SwiftUI + feed script), Android "Create My Widget" | one generation, then free | wide | host re-runs the script | host styling |

Takeaways:

- **Generation is slow; refreshing must not be.** Every product that puts the LLM in the refresh loop (Artifacts, Imagine with Claude, Rabbit) feels slow. The model should write the widget once. After that, refreshing means re-running a data source.
- **For one user on their own machine, HTML's range beats a component catalog.** A2UI and json-render exist so untrusted agents can render into a branded product. Here a small built-in CSS kit gives most of the consistency without capping what a widget can be.
- **Speed comes from short output, not from a smart pipeline.** On a fast model, a widget of 1.5–3k tokens takes 2–15 s. Claude's own widget prompt keeps output short with prebuilt classes, CSS variables only, no comments, and `<style>` → content → `<script>` in that order. That ordering lets the widget render while it streams.
- **Questions about the user's own machine need an agent, not a completion.** "My VPN status" has no answer without looking: which VPN, which interface, which config. Short read-only tool turns on a fast model, shown live, keep this quick. Testing the data source before writing the view is what makes the widget right the first time.
- **Warp routes command vs. natural language locally**, before any model call. Deterministic routing for obvious inputs costs 0 ms.
- **MCP Apps is now the standard bridge** for HTML views: JSON-RPC over `postMessage`, `ui/initialize`, `host-context-changed` for theme variables, and a CSP that defaults to `connect-src 'none'`. Copying its message names keeps the door open to hosting real MCP Apps later.

Sources: research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt · a2ui.org · github.com/vercel-labs/json-render · github.com/modelcontextprotocol/ext-apps (spec 2026-01-26) · developers.openai.com/apps-sdk/reference · michaellivs.com/blog/reverse-engineering-claude-generative-ui · github.com/Surdeddd/agent-widgets · github.com/tldraw/make-real-starter · docs.warp.dev (terminal and agent modes, agent permissions) · code.claude.com/docs/en/headless · ai-sdk.dev · platform.claude.com/docs/en/build-with-claude/prompt-caching · electronjs.org/docs/latest/tutorial/security

## Behaviour

1. **One input, no mode picker.** ⌘M (File → New Magic Widget) opens a window whose body is a prompt field (see UI and UX). The palette, paste and drop, and `cmd magic "…"` lead to the same place. Paste, URL, JSON, a command and plain English all go into the same field.
2. **Deterministic fast paths first (no LLM, 0 ms):**
   - pasted JSON → the built-in JSON view (tree + table), shown instantly;
   - a URL that returns JSON → fetched by the core and shown in the JSON view;
   - something that is plainly a shell command (`curl …`, a known binary, a pipeline) → a terminal with the command typed in, not run.

   Each fast-path result has a **✦ Make it nice** action, which runs the normal generation with the data already sampled.
3. **Otherwise a read-only agent takes it** (see Agent). It can look around the machine first: run read-only commands, read files, list folders, fetch URLs. For "show my VPN status" it finds out that `scutil --nc list` knows a WireGuard service, or that `~/src/private-vpn` holds a `wg0.conf` with an exit IP. Then it writes a data source and **tests it** before writing the view. A request that needs nothing from the machine ("a pomodoro timer") skips exploring and answers in one turn. The agent's final answer picks the kind:
   - **widget**: HTML in a sandboxed frame, optionally with a **data source** the core refreshes;
   - **terminal**: a command for a terminal window, e.g. `watch -n 2 'ps -Ao pcpu,comm -r | head'`, `btop`, `curl -s … | jq`. It is typed in, and only runs on ⏎ or when the command policy allows it (see Security).
4. **It shows up immediately, and you watch it work.** The window opens at once. While the agent explores, its steps show as a live trace in the window ("Checking network services… `scutil --nc list`", "Reading ~/src/private-vpn/up.sh"), and each one can be expanded to show its output. Once the final answer starts, the title and loading line come from its header, and the HTML streams in and is morphed into the frame. Scripts run once the output is complete. The trace stays available as "How this was made".
5. **Data refreshes without the AI.** The source the agent tested is stored with the window. The core runs it right away, then every `refresh` seconds, and calls the view's `render(data)` with each result. The agent is never involved again. Refreshing pauses while the window isn't visible and backs off on errors. The window's status shows "Updated 12s ago" or "Stale · scutil failed".
6. **Refine by talking to it.** Every Magic widget has a prompt line (⌘L focuses it): "bigger numbers", "add humidity", "make it a line chart". A small widget (about 3k tokens or less) is regenerated with its current code in context. A larger one gets search/replace edits, with full regeneration as the fallback. Every version is kept, and ⌘Z in the prompt line steps back.
7. **Self-repair.** If the frame reports a script error, an empty render or overflow after running, the agent gets one more turn with the error and the data sample. It keeps its tools for that turn, so it can re-check the source. It is never silently retried more than once.
8. **Themed by construction.** The model never sees colours, only token names. The frame gets the theme's tokens and is re-sent them when the theme changes, so widgets follow light and dark mode and theme switches live, like everything else.
9. **Keep what works.** "Save as Recipe" stores the widget (intent, source, view, refresh, and parameters such as `{{city}}`). Recipes appear in the palette and are matched against new prompts before any model call: an exact or near match opens instantly and costs no tokens.
10. **Magic widgets are windows.** They live in a Space, show in the sidebar, survive core restarts (drawn instantly from their last data), and can be moved. Their sources stop when they close, and closed ones can be reopened with their history for 30 days (see Data model).

## Agent

A real tool loop, run by the core. It is not a chat completion and not a Claude Code pane: it has its own small tool set, and the core enforces read-only access whatever model or backend drives it.

**Tools** (all served by the core, so every backend gets the same ones):

| Tool | Does | Limits |
|---|---|---|
| `run(command, cwd?)` | runs a command without a PTY, returns stdout, stderr and the exit code | command policy: read-only allowlist, never asks mid-loop (a command that would need asking is refused with the reason, so the agent picks another); runs under the read-only sandbox below; 10 s timeout, 64 KB output cap |
| `read(path, range?)`, `list(path)`, `find(root, glob)`, `grep(root, pattern)` | file system | the deny-read list below; size caps |
| `fetch(url)` | HTTP GET from the core | body truncated; secrets are never sent automatically |
| `test_source(source)` | runs a candidate data source exactly as the scheduler will, and returns a sample of its data, or the error | the same limits as `run`/`fetch` |

The final answer is the output contract below, and it doesn't count as a tool call. A widget with a source must have called `test_source` on that exact source; the core checks this. If the agent skipped it, the core runs it and feeds the result back as one more turn. A source is therefore always tested before the window shows it, and the view is written against real data.

**No questions.** The agent never asks the person anything while it works. Where a request is ambiguous it picks the likeliest reading (the active VPN, the current folder's repository), says in the widget what it chose, and the person corrects it afterwards through the refine prompt line.

**Budget.** At most about 12 tool calls and 45 s, with parallel tool calls allowed. When the budget runs out the agent is told to answer with what it has. The prompt says to explore only when the request is about this machine or needs facts it doesn't have, so "a pomodoro timer" still answers in one turn.

**Read-only, enforced twice:**
1. **Policy.** `run` only accepts commands that the command policy (see Security) classifies as read-only. It never asks mid-loop.
2. **Sandbox.** Every `run` and `test_source` command also executes under `sandbox-exec` with a profile that denies `file-write*` (except `/dev/null` and a per-run temp dir) and `process-exec` of `sudo` and `osascript`. A misclassified command still can't change anything. `sandbox-exec` is deprecated but still works and is used by Claude Code and Codex. Open question: whether it can apply a profile when the core itself already runs in a sandbox, as it does under Agent Safehouse. If it can't, the core refuses `run` rather than running unsandboxed.

**Privacy.** What the agent reads goes to the model provider. The deny-read list therefore applies to both the file tools and the sandbox profile:
- `~/.ssh`;
- `~/.aws`, `~/.config/gcloud`, `~/.kube`;
- `~/.netrc`, `.env*` files;
- keychains;
- browser profiles;
- the user's own `magic.denyPaths`.

A setting `magic.explore` (`ask` | `allow` | `off`) controls exploring. The default `ask` shows "Look around this Mac to answer?" the first time per prompt in each Space and remembers the answer.

**Escape hatch.** "Continue in Claude Code" opens a real agent pane with the prompt, the trace and the draft. That's for requests that need writes, `sudo` (`wg show`), or more than the budget.

## Output contract

The agent's final answer has the same shape on every backend: a JSON **header line**, then `---`, then a raw body. Raw text streams on every provider, local models and CLI backends included. It costs fewer tokens than HTML escaped inside JSON, and it can be rendered progressively.

```
{"kind":"widget","title":"Weather · Berlin","loading":["Asking Open-Meteo…"],"source":{"type":"fetch","url":"https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m,weather_code"},"refresh":600}
---
<style>.big{font-size:48px}</style>
<div class="k-card"><div class="k-stat"><span class="big" id="t">–</span><small id="c"></small></div></div>
<script>cmd.onData(d => { t.textContent = Math.round(d.current.temperature_2m) + "°"; … })</script>
```

```
{"kind":"terminal","title":"Top CPU","command":"watch -n 2 'ps -Ao pcpu,comm -r | head -15'","run":"ask"}
```

Header fields:

- `kind`: `widget` | `terminal`.
- `title`, and `loading` (1–3 short lines shown while the widget streams).
- `source` (widget only, optional):
  - `{type:"fetch", url, method?, headers?, secret?}`: run by the core with Node `fetch`, so there is no CORS. `secret` names a stored key, which is added on the core side and never reaches the frame.
  - `{type:"command", command, cwd?}`: run without a PTY, with a timeout and an output cap. Output is parsed as JSON when it can be, otherwise passed as text.
- `refresh`: in seconds, or 0.
- `command`, and `run: "ask" | "now"` (terminal only; `now` still goes through the policy).
- `media` (widget only, optional): https origins the view streams audio/video or loads images from (a web radio). See Security → Media.

The body uses the **kit**: about 40 classes (`k-card`, `k-stat`, `k-grid`, `k-table`, `k-list`, `k-badge`, `k-spark`, `k-bar`, `k-mono`…) built on the theme tokens. Two chart libraries (uPlot and Chart.js) are vendored, not loaded from a CDN. Rules in the prompt:

- tokens only, never literal colours;
- `<style>` → markup → `<script>` last;
- no comments;
- no gradients, shadows or blur, since they flash while streaming;
- render from `cmd.onData`, never fetch directly.

The **frame API** (`window.cmd` inside the frame, built over the bridge):

- `onData(fn)`
- `refresh()`
- `state.get` / `state.set`: per-window, persisted in the window state
- `openUrl(url)`: routed through the window-type registry
- `run(command)`: always through the command policy
- `complete(prompt)`: a model call, like Artifacts' `window.claude.complete`; later

## Providers

Two providers, both through the Vercel AI SDK v7 (plain ESM, runs under type stripping): **Anthropic** (`@ai-sdk/anthropic`) and **OpenAI** (`@ai-sdk/openai`, the Responses API). The core runs the loop with `streamText`, tools and `stopWhen`; the tools always execute in the core, so the policy, sandbox and budget are the same for both. The system prompt is cached (`cache_control` on Anthropic, automatic on OpenAI). Effort is `low` where the model takes it (Anthropic's newer models, OpenAI's reasoning models).

**Everything is the user's choice, nothing is discovered.** Settings (Settings → Magic Widgets):
- `magic.provider`: `anthropic` | `openai`;
- `magic.anthropic.model`, `magic.openai.model`: one model per provider, so switching keeps each choice. The old `magic.model` carries over as `magic.anthropic.model`; `magic.baseUrl` is ignored.

API keys are **secrets**, not settings (`packages/protocol/src/secrets.ts`): `magic.anthropic.apiKey`, `magic.openai.apiKey`. The core keeps them in `$CMD_HOME/secrets.json` (mode 0600, not in the config folder people sync), never in `settings.json`. Clients only see whether each is set and its last four characters (`secrets.status`, `secrets.updated`); `secrets.set` stores or removes one. The Settings window shows them as rows beside their model; the CLI stores one from stdin (`pbpaste | cmd settings secret magic.openai.apiKey`), so it stays out of argv and shell history. Environment variables (`ANTHROPIC_API_KEY`, …) are not read, and the `cmd magic` prompt lab uses the same settings and stored keys as the app.

**Model lists** come from the providers, with the user's key, so they show exactly what that key can use (`magic.models { provider }`, cached 10 minutes per key; the popup's ↻ asks again):
- Anthropic `GET /v1/models` (`x-api-key`, `anthropic-version`): id, display name, release date, newest first, paginated with `after_id`. Every entry is a chat model.
- OpenAI `GET /v1/models` (Bearer): id and creation time only, and everything the key can call. cmd keeps chat models by id: no embeddings, audio, realtime, image, moderation or search models, no dated snapshots (their alias is listed), nothing older than GPT-4o.
- models.dev (`https://models.dev/api.json`) has richer metadata (tool calling, limits, prices) but is about 5 MB and says nothing about a given key's access, so it isn't used.

A chosen model the list doesn't have stays selected and is marked "not available to this key". With no key, the window says which key to add and where.

Retired: the `auto` provider, the Claude Code login backend (`claude -p` with an MCP relay for the tools) and OpenAI-compatible endpoints (`magic.baseUrl`). They depended on what happened to be installed or set in the environment.

**Fast tier by default:**
- Haiku 4.5 without thinking: about 0.4–0.6 s to first token, 85–200 tok/s.
- Gemini Flash-Lite: 200–390 tok/s.
- gpt-oss-120b on Cerebras or Groq: 250–1,800 tok/s.

Thinking stays off on this path; reasoning modes add about 20 s before the first token. The fast tier also drives the agent loop: tool turns are short, so exploring costs one round trip per step (about 1 s plus the command's own time), not a long generation. A typical "VPN status" run takes 3–5 steps, roughly 5–10 s before the widget starts streaming, and the live trace makes that wait legible.

**Quality tier** (e.g. Sonnet at low effort) for ✦ Polish, which also includes a screenshot critique via `capturePage`. It also takes over when the fast tier runs out of budget or fails to repair a widget.

## Security

The renderer runs with `sandbox: false`, and `window.cmd` there is the core socket. A frame that could reach `window.parent` would have full control of the core. So:

- **Frames:**
  - `<iframe sandbox="allow-scripts">`, never `allow-same-origin`, popups or top navigation;
  - served from a custom `cmd-widget://<window id>/` protocol with the CSP as a **header**: `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'none'; frame-src 'none'`.
  - Main also blocks navigation (`will-frame-navigate`), new windows, permission requests and outbound requests from `cmd-widget:` frames. `nodeIntegrationInSubFrames` stays off.
- **Bridge:** the renderer accepts a message only if `event.source === frame.contentWindow`, since every opaque origin reports `"null"`. A frame can only use the frame API above, scoped to its own window.
- **Media:** the frame has no network, except media. A widget lists the https origins it plays audio/video or shows images from in `header.media` (answers from before that field are read from the body when it uses `<audio>`/`<video>`). The window asks once ("This widget wants to play media from …", Allow / Don't Allow, `magic.media`); the answer is kept in the window's state (`mediaAllowed`, `mediaDenied`). Main serves allowed frames as `cmd-widget://frame/<token>`, with those origins added to `img-src` and `media-src` only; the token comes from the renderer (`widget-frame`), so a widget can't navigate itself to a looser CSP. `connect-src` stays `'none'`. What remains is that a widget can encode data in a media URL to an allowed origin, which is why it is per window and asked for.
- **Fetch sources:** the origins in the header are shown in the window chrome. A new origin, or a source using a `secret`, is approved once per window.
- **Command policy** (used by terminal kinds, command sources and `cmd.run`), in the order Claude Code uses:
  - rules are deny, then ask, then allow;
  - compound commands are split on `&& || ; |` and each part is checked;
  - there is a built-in allowlist of read-only commands (`ls`, `cat`, `ps`, `df`, `git status`, `jq`, …);
  - anything that writes, uses `sudo` or `eval` asks first.
  - Approval is per window and per exact command string. The approval sheet shows the command, its cwd, and why it was classified as it was.
- **Command sources** run under the same read-only sandbox as the agent's `run`, every time they refresh. A source the policy classifies as read-only runs without asking, since the agent already tested it. Anything else asks once, and asks again whenever the command text changes (e.g. after a refinement).
- **Logged-in CLIs** (`gh`, `glab`, `kubectl`, `docker`, `tailscale`): the line is that the model never *sees* a secret, not that nothing may *use* one. Their read-only subcommands run with their token env vars kept and their config folder (and, for `gh`/`glab`, the login keychain and `/usr/bin/security`) reachable in the sandbox, for that command only. Token-printing subcommands are refused (`gh auth token`, `--show-token`, `glab config`), the files stay unreadable to `read`/`cat`, and all command, file and fetch output is scrubbed of token-shaped strings (`ghp_…`, `glpat-…`, `sk-…`, AWS keys, JWTs, private keys, `token=…`) before the model gets it. The prompt tells the agent to prefer these CLIs over raw HTTP for services.
- **Agent tools** never ask mid-loop. What they may do is fixed by the policy, the sandbox and the deny-read list (see Agent).

## Data model

Persistence has two parts, so that what every UI receives stays small:

```ts
// 1. Window state (packages/core/src/windows/builtin.ts, a "magic" WindowType).
//    Opaque JSON in the `windows` table, like every type. It is broadcast with
//    window.updated and included in the snapshot, so it holds only what the
//    window needs to draw itself.
type MagicState = {
  prompt: string;
  kind: "widget" | "terminal";
  version: number;             // the version currently shown
  html: string;                // that version's view
  source: MagicSource | null;
  refresh: number;
  lastData: { data: unknown; at: number } | null;   // so it draws instantly after a restart, before the first refresh
  approved: string[];          // origins and exact commands
  size?: "s" | "m" | "l" | "wide";
  recipe?: string;
};
```

```
2. The workbench: $CMD_HOME/magic/<window id>/, fetched only on demand (versions, "How this was made", refining)
   versions/<n>.json   { prompt, html, source, refresh, at }; one file per version, append-only
   runs/<n>.ndjson     the agent's events for that version: steps, tool output (truncated), the answer
   messages.json       the conversation, so a refinement continues the agent instead of starting over
```

Files rather than SQLite rows, because this is the same layout `cmd magic --out` writes. A window's history is also an eval run: `cmd magic view` and `report` open it, and a good window can become a test fixture by copying its folder.

**Lifecycle:**
- **Restart:** the window draws `html` with `lastData` at once, marked stale; the scheduler then re-runs the source.
- **Close** (or closing its Space): the window's row goes, as for every type. Its workbench moves to `$CMD_HOME/magic/closed/`, kept for 30 days. "Reopen Closed Magic Widget" in the palette brings it back with its full history.
- **Save as Recipe** copies the current version to `$CMD_CONFIG_DIR/recipes/<name>.json`. Recipes are config, not state: kept forever, easy to sync or put in dotfiles, and shareable.
- **Edit code** writes a new version. The text window edits `versions/<n>.json`'s HTML through a small adapter, so hand edits are versioned like prompts.
- Ad-hoc `cmd magic` runs from the CLI aren't windows. They go to `$CMD_HOME/magic/runs/` until `cmd magic open RUN` turns one into a window.

New methods for the on-demand part: `magic.versions { id }`, `magic.run { id, version }`, `magic.restore { id, version }`, `magic.reopen { closedId }`.

A terminal kind stays a Magic widget only while its command is offered. Once run, it becomes an ordinary terminal window: `window.update { kind }` already switches type in place.

Methods:

```ts
"magic.create":  { params: Placement & { prompt: string }; result: AppWindow };        // fast paths + generation
"magic.refine":  { params: { id: WindowId; prompt: string }; result: null };
"magic.cancel":  { params: { id: WindowId }; result: null };
"magic.approve": { params: { id: WindowId; what: string }; result: null };
"magic.recipes": { params: {}; result: Recipe[] };
```

Events:
- `magic.stream { id, step?, header?, delta?, done?, error? }` carries the agent's run to the renderer: `step` is a tool call starting or finishing (for the trace), and `delta` is the final answer's text;
- `magic.data { id, data, at, error? }` carries source results.

Neither is persisted.

Core module `packages/core/src/magic/`:
- `providers.ts`;
- `agent.ts`, the loop: budget, the `test_source` check, cancellation;
- `tools.ts`, the tools, plus `mcp.ts`, which serves them over stdio for CLI backends;
- `sandbox.ts`, the `sandbox-exec` profile (no writes, deny-read paths) used by `run`, `test_source` and command sources;
- `prompt.ts` (the cached system prompt: rules, tool guidance with examples of how to find things on a Mac, kit reference, 4–6 short examples; long enough to pass Haiku's 4,096-token cache minimum);
- `router.ts` (the fast paths);
- `sources.ts`, the scheduler. It is shared with the monitors planned in docs/06: a Magic widget is a generated monitor with an HTML view;
- `policy.ts`;
- `recipes.ts` (`$CMD_CONFIG_DIR/recipes/*.json`).

Settings:
- `magic.provider`, `magic.anthropic.model`, `magic.openai.model` (and the API keys, as secrets; see Providers); later `magic.qualityModel`;
- `magic.autoRepair`;
- `magic.explore` (`ask` | `allow` | `off`), `magic.denyPaths`, `magic.maxSteps`;
- `magic.commandPolicy`: allow and deny rules, in the `open.handlers` style.

All of them are read when acting, so they apply live.

Renderer:
- a `magic` WindowView with the frame, a prompt line and the source status (refresh, stale, approve);
- `widget-host.html`, the bootstrap served by the protocol: theme tokens, kit CSS, morphdom, and the frame API;
- theme tokens come from the existing `themeVars()` plus the 16 ANSI colours, and are re-sent on `settings.updated`.

## Prompt lab: CLI first

The system prompt, the kit and the examples *are* the product, so they get a fast loop before any UI exists. The app comes second, as a thin layer over the same code.

**One module, no Core.** `packages/core/src/magic/` exports `runMagic({ prompt, system?, model, explore, onEvent }) → MagicResult`. It does not depend on the `Core` class. `cmd magic` imports it and runs it in-process, so:
- an edited prompt applies on the next run;
- a stale core doesn't matter (see CLAUDE.md).

The system prompt lives in files read at call time: `magic/prompt.md`, `magic/kit.css`, `magic/examples/*.html`. Later the app's core wraps the same function and maps its events to `magic.stream`.

```
cmd magic "show my vpn status"   trace on stderr; the answer on stdout (the command, or the path of the widget)
    --model M --provider P        --system FILE (prompt variant)   --no-explore
    --json                        NDJSON events (steps, header, deltas, metrics)
    --out DIR --shot              write the run and screenshot it (dark + light)
cmd magic view DIR                re-render a saved run without the model (after editing kit.css)
cmd magic eval [CASE…] [--variant NAME=FILE…] [--model M…] [--repeat N] [-j 4] [--judge]
cmd magic report RUN…             compare runs side by side
```

**A run** is a folder in `$CMD_HOME/magic/runs/<time>-<variant>/<case>/`:
- `events.ndjson`, `trace.json`, `answer.txt`;
- `data.json`, the tested source's sample;
- `widget.html`, standalone: the host page, theme tokens, kit and data inlined, so it opens in any browser;
- `dark.png` and `light.png`;
- `metrics.json`.

The screenshots use the **same** `widget-host.html` and kit as the app. They are rendered in Playwright Chromium, already a dev dependency for e2e, with tokens from real themes. Themes therefore need to move from the renderer into a shared package (`@cmd/protocol` or `packages/themes`); they are plain data, so the move is mechanical.

**Metrics per case**, all automatic:
- the header is valid;
- the kind is the one expected;
- the source was tested;
- the agent explored when it should have (and didn't when it shouldn't);
- script errors, empty or overflowing renders;
- literal colours in the HTML (a lint for `#hex` / `rgb(`);
- output tokens and steps;
- time to first trace line, to the header, to first paint, and in total;
- cost.

`--judge` (opt-in) also has the quality-tier model grade the dark screenshot plus the prompt against a short rubric, scored 1–5 on each of:
- answers the request;
- data looks right;
- legible at the window's size;
- on-theme;
- nothing superfluous.

**Cases** are `magic/evals/*.json`, each `{ id, prompt, expect: { kind?, explores?, source? }, tags }`:
- **Portable cases** run anywhere: the weather, a JSON URL (a fixture served on localhost), pasted JSON, a pomodoro timer, top processes as a chart, a `curl` command.
- **`local` cases** depend on the machine and are only compared on the same Mac: VPN status, disk usage of `~/src`, git status of every repo, battery, today's calendar.

**The loop:** edit `prompt.md`, then run `cmd magic eval --variant base=prompt.md@HEAD --variant new=prompt.md --repeat 3` and open the report. It shows a grid of cases × variants with screenshots, metrics and failures highlighted. Keep what wins. Good runs' `events.ndjson` become the fake-provider fixtures for the core tests, so the tests replay real model behaviour.

## UI and UX

**1. Starting.** The prompt *is* the window. What you asked for and what you get stay in one place, and nothing is modal.
- **⌘M** (File → New Magic Widget) puts a new window in the layout immediately, in the slot it will keep. Its body is one large prompt field.
- **The empty window suggests**:
  - your recipes;
  - two or three examples fitted to the Space (a repo root → "git activity this week");
  - a hint that URLs, JSON and commands work too.
- **Palette fallback:** a palette query with no good match ends with **"✦ Make a window for '…'"**, so the feature is discoverable without a single new habit.
- **Paste or drop** a URL or JSON onto the main view (nothing focused) or the canvas: it offers a Magic widget.
- **`cmd magic "…"`** from any terminal opens it in that terminal's Space.

**2. While it works: the magic moment.**
- The prompt shrinks into the title bar and serves as the name until the header gives a title.
- The body becomes a quiet **trace**: one line per step, each with a status light. Every tool call carries a short human label (a `why` parameter on each tool), e.g. "Looking at network services" with `scutil --nc list` dimmed in mono beside it. Clicking a line shows its output.
- If consent is needed it appears as the first line, inline: "I'll look around this Mac, read-only. **Allow** · **Always in this Space** · **Answer without looking**".
- Then "Drawing…" with the header's loading lines; the widget morphs in and the trace folds away into "How this was made".
- Esc or ⌘. cancels.
- Targets: the window in under 100 ms, the first trace line within 1 s, the widget in under 10 s for typical requests.

**3. The finished window.**
- **Title bar**, by the rules in docs/10:
  - Name: the title;
  - Kind: "magic", with a ✦ icon;
  - Place: the source's host or command;
  - Status: "Updated 12s ago" or "Stale"; "Refreshing" is transient.
- **Prompt line** along the bottom edge, shown on hover or ⌘L, with the placeholder "Change something…".
  - ⏎ refines: the widget dims slightly and morphs in place.
  - After the first change, ◀ ▶ step through versions.
- **✦ menu** (title bar and context menu):
  - Refresh now, and Refresh every…;
  - Versions, and How this was made;
  - **Edit code**, which opens the HTML in a text window; saving updates the widget live;
  - Save as Recipe…;
  - Polish;
  - Continue in Claude Code.
- **Terminal kind:** the window is a terminal with the command typed in, and a one-line hint: "⏎ run · ⌘L change it". Once run, it's an ordinary terminal.
- **Size:** the header may hint `size: s | m | l | wide`. Strip and canvas use it for the first width or rect. Widgets are small, so a canvas of them becomes a dashboard by itself.

**4. When things go wrong, never a blank window or a stack trace.**
- **Render still fails after the repair:** show the data in the JSON view, with "Couldn't draw this · Retry · Polish · Continue in Claude Code".
- **The source fails:** keep the last good render, dimmed, with "Stale · scutil exited 1" in the status. A click shows details and Retry.
- **The budget runs out:** show what the agent found, with the same buttons.
- **No provider set up:** the empty window becomes setup. If it finds the `claude` or `codex` CLI it offers "Use your Claude Code login" in one click; otherwise it asks for a key and stores it in the Keychain.

**5. Living with them.**
- They are ordinary windows in the sidebar's Windows section, marked ✦.
- **Widgets can ask for attention** (frame API `cmd.attention(text)`), which goes through the same notification path as a terminal's bell. "Tell me when the VPN drops" is just a refinement that adds the rule, so Magic widgets become monitors that tap you on the shoulder.
- Recipes show in the palette as "✦ VPN status". Parameterised ones ask for their parameter inline. Per-Space recipes in `<root>/.cmd/recipes` come later.

**6. Feel.** It follows the Platinum design language (docs/07):
- status lights in the trace;
- a dithered placeholder while drawing;
- the pixel font only on the ✦ label;
- widget content in the text font;
- motion only from morphing and short fades, with no shimmer, because gradients flash during DOM diffs.

## Plan

1. **Prompt lab core.**
   - `runMagic` with one SDK provider (Anthropic) and the `claude -p` backend.
   - The tools, behind `policy.ts` and `sandbox.ts` with their tests first: the CLI runs real commands from the start.
   - The contract parser, and `cmd magic` with trace output.
2. **Shared rendering and evals.**
   - `widget-host.html`, `kit.css`, and themes moved to a shared package.
   - `--shot`, `view`, `eval`, `report`, and the first ~15 cases.
   - **Iterate on the prompt here until the results are good.**
3. **App window.**
   - The `magic` window type, the `cmd-widget://` protocol and the frame bridge.
   - Streaming morph, the trace UI and inline consent.
4. **Living widgets.** The source scheduler, refinement and versions, the failure states, the terminal kind, Edit code.
5. **Reach.** Recipes, the palette fallback, paste and drop, attention, the Codex backend and more providers.
6. **Later:**
   - local models;
   - ✦ Polish with screenshot critique;
   - `cmd.complete` inside frames;
   - publishing a recipe as a plugin monitor;
   - hosting real MCP Apps in the same frame.

## Decisions to confirm

1. HTML with a kit, not a component catalog (A2UI / json-render), as the primary contract.
2. Generated data sources run by the core, not network access from the frame.
3. A header line + raw body rather than tool calls / JSON schema, so every backend, CLI logins included, works the same way.
4. The fast tier is the default; quality is opt-in (✦ Polish).
5. Terminal-kind commands are typed but not run until ⏎ or the policy allows them; command sources ask once per exact string.
6. Using the user's `claude` / `codex` login as a fallback backend.
7. A core-run agent with our own read-only tools (enforced by policy + `sandbox-exec`), rather than a Claude Code session with its own tools and permission prompts.
8. Exploring asks once per prompt in each Space (`magic.explore: ask`), because what the agent reads leaves the machine.
