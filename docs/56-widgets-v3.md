# Widgets V3: packages on a versioned API

**Status:** proposal: a clean slate for widgets as installable, testable packages that talk to the core through a small versioned API and draw with the real kit; built in phases, each shippable.

Date: 2026-10-14. Read first: [16-widgets.md](16-widgets.md) (the Widget Library, which stays), [14-magic-v2.md](14-magic-v2.md) (the format this replaces), [54-agent-integration.md](54-agent-integration.md) (tools, the access table, "one source, no drift"), [55-approvals.md](55-approvals.md) (how a call asks), [architecture-review-01/11](architecture-review-01/11-magic-widgets-sandbox-and-ai.md) (what is wrong with the sandbox today), [40-window-design.md](40-window-design.md) (the kit).

## The idea in three sentences

> A **widget is a package**: a folder with a `package.json`, TypeScript and tests, that you can make with Magic, write by hand, install from a link, and one day publish.
> It talks to cmd through **one small API with a version number**, so it can show your agents, terminals, commits and windows live, and act on them with your permission.
> It **draws with cmd's own kit**, so every widget looks first-party, works on a phone, and can be tested without a browser.

Everything else here follows from those three, and from one constraint Jan set: cmd is young and its internals change weekly, widgets are the showcase and can't wait, and whatever ships must be built for iteration without breaking what people made.

## Why a V3

Two versions in two weeks (docs/12, docs/14) got Magic to "an agent writes a widget that keeps working". Twenty-two widgets live in Jan's library today (CI for three repositories, departures, weather, usage, calculators, a shader, a radio). Looking at them and at the code behind them, the format itself is the ceiling:

1. **Widgets can't see the workspace.** `data.ts` runs in Deno on a timer, reads the web and runs CLIs, and reaches the core only for `events()` over the widgets socket, read-only, in one class of data at a time. It can't list the agents, read a terminal, know which window is selected, be told when an agent stops, open a window or run a Workspace Action. The built-ins (Agent Activity, Live Diff, Commands) do all of that, which is why they are React views in the app and not widgets: the API they use is the renderer's store, not anything a widget could reach. Every "show me my agents" request ends as a worse copy of a built-in.
2. **Views are a web page in a box.** `view.html` plus `view.ts` in a sandboxed iframe, with a CSS kit (`k-*` classes) that imitates the app's components. Three copies of the frame host exist (Magic, Jam, Visualizer; AR1-11-05); the kit is a second, hand-kept version of `@cmd/ui`'s look (`kit.css` beside `tokens.css`, versioned as kits 1–3); nothing in the frame reaches the core; lists don't virtualise; the phone client can't show them; a test needs a browser.
3. **Permissions are written by the model and applied without a grant** (AR1-11-01, critical, open). `manifest.json` is one of the files the agent writes; its `net`, `run`, `env` and `read` become Deno flags on the next run. A store can't be built on that, and neither can trust.
4. **It isn't a package.** The folder has no name, version, dependencies, lockfile, tests or license. `cmd widget check|run|preview` exist, but nothing a developer who has shipped a VS Code or Raycast extension would recognise: no template, no hot reload in the app, no fake host for tests, no `pack`, no `install`.
5. **Magic's service is the whole system.** `MagicService` (935 lines) holds the build loop, the refresh scheduler, health, hand-edit watching, the library, config, secrets, media consent and two migrations (AR1-11-08). A built-in widget doesn't go through it; a package can't.

The Library (docs/16: the sheet, ⇧⌘L, Remove from Board, copies, the Widgets menu) and the Magic making experience (the prompt, steps, screenshots, Fix) are right and stay. What changes is what a widget *is* underneath, how it reaches cmd, and how it draws.

## What exists to build on

| Piece | Where | Reused as |
|---|---|---|
| The widgets socket and per-run tokens; `widget.hello`; the policy table over the event log | `data/widgets.ts`, `data/policy.ts`, `widget-runtime/cmd.ts` `widgetCall` | The transport of the host API: one long-lived connection per widget process instead of one per call |
| Deno found, pinned, hashed, installed on request; flags from permissions; the `sandbox-exec` profile with the network closed | `widgets/deno.ts`, `magic/sandbox.ts` | The widget process runtime, unchanged |
| The access tables typed against `Method`, fail-closed; approvals with "always allow … here" | `tools/access.ts`, `remote/policy.ts`, `tools/approvals.ts` (docs/55) | The widget API's capability table has the same shape; act calls go through the same approvals |
| The tools registry: a dozen task-shaped verbs over the methods, one definition for MCP, the CLI and the Operator | `tools/` (docs/54) | The verbs of the host API are the same verbs; the widget API is a third surface of the registry |
| Window types with `role: "widget"`, opaque state, the Library's `widget.*` methods and event | `windows/types.ts`, `widgets/library.ts`, `widgets/handlers.ts` | A package's widgets register as window types of kind `pkg:<name>/<widget>`; the Library lists them beside built-ins |
| The kit: window pieces, lists, stats, charts, DataGrid, toolbar, callouts, the stories and the Workbench | `packages/ui`, docs/40, docs/48 | What widget views are made of, drawn by the app, never copied |
| Magic's build loop, tools, verify, previews, revisions, Fix, autoFix, evals | `magic/build.ts`, `widgets/verify.ts`, `widgets/preview.ts`, `magic/evals` | The agent writes packages instead of folders; verify becomes `cmd widget check` + `test` + `preview` |
| Secrets per widget, mode 0600 | `widgets/secrets.ts` | Unchanged; `cmd.secrets` in the API |
| The build hash and protocol version on `core.hello`, `has(method)` | `protocol/version.ts`, DEVELOPMENT.md "Versions on the wire" | The pattern the widget API's own version follows |

## What others do

Researched 2026-10-14 from primary sources (a report with URLs is in Sources). The short version, as it applies here:

- **The manifest is `package.json`** at VS Code (`engines.vscode`, `contributes`, `activationEvents`) and Raycast (`commands[]`, `preferences`), `manifest.json` at Obsidian and Figma, `extension.toml` at Zed. Everyone declares entry points, compatibility and permissions where the host can read them without running code.
- **A host-version range, and a window of old API versions.** VS Code pins `engines.vscode` to the release that shipped the API an extension uses, and the types package follows it. Obsidian's `versions.json` maps plugin versions to the oldest app that runs them, so an old app installs an older build. Zed keeps bindings for every API version in `since_v0.x.0` folders and publishes a table of which Zed runs which API. Neovim stamps every function with `since` and `deprecated_since` and promises that signatures never change after release. Shopify supports each API version at least 12 months.
- **An unstable lane that can't ship.** VS Code's proposed APIs need `enabledApiProposals` and are refused by the Marketplace; Figma's `enableProposedApi` is dev-only; Neovim marks `nvim__` functions private. That is how they iterate fast without breaking anyone.
- **UI as data, drawn by the host.** Raycast's extensions run React in a Node worker; a custom reconciler sends a JSON tree with patches over JSON-RPC and native code draws it. Shopify's checkout extensions run Preact in a Web Worker against host-provided `s-*` elements over remote-dom, 64 KB per bundle. Figma and VS Code keep custom HTML in an iframe behind postMessage, "sparingly". The constrained kit is what makes every extension look native and makes a UI testable as data.
- **Capabilities: declared, scoped, granted, and shrinkable by the person.** Figma's `networkAccess.allowedDomains` with a required `reasoning`; Zed's `process:exec` and `download_file` globs, narrowed by the user's `granted_extension_capabilities`; Chrome's optional permissions asked at run time, and an update that adds a permission **disables the extension until the person accepts**; Tauri's per-window capability files where deny wins; Deno's `--allow-net=host` with `--allow-run` documented as an escape from everything else.
- **Isolation is mostly for stability.** VS Code's extension host and Raycast's worker threads protect the app from crashes and lag and say so; neither is a permission boundary. Only Figma (QuickJS in WebAssembly, after Realms escapes), Zed (WebAssembly), Chrome and Deno make the runtime the boundary. Raycast tried JavaScriptCore first and gave it up: no npm, every API polyfilled.
- **Registries are thin.** Obsidian: a JSON list in a GitHub repository pointing at releases whose assets are exactly `main.js` and `manifest.json`. Raycast: a PR into one monorepo, so every extension's source is public and reviewed. VS Code signs at publish and verifies at install; Open VSX scans for secrets and typosquats.
- **The dev loop ships with the host**: `ray develop` hot-reloads inside Raycast; Obsidian's hot-reload plugin; `@vscode/test-electron` runs tests inside a real VS Code; Figma's dev console and VM toggle.
- **What went wrong:** Obsidian can't restrict plugins at all and says so; Figma's in-engine sandbox was escaped several times; Chrome's MV2 to MV3 took four years and broke whole categories; Chrome's `minimum_chrome_version` silently stops updates for old users; Slack reset its app platform twice. Hyper and Tabby (docs/04) let plugins patch internals, and broke on every refactor.

## Principles

1. **Widgets speak the product's vocabulary, never the core's.** The API has workspaces, agents, terminals, windows, events, actions and notifications: words that don't change when `panes.ts` does. The core's `Methods` map (170 methods, renamed weekly) is never exposed. One file in the core maps each API verb to internals; when internals move, that file moves with them and no widget notices. This is the answer to "the codebase is young": the promise is small enough to keep.
2. **Version the promise, not the app.** The API has a major of its own (`@cmd/widget-api@1`), independent of cmd's release numbers. Within a major, only additions. A widget says which major it is written against; the core keeps the adapters for every major it still supports and says, in the Library and in the title bar, when one is on its way out. Experiments live in an `experimental` namespace that the community index refuses, so new surfaces can change daily until they are promoted.
3. **The person grants; the manifest only asks.** What a widget may touch is `declared ∩ granted`, never the manifest alone. A new version asking for more runs with the old grant until the person answers. Acting (typing into a terminal, starting an agent, running a deploy) goes through the same approvals as agents' tools (docs/55), remembered per workspace.
4. **Draw with the kit, through data.** A widget's view is a tree of kit components the app draws, not HTML it ships. One look, one set of tokens, virtualised lists, accessibility, the phone client, and tests that assert on a tree. Custom visuals keep a frame, with nothing in it but pixels.
5. **A package, by the standard.** `package.json`, TypeScript, `npm test`, a lockfile, a license, a changelog, `files`. The same package runs linked from a folder, installed from a release, or made by Magic in your library. Magic is a very good author of packages, not a format of its own.
6. **Every phase ships.** Each phase is visible in the app and leaves the old path working. cmd:2 widgets keep running on an adapter until Magic has moved them, one change at a time, as kits were moved (`kitMove`).

## The design

### A widget is a package

```
~/.cmd/widgets/ci-runs/
  package.json          name, version, engines.cmd, the cmd block (below), devDependencies
  src/ci.tsx            export default defineWidget(…)
  src/ci.test.tsx       runs with `cmd widget test` (vitest + @cmd/widget-api/testing)
  src/ci.story.tsx      optional: states the Workbench and the Library preview show
  fixtures/busy.json    data the view must handle (Magic writes these; tests use them)
  README.md, CHANGELOG.md, LICENSE
  pnpm-lock.yaml        or none: a widget with no dependencies needs none
```

`package.json`, the one manifest, in the shape VS Code and Raycast use:

```json
{
  "name": "ci-runs",
  "version": "1.2.0",
  "description": "The latest GitHub Actions runs of a repository, with Rerun.",
  "license": "MIT",
  "engines": { "cmd": ">=0.32" },
  "devDependencies": { "@cmd/widget-api": "^1.0.0" },
  "cmd": {
    "api": 1,
    "widgets": [
      { "id": "ci", "title": "CI", "icon": "checkmark.seal", "main": "src/ci.tsx", "size": "m",
        "config": [{ "key": "repo", "title": "Repository", "type": "string", "default": "" },
                   { "key": "token", "title": "Token", "type": "string", "secret": true }] }
    ],
    "permissions": {
      "net": ["api.github.com"],
      "run": ["gh"],
      "workspace": ["read"],
      "events": ["output"],
      "act": ["actions.run"]
    }
  }
}
```

- `cmd.api` is the API major the code is written against; the `@cmd/widget-api` devDependency carries the types for it, and `cmd widget check` refuses a mismatch (as `vsce` does for `engines.vscode` against `@types/vscode`).
- `engines.cmd` is the oldest cmd that runs it; cmd refuses to install a newer requirement and the Library says "needs cmd 0.33" instead of failing later.
- A package holds one or more widgets (`cmd.widgets[]`, like Raycast's `commands[]`): a "GitHub" package can ship CI, Pull Requests and Issues. Each is a window type `pkg:<package>/<widget>` with the `role: "widget"`, `description`, `icon` and `config` the Library already shows.
- `permissions` is what the package *asks* for (next section). `net`, `run` and `read` are today's; `workspace`, `events` and `act` are new.
- Source is TypeScript; `main` is an entry the runtime imports directly (type stripping, as the core itself runs), so a widget with no dependencies has no build step. A package that uses npm dependencies bundles them (`cmd widget pack` runs esbuild to `dist/`, as VS Code advises); the runtime never resolves `node_modules` at run time, since that is how a dependency gets to run outside the grants.

**Where packages live.** `~/.cmd/widgets/<name>/` for every package you have, installed, linked or made with Magic, shared by every cmd instance on the Mac as `~/.vscode/extensions` is (today's folders are per instance under `$CMD_HOME/widgets/`, so a dev build has an empty library). `CMD_WIDGETS_HOME` overrides it (e2e uses a throwaway, as `CMD_TRANSCRIPTS_HOME` does). What is *about* a package but not *of* it stays per instance in `$CMD_HOME/widgets/<name>/`: grants, secrets, each window's config and state, the last data, Magic's build log. A linked package (`cmd widget link ~/src/my-widget`) is a symlink there, reloaded on every save.

### The host API

One module, `@cmd/widget-api`, typed, published to npm and vendored into the runtime cmd ships (`packages/widget-api`, imported in the widget process as `@cmd/widget-api` through an import map cmd writes, so widgets start in milliseconds, offline). It is the only way a widget reaches cmd. Its surface in API 1, in the vocabulary of docs/54's tools:

| Namespace | Read (runs at once, within the grant) | Act (asks, docs/55) |
|---|---|---|
| `cmd.workspace` | `get()`: id, name, root, branch; `windows()`; `selected()`; `use()` (live) | |
| `cmd.agents` | `list()`, `use()` (live: state, name, place, waiting since), `get(id)` | `start({ kind, prompt, cwd })`, `send(id, text)`, `stop(id)` |
| `cmd.terminals` | `list()`, `read(id)` (the screen, clipped, marked untrusted), `waitFor(id, pattern)` | `type(id, text)`, `open({ cwd, command })` (typed, not run) |
| `cmd.windows` | `list()`, `use()` | `open(target)` (a URL, a path, a widget), `select(id)`, `close(id)` |
| `cmd.events` | `query(q)`, `subscribe(q, fn)`, `stats(q)`: the event log under `data/policy.ts`, the widget's workspace, the classes it declared | |
| `cmd.actions` | `list()` | `run(name)` (risky ones confirm, as `actions.run` does) |
| `cmd.git` | `status()`, `diff(file?)`, `worktrees()` | |
| `cmd.notify` | | `send({ key, title, body, urgent })`: through the notification center, deduplicated by key, the widget's attention mark, muted per window as today |
| `cmd.net` | `fetch(url)` within granted hosts (the sandbox's `--allow-net` does the enforcing) | |
| `cmd.run` | `run(program, args)`: through the core, classified by `magic/policy.ts` like an agent's `run` tool (AR1-11-01 §3), so `docker run -v /:/h` and `git -c alias.x='!…'` are refused by one rule | |
| `cmd.config`, `cmd.secrets` | this window's config values; secret fields, never shown in the UI tree | |
| `cmd.state` | `get`, `set`, `history`: per window, persisted by the core, as `cmd.state` is today | |
| `cmd.env` | `version` (cmd's), `api` (the major and minor served), `has("agents.start")`, `theme`, `size`, `placement` (board or sidebar) | |

Rules of the surface:

- **Every method has one row in a capability table**, `widgets/api/access.ts`, typed against the API's method names the way `TOOL_ACCESS` is against `Method`: the permission it needs (`workspace:read`, `agents:act`, `events:<class>`, `net`, `run`), and whether it is `read`, `act` or `confirm`. A method without a row fails tsc. The table is the one place that decides, for the widget process, the CLI and the remote client alike.
- **`use()` is a subscription.** Under it, the core's `events.subscribe` and `data.subscribe` deliver changes over the widget's connection; the React side re-renders. A widget never polls cmd for what cmd can push. Refresh timers remain for the outside world (`cmd.net`, `cmd.run`), as `refresh` in the manifest.
- **Reads are clipped and marked**, as the tools' are: a terminal's screen comes back as text with a note that it is untrusted content; a page never comes back at all (no `browser.read`; a widget that wants a page is an agent's job).
- **No file writes.** Widgets read what they are granted and write nothing but their own state. A widget that wants to change files starts an agent.
- **The `experimental` namespace** (`cmd.experimental.*`) carries anything not yet promised. A package that uses it declares it (`"cmd": { "experimental": ["pages"] }`), the Library shows a badge, and the community index refuses it (VS Code's proposed APIs). Promotion is a minor version of the API and a rename out of the namespace.

The adapter behind it, `widgets/api/v1.ts`, is the only core file that knows both sides: each verb in terms of `CoreContext` services (`agents.list()`, `panes.read()`, `tools.run()`), and the capability row it checks first. It is where internal churn is absorbed. A registries test checks that every verb in the d.ts has a row in the table and an implementation in the adapter.

### The runtime: a widget process

Each widget instance (a window on the board) is one long-lived process, started when its window opens in any workspace and stopped a minute after the last window showing it closes. It runs on Deno, as `data.ts` does today, with everything that was built for that: the pinned, hashed binary; `--allow-net`, `--allow-read` and `--allow-env` from the grant; `--no-remote --no-npm --no-prompt`; the `sandbox-exec` profile with writes and the network denied except for the widgets socket and credentialed CLIs. What changes:

- It is **long-lived** and holds one connection to the widgets socket, opened with a token for that instance (today's `runSocket`, with the token living as long as the process). Subscriptions, state, notifications and the UI tree all travel on it. The process announces `{ api: 1, widget, package, version }` in its hello; the core picks the adapter.
- **`--allow-run` goes away.** `cmd.run` is a call to the core, which classifies and runs the program under the profile. `permissions.run` still names the programs, so the grant is honest, but the enforcement is in one place (AR1-11-01 §3).
- **Lifecycle is a contract**, as Raycast's and Chrome's are: a process is killed after 20 s of a stalled event loop, at a memory limit (`--v8-flags=--max-old-space-size`), or after three crashes in five minutes, and its window shows "Stopped · <reason>" with Restart. The title bar's health (`Updated 12 s ago`, `Stale · HTTP 403`) and backoff carry over as they are.
- **One process per instance**, not per package: instances differ in workspace, config and grants, and the sandbox is per process. Twenty widgets are twenty Deno processes at rest (about 25 MB each; docs/43 budgets it). A window off every board costs nothing. `background: true` in a widget's manifest, which keeps it running to notify while not shown, is a permission of its own and is not in phase 1.

Why Deno and not the alternatives, decided: a Node `utilityProcess` has no permission model (Raycast's choice, and they say they rely on review instead); QuickJS or SES in the renderer would have no `gh`, no `fetch`, no npm, and the escapes Figma had (and SES can't stop a loop or memory); WebAssembly (Zed) is the strongest but asks widget authors, and Magic, to compile to it. Deno has the permission model, runs TypeScript as is, and is already pinned, verified and sandboxed in cmd.

### The view: React, drawn by the app

A widget's view is React, written against `@cmd/widget-api`'s components, and it runs **in the widget process**. A custom reconciler (`react-reconciler`, as Raycast's) turns the component tree into a JSON tree of kit elements and sends it over the socket, then patches as it changes; the renderer's `PackageWidgetView` draws it with the real `@cmd/ui` components and sends interactions back (`{ handler: 12, event: "press" }`). Nothing of the widget's runs in the renderer.

```tsx
import { defineWidget, View, Toolbar, List, ListRow, Stat, Button, EmptyState, cmd } from "@cmd/widget-api";

export default defineWidget(() => {
  const agents = cmd.agents.use();                                   // live
  const waiting = agents.filter((a) => a.state === "waiting");
  if (!agents.length) return <EmptyState icon="person.2" title="No agents" body="Start one with ⌥⌘N." />;
  return (
    <View>
      <Toolbar><Stat label="Waiting" value={waiting.length} tone={waiting.length ? "warn" : "dim"} /></Toolbar>
      <List>
        {agents.map((a) => (
          <ListRow key={a.id} icon={a.icon} title={a.name} detail={a.statusLine} end={cmd.fmt.ago(a.changedAt)}
                   onPress={() => cmd.windows.select(a.windowId)} />
        ))}
      </List>
    </View>
  );
});
```

- **The components are the kit's window pieces** (docs/40): `View`, `Split`, `Stack`, `Inline`, `Toolbar` and its items, `List`/`ListSection`/`ListRow`/`Chip`, `Stat`, `Text`, `KeyValue`, `Callout`, `EmptyState`, `CodeBlock`, `Badge`, `StatusDot`, `Progress`, `Button`, `Segmented`, `Select`, `TextField`, `Switch`, `DataGrid`, `Chart`/`Sparkline`/`TimeSeries`/`Ranking`, `Picture`. The set is an allow-list the renderer holds, with each element's props and events (as remote-dom's host does), so a tree can't name a component outside it and props that are functions, URLs or HTML never cross: an image is a `Picture` with a URL the grant allows, a link is `onPress` plus `cmd.windows.open`.
- **Scrolling, text input and selection are the renderer's.** The tree says `<TextField value onChange>`; the renderer owns the caret and sends the value, debounced. Lists virtualise because `List` does. A thousand rows cross once, then as patches.
- **Theme, size and placement** are the app's: a widget reads `cmd.env` when it wants to adapt (a sidebar shows less), and never sees a colour.
- **Testable as data.** `render(<Widget/>, host)` from `@cmd/widget-api/testing` gives the tree; tests assert on it (`expect(tree).toHaveRow("Waiting")`) and snapshot it, with a fake host that serves fixture agents and events. No browser, no Electron, no Deno needed in CI. The same tree, drawn by the app's previewer, is the screenshot Magic looks at.
- **The phone client draws it too** (docs/13): the web client has the kit; a tree is data. Remote gets view-scope widgets for free, and act calls are `never` for remote, as the policy table already says for the tools.

**The frame surface, for pixels.** Four of Jan's widgets (a shader, a demo scene, a radio, a visualiser) are a canvas or a media element, not a list. A widget may declare `"surface": "frame"` and ship `view.html`: today's sandboxed iframe on `cmd-widget://`, with its CSP, media consent and kit CSS, drawn inside a kit `View` the app provides. It gets `props` from the widget process (data, config, theme) and sends `cmd.state` back; it has no host API. One frame host serves it, Jam and the Visualizer (AR1-11-05). Not the default, not what Magic reaches for unless the request is visual.

Rejected: React in the iframe with a copy of the kit (two kits again, no core access, no phone, no tree tests); plain HTML with a stricter kit (the same box, nicer); widgets as React code loaded into the renderer (Obsidian's model: full access, no boundary, impossible to grant).

### Capabilities and grants

The manifest asks; the person grants; the core enforces `declared ∩ granted` (AR1-11-01 §1–2).

- **Grants live outside the package**, in `$CMD_HOME/widgets/<name>/grants.json`: the set of permissions as granted, with the package version they were granted for. Magic's agent can't write it (it is not among the files its tools reach), and neither can a hand edit.
- **A sheet asks** when a package is added from the Library, installed, linked, or when a new version asks for more (a new host, program, folder, class of events, or any `act`): the approval sheet of docs/55 with the package's name, version and source, and each permission in words ("Reach api.github.com", "Run gh", "See the agents and terminals of this workspace", "Read commands' output", "Run Workspace Actions, asking first"). Allow on Return; a decline leaves the widget on the previous grant (or not running), never a half-granted state. Chrome's rule: an update that needs more waits, visibly, until answered.
- **During a Magic build**, the agent's request for permissions is itself a step: the build view shows "Wants to run gh and reach api.github.com" with Allow, and `run_data` runs offline against fixtures until it is answered. autoFix and hand edits never widen a grant.
- **Act calls ask again per call** (`confirm` rows), as the tools do, with the same remembered approvals ("Always allow ci-runs to run `test` here"). A read grant is given once per package version; an act grant is a permission to *ask*.
- **The vocabulary**, in words a person reads: `net:<host>`, `run:<program>`, `read:<folder>`, `workspace:read` (windows, panes, agents, selection of its workspace), `events:<class>` (docs/28's classes under `data/policy.ts`'s widget row), `agents:act`, `terminals:act`, `windows:act`, `actions:act`, `notify`, `background`. No `env`: a secret is a `secret` config field (AR1-11-01 §4). No `*` hosts in the community index; allowed locally with a red badge.
- **`cmd widget check`** refuses what the validator in docs/14 planned: shells and interpreters in `run`, `read: ["~"]`, undeclared `experimental` use, a `main` that imports outside the package, bundles over a size.

### Versioning and compatibility

This section is the answer to the constraint, so it is specific.

- **Three numbers, three jobs.** cmd's release (`0.32.0`) says what app you have. `PROTOCOL` (docs: "Versions on the wire") says whether a client and a core agree, and is internal. The widget API major (`cmd.api: 1`, `@cmd/widget-api@1.x`) says what a widget may rely on. Only the last is a promise to people outside the repo.
- **Within a major: additions only.** New verbs, new optional props, new components, new event fields. A widget checks `cmd.env.has("agents.start")` (as clients check `has(method)`) when it wants to run on an older cmd too; otherwise `engines.cmd` says the minimum. The d.ts carries `@since 1.2` on everything added after 1.0, and `cmd widget check` warns when a package uses something newer than its `engines.cmd` admits (VS Code's rule).
- **A major is an adapter, kept.** `widgets/api/v1.ts` stays when `v2.ts` arrives; the process's hello picks one. The core supports a major for at least two minors of cmd after its successor ships, and a `SUPPORTED_API` range in `packages/protocol` is what `core.hello` reports (the Library reads it). A widget on a major the core no longer serves doesn't break silently: its window says "Made for an older cmd" with **Update with Magic** (next bullet) or a link to the package's page, and the Library badges it. Chrome's silent non-update is the failure to avoid.
- **Magic migrates.** Kits already move widgets up (`kitMove` rewrites kit-1 variables). A major bump ships with a migration prompt: when the person next changes a widget, or presses Update, the agent rewrites it against the new API with the old files, the d.ts diff and the migration notes in its context, then checks and previews as for any change. This is cmd's unfair advantage over every system in the research: deprecation can be paired with an author who is always available.
- **Deprecation is visible, dated, and tested.** A verb to be removed is marked `@deprecated since 1.4, removed in 2` in the d.ts; calling it logs once per process into the widget's health ("uses agents.watch, which cmd 0.40 will drop"), and the Library shows a count. `widget-api.test.ts` keeps one example package per supported major in the repo (`packages/widget-api/examples/v1/`) and runs it against the current core on every commit: the promise is tested, not remembered.
- **cmd:2 widgets** (today's folders) are an adapter too: `widgets/legacy/` runs `data.ts` on its timer and the frame as today, unchanged, with the same grants sheet in front of it. They are listed in the Library as they are, marked "Older format"; a change in Magic rebuilds them as packages; a Move to V3 button does it without a change. The adapter is removed two releases after Magic stops writing the old format, and the folders that were never moved get a final offer in the Library before that.
- **The experimental namespace is where speed lives.** Anything in `cmd.experimental.*` can change in any release. Internal widgets (the built-ins that move to packages, phase 6) may use it; the community index refuses it; a Magic widget may use it only when the request needs it, and the Library shows the badge. Promoting an experiment is a minor of the API and the d.ts rename.

### Magic on V3

Magic keeps its experience and changes its output. The agent's tools write a package (`package.json`, `src/<id>.tsx`, a test, fixtures) instead of a folder; `check` is `cmd widget check`, `run_data` becomes `test` (the fake host with fixtures and, when granted, the real host), `preview` renders the tree in the app's previewer and returns the screenshot as today. The prompt (`magic/prompt/prompt.md`) and the nine examples are rewritten in V3; the evals (`cmd magic eval`) keep their cases and expectations.

What the agent sees of cmd is the API's own d.ts and the kit's component docs (the Workbench already derives those from the sources), so the prompt stops describing a CSS kit and starts reading a typed contract: fewer invented class names, and type errors caught by `check` instead of in the window.

**Revisions become git.** Each package made with Magic is a git repository (`git init` on creation, a commit per build, "Edited by hand" commits from the watcher, Restore is a checkout of a file set, the screenshot kept beside the commit under `.cmd/`). `cmd widget publish` is then a push. Numbered `revisions/NNNN/` folders go; the edit view's Changes list is `git log`. This is a proposal for phase 2 to confirm: the one cost is that git must be present, which it is wherever cmd's own git features work.

The `MagicService` split the review asked for (AR1-11-08) happens by construction: builds stay in `magic/`; running, health and lifecycle move to `widgets/host/`; the library to `widgets/library.ts`; config, state and secrets to the adapter. Each is a feature in `kernel/features.ts` with its own handlers.

### Developer ergonomics

`cmd widget`, one tool, every command usable by a person or an agent (Magic calls the same ones):

| Command | What |
|---|---|
| `new <name>` | a package from the template: `package.json`, a widget with a list and a toolbar, a test, a story, `CLAUDE.md`/`AGENTS.md` pointing at the API docs |
| `link [dir]` | symlink the folder into `~/.cmd/widgets`, grant sheet, in the Library at once; saves reload the process (hot reload, Raycast's `develop`) |
| `dev` | `link` plus a window on the board, the process's console in the terminal, errors and tree patches logged |
| `check [dir]` | manifest, types against the declared API major, `engines`, permissions rules, bundle size |
| `test [dir]` | vitest with `@cmd/widget-api/testing` (the fake host) |
| `preview [dir] [--themes all --sizes all]` | the tree drawn in the app or headless, screenshots, overflow and empty-state checks (today's `preview`) |
| `pack [dir]` | bundle to `dist/`, write `widget.tgz` with `files` only, a `sha256` |
| `install <url\|path\|name>` | from a tarball, a GitHub release, a folder, or the community index (phase 5) |
| `list`, `add`, `remove`, `update` | the Library's verbs (today's `list` and `add`) |
| `publish` | to GitHub (a release with `widget.tgz` and `package.json` as assets, Obsidian's shape) and a PR to the index |

- **`@cmd/widget-api/testing`**: `createHost({ workspace, agents, terminals, events, config })` returns a fake `cmd` whose reads serve the given data and whose acts record calls; `render(element, host)` returns the tree with matchers (`toHaveRow`, `toShowEmptyState`, `toHaveStat`) and a `press(row)` to drive handlers. Fixture agents, panes and events ship with it, taken from the e2e fixtures.
- **Stories in the Workbench** (docs/48): a package's `*.story.tsx` renders in the UI Workbench like a kit component's, with the fake host, in every theme and size. The Library's hover preview shows a story's shot. Magic writes a story per fixture.
- **The API reference** is generated from the d.ts (one page per namespace, every verb with its capability and `@since`) into the docs site and the prompt. One source.
- **Types that stop mistakes early**: `defineWidget` is typed by the config schema, `cmd.config.repo` is a `string`; a component's props are the kit's; a URL prop takes a `string` the check tool matches against `net`.

### Distribution

Later phases, but the format is decided now so nothing has to change for it:

- **A release is the package.** `cmd widget pack` writes `widget.tgz` (the `files` of `package.json`, bundled `dist/`, no `node_modules`) and its SHA-256. `install` from a GitHub release downloads exactly those two assets, checks the hash against the index, unpacks into `~/.cmd/widgets/<name>/`, and shows the grant sheet with the source ("from github.com/jan/ci-runs, 1.2.0").
- **The index is a JSON file in a repository** (`cmd-widgets/index`): name, repo, description, the hash per version, and the permissions as published, so the Library shows them before a download. A PR adds a package; CI runs `cmd widget check`, `test`, `preview` on it and refuses `experimental`, `*` hosts, shells, or a hash that doesn't match the release. Human review for listing, Obsidian-style, with a checklist (a README, a license, the screenshots, no analytics, no keychain).
- **Updates** check the index daily; a new version with the same permissions installs on next launch; one with more waits for the grant sheet (Chrome); the Library has an Updates row.
- **Signing** comes after hashing: a Sigstore or minisign signature per release, verified at install, once the index exists. Not phase 5.
- **The Library gets a Community tab**: search over the index, a card per package with its permissions in words, Install. Magic-made and installed packages sit together in Your Widgets; "Made with Magic" and "from github.com/…" are the subtitles.

### Built-ins and dogfooding

The API is proven by rewriting built-ins with it. Three are the yardstick for phase 1 and 6, chosen because they use what packages couldn't reach today: **Agent Activity** (agents live, selection, workspace scope), **Commands** (events with output, Run Again as a terminal act), **Timer** (state, notifications, a toolbar). If the API can't express one, the API is missing something, not the widget. They ship inside the repo (`packages/widgets/<name>/`, published to the index like anyone's) and the Library lists them as it does now; being a package changes nothing for the person.

What stays native: anything with a dependency the kit doesn't have (Live Diff's CodeMirror merge view, SQLite, PDF, Video, Jam's Strudel, the Visualizer's audio graph, YouTube's webview), the Navigator (a sidebar with the board's own state), the Operator. A native widget is a `WindowType` as today; the registry doesn't care.

### Remote

The tree makes view-scope widgets work in the phone client without a frame: `window.follow` subscribes the device to a window's tree the way it does to `magic.data`. Act handlers are stripped from trees sent to a view-scope device and confirm on the Mac for a control-scope one, as `REMOTE_ACCESS` does for the tools. Frame-surface widgets stay Mac-only, as Magic widgets are today.

## Phases

One worktree per phase; each ends green and visible. Sizes as in the review: S (days), M (a week or two), L (more).

1. **A package runs, and Agent Activity is one** (L). `packages/widget-api` (the d.ts for API 1 read verbs plus `notify`, `windows.open/select`, `state`, `config`; the components; `testing`); `package.json` parsing (`widgets/package.ts`); `~/.cmd/widgets` and `CMD_WIDGETS_HOME`; the widget process (`widgets/host/`: Deno, the long-lived connection, hello, lifecycle, limits); the adapter `widgets/api/v1.ts` and its capability table; the reconciler and tree protocol; `PackageWidgetView` drawing a first allow-list of components (View, Toolbar, Stack, Inline, List and rows, Stat, Text, Badge, StatusDot, Button, EmptyState, Callout, Progress); the grants file and the sheet; `cmd widget link|list|add|check`. Agent Activity rewritten as `packages/widgets/agents` and listed in the Library in place of the native one behind the `widgets.developer` setting until it matches. cmd:2 widgets untouched, running as before. **Visible:** a 60-line React widget linked from a folder, live with your agents, hot-reloaded on save, in every theme, on the phone.
2. **Magic makes packages** (M). The prompt and examples rewritten; the tools write packages; `check`/`test`/`preview` as the build's verify; the permission step in the build view; git-backed revisions (confirm first); fixtures and a story per build; the cmd:2 adapter in `widgets/legacy/` behind the same grants sheet; Move to V3 in the Library; `MagicService` split along the lines above. **Visible:** ⇧⌘M builds a kit widget; an old widget moves up with one click.
3. **The developer loop** (M). `cmd widget new|dev|test|preview`, the template, `@cmd/widget-api/testing` matchers and fixtures, stories in the Workbench and the Library's hover preview, the generated API reference, `CLAUDE.md` in the template so coding agents write widgets too. **Visible:** `cmd widget new` to a widget on the board in a minute, tests green in CI without Electron.
4. **Acting** (M). The act verbs (`agents.start/send/stop`, `terminals.type/open`, `actions.run`, `windows.close`) through `confirm` rows and docs/55's approvals with remembered grants per package and workspace; `cmd.run` through the core's policy and `--allow-run` removed; the acting mark on the window acted on, naming the widget. Commands and Timer rewritten as packages (Run Again is `terminals.open`; the Timer rings through `notify`). **Visible:** CI's Rerun runs for real after one approval, remembered.
5. **Distribution** (M). `pack`, `install` from a path, a tarball and a GitHub release with hash checks, `update`, the index repository with its CI, the Community tab, the permission-diff sheet on updates, `publish`. **Visible:** install a widget from a link in the Library; publish yours.
6. **Built-ins and the sunset** (M). Notifications and Resources as packages where they fit; `background` as a permission; signing; the cmd:2 adapter removed two releases after phase 2 shipped, with the final offer in the Library; `kits/`, `host.js`, `kit.css` and `view.d.ts` deleted with it; docs/14 and docs/16's "Under the hood" marked superseded.

Phase 1 is the one that proves the three sentences and is where the time goes; phases 2 and 3 are what people and agents touch; 4 to 6 can follow at the pace the registry needs. The order is chosen so that nothing in phases 2–6 changes the contract of phase 1: the d.ts grows, the table gets rows, the adapter gets verbs.

## Decisions, so they don't get re-decided

| Question | Decision | Why |
|---|---|---|
| Manifest file | `package.json` with a `cmd` block | What VS Code and Raycast authors know; npm tooling, semver, `files`, lockfiles for free |
| Where packages live | `~/.cmd/widgets/`, shared by instances; per-instance state in `$CMD_HOME/widgets/` | Installed packages are yours, not a dev build's; grants and secrets are the instance's |
| Logic runtime | one Deno process per instance, long-lived, under the existing sandbox | The only runtime here with a permission model that runs TypeScript as is; already pinned and sandboxed |
| View | React in the process, a kit tree drawn by the app; `frame` for pixels | One look, testable as data, the phone client, no second kit |
| Core access | `@cmd/widget-api` verbs over the widgets socket, adapter per major | Internal churn stays behind one file; the promise is small |
| Permissions | declared in the manifest, granted by the person, `declared ∩ granted`, re-asked on growth | AR1-11-01; Chrome and Zed |
| Acting | the same approvals as tools, confirm per call, remembered per package and workspace | One access model for agents, the Operator, remote and widgets (docs/54, docs/55) |
| API version | `cmd.api` major, `@since` minors, `has()`, adapters kept, deprecations dated, an example per major in CI, Magic migrates | Zed's bindings per version, Neovim's `since`, VS Code's engine pin; the migration author is cmd's own |
| Unstable surfaces | `cmd.experimental.*`, refused by the index | VS Code's proposed APIs: iterate daily without breaking published widgets |
| Dependencies | bundled by `pack`; the runtime never resolves `node_modules` | Chrome's no-remote-code; a dependency can't run outside the grant |
| Revisions | git per Magic package (confirm in phase 2) | Standard, publishable, diffable; Restore is checkout |
| Registry | a JSON index in a repository over GitHub releases, hash-pinned, reviewed | Obsidian's shape; the thinnest thing that is trustworthy |

## Open questions

- **Process count.** Twenty widgets on the board are twenty Deno processes. If docs/43's audit says that's too much at rest, instances of one package in one workspace could share a process with separate roots; the API doesn't change either way.
- **Git for revisions** needs confirming against the edit view's needs (screenshots per version, "what was asked"): commit messages and a `.cmd/` folder cover it, but the UI work is real.
- **Act grants for Magic-made widgets.** Should a widget the agent just wrote be able to ask for `agents:act` in the same build? Proposed: yes, with the same sheet, since the person asked for the widget; the index is where the bar is higher.
- **Where the built-ins' packages publish from.** In-repo packages published to the index under a `cmd` publisher, or kept out of the index as "Built-in" and only in the app. Proposed: in the index too, so the index's CI runs on them.
- **Windows** (docs/42): Deno and `sandbox-exec` are macOS answers; on Windows the process runs with Deno's flags and no OS sandbox, which the Library should say.

## Sources

Primary sources behind "What others do", fetched 2026-10-14:

- VS Code: [extension manifest](https://code.visualstudio.com/api/references/extension-manifest), [activation events](https://code.visualstudio.com/api/references/activation-events), [extension API process](https://github.com/microsoft/vscode/wiki/Extension-API-process), [proposed APIs](https://code.visualstudio.com/api/advanced-topics/using-proposed-api), [extension host](https://code.visualstudio.com/api/advanced-topics/extension-host), [runtime security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security), [webviews](https://code.visualstudio.com/api/extension-guides/webview), [workspace trust](https://code.visualstudio.com/api/extension-guides/workspace-trust), [publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), [bundling](https://code.visualstudio.com/api/working-with-extensions/bundling-extension), [testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension), [Open VSX publishing](https://github.com/eclipse/openvsx/wiki/Publishing-Extensions)
- Obsidian: [manifest](https://docs.obsidian.md/Reference/Manifest), [sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin), [releases repository](https://github.com/obsidianmd/obsidian-releases), [plugin security](https://obsidian.md/help/plugin-security), [guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines), [submitting](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
- Raycast: [manifest](https://developers.raycast.com/information/manifest), [user interface](https://developers.raycast.com/api-reference/user-interface), [how extensions work](https://www.raycast.com/blog/how-raycast-api-extensions-work), [lifecycle](https://developers.raycast.com/information/lifecycle), [prepare for the store](https://developers.raycast.com/basics/prepare-an-extension-for-store), [publish](https://developers.raycast.com/basics/publish-an-extension)
- Figma: [how plugins run](https://developers.figma.com/docs/plugins/how-plugins-run/), [manifest](https://developers.figma.com/docs/plugins/manifest/), [plugin security update](https://www.figma.com/blog/an-update-on-plugin-security/), [typings](https://developers.figma.com/docs/plugins/api/api-reference/), [debugging](https://developers.figma.com/docs/plugins/debugging/)
- Zed: [developing extensions](https://zed.dev/docs/extensions/developing-extensions), [Zed decoded: extensions](https://zed.dev/blog/zed-decoded-extensions), [capabilities](https://zed.dev/docs/extensions/capabilities)
- Chrome: [declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions), [permission warnings](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings), [minimum_chrome_version](https://developer.chrome.com/docs/extensions/reference/manifest/minimum-chrome-version), [service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy), [MV2 deprecation timeline](https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline)
- Deno: [security and permissions](https://docs.deno.com/runtime/fundamentals/security/), [deno.json](https://docs.deno.com/runtime/reference/deno_json/); Slack: [app manifest](https://docs.slack.dev/tools/deno-slack-sdk/guides/using-the-app-manifest)
- Tauri: [capabilities](https://v2.tauri.app/security/capabilities/), [permissions](https://v2.tauri.app/security/permissions/), [scopes](https://v2.tauri.app/security/scope/)
- Versioning: [Shopify API versioning](https://shopify.dev/docs/api/usage/versioning), [Neovim API](https://neovim.io/doc/user/api/), [Home Assistant manifest](https://developers.home-assistant.io/docs/creating_integration_manifest/) and [quality scale](https://developers.home-assistant.io/docs/core/integration-quality-scale/), [HACS publishing](https://www.hacs.xyz/docs/publish/integration/)
- Sandboxing: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process), [SES](https://github.com/endojs/endo/blob/master/packages/ses/README.md), [LavaMoat](https://github.com/LavaMoat/LavaMoat), [ShadowRealm](https://github.com/tc39/proposal-shadowrealm), [remote-dom](https://github.com/Shopify/remote-dom), [Shopify checkout UI extensions](https://shopify.dev/docs/api/checkout-ui-extensions)
- What went wrong: [Sunsetting Atom](https://github.blog/news-insights/product-news/sunsetting-atom/), [Slack deprecations](https://docs.slack.dev/changelog/tags/deprecation), Hyper and Tabby in [04-prior-art.md](04-prior-art.md)
