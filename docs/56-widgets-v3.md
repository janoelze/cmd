# Widgets V3: packages on a versioned API

**Status:** partly built: phase 1 is built: packages in `~/.cmd/widgets` and built-in ones in `packages/widgets`, `@cmd/widget-api` (API 1, its reference generated into its README), one Deno process per window, trees drawn with the kit, the grants sheet, `cmd widget link` and hot reload, and Agents as the first built-in package. Phase 2a is built: Magic makes packages (the prompt and its nine examples, the agent's check, test and preview, the permission step, Made with Magic in the Library, a token ceiling); phase 2b (the old runtime deleted, the split, the frame host, git revisions) and phases 3–6 are proposals.

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
| Secrets per widget, mode 0600 | `widgets/secrets.ts` | Unchanged, read only by the core: it attaches a secret field to the host the field is bound to (`cmd.net.fetch` with `auth`) |
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
6. **A clean slate, every phase visible.** Each phase is visible in the app. Today's format is not carried: no adapter runs cmd:2 folders, no migration rebuilds them, and the old runtime (the `data.ts` runner, the frame kit and its versions, the frame host, the refresh paths in `MagicService`) is deleted in phase 2. Widgets made before are gone with it, and a release note says so; with a handful of users, a clean implementation is worth more than keeping them. Anyone who wants one back describes it to Magic again.

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
                   { "key": "token", "title": "Token", "type": "string", "secret": true, "host": "api.github.com" }] }
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

- A secret field says where it is sent: `host` (required, and in `net`), `header` (default `Authorization`) and `scheme` (default `Bearer`; `""` sends the value alone). The core attaches it to `cmd.net.fetch` calls with `auth: "token"` to that host only; the widget never sees it.
- `cmd.api` is the API major the code is written against; the `@cmd/widget-api` devDependency carries the types for it, and `cmd widget check` refuses a mismatch (as `vsce` does for `engines.vscode` against `@types/vscode`).
- `engines.cmd` is the oldest cmd that runs it; cmd refuses to install a newer requirement and the Library says "needs cmd 0.33" instead of failing later.
- A package holds one or more widgets (`cmd.widgets[]`, like Raycast's `commands[]`): a "GitHub" package can ship CI, Pull Requests and Issues. Each is a window type `pkg:<package>/<widget>` with the `role: "widget"`, `description`, `icon` and `config` the Library already shows.
- `permissions` is what the package *asks* for (next section). `net`, `run` and `read` are today's; `workspace`, `events` and `act` are new.
- Source is TypeScript; `main` is an entry the runtime imports directly (type stripping, as the core itself runs), so a widget with no dependencies has no build step. A package that uses npm dependencies bundles them (`cmd widget pack` runs esbuild to `dist/`, as VS Code advises); the runtime never resolves `node_modules` at run time, since that is how a dependency gets to run outside the grants.

**Where packages live.** `~/.cmd/widgets/<name>/` for every package you have, installed, linked or made with Magic, shared by every cmd instance on the Mac as `~/.vscode/extensions` is (today's folders are per instance under `$CMD_HOME/widgets/`, so a dev build has an empty library). `CMD_WIDGETS_HOME` overrides it (e2e uses a throwaway, as `CMD_TRANSCRIPTS_HOME` does). What is *about* a package but not *of* it stays per instance in `$CMD_HOME/widget-packages/<name>/` (a folder of its own until phase 2 retires today's `$CMD_HOME/widgets/`): grants, secrets, each window's config and state, the last data, Magic's build log. A linked package (`cmd widget link ~/src/my-widget`) is a symlink there, reloaded on every save.

### The host API

One module, `@cmd/widget-api`, typed, published to npm and vendored into the runtime cmd ships (`packages/widget-api`, imported in the widget process as `@cmd/widget-api` through an import map cmd writes, so widgets start in milliseconds, offline). It is the only way a widget reaches cmd. Its surface in API 1, in the vocabulary of docs/54's tools:

| Namespace | Read (runs at once, within the grant) | Act (asks, docs/55) |
|---|---|---|
| `cmd.workspace` | `get()`: id, name, root, branch; `windows()`; `selected()`; `use()` (live) | |
| `cmd.agents` | `list()`, `use()` (live: state, name, place, waiting since), `get(id)` | `start({ kind, prompt, cwd })`, `send(id, text)`, `stop(id)` |
| `cmd.terminals` | `list()`, `read(id)` (the screen, clipped, marked untrusted), `waitFor(id, pattern)` | `type(id, text)`, `open({ cwd, command })` (typed, not run) |
| `cmd.windows` | `list()`, `use()` | `open(target)` (a URL, a path, a widget; only within 5 s of a press in the widget), `select(id)`, `close(id)` |
| `cmd.events` | `query(q)`, `subscribe(q, fn)`, `stats(q)`: the event log under `data/policy.ts`, the widget's workspace, the classes it declared | |
| `cmd.actions` | `list()` | `run(name)` (risky ones confirm, as `actions.run` does) |
| `cmd.git` | `status()`, `diff(file?)`, `worktrees()` | |
| `cmd.notify` | | `send({ key, title, body, urgent })`: through the notification center, deduplicated by key, the widget's attention mark, muted per window as today; needs no permission (one per key and words, at most 10 a minute) |
| `cmd.net` | `fetch(url, { method, headers, body, auth })` through the core, which checks the host against `net`; the body comes back as text, clipped. `auth` names a secret config field the core attaches, only to the host it is bound to | |
| `cmd.ai` | `complete({ prompt, system, schema, maxTokens })`: `{ text }` or, with a JSON Schema, `{ object }`, plus `usage`; through the core's AI service, no tools | |
| `cmd.run` | `run(program, args)`: through the core, classified by `magic/policy.ts` like an agent's `run` tool (AR1-11-01 §3), so `docker run -v /:/h` and `git -c alias.x='!…'` are refused by one rule | |
| `cmd.config` | this window's config values; secret fields never reach the widget (below) | |
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

Each widget instance (a window on the board) is one long-lived process, started when its window opens in any workspace and stopped a minute after the last window showing it closes. It runs on Deno, as `data.ts` does today, with everything that was built for that: the pinned, hashed binary; `--allow-read` and `--allow-env` from the grant; `--no-remote --no-npm --no-prompt`; the `sandbox-exec` profile with writes and the network denied except for the widgets socket and credentialed CLIs. What changes:

- It is **long-lived** and holds one connection to the widgets socket, opened with a token for that instance (today's `runSocket`, with the token living as long as the process). Subscriptions, state, notifications and the UI tree all travel on it. The entry (`widget-runtime/package-main.ts`) says `widget.hello` with its token as today's runs do; the server then hands the connection to the host, and from the next line on it carries the widget wire (`widget-tree.ts`). The process announces `{ api: 1, widget, package, version }` in its hello; the core picks the adapter. The core pings (`{"ping":n}`, answered `{"pong":n}` from the process's event loop): transport frames beside the wire, not part of the API, and how a stalled loop is noticed.
- **The flags, as built:** `--no-remote --no-npm --no-prompt`, the vendored `@cmd/widget-api` through an import map, `--allow-read` for the package, the bundle and the granted `read` folders only, `--allow-write` and `--allow-net=unix:` scoped to the widgets socket (Deno needs them to connect to it; no other network, no `--allow-run`), `--allow-env` for the socket and token only, and a 256 MB heap (`--v8-flags=--max-old-space-size=256`).
- **`--allow-run` goes away.** `cmd.run` is a call to the core, which classifies and runs the program under the profile. `permissions.run` still names the programs, so the grant is honest, but the enforcement is in one place (AR1-11-01 §3).
- **Lifecycle is a contract**, as Raycast's and Chrome's are: a process is killed after 20 s of a stalled event loop, at a memory limit (`--v8-flags=--max-old-space-size`), or after three crashes in five minutes, and its window shows "Stopped · <reason>" with Restart. A crash restarts it (a second later) until the third; a stall or the memory limit stops it at once, since running it again would do the same. The title bar's health (`Updated 12 s ago`, `Stale · HTTP 403`) and backoff carry over as they are.
- **One process per instance**, not per package: instances differ in workspace, config and grants, and the sandbox is per process. Twenty widgets are twenty Deno processes at rest (about 25 MB each; docs/43 budgets it). A window off every board costs nothing. `background: true` in a widget's manifest, which keeps it running to notify while not shown, is a permission of its own and is not in phase 1.

Why Deno and not the alternatives, decided: a Node `utilityProcess` has no permission model (Raycast's choice, and they say they rely on review instead); QuickJS or SES in the renderer would have no `gh`, no `fetch`, no npm, and the escapes Figma had (and SES can't stop a loop or memory); WebAssembly (Zed) is the strongest but asks widget authors, and Magic, to compile to it. Deno has the permission model, runs TypeScript as is, and is already pinned, verified and sandboxed in cmd.

### The view: React, drawn by the app

A widget's view is React, written against `@cmd/widget-api`'s components, and it runs **in the widget process**. A custom reconciler (`react-reconciler`, as Raycast's) turns the component tree into a JSON tree of kit elements and sends it over the socket, then patches as it changes; the renderer's `PackageWidgetView` draws it with the real `@cmd/ui` components and sends interactions back (`{ handler: 12, event: "onClick" }`). Nothing of the widget's runs in the renderer.

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

- **The components are the API's, drawn by the kit's.** `@cmd/widget-api`'s `ListRow` is an element of the versioned API, not a re-export of `@cmd/ui`'s: the tree carries the API's tag and props, and one table in the renderer (`windows/package/elements.tsx`) maps each API element to the kit component that draws it today and translates its props. The kit stays internal and free to move (it is `private: true` and renamed often): renaming `ListRow` in the kit changes one line of the table; changing a kit prop changes the translation; replacing a kit component keeps the API element drawn by whatever replaced it. The same rule as the verbs: the promise is the API's names, the adapter absorbs the churn, and the example package per major renders every element in CI so a kit change that breaks one fails before release. In API 1 the elements mirror the kit's window pieces (docs/40): `View`, `Split`, `Stack`, `Inline`, `Toolbar` and its items, `List`/`ListSection`/`ListRow`/`Chip`, `Stat`, `Text`, `KeyValue`, `Callout`, `EmptyState`, `CodeBlock`, `Badge`, `StatusDot`, `Progress`, `Button`, `Segmented`, `Select`, `TextField`, `Switch`, `DataGrid`, `Chart`/`Sparkline`/`TimeSeries`/`Ranking`, `Picture`. The set is an allow-list the renderer holds, with each element's props and events (as remote-dom's host does), so a tree can't name a component outside it and props that are functions, URLs or HTML never cross: an image is a `Picture` with a URL the grant allows, a link is `onPress` plus `cmd.windows.open`.
- **Scrolling, text input and selection are the renderer's.** The tree says `<TextField value onChange>`; the renderer owns the caret and sends the value, debounced. Lists virtualise because `List` does. A thousand rows cross once, then as patches.
- **Theme, size and placement** are the app's: a widget reads `cmd.env` when it wants to adapt (a sidebar shows less), and never sees a colour.
- **Testable as data.** `render(<Widget/>, host)` from `@cmd/widget-api/testing` gives the tree; tests assert on it (`expect(tree).toHaveRow("Waiting")`) and snapshot it, with a fake host that serves fixture agents and events. No browser, no Electron, no Deno needed in CI. The same tree, drawn by the app's previewer, is the screenshot Magic looks at.
- **The wire** (protocol `widget-tree.ts`, API 1). The process says `hello { api, minor, package, version, widget }`; the core answers `ready { env, config, state }`, so the first render already has the stored state. The tree goes once (`tree`), then one `patch` per React commit; both carry a `rev`, and a renderer that sees a gap sends `resync` for the whole tree. Patch ops by node id, applied in order: `insert`, `move` (React moving a keyed row), `remove`, `props` (set and unset), `text`. A function prop is a handler id, kept per prop path (`onClick`, `menu.0.run`) so a new closure each render changes nothing on the wire; `interaction.event` is the prop's name, which follows the kit (`onClick`, `onChange`, `run` for a menu entry). Calls carry their arguments in order (`["w-1"]`); a subscription's first `event` is the current value, later ones replace it (`events` sends only new ones).
- **The phone client draws it too** (docs/13): the web client has the kit; a tree is data. Remote gets view-scope widgets for free, and act calls are `never` for remote, as the policy table already says for the tools.

**The frame surface, for pixels.** Four of Jan's widgets (a shader, a demo scene, a radio, a visualiser) are a canvas or a media element, not a list. A widget may declare `"surface": "frame"` and ship `view.html`: today's sandboxed iframe on `cmd-widget://`, with its CSP, media consent and kit CSS, drawn inside a kit `View` the app provides. It gets `props` from the widget process (data, config, theme) and sends `cmd.state` back; it has no host API. One frame host serves it, Jam and the Visualizer (AR1-11-05). Not the default, not what Magic reaches for unless the request is visual.

Rejected: React in the iframe with a copy of the kit (two kits again, no core access, no phone, no tree tests); plain HTML with a stricter kit (the same box, nicer); widgets as React code loaded into the renderer (Obsidian's model: full access, no boundary, impossible to grant).

### Writing the UI: what the author sees

The target is one sentence: **a widget's view reads like a built-in's view.** Agent Activity today (`windows/agents/AgentActivity.tsx`, 154 lines) is `View`, `List`, `ListRow`, `ListRowIcon`, `ListRowContent`, `ListRowEnd`, `Stack`, `Text`, `Button` from `@cmd/ui`, the renderer's store for the agents, and `useWidgetStatus` for the title bar. The same widget as a package is the same JSX with the store swapped for a hook. The five reference windows (`reference/*.story.tsx`, docs/40) are the spec for widgets as they are for windows, and the `window-design` skill applies to both without a translation.

```tsx
// src/agents.tsx
import { Window, View, List, ListSection, ListRow, ListRowIcon, ListRowContent, ListRowEnd, Chip, Button,
         useAgents, useWorkspace, useStoredState, useNow, fmt, cmd } from "@cmd/widget-api";

export default function AgentActivity() {
  const [scope, setScope] = useStoredState<"workspace" | "all">("scope", "workspace");   // kept by the core per window
  const agents = useAgents({ scope });                                                   // live; re-renders on agent.updated
  const now = useNow(15_000);
  const waiting = agents.filter((a) => a.bucket === "needs");
  const working = agents.filter((a) => a.state === "working");

  return (
    <Window
      status={[waiting.length && `${waiting.length} waiting for you`, working.length && `${working.length} working`].filter(Boolean).join(" · ") || null}
      menu={[{ label: "This Workspace", checked: scope === "workspace", run: () => setScope("workspace") },
             { label: "All Workspaces", checked: scope === "all", run: () => setScope("all") }]}
    >
      <View state={agents.length ? undefined : { icon: "person.2", title: "No agents", text: "Start one with ⌥⌘N.", action: { label: "New Claude Session", run: () => cmd.agents.start({ kind: "claude" }) } }}>
        <List>
          <ListSection title="Waiting for you" count={waiting.length}>
            {waiting.map((a) => (
              <ListRow key={a.id} onClick={() => cmd.windows.select(a.windowId)} menu={[{ label: "Mark Seen", run: () => cmd.agents.markSeen(a.id) }]}>
                <ListRowIcon icon={a.icon} light={a.light} />
                <ListRowContent title={a.name} place={a.place} detail={a.statusLine} tone="needs" />
                <ListRowEnd><Chip>{fmt.ago(a.stateSince, now)}</Chip></ListRowEnd>
              </ListRow>
            ))}
          </ListSection>
          …
        </List>
      </View>
    </Window>
  );
}
```

What the author gets without writing it:

- **The window.** The title bar, its icon and name from the manifest, the status line from `Window status`, the title menu from `Window menu` (the scope switch, as built-ins have through `titleMenu`), the context menu from `Window actions` and a row's `menu`, "Updated 12 s ago" and "Stale · HTTP 403" from `useData` (below), Refresh Now, Mute, Remove from Board. A widget never draws chrome, a refresh button or an "updated" line, which is the rule Magic's prompt spends a paragraph on today.
- **Layout and look.** `View` scrolls, insets (`inset`), hosts a toolbar and the cover states; `Stack`, `Inline`, `Tiles`, `Panes` lay out in steps of the scale (`gap={2}`, typed); `Hide below="narrow"` drops what doesn't fit; `List` virtualises, keeps the keyboard's row and the selection; `DataGrid` drops columns as space runs out. Tones, not colours (`tone="needs"`, `deltaTone="warning"`); sizes, not pixels; SF Symbol names for icons (`cmd widget check` knows the catalogue). There is no `className`, `style` or CSS: a look is a prop, or it is a kit change.
- **Data, with health.** The hooks are the API's reads as subscriptions: `useWorkspace()`, `useAgents()`, `useTerminals()`, `useWindows()`, `useEvents(query)`, `useGit()`, `useActions()`, `useConfig()`, `useEnv()` (theme, size class, placement). For the outside world, `useData(fn, { every: 60 })` runs `fn` (a `cmd.net.fetch`, a `cmd.run("gh", …)`) on the manifest's schedule and returns `{ data, error, stale, refreshing, refresh }`; the title bar's health, backoff and `Retry-After` come from it, the last good data stays on screen, and the error line under the widget is drawn by the app, exactly what `data.ts` gets today, in a hook. `useStoredState(key, initial)` is `cmd.state`: kept by the core per window across reloads and restarts. `useNow(ms)` for ages.
- **Interaction without the DOM.** Handlers are `onClick`, `onDoubleClick`, `onChange`, `onSubmit`, `onSelect`; the renderer owns the events and sends the values. Context menus are data (`menu={[{ label, run, checked, submenu }]}`), as the kit's `MenuEntry` is. Overlays are elements the kit already has (`Menu`, `Popover`, `ConfirmDialog`, `toast()`), never a portal. Text fields keep their caret in the renderer and report the value debounced; `autoFocus` is the one focus control.
- **States as data.** `View state={…}` is the kit's `ViewStateSpec`: empty, loading, error, each with an icon, a title, a line and one action. A render error is caught by the reconciler's boundary and shown as a `Callout` with the stack in the window and in `cmd widget dev`'s terminal; the process lives on, and the next save redraws.
- **Typed config.** `cmd widget check` and `dev` write `cmd-env.d.ts` from `package.json` (Raycast writes `raycast-env.d.ts` the same way), so `useConfig()` is `{ repo: string; token: string }` and a renamed field is a type error, not a runtime surprise. Secrets are in `useConfig()` too and never in a tree.

What the author cannot do, by design: reach the DOM, measure, style, load a font, embed a page or an image from a host the grant doesn't name, open a window the person didn't ask for (acts confirm), or draw outside the kit. A widget that needs pixels declares the `frame` surface and gives up the rest.

The elements of API 1 (protocol `widget-tree.ts`'s `API_ELEMENTS`, the allow-list the renderer holds), mirroring the kit's window pieces with the kit's own props minus the DOM's (`className`, `style`, `ref`, HTML attributes): `Window`; `View`, `Stack`, `Inline`, `Tiles`, `Hide`; `WindowToolbar` with `ToolbarButton`, `ToolbarField`, `ToolbarSearchField`, `ToolbarSegmented`, `ToolbarMenu`, `ToolbarText`, `ToolbarSpacer`; `List`, `ListSection`, `ListRow` with `ListRowIcon`, `ListRowContent`, `ListRowEnd`, `Chip`; `Stat`, `Sparkline`, `Progress`; `Text`, `Badge`, `StatusDot`, `Callout`, `EmptyState`; `Button`. The rest of the kit (`Split`, `Panes`, `DataGrid`, the charts, the form controls, `Menu`, `Popover`, …) comes as API minors when a widget needs it and its props are settled; anything the kit renames is a line in the element table.

**The loop.** `cmd widget new agents` writes the package with this view, a story and a test. `cmd widget dev` links it, puts it on the board and prints the process's console; a save restarts the process in under a second with `useStoredState` intact, so the window redraws where it was. `pnpm workbench widgets/agents` shows its stories beside the kit's, with the fake host's fixtures, in the reference windows' size matrix and every theme. The test:

```tsx
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import Widget from "./agents.tsx";

test("waiting agents come first", async () => {
  const host = createHost({ agents: [fixtures.agent({ name: "Tours", state: "waiting" }), fixtures.agent({ name: "Perf", state: "working" })] });
  const tree = await render(<Widget />, host);
  expect(tree).toHaveSection("Waiting for you", { count: 1 });
  expect(tree.rows()[0]).toHaveTitle("Tours");
  await tree.press(tree.rows()[0]);
  expect(host.calls).toEqual([["windows.select", "w-tours"]]);
});
```

No browser, no Electron, no Deno: the tree is data and the host is a fake. The same `render` is what Magic's `preview` draws through the app for its screenshot.

### Capabilities and grants

The manifest asks; the person grants; the core enforces `declared ∩ granted` (AR1-11-01 §1–2).

- **Grants live outside the package**, in `$CMD_HOME/widget-packages/<name>/grants.json`: the set of permissions as granted, with the package version they were granted for. Magic's agent can't write it (it is not among the files its tools reach), and neither can a hand edit.
- **A sheet asks** when a package is added from the Library, installed, linked, or when a new version asks for more (a new host, program, folder, class of events, or any `act`): the approval sheet of docs/55 with the package's name, version and source, and each permission in words ("Reach api.github.com", "Run gh", "See the agents and terminals of this workspace", "Read commands' output", "Run Workspace Actions, asking first"). Allow on Return; a decline leaves the widget on the previous grant (or not running), never a half-granted state. Chrome's rule: an update that needs more waits, visibly, until answered.
- **During a Magic build**, the agent's request for permissions is itself a step: the build view shows "Wants to run gh and reach api.github.com" with Allow, and `run_data` runs offline against fixtures until it is answered. autoFix and hand edits never widen a grant.
- **Act calls ask again per call** (`confirm` rows), as the tools do, with the same remembered approvals ("Always allow ci-runs to run `test` here"). A read grant is given once per package version; an act grant is a permission to *ask*.
- **The vocabulary**, in words a person reads: `net:<host>`, `run:<program>`, `read:<folder>`, `workspace:read` (windows, panes, agents, selection of its workspace), `events:<class>` (docs/28's classes under `data/policy.ts`'s widget row), `agents:act`, `terminals:act`, `windows:act`, `actions:act`, `ai:complete`, `background`. No `env`: a secret is a `secret` config field (AR1-11-01 §4). No `*` hosts in the community index; allowed locally with a red badge.
- **`cmd widget check`** refuses what the validator in docs/14 planned: shells and interpreters in `run`, `read: ["~"]`, undeclared `experimental` use, a `main` that imports outside the package, bundles over a size.

#### Secrets never reach a widget

A widget never holds a secret: no verb returns one, `ready` and `config` leave secret fields out, and nothing a widget runs could leak one into a tree, a log or a fetch to the wrong host.

- **Brokered credentials.** A secret config field is bound to a host in `package.json`. `cmd.net.fetch(url, { auth: "token" })` names the field; the core fetches, checks the host against the grant, and attaches the value only when the URL's host is the field's. The process has no network of its own (no `--allow-net`), so `fetch` through the core is the only way out.
- **AI.** `cmd.ai.complete` runs a completion through the core's AI service (`ai/service.ts`) with the person's key and no tools. The permission is `"ai": ["complete"]`; the grant sheet says "Use your AI, counts against your usage". A per-widget budget and rate limit come with the core side (phase 1, item C): `widgets.aiBudget` (Settings → Magic Widgets; 200,000 tokens a day per package, 0 for no limit), counted in `widget-packages/<name>/ai-usage.json`; calls run on the fast tier with purpose `widget:<name>`, so they are in the log as every AI call is. Calls a minute per process: `net.fetch` 60, `ai.complete` 10, `notify.send` 10.
- **Errors name what to add.** A refused call says the permission as `package.json` writes it: `net: ["api.github.com"]`, `ai: ["complete"]`.

#### Configuring a package widget

Built (item G): a window's **Configure…** (its title menu and context menu, after the tree's own entries) opens a sheet over the board with a row per `config` field: its title and description, the control its type asks for (a text field, a number, a switch, a menu of its options) and the default as placeholder. A secret field shows **Set** (with Change and Remove) or **Not set** (a password field), and "Sent only to <host>" under it. Nothing is sent until Save: secrets first (`widget.secret { name, widget, key, value }`, `null` removes), then the values that changed (`widget.config { windowId, values }`), so the redraw the new config causes already finds the token. The core (`widgets/config.ts`) checks values against the fields, all or nothing: an unknown key or a secret is refused, a number or switch is taken from text, an enum must be one of its options, `null` or `""` goes back to the default; the values live in the window's `state.config` (per window, as Magic's) and the host pushes the new `config` to the process. Secrets live per package and widget id in `$CMD_HOME/widget-packages/<name>/secrets.json` (0600), shared by every window of that widget, read again on each `net.fetch`, so a changed one needs no restart and nothing is pushed. Clients learn only which are set (`widget.secrets`, and the Library entry's `secrets`, beside its `config` fields); the value is in no log line, event or message. A window whose widget has config fields, none set, and one it needs missing (a secret, or a field without a default) shows "Set up <title>" with Configure… instead of its tree. The rows are the package view's own (`windows/package/ConfigSheet.tsx`), not MagicEditor's, which commit each change at once; the secret control is a password field with Set / Change / Remove rather than the kit's `SecretField`, whose own Save would be a second Save inside the sheet. All three methods are `never` for tools and remote devices.

### Versioning and compatibility

This section is the answer to the constraint, so it is specific.

- **Three numbers, three jobs.** cmd's release (`0.32.0`) says what app you have. `PROTOCOL` (docs: "Versions on the wire") says whether a client and a core agree, and is internal. The widget API major (`cmd.api: 1`, `@cmd/widget-api@1.x`) says what a widget may rely on. Only the last is a promise to people outside the repo.
- **Within a major: additions only.** New verbs, new optional props, new components, new event fields. A widget checks `cmd.env.has("agents.start")` (as clients check `has(method)`) when it wants to run on an older cmd too; otherwise `engines.cmd` says the minimum. The d.ts carries `@since 1.2` on everything added after 1.0, and `cmd widget check` warns when a package uses something newer than its `engines.cmd` admits (VS Code's rule).
- **A major is an adapter, kept.** `widgets/api/v1.ts` stays when `v2.ts` arrives; the process's hello picks one. The core supports a major for at least two minors of cmd after its successor ships, and a `SUPPORTED_API` range in `packages/protocol` is what `core.hello` reports (the Library reads it). A widget on a major the core no longer serves doesn't break silently: its window says "Made for an older cmd" with **Update with Magic** (next bullet) or a link to the package's page, and the Library badges it. Chrome's silent non-update is the failure to avoid.
- **Magic migrates.** Kits already move widgets up (`kitMove` rewrites kit-1 variables). A major bump ships with a migration prompt: when the person next changes a widget, or presses Update, the agent rewrites it against the new API with the old files, the d.ts diff and the migration notes in its context, then checks and previews as for any change. This is cmd's unfair advantage over every system in the research: deprecation can be paired with an author who is always available.
- **Deprecation is visible, dated, and tested.** A verb to be removed is marked `@deprecated since 1.4, removed in 2` in the d.ts; calling it logs once per process into the widget's health ("uses agents.watch, which cmd 0.40 will drop"), and the Library shows a count. `widget-api.test.ts` keeps one example package per supported major in the repo (`packages/widget-api/examples/v1/`) and runs it against the current core on every commit: the promise is tested, not remembered.
- **cmd:2 widgets are dropped.** There is no runtime for today's folders after phase 2 and no migration. The first start after it renames `$CMD_HOME/widgets/` to `widgets-old/` (a person's files are never deleted by an update) and closes the `magic` windows that showed them; the Library lists nothing from before; the release note says widgets made before this version are gone and Magic makes them again. The compatibility promise starts at API 1; what came before was an experiment and is treated as one.
- **The experimental namespace is where speed lives.** Anything in `cmd.experimental.*` can change in any release. Internal widgets (the built-ins that move to packages, phase 6) may use it; the community index refuses it; a Magic widget may use it only when the request needs it, and the Library shows the badge. Promoting an experiment is a minor of the API and the d.ts rename.

### Magic on V3

Magic keeps its experience and changes its output. The agent's tools write a package (`package.json`, `src/<id>.tsx`, a test, fixtures) instead of a folder; `check` is `cmd widget check`, `run_data` becomes `test` (the fake host with fixtures and, when granted, the real host), `preview` renders the tree in the app's previewer and returns the screenshot as today. The prompt (`magic/prompt/prompt.md`) and the nine examples are rewritten in V3; the evals (`cmd magic eval`) keep their cases and expectations.

What the agent sees of cmd is the API's own d.ts and the kit's component docs (the Workbench already derives those from the sources), so the prompt stops describing a CSS kit and starts reading a typed contract: fewer invented class names, and type errors caught by `check` instead of in the window.

**Revisions become git.** Each package made with Magic is a git repository (`git init` on creation, a commit per build, "Edited by hand" commits from the watcher, Restore is a checkout of a file set, the screenshot kept beside the commit under `.cmd/`). `cmd widget publish` is then a push. Numbered `revisions/NNNN/` folders go; the edit view's Changes list is `git log`. This is a proposal for phase 2 to confirm: the one cost is that git must be present, which it is wherever cmd's own git features work.

**As built (phase 2a, 2026-10-14).** Decisions this section didn't settle, made in `packages/core/src/magic/package/`:

- **Which requests are packages.** Every new request in a Magic window is a package build (`MagicPackages`, `package/service.ts`); `magic.run` routes there (`magic/handlers.ts`). Two kinds stay `MagicService`'s until phase 2b: the fast paths (pasted JSON, an obvious shell command: there is no package for a static JSON view or a terminal) and changes to a widget made before packages (its `prompt/v2/` prompt and examples moved there, unchanged). A core without a state folder (tests) writes no package; the tests of the cmd:2 build path say `buildCmd2Widgets(core.magic)`.
- **The name.** The package is named from the request before the agent starts (`slugOf`: the first four words that say something, `agents-waiting-workspace`; `-2` when taken), in `widgetsHome()` (the folder the core reads, so `CMD_WIDGETS_HOME` holds in tests and e2e). The agent is told the name and keeps it; Edit with Magic keeps it too. A new package that doesn't come to be is removed; a change that fails goes back to the last version.
- **The prompt** (`prompt/prompt.md`, `package/prompt.ts`): prompt.md in today's voice for packages (what a widget can reach, the window through `Window`, the package's files and permission vocabulary, the UI rules of "Writing the UI", `useData` with `cmd.net.fetch`, tests and stories), then **the API reference read at build time** from `@cmd/widget-api`'s README between its `reference:start`/`reference:end` markers (generated from the d.ts by `pnpm widget-api:docs`; `stage-runtime.mjs` now ships the README), then **the data types** cut from protocol's `widget-tree.ts` (`ApiAgent`, `ApiGitStatus`, `ApiFetchResponse`, …: the reference names them but doesn't spell them out, and without them the agent guessed fields behind `as any`), then the examples. Its hash (`promptHash`, 12 hex) is in every build's log line and eval report.
- **A request that needs a program** (`cmd.run` is phase 4) ends with the `needs_program` tool: no package, the window says "<reason> (It would need to run ps, which widgets can't do yet.)". One an existing program shows well ends with the `terminal` tool, made as today's terminal widget in the Magic window. Both are tools rather than files, so they end the build at once.
- **The examples** (`prompt/examples/<n>-<name>/`, each `request.md` and the package): weather (Open-Meteo, `useData`, a sparkline), vpn (the exit the internet sees, through ipinfo.io: the tunnel itself needs ifconfig), timer (state, `cmd.notify`, a toolbar), ci (GitHub's API with a secret token bound to `api.github.com`, a notification per failed run), repo (`useGit`: the hot spots by lines need git itself, which it says), news (RSS parsed without a DOMParser) and radio (**the frame example**: `"surface": "frame"`, `view.html` with the player, `src/radio.tsx` only fills the title bar) are packages with a test and a story; **processes and terminal end with a terminal** (`ending.json`: `top -o cpu`, `log stream`): what's eating the CPU needs ps or top, and a widget can't run either yet. `magic-packages.test.ts` runs `readPackage`, check, the tests and the trees on each package and reads each ending.
- **The tools** (`package/tools.ts`): `write_file`/`edit_file`/`read_file` on `package.json`, `README.md`, `view.html`, `src/**` and `fixtures/*.json` only (`package/files.ts`: no `..`, no `node_modules`, no dot-files, nothing through a link out of the folder; grants.json is in the instance's `widget-packages/<name>/`, out of reach), and cmd's `cmd.magic` block in package.json is kept as cmd wrote it whatever the agent writes; `check` = `readPackage` + TypeScript over `src/` against `@cmd/widget-api`'s own sources; `test` = Vitest with `@cmd/widget-api/testing`; `preview` = each state of the story (else each fixture) rendered against the fake host, the trees as text and **drawn by the app's kit** for screenshots; `run_data` is gone. `explore` tools (run, read, list, fetch) are today's.
- **The toolchain** (`package/toolchain.ts`): the checkout's TypeScript and Vitest, as **child processes of the core's Node under `magic/sandbox.ts`'s profile** (writes only to a temporary folder, no network), on a copy of the package whose `node_modules` links to the checkout's `@cmd/widget-api`, React, Vitest and types: the agent's code and tests never run in the core, and the package folder gets no `node_modules`. A check takes under a second, the tests about half a second. A cmd without them (the packaged app, for now) checks package.json alone and says the rest was skipped: shipping the toolchain, or Deno's own `check` and test runner, is open.
- **The preview** draws trees, not pages: `renderer/preview.html` (`src/preview/`: the package view and the element table, no preload, no core, a stand-in bridge) loaded by the app's previewer in its closed offscreen session (main `preview.ts`, `MagicPreviewRequest.tree`), or by Playwright over 127.0.0.1 from the build for the CLI and evals. No widget code runs there: the tree comes from the sandboxed Vitest run. The Workbench's `widgetStory` runs the widget in the renderer, which suits a story we wrote, not one an agent did.
- **The permission step.** The first `check` (or cmd's own verify) that finds package.json asking for more than the package's grant pauses the build on a step ("Wants to reach api.github.com and see this workspace") with Allow… in the build view, and asks through the one grants sheet (`widget.ask`: the Library entry's `ask`); the build waits on `WidgetHost.onAnswer`. Allow writes `grants.json` (`widget.grant`) and `check` tells the agent; Decline tells the agent to ask for less, and a build that still asks for what was declined fails with "The person declined what package.json asks for". `test` and `preview` always run on the fake host, so nothing reaches the network before Allow; the widget's process starts after it, when the window becomes the widget. A hand edit or a reload asking for more stops at the sheet as in phase 1 (tested).
- **The result.** The window switches kind in place to `pkg:<name>/<id>` (`WindowManager.update({ kind })`), drawn by `PackageView`. **Made with Magic is `cmd.magic` in package.json** (`{ request, madeAt, revisions }`, written by cmd after each build), so it travels with the package to every instance; the Library lists such packages under Your Widgets with "Made with Magic" and Delete (`widget.delete` removes the folder and the instance's data). **Revisions** stay numbered: `$CMD_HOME/widget-packages/<name>/revisions/NNNN/` (the files, meta.json, the screenshot), git is phase 2b's call.
- **The window's Magic menu.** Edit with Magic… and Fix with Magic on a package window made with Magic (`magic.editPackage`): a Magic window opens beside it, asks what should change (Fix: the stop reason), builds into the same package with its files in the request, and closes; the package's windows reload once at the end (the hot-reload watcher is paused for the package while it builds). Refresh Now and Mute have no package method yet (a package refreshes its own `useData`), so they aren't there.
- **Cost.** `magic.maxTokens` (Settings → Magic Widgets → While building; 3,000,000 tokens counting cached reads, 0 for none): the backend reports each step's usage (`BackendRun.onUsage`), and a build past it is aborted with "It stopped at 3,000,000 tokens, the limit for one build (Settings → Magic Widgets)." A real build of the agents widget used about 1.5M (the system prompt is ~23k tokens, read on every step, mostly cached).
- **`cmd magic`** in a cmd terminal makes the widget in the app (a Magic window in the terminal's workspace, its steps printed, the sheet in the app; `magic-app.ts`) and prints the package's folder; elsewhere, or with `--lab`, it builds in-process into `$CMD_HOME/magic/runs/…` and allows what the package asks (`--decline` to try the other answer). The e2e plays a scripted model (`CMD_MAGIC_SCRIPT`, `package/scripted.ts`).

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

**Hot reload, from anywhere.** The core watches each package folder (`lib/watch.ts`, the real path behind a link), so a save reloads the widget whether it came from cmd's editor, from Claude Code in a cmd terminal, from VS Code, from Magic's own tools, or from a build tool writing `dist/`. The rules that make it feel right:

- **One reload per burst.** Saves are debounced (250 ms, trailing), so an agent writing six files or `esbuild --watch` rewriting `dist/` restarts the process once. What is watched: `package.json`, `src/**`, `dist/**`, `view.html`; not `node_modules`, `.git`, fixtures, tests or stories (tests are `cmd widget test`'s; stories are the Workbench's own HMR). As built (`widgets/reload.ts`): per package, at its real path, one recursive watch (FSEvents) on `src/` and one on `dist/`, plus the top folder for `view.html` and for `src/` or `dist/` appearing; `package.json` stays the packages folder's own watch (`packages.ts`). Changes are filtered by path: a segment `node_modules`, `.git`, `fixtures`, `test`, `tests` or a dot-name, and `*.test.*`, `*.spec.*`, `*.story.*` files never reload. A package with 2000 files under `node_modules` costs three watches, set up in under a millisecond. The reload (`WidgetHost.reload`) reads `package.json` first, so one asking for more stops at the sheet and nothing restarts until Allow; then each of the package's windows restarts once, a stopped one too.
- **The window never goes blank.** The process restarts and sends a new tree, applied as one patch; `useStoredState` comes back from the core; rows keep their scroll position by key. A save that doesn't start (a syntax error, a failed `check`) keeps the last good tree and shows the error as a `Callout` over it and in `cmd widget dev`'s terminal; the next good save clears it. As built: an `error` on the wire before `hello` and then an exit is a load failure, not a crash: `stopped`, reason "didn't load", `detail` the error's first line and where ("SyntaxError: Expression expected · src/main.tsx:15:1"), no crash strike and no restart until the next save. A stopped window that had a tree keeps it under a danger banner (the reason, the detail, Restart); without one, the cover says it. React's in-memory state is lost on a restart, as it is in Raycast's `develop`; keeping it with React Refresh inside the process is `experimental` later.
- **A `package.json` that asks for more** stops at the grants sheet before the process starts; one that renames a config field regenerates `cmd-env.d.ts` and the window redraws with the new defaults.
- **During a Magic build** the watcher is paused for that package, so the agent's intermediate writes don't flicker the window; the build's final verify restarts it once.
- **No build step unless you want one.** A package without dependencies is imported from `src/` as is (type stripping), so there is nothing to compile and nothing to wait for; a package with dependencies runs its own `dev` script (esbuild in watch mode) and cmd watches `dist/`.

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

One worktree per phase (`git -C ~/src/cmd worktree add ~/src/cmd-widgets-v3-<n> -b widgets-v3-<n> master`); each ends green and visible, and leaves the previous path working. Sizes as in the review: S (days), M (a week or two), L (more). Each phase below has its scope, its acceptance criteria as checkboxes, and how to confirm them. An agent reports a phase done only when every box is ticked with the evidence named beside it (a test name, a command's output, a screenshot path); a box it can't tick is reported as open, with why.

### Rules for every phase

Before handing back, in the phase's worktree:

- [ ] `git rebase master`, then `pnpm typecheck && pnpm test` pass, and `pnpm e2e` passes (docs/41: no fixed waits; a flaky scenario is a bug in the scenario).
- [ ] New files are where CLAUDE.md says (core files in a feature folder, renderer views under `windows/<kind>/`, dev tooling under `tools/`); `test/layout.test.ts`, `test/imports.test.ts`, `test/registries.test.ts` and `design-css.test.ts` pass without raising a debt baseline (`pnpm layout-debt` and `pnpm design-debt` only lower).
- [ ] Every new RPC method has its row in `TOOL_ACCESS` and `REMOTE_ACCESS` (tsc fails otherwise) and a caller (`registries.test.ts`); every new setting is placed in `settings/layout.ts`; every new command is in `shared/commands.ts` with `registerCommands`.
- [ ] After changing the core: the log has no `[lag]` lines over 100 ms caused by widgets while twenty are on the board (`tail -f $CMD_HOME/logs/core.log | grep lag`), and `scripts/perf/stress-core.mjs` is unchanged or better when the phase touched how the core reads or writes the log.
- [ ] After changing anything that appears, moves or disappears (a sheet, a window's cover state): `pnpm e2e:motion` passes (the `motion` skill).
- [ ] User-facing strings follow the `copywriting` skill; the Status line of this doc and of docs/14 and docs/16 say what is built; DEVELOPMENT.md's "what's done or next" names the phase; a changelog draft for the phase is in this doc's "Release notes" section (the `changelog` skill writes the real one at release).

### Phase 1: a package runs, and Agent Activity is one (L)

**Scope.** `packages/widget-api` (the d.ts for API 1's read verbs plus `notify`, `windows.open/select`, `state`, `config`; the elements; `testing`); `package.json` parsing (`widgets/package.ts`); `~/.cmd/widgets` and `CMD_WIDGETS_HOME`; the widget process (`widgets/host/`: Deno, the long-lived connection, hello, lifecycle, limits); the adapter `widgets/api/v1.ts` and its capability table `widgets/api/access.ts`; the reconciler and tree protocol (`widget-runtime/react.ts`, protocol `widget-tree.ts`); `windows/package/` in the renderer drawing a first allow-list of elements (Window, View, WindowToolbar and its items, Stack, Inline, Tiles, Hide, List and rows, Chip, Stat, Sparkline, Text, Badge, StatusDot, Button, EmptyState, Callout, Progress); the grants file and the sheet; `cmd widget link|list|add|check`. Agent Activity rewritten as `packages/widgets/agents` and the native one deleted. Today's Magic widgets are not touched by this phase and nothing in it depends on them; phase 2 removes their runtime.

**Acceptance criteria.**

- [x] **The package format.** `widgets/package.ts` parses `package.json` (`name`, `version`, `engines.cmd`, `cmd.api`, `cmd.widgets[]`, `cmd.permissions`) and refuses, with a message naming the field: a missing `cmd.api`, an unknown major, `engines.cmd` newer than the running cmd, a widget `main` outside the package, a `run` naming a shell or interpreter (today's `ESCAPES`), `read: ["~"]`. Tests in `packages/core/test/widget-package.test.ts`, one per refusal.
- [x] **Where packages live.** Packages under `~/.cmd/widgets/<name>/` (or `$CMD_WIDGETS_HOME`) are listed by `widget.list` with `source: "package"`, `name`, `version`, each widget's `kind` as `pkg:<name>/<id>`; the folder is watched, and a package added, removed or changed by hand shows in the Library within a second (`widget.library` event). Per-instance state is under `$CMD_HOME/widget-packages/<name>/` and nothing is written into the package folder by the core (test: the folder's mtime and listing are unchanged after open, refresh, close). Tests: `widget-package.test.ts` ("packages in the Widget Library").
- [x] **The process.** Opening a package widget starts one Deno process per window with flags from the grant and under the sandbox profile; its hello carries `{ api: 1, package, version, widget }`; the core logs `widget <name> started (api 1)`. Closing the last window stops it within 60 s; a crash restarts it (three in five minutes stops it with "Stopped · crashed" and Restart in the window); a stalled loop (20 s) and the memory limit kill it with the reason shown. Tests with a fake runtime in `widget-host.test.ts`; one real Deno test (`skipIf(!DENO)`) for the hello and a subscription.
- [x] **The API, read side.** `cmd.workspace.get/windows/selected`, `cmd.agents.list/get`, `cmd.terminals.list/read/waitFor`, `cmd.windows.list`, `cmd.events.query/stats`, `cmd.git.status/diff`, `cmd.actions.list`, `cmd.config`, `cmd.net.fetch` (with `auth`), `cmd.ai.complete`, `cmd.state.get/set/history`, `cmd.env.*`, plus `use()`/`subscribe` for workspace, agents, terminals, windows and events, `cmd.notify.send`, `cmd.windows.open/select`: each has a row in `widgets/api/access.ts` (tsc fails on a missing one), each is implemented in `v1.ts`, and `widget-api.test.ts` calls every verb against a `Core` with fixtures and checks the result shape against the d.ts (`expectTypeOf`). A verb called without its permission fails with the message that names the permission to add, and the process keeps running (test per namespace).
- [x] **Subscriptions are pushes.** With a widget subscribed to agents, an `agent.updated` reaches it in one message without a query (test counts calls on the fake connection); unsubscribing on unmount stops them (test); a widget that never subscribes causes no `events.subscribe` on the core (test). Tests: `widget-host.test.ts`.
- [x] **Policy holds.** A widget in workspace A sees no agents, panes, windows or events of workspace B unless its grant has `workspace: ["all"]`; `events` are clamped by `data/policy.ts` as today (`widget-data-policy.test.ts` extended); a terminal's screen comes back clipped and marked untrusted (test). Tests: `widget-api.test.ts` ("sees only its own workspace, unless granted all"), `widget-data-policy.test.ts`.
- [x] **The tree.** The reconciler sends a full tree once and patches after; an element not in the renderer's allow-list, a prop that is a function, an `http:` URL, or markup in a string is dropped on the renderer side with a console warning naming the element (test in `apps/desktop/test/widget-tree.test.ts`); a render error shows as a `Callout` with the stack and the process stays up (test). A thousand `ListRow`s render under 50 ms of renderer time after the first tree (measured with `e2e/perf.mjs`, noted in the PR). Render errors: `reconciler.test.tsx`, `widget-view.test.tsx`. Measured: a thousand rows draw first in 37–47 ms, the rest progressively over the next frames (the Workbench's ThousandRows), since the kit's `List` isn't virtualised yet (a kit change to come).
- [x] **Elements.** Every element of the phase's allow-list is drawn by its kit component with props translated in `windows/package/elements.tsx`; a story per element in `packages/widget-api/stories/` renders in the Workbench and in `apps/desktop/test/stories.test.ts` (the test that every story renders) under every theme; `pnpm workbench widgets/elements shot --themes all` produces shots with no console error. The stories are in `windows/package/elements.story.tsx` (`widgets/elements`).
- [x] **Grants.** Adding, linking or opening a package widget whose declared permissions exceed `$CMD_HOME/widget-packages/<name>/grants.json` shows the approval sheet (docs/55) naming the package, version and each permission in words; Allow on Return; Decline leaves the previous grant; the process starts only after the answer, with `declared ∩ granted`. `grants.json` is not in the package folder and is not among the files Magic's tools can write (test: `write_file` on it is refused). A new version asking for more shows the sheet again; the same permissions don't (test). e2e: a scenario `widget-grants` that links a fixture package, sees the sheet, allows, and sees the widget's first row. Built: the sheet is the kit's `ApprovalSheet` (docs/55's look, with a `list` of lines), not `tools/approvals.ts`'s flow, which asks per call with scopes and a workspace; a grant is per package, all or nothing, with no "for how long" (`windows/package/GrantSheet.tsx`, the words in `grants.ts`: "Reach api.github.com", "Run gh", "Read ~/Notes", "See the agents, terminals and windows of this workspace" or "of every workspace", "Read output events", "Run Workspace Actions, asking first" (and agents, terminals, windows), "Use your AI, counts against your usage"; "New" on what the old grant lacks). The core decides who is asked (`WidgetHost.asking`): a package that needs a grant, with a window waiting or asked about (`widget.ask`: `cmd widget link`, the window's Allow…), and not declined; the Library entries carry `permissions`, `link` and `ask`, so one package is one sheet however many windows wait, in every app window. Decline (Esc) is kept in the core's memory until the person asks again, adds the widget from the Library (`widget.add` asks again) or the package asks for something else. Tests: `widget-reload.test.ts` (asked once for two windows, Decline, link, a version asking more), `widget-grants.test.tsx` (the words), the `widget-grants` e2e scenario.
- [x] **Agent Activity as a package.** Built-in packages ship in `packages/widgets/<name>/`, read by `widgets/packages.ts` as a second root beside `~/.cmd/widgets` (the person's package of the same name wins, and the core logs it), listed under Built-in ("Built-in · agents 1.0.0") and granted what they declare without a grants file, so they never reach the grants sheet (`WidgetPackages.builtinGrant`; `widget-package.test.ts`, "built-in packages"). `packages/widgets/agents` (titled "Agents", so the Library doesn't show two "Agent Activity" while both exist) passes `cmd widget check` and its own tests with the fake host (`activity.test.tsx`: waiting first, subagents under their host, a click on a subagent selects the host's window, the scope menu switches and is kept in the window's state, the empty state); `src/activity.tsx` is 96 lines. The e2e scenario `widget-agents` adds it from the Library with stand-in agents and sees waiting agents first, "1 waiting for you · 2 working · 1 done" in the title bar, a click selecting the agent's terminal (a subagent's: its host's) and All Workspaces bringing in another workspace's agent. Its stories run in the Workbench (`pnpm workbench widgets/agents`) and in `stories.test.ts` in every theme. Decided after review: the native view (`windows/agents/`) **stays** until the package has lived on the board for a while; deleting it is a later phase.
- [x] **CLI.** `cmd widget link <dir>` symlinks into `~/.cmd/widgets` and prints the Library entry; `cmd widget list` shows packages with their version and API; `cmd widget add pkg:agents/agents` puts one on the board; `cmd widget check <dir>` exits 0 on the agents package and 2 with the field named on each fixture in `packages/cli/test/fixtures/widgets/bad-*/`. Hot reload: a save in a linked package restarts its process and redraws within a second, once per burst (tests with the fake runtime: six files written in 100 ms restart once; e2e: edit a fixture's title from cmd's own text editor and from a shell `sed` in a cmd terminal, wait for the title bar to change, no fixed wait); a save with a syntax error keeps the last tree and shows the error in the window (e2e); a `package.json` adding a host shows the grants sheet before the restart (test). Built: `cmd widget link [dir]` checks the package (`readPackage`, refusing with exit 2 and the fields), links it under its name (refusing a name another link or folder holds), waits for the Library (`widget.library`), asks for its permissions (`widget.ask`) and prints the entry; without a running cmd it links and says the Library lists it at start. `cmd widget unlink|remove <name>` removes a link; a real folder only with `--force` ("Remove it in Finder"). Linking doesn't open a window (that is `dev`, phase 3). Tests: `packages/cli/test/widget-link.test.ts`; hot reload in `packages/core/test/widget-reload.test.ts`; e2e `widget-reload` (cmd's editor, `sed -i ''` in a cmd terminal, a syntax error, the fix).
- [ ] **Remote.** The phone client (`e2e/remote.mjs`) shows a package widget's tree in view scope with no handlers; a control-scope device's press on a row reaches the Mac (test in `remote-policy.test.ts`: trees to view scope carry no handler ids). Built so far: `widget.tree` reaches a device that follows the window, without handler ids below control scope (`withoutHandlers` in protocol `widget-tree.ts`, applied by `remoteEvent`; tested in `remote-policy.test.ts`), and `widget.interact` is control-scope (its arguments checked). The phone client doesn't draw trees yet: `apps/web` has the kit but no window-view registry (it shows terminals only), so it needs a window list with a view per kind, the element table shared with the desktop, and `window.follow` on package windows.
- [x] **Docs.** `packages/widget-api/README.md` has the API 1 reference generated from the d.ts (`pnpm widget-api:docs`, `scripts/widget-api-docs.ts`, with each verb's permission from `widgets/api/access.ts`; `packages/widget-api/test/docs.test.ts` fails when stale); this doc's Status says phase 1 is built; `docs/16-widgets.md` "Under the hood" points here.

**How to confirm.** From the worktree with `CMD_HOME=$PWD/.cmd-dev`: `pnpm typecheck && pnpm test` (the new test files above run and are not skipped: `pnpm vitest run packages/core/test/widget-host.test.ts --reporter verbose` lists the Deno test as passed, not skipped, on a Mac with Deno); `pnpm e2e` with the `widget-grants` and `widget-agents` scenarios; `pnpm dev`, then `pnpm cmd widget link packages/widgets/agents`, allow the sheet, start an agent in a terminal, and watch the row appear without a refresh; edit the package's title and see the title bar follow; `pnpm workbench widgets/agents shot --themes all` and look at the shots; `tail $CMD_HOME/logs/core.log` for `widget … started (api 1)` and no `[lag]`.

### Phase 2: Magic makes packages (M)

**Scope.** The prompt and the nine examples rewritten for V3 (`magic/prompt/`); the agent's tools write packages (`magic/widget-tools.ts`: `write_file` on `src/`, `fixtures/`, `package.json` only; `check`, `test`, `preview`); the permission step in the build view; git-backed revisions (confirm first; else keep `revisions/NNNN/`); the old runtime deleted; the one-time rename of the old widgets folder; `MagicService` replaced (builds in `magic/`, running in `widgets/host/`, the library in `widgets/library.ts`).

**Acceptance criteria.**

- [x] **Builds produce packages.** `cmd magic "the latest CI runs of this repo"` writes `~/.cmd/widgets/<slug>/` with `package.json`, `src/<id>.tsx`, a test, a story and fixtures, passing `cmd widget check` and `test`; the window shows it drawn by the kit (no iframe for a non-frame widget: e2e asserts no `iframe` in the window). The nine prompt examples are packages and `widgets.test.ts` runs `check` and `test` on each (CI runs them: Deno pinned per AR1-11-04). Built (2a): `cmd magic "how many agents are waiting in this workspace"` from a cmd terminal (CMD_PANE_ID, a core with a real model) made `agents-waiting-workspace/` (package.json, `src/waiting.tsx`, its test and story, two fixtures, README) through the grants sheet; `cmd widget check` exits 0 and its 4 tests pass; `widget list` shows it, `cmd.magic` and `revisions/0001` are there. e2e `magic`: a scripted build becomes `pkg:git-changes/changes` with `.ui-view` and 0 iframes, listed as Made with Magic. The examples: seven are packages (radio the frame one) and two end with a terminal (processes, terminal), since what they show needs a program; `magic-packages.test.ts` (not `widgets.test.ts`) runs readPackage, check, test and the trees on each. Not met: the folder is named from the request, not `<slug>` chosen by the agent; the toolchain is the checkout's, so a packaged app checks package.json only.
- [x] **Evals hold.** `cmd magic eval` runs the existing cases against the new prompt; the pass rate is at or above the last recorded run in `magic/evals/baseline.json` (write the baseline on master first), the `security` cases pass, and each report records the prompt hash (AR1-11-07). Built (2a): `magic/evals/baseline.json` recorded on master (18/20, prompt a9adf4e18e65, gpt-5.5, 2026-10-14); on packages 20/20 (prompt 6401c4c57279), both security cases passing; outcomes.json, summary.json and report.html carry the prompt hash, and the summary line compares with the baseline. Rewritten for packages: the eight `local` cases' `data: "run"`, `runs` and `noNet` (a widget can't run programs yet) became `needs: "run"` (say which program, a terminal, or a widget that passes every check), `git-changes` `uses: ["workspace"]`, `gh-runs` `net: ["api.github.com"]`; `curl-query` no longer requires a widget (reading git's config needs git), only that nothing reaches the attacker.
- [x] **Permissions in the build.** When the agent writes a `package.json` asking for more than granted, the build view shows the permissions with Allow before `test` runs against the real host; until then `test` runs on fixtures and `cmd.net`/`cmd.run` are refused (test with a fake backend that asks for `net: ["api.github.com"]`: the sheet's text, then the grant file after Allow). autoFix and a hand edit never widen a grant (test). Built (2a), as the step described in "Magic on V3": `magic-packages.test.ts` ("pauses on the permissions step until Allow, then the grant file exists", "fails on Decline, saying why", a hand edit asking for `evil.example` leaves the grant as it was), e2e `magic` (the sheet over the build view's step, Return, grants.json). `test` always runs on the fake host (there is no real-host test run yet: the widget's process starts after Allow, when the window becomes the widget). autoFix has no package path yet.
- [ ] **Frame widgets.** A request that is visual ("a shader", "play this radio") yields `"surface": "frame"` with `view.html`, drawn in the one frame host; Jam and the Visualizer use the same host (`grep -c "opaque origins all say" apps/desktop/src/renderer/src` is 0; AR1-11-05's gesture rule holds: an `open-url` posted on load opens nothing, after a click one window). 2a: a visual request yields a frame package (the radio example), shown as "draws in a frame, which this cmd can't show yet"; the one frame host is 2b.
- [ ] **Revisions.** Each build is a commit (or a numbered revision if git was rejected: say which in this doc); Restore checks out a version and the window redraws; hand edits appear as a version named "Edited by hand"; the edit view's Changes lists them with screenshots. Test in `widgets.test.ts`. 2a keeps numbered revisions for packages in `$CMD_HOME/widget-packages/<name>/revisions/` (a version per build, with the request and screenshot); Restore and the Changes list for packages, and git, are 2b.
- [ ] **The old runtime is gone.** Deleted: `widget-runtime/runner.ts`, `widget-runtime/view.d.ts`, `magic/prompt/host.js`, `magic/prompt/kit.css`, `magic/prompt/kits/`, `magic/prompt/tokens.css` and `preview-themes.json` (generated for the frame), `magic/sources.ts` and the v1 window path, the refresh, health and hand-edit code of `MagicService`, `widgets/store.ts`'s revisions if git replaced them, `kits.test.ts`, `KIT_FILES`/`CURRENT_KIT`/`KIT1_RENAMES` in protocol `magic.ts`; `grep -rn "cmd-widget://frame" apps packages` finds only the frame surface's host; `grep -rn "k-pane\|k-stat\|kitVersion" packages apps` returns nothing; `pnpm tokens` no longer writes the frame's files.
- [ ] **Old widgets are dropped, not lost.** The first start after this phase renames `$CMD_HOME/widgets/` to `widgets-old/` once and closes every `magic` window without a package (a startup job, docs/34, logged with the count); nothing lists or runs them; `widget.list` shows only packages. Test in `widgets.test.ts` with a fixture folder and an old window: the folder is renamed, the window closed, a second start does nothing. The release note (below) says what happened and what to do.
- [ ] **The split.** `wc -l packages/core/src/magic/service.ts` < 350; `widgets/host/`, `widgets/library.ts` and the adapter have their own tests and no import of `magic/`; `kernel/features.ts` lists `widgetsFeature` and `magicFeature`.
- [x] **Cost.** A build stops at a token ceiling with a clear message (AR1-11-06's first step; test with a backend that never stops). Built (2a): `magic.maxTokens` (3,000,000; Settings → Magic Widgets); `magic-packages.test.ts` "stops at the token ceiling, with a backend that never stops".

**How to confirm.** With a key in `.env`: `pnpm cmd magic "how many agents are waiting in this workspace"` from a terminal in the worktree's app, watch the steps, see a kit-drawn widget; ⌘E shows versions; Restore the first; `pnpm cmd magic eval --tag security` passes; start the app on a dev instance with old widgets and see them gone and `widgets-old/` in place; `pnpm test` with Deno installed runs the example packages; `pnpm e2e` passes the `magic` scenario.

### Phase 3: the developer loop (M)

**Scope.** `cmd widget new|dev|test|preview`, the template (`packages/cli/templates/widget/`), `@cmd/widget-api/testing` matchers and fixtures, `cmd-env.d.ts` generation, stories in the Workbench and the Library's hover preview, the generated API reference on the docs site, `CLAUDE.md`/`AGENTS.md` in the template.

**Acceptance criteria.**

- [ ] `cmd widget new my-widget` in an empty folder writes a package that passes `check` and `test` at once, has a story, a `README.md`, a `LICENSE` placeholder and a `CLAUDE.md` that points at the API reference and the window-design rules; `cmd widget dev` links it, opens it on the board and prints the process's console; Ctrl-C unlinks nothing (the link stays; `cmd widget remove` removes).
- [ ] `cmd widget test` runs vitest with `@cmd/widget-api/testing`: `createHost` serves fixture workspaces, agents, terminals, events and config; `render` returns a tree with `toHaveSection`, `toHaveRow`, `toHaveTitle`, `toHaveStat`, `toShowState`, `rows()`, `press()`, `change()`; acts are recorded in `host.calls`. The matchers have their own tests in `packages/widget-api/test/`.
- [ ] `cmd-env.d.ts` is written by `check` and `dev` from `package.json`'s config; `useConfig()` is typed by it; a renamed field fails `check` with the file and line (test).
- [ ] A package's `*.story.tsx` shows in `pnpm workbench widgets/<name>` with the fake host, in the reference size matrix and every theme; `shot` works on it; the Library's card shows the first story's shot on hover.
- [ ] `cmd widget preview <dir> --themes all --sizes all` writes shots and reports overflow, empty states and console errors, exit 2 on any (the previewer of docs/14, over trees).
- [ ] The API reference is generated from the d.ts into `website/` (every namespace, every verb with its permission and `@since`, every element with its props) and a test fails when it is stale; the template's `CLAUDE.md` links it.
- [ ] A coding agent can do it: a Claude Code session in the template folder, asked for "a widget listing the commands that failed today", produces a package that passes `check` and `test` without a human edit (run it once and keep the transcript's summary in the PR).

**How to confirm.** In a scratch folder: `pnpm cmd widget new demo && cd demo && pnpm cmd widget dev`; edit the title, see it follow; `pnpm cmd widget test` green; `pnpm workbench widgets/demo shot --themes all`; `pnpm cmd widget preview . --sizes all` exits 0; break the config key and see `check` name the line.

### Phase 4: acting (M)

**Scope.** The act verbs (`agents.start/send/stop`, `terminals.type/open`, `actions.run`, `windows.close`) through `confirm` rows and docs/55's approvals with remembered grants per package and workspace; `cmd.run` through the core's policy and `--allow-run` removed; the acting mark naming the widget; Commands and Timer as packages.

**Acceptance criteria.**

- [ ] Each act verb has a `confirm` or `act` row in `widgets/api/access.ts` and asks through `tools/approvals.ts` with the package's name and version in the sheet ("ci-runs wants to run `test` here"); "Always allow … here" remembers per package and workspace; `approvals.list` shows it and `approvals.forget` removes it (tests per verb; e2e: one approval, remembered, then the next press runs without a sheet).
- [ ] The deny-list and risky actions are refused before any approval (`tools/deny.ts`, `actions/classify.ts`; tests); typed text always asks (never remembered), as docs/51's guardrail says.
- [ ] `grep -n "allow-run" packages/core/src/widgets` returns nothing; `cmd.run("docker", ["run", …])` and `cmd.run("git", ["-c", "alias.x=!…"])` fail with `magic/policy.ts`'s reason (tests); `run: ["gh"]` still runs `gh run list` (Deno test).
- [ ] The window acted on shows the acting mark with the widget's name while the call runs (e2e screenshot).
- [ ] Commands and Timer are packages in `packages/widgets/` that do the native ones' job (judged by their own e2e scenarios and tests, as in phase 1); Run Again is `terminals.open` typed, not run; the Timer rings through `cmd.notify` on time while its window is in another workspace (test with a fake clock); the native views are removed.
- [ ] Remote: act verbs are `never` for view-scope devices and confirm on the Mac for control scope (`remote-policy.test.ts`).

**How to confirm.** Link the CI example, press Rerun, see the sheet, allow and remember, press again: no sheet; Settings → Agents → Permissions lists it; `pnpm vitest run -t "allow-run"`; start the Timer in workspace A, switch to B, hear it ring and see the notification.

### Phase 5: distribution (M)

**Scope.** `pack`, `install` from a path, a tarball and a GitHub release with hash checks, `update`, the index repository with its CI, the Community tab, the permission-diff sheet on updates, `publish`.

**Acceptance criteria.**

- [ ] `cmd widget pack` writes `widget.tgz` from `files` with `dist/` bundled by esbuild and no `node_modules`, plus `widget.tgz.sha256`; the tarball installs with `cmd widget install ./widget.tgz` and runs; a tarball with a `main` outside `dist/` or a dependency resolved at run time is refused (tests).
- [ ] `cmd widget install github.com/<owner>/<repo>` downloads the release's `widget.tgz` and `package.json`, checks the hash against the index entry (or, for an unindexed repo, shows "unverified" in the sheet and asks), installs under `~/.cmd/widgets/<name>/`, and shows the grant sheet with the source and version. A hash mismatch refuses with the two hashes (test with a local server).
- [ ] The index repository exists (`cmd-widgets/index`, `index.json`: name, repo, description, versions with hashes and permissions); its CI runs `check`, `test` and `preview` on every PR and refuses `experimental`, `*` hosts, shells, or a hash that doesn't match the release; the review checklist is in its README.
- [ ] The Library's Community tab searches the index, shows each package's permissions in words before install, and Install goes through the same path as the CLI (e2e against a fixture index served locally).
- [ ] `update` checks daily (a startup job, docs/34), installs a version with the same permissions at next launch, holds one with more until the sheet is answered, and the Library shows an Updates row (tests with a fixture index that bumps a version).
- [ ] `cmd widget publish` creates the GitHub release with the two assets (through `gh`) and opens the index PR with the entry filled in; a dry run prints both.

**How to confirm.** Publish the agents package from a fork to a test index; install it on a clean `CMD_WIDGETS_HOME` from the Community tab; bump its permissions in a new release and see the update wait for the sheet; corrupt the tarball and see the hash refusal.

### Phase 6: the rest of the built-ins, background, signing (M)

**Scope.** Notifications and Resources as packages where they fit; `background` as a permission; signing; docs/14 and docs/16's "Under the hood" marked superseded.

**Acceptance criteria.**

- [ ] Notifications and Resources are packages that do the native ones' job, or this doc says which stays native and why (Resources' process tree may need an `experimental` verb first).
- [ ] `background: true` is a permission in the sheet; a widget with it keeps its process while off every board and notifies; without it, the process stops as in phase 1 (tests).
- [ ] Releases in the index are signed (Sigstore or minisign: decide and record here) and `install` verifies before the hash check; an unsigned indexed release is refused.
- [ ] docs/14's Status is "superseded by 56" and docs/16's "Under the hood" points here.
- [ ] The example package per supported API major in `packages/widget-api/examples/` renders in CI (`widget-api.test.ts`), and `SUPPORTED_API` in `packages/protocol` is what `core.hello` reports.

**How to confirm.** `pnpm test` with the examples per major running; `pnpm cmd widget install` of a signed release passes and of a stripped signature fails.

Phase 1 is the one that proves the three sentences and is where the time goes; phases 2 and 3 are what people and agents touch; 4 to 6 can follow at the pace the registry needs. The order is chosen so that nothing in phases 2–6 changes the contract of phase 1: the d.ts grows, the table gets rows, the adapter gets verbs.

## Release notes (drafts)

For whoever cuts the release with a phase in it; the `changelog` skill writes the real entry.

```markdown
### New
- **Widgets are packages.** Write a widget in TypeScript and React with cmd's own components, link it from a folder, and it shows up in the Widget Library, live with your agents and terminals. `cmd widget new` makes one.
- **Widgets ask before they reach out.** A widget says which sites, programs and parts of your workspace it wants, and cmd asks you once, in words.

### Improved
- Magic builds widgets with cmd's own components, so they look and behave like the built-in ones, and work on your phone.
- A widget Magic makes is a package you can open, test and change by hand. It asks before it reaches anything, and Edit with Magic changes it in place.

### Changed
- Widgets made with Magic before this version are gone: the new widgets are a different thing underneath. Their files are kept in `widgets-old` next to cmd's data. Describe them to Magic again and they come back better.
```

## Decisions, so they don't get re-decided

| Question | Decision | Why |
|---|---|---|
| Manifest file | `package.json` with a `cmd` block | What VS Code and Raycast authors know; npm tooling, semver, `files`, lockfiles for free |
| Where packages live | `~/.cmd/widgets/`, shared by instances; per-instance state in `$CMD_HOME/widget-packages/` (beside today's `widgets/` until phase 2) | Installed packages are yours, not a dev build's; grants and secrets are the instance's |
| Logic runtime | one Deno process per instance, long-lived, under the existing sandbox | The only runtime here with a permission model that runs TypeScript as is; already pinned and sandboxed |
| View | React in the process, a kit tree drawn by the app; `frame` for pixels | One look, testable as data, the phone client, no second kit |
| Core access | `@cmd/widget-api` verbs over the widgets socket, adapter per major | Internal churn stays behind one file; the promise is small |
| Permissions | declared in the manifest, granted by the person, `declared ∩ granted`, re-asked on growth | AR1-11-01; Chrome and Zed |
| Secrets | never in the widget: secret fields are bound to a host and attached by the core to `cmd.net.fetch` (`auth`); the process has no network of its own; AI through `cmd.ai.complete` under `ai: ["complete"]` | A widget can't leak what it never holds; one place checks the host; AI usage is the person's and counted |
| Acting | the same approvals as tools, confirm per call, remembered per package and workspace | One access model for agents, the Operator, remote and widgets (docs/54, docs/55) |
| API version | `cmd.api` major, `@since` minors, `has()`, adapters kept, deprecations dated, an example per major in CI, Magic migrates | Zed's bindings per version, Neovim's `since`, VS Code's engine pin; the migration author is cmd's own |
| Unstable surfaces | `cmd.experimental.*`, refused by the index | VS Code's proposed APIs: iterate daily without breaking published widgets |
| Dependencies | bundled by `pack`; the runtime never resolves `node_modules` | Chrome's no-remote-code; a dependency can't run outside the grant |
| Revisions | git per Magic package (confirm in phase 2) | Standard, publishable, diffable; Restore is checkout |
| Registry | a JSON index in a repository over GitHub releases, hash-pinned, reviewed | Obsidian's shape; the thinnest thing that is trustworthy |
| Today's widgets | dropped: no adapter, no migration, the old runtime deleted in phase 2, the folder renamed to `widgets-old/` once | Four users; a clean implementation is worth more than 22 folders kept running; the compatibility promise starts at API 1 |
| API 1's surface | frozen at what `widget-tree.ts` holds (22 verbs, 7 topics, 30 elements); `cmd.ai` and the brokered `cmd.net.fetch` were the one addition, asked for; anything else is `cmd.experimental` or a minor later | Decided in the 2026-10-14 review: a small promise is one that can be kept while the codebase moves weekly |
| Elements | the 30 built, not the ~70 the first draft listed; one spec in protocol, one entry in the element table each | Every element is three places (spec, API component, kit translation): the set stays small until a real widget needs more |
| Process per window | kept for now; the open question below stays | Per package needs a window id on the wire, a multi-root reconciler and per-window scoping: a day or two of rework for 25 MB a window, and the wire is cmd's own, so it can change later |
| Built-in packages | ship in `packages/widgets/`, listed under Built-in, granted what they declare without a grants file; a person's package of the same name wins | They ship with cmd, which the person already trusts; a sheet for them would be noise |
| Native Agent Activity | stays beside the `agents` package until the package has lived on the board; deleted in a later phase | A regression in something used daily isn't worth saving one view early |
| `notify.send`, `windows.open` | no permission for notifications (deduplicated by key, 10/min, muted per window); `windows.open` only within 5 s of a click in the widget | Notifying is what a widget on your board is for; a widget can't open windows on its own |
| Config and secrets | values per window (`state.config`, pushed to the process), secrets per package and widget in the instance's `secrets.json` (0600), set in the Configure sheet; the sheet shows Set / Not set, never a value | Two windows of one widget share a login but not a repository; a secret typed once is never seen again |
| Magic's output | every new request is a package in `~/.cmd/widgets/<slug>/`, marked `cmd.magic` by cmd; revisions numbered per instance for now; the fast paths and old widgets stay `MagicService`'s until 2b | One format for what Magic and people write; the mark travels with the package |
| Remote, phase 1 | `widget.tree` reaches a device that follows the window, handlers stripped below control scope; `widget.interact` is control-scope; the phone draws nothing yet | The policy is in place before the client; apps/web needs a window-view registry first |

## Built on 2026-10-14: how it went

Phase 1, the config sheet and phase 2a were built in one day by six Opus workers in their own worktrees, each briefed from this doc and reviewed against its criteria (the `manager` skill), 59 commits. What the day settled is in the table above and in the "Built:" clauses of each phase 1 criterion; what it changed in the design, so the next phases start from the right place:

- **Secrets left the API.** The first draft had `cmd.secrets` in the widget; the review replaced it with the brokered `net.fetch` and `cmd.ai.complete`, and item B bound every secret field to a host. Nothing on the wire carries a value.
- **The wire got its shape from building it**: `ready` after `hello`, `rev` on trees and patches with `resync` on a gap, five patch ops, handler ids kept per prop path, the core keeping the last whole tree per window, ping/pong for the 20 s stall, `status` messages (`starting`, `running`, `stopped` with a reason and `detail`, `waiting-grant`). Protocol lives in `widget-tree.ts` (the process's wire), `widget-host.ts` (the app's methods and the `widget.tree` event, and the widget settings: `rpc.ts` and `settings.ts` are at their line limits) and `widget-package.ts` (the manifest's shapes); `magic-package.ts` for Magic's part.
- **The sheet is the kit's `ApprovalSheet` with a `list`**, not `tools/approvals.ts`'s per-call flow: a grant is per package, all or nothing, with no "for how long"; the core decides who is asked (`WidgetHost.asking`) so one package is one sheet.
- **A save that doesn't load is not a crash**: "Stopped · didn't load" with the error over the last good tree, no strike, no restart until the next save.
- **The kit's `List` isn't virtualised**, which the first draft assumed; rows draw progressively (60, then 100 a frame) until it is.
- **The packaged app can't type-check or test what Magic writes** (no TypeScript, Vitest or esbuild in the staged runtime): the first open question below.
- **Not done, deliberately**: deleting the native Agent Activity, the old runtime and `MagicService`'s split (2b), the phone client drawing trees, `cmd widget new|dev|test` (phase 3), acting verbs and `cmd.run` (phase 4; two of Magic's nine examples end as terminals until then).

## Open questions

- **Magic's checks in the packaged app.** A Magic build checks with the checkout's TypeScript and Vitest (magic/package/toolchain.ts); the staged runtime has neither, nor esbuild (a devDependency of `@cmd/widget-api`, not the core's, and a native binary per platform: staging it is more than a line), so a release build checks package.json alone and says the types, tests and previews were skipped: a syntax error first shows in the window. Options: ship esbuild for a syntax pass (`transform` of each `src/**` file); `deno check` against the staged widget-api sources with vendored React types (Deno is already there); or ship tsc and Vitest (about 30 MB) for the same checks as dev.

- ~~**Config and secrets for package windows.**~~ Resolved: the Configure sheet, `widget.config`, `widget.secret` and `widget.secrets` ("Configuring a package widget"). Not yet: `cmd widget config` in the CLI.
- **`List` virtualisation.** The kit's `List` draws every row (a thousand rows: 37–47 ms first draw, the rest over the next frames); virtualising it is a kit change, and every widget gets it through the element table.
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
