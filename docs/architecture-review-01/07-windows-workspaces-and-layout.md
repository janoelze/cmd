# 07 Windows, workspaces and layout

**Score: 6/10** · reviewed 2026-10-10 against commit ddb7832 · scope: the window type registries (core and renderer), window state, workspaces, the board's layout engine, sidebars, motion hand-off and Electron windows per workspace

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 6/10 | Core registry and layout maths are clean and pure; `WindowsView.tsx` is a 1177-line monolith and layout state is untyped renderer data kept in the core. |
| Correctness & robustness | 6/10 | Routing of typed text is wrong for several inputs, layout keys leak forever (69 of 71 canvas rects dead in the real store), docking reloads web pages. |
| Performance | 7/10 | Carefully built: native compositor scrolling, memoised content, no per-frame React work; only window drafts are written and broadcast too eagerly. |
| Security | 7/10 | Window state accepts any keys of any size from "control" connections for types without `update`. |
| Testability & tests | 5/10 | 82 tests over the pure helpers and the core managers; the board (WindowsView, Dock, the gesture code) has none. |
| Extensibility | 5/10 | The registry is real for state, but the two halves match by string and convention: adding the SQLite viewer touched 15+ files in 4 packages. |
| Code health | 6/10 | Good comments and naming; 8 `eslint-disable` for hook deps, 5 hand-rolled pointer-gesture loops, duplicated tile rendering. |

## What this system is

Everything the board shows is a **window**. In the core, `packages/core/src/windows/` holds the `WindowType` registry (`types.ts`, 116 lines: `opens` rules, `create`, `update`, `resolve`), 23 built-in types in one file (`builtin.ts`, 699), the `WindowManager` (`manager.ts`, 214: non-terminal windows persisted as opaque JSON `state`, terminal windows synthesised from panes with id = pane id) and routing (`routing.ts`, 87: path/URL → `OpenTarget`, shell env). Workspaces live in `packages/core/src/workspaces/manager.ts` (222) and `paths.ts` (63): identity is the canonical root, Home always exists, closed ones stay as recents, `check()` polls every 30 s for removed folders (docs/35). Each workspace carries `view: Record<string, unknown>` (≤ 256 KB), which the renderer fills with the board's layout: `view.mode`, `grid.order`, `strip.widths`, `canvas.rects`, `canvas.camera`, `docks`, `selection.pane`, `selection.history` (`App.tsx:111-179`, `store.ts:268-310`). The renderer half of each type registers a view by kind (`renderer/src/windows/registry.ts`, 76; `builtin.tsx`, 356, plus one file per newer type), and three other per-window registries sit beside it: previews (`preview.ts`), window actions (`windowActions.ts`, 121) and drop targets (`drops.ts`, 161). Layout is four pure functions over `(ids, viewport, spacing)` (`layouts.ts`, 125: focus, grid, strip, canvas), with canvas maths in `canvas.ts` (183) and sidebars in `docks.ts` (98); `components/WindowsView.tsx` (1177) renders every tile absolutely positioned in stable DOM order and owns scrolling, the camera, dragging, resizing and the hand-off to `TileMotion` (`motion.ts`, 375), the only writer of tile geometry (docs/37). `Dock.tsx` (144) draws a docked window, `TileTitle.tsx` (146) the shared title bar (docs/10-window-titles). In Electron main, `main/workspaces.ts` (289) enforces "one workspace in at most one app window", routes `workspace.show`, and keeps window bounds per display setup in `windows.json`. Design docs: 09, 10-windows, 10-window-titles, 11, 21, 22, 35-checkouts, 37, 39, 40.

## What is good

- **`TileMotion` really owns geometry.** No tile has a CSS transition on `transform`, `width` or `height`; the only geometry transition left is `.ghost-slot` (`styles.css:662`), which is not a window. The "never animate geometry from React" rule holds, and `motion-css.test.ts` guards it.
- **Layouts are pure functions** returning rects, hidden set, drop index and chrome flags (`layouts.ts`); canvas placement, framing and zoom are pure too (`canvas.ts`) and tested (`canvas.test.ts`, 14 cases). Copy this split for anything else that positions things.
- **The core registry is the plugin shape already:** built-ins register through `WindowTypes.register`, routing comes from data (`opens`), the shell integration reads the same rules (`shellOpenEnv`), and renamed kinds migrate on load (`RENAMED_KINDS`).
- **Workspace identity is right:** canonical realpath + NFC, whole-segment containment, deepest root wins (`paths.ts`); tested in `workspaces.test.ts` (334 lines).
- **Performance discipline in the board:** the strip is a native scroller (compositor scrolling, macOS momentum), React hears the offset only when it rests (`OFFSET_SYNC_MS`), `WindowContent` is memoised so camera frames don't re-render content, layout reads happen only while dragging (`WindowsView.tsx:820-822`).
- **Drag and drop has one router for everything native** (`drops.ts`: Finder, other apps and cmd's own file drags, which are real macOS drags via `drags.ts`), separate from tile dragging (pointer events in the board). There is no cross-app-window tile drag; Move to Workspace covers it, consistent with one workspace per app window (docs/11 §4, enforced in `main/workspaces.ts#show`).
- **Display-setup-aware window placement** in main (`displays.ts` + `#displaysChanged`) is a detail most Electron apps get wrong.

## Issues

### AR1-07-01 · Split `WindowsView` into a layout hook, two scroll controllers, one gesture helper and a `<Tile>`

- **Status:** open
- **Severity:** high
- **Effort:** L (> 2 days)
- **Where:** `apps/desktop/src/renderer/src/components/WindowsView.tsx:133-1062`, `apps/desktop/src/renderer/src/components/Dock.tsx:38-144`

**Problem.** One function component holds the layout choice, the strip's scroll state machine, the canvas camera (pan, zoom, fit, reveal, debounced save), mode-switch "jump" bookkeeping, tile dragging with live reordering, strip edge resizing, canvas edge resizing, background panning, edge auto-scroll, the ResizeObserver live-resize detector and the TileMotion hand-off. Every change to one mode risks the others (the mode-switch rules are spread over six layout effects that read each other's refs), and none of it can be unit tested: bugs show up only in `pnpm e2e:motion`. `Dock.tsx` repeats the tile body (`r.pane ? <TerminalView> : <WindowContent>`, the `kind-…` class, attention ring) instead of sharing it.

**Evidence.** In `WindowsView.tsx`: 14 `useState`, 28 `useRef`, 13 `useEffect`, 10 `useLayoutEffect`, 6 `useCallback`, 4 `flushSync`, 19 `addEventListener`, 11 `getBoundingClientRect`, 8 `eslint-disable` for exhaustive-deps. Five hand-written pointer loops with their own add/remove listener bookkeeping: `startPan` (610-637), `startDrag` (703-750), `startResize` (758-785), `startSizing` (788-817), the minimap (1105-1119). A `live` ref (301-302) mirrors nine values so handlers registered once see fresh ones. No test imports `WindowsView`, `Dock` or `motion.ts` logic; the desktop tests in scope cover `layouts`, `canvas`, `docks`, `strip` only.

**Proposal.** Keep the one-DOM-tree, stable-order design and TileMotion; move logic out of React:
- `board/useBoardLayout.ts`: pure `(mode, ids, widths, canvasRects, vp, insets, spacing) → { lay, stripSlots, stripTotal }` (today lines 161-196), tested as a table.
- `board/StripScroller.ts` and `board/CanvasCamera.ts`: plain classes owning offset/camera, `animateTo`, `jump`, `reveal`, `fit`, the save debounce and the `jumpFrom` note, with an injected scroller element and clock. TileMotion already shows the pattern (a class driven by `update()`).
- `board/gesture.ts`: one `pointerGesture(e, { threshold, capture, move, end })` that every drag, resize, pan and the minimap use (and `hold()` for embeds).
- `components/Tile.tsx`: the tile shell (frame, title, body by kind, attention class) used by both `WindowsView` and `Dock`.
`WindowsView` then wires these together and renders. Prior art: VS Code's grid view (`SplitView`/`GridView`) separates layout model from DOM; tldraw keeps camera and gestures in a state machine outside React.

**Success criteria.**
- [ ] `WindowsView.tsx` under 400 lines; no file under `renderer/src/board/` over 350.
- [ ] Zero `eslint-disable` comments in `WindowsView.tsx`.
- [ ] `apps/desktop/test/board-*.test.ts` cover `useBoardLayout` (all four modes, insets), `StripScroller` (reveal, clamp, jump on mode switch) and `CanvasCamera` (fit, reveal, limits) with a fake element.
- [ ] `grep -c "addEventListener(\"pointermove\"" components/WindowsView.tsx` returns 0 (all through `pointerGesture`).
- [ ] `Dock.tsx` and `WindowsView.tsx` both render `<Tile>`; `grep -n 'r.pane ?' components/Dock.tsx components/WindowsView.tsx` returns nothing.
- [ ] `pnpm e2e:motion` scores no worse than before the split.

### AR1-07-02 · Type `workspace.view`, validate it in the core and prune ids when windows go

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `packages/protocol/src/model.ts:16-41`, `packages/core/src/workspaces/manager.ts:15,153-177`, `packages/core/src/core.ts:778-782`, `apps/desktop/src/renderer/src/store.ts:268-310`, `apps/desktop/src/renderer/src/App.tsx:111-179`, `apps/desktop/src/renderer/src/components/WindowsView.tsx:306-316`

**Problem.** The board's whole layout is nine string keys in an untyped `Record<string, unknown>`, written by the renderer and stored by the core. Nothing removes a window's entries when it closes or moves: `saveRect` merges `{...p.canvasRects, ...all}` so closed windows' rects stay forever, `selection.history` keeps dead ids, `grid.order` and `strip.widths` only prune on the next write of that key. The core also reaches into the "opaque" view by name (`view["selection.pane"]`, `core.ts:779`). When the 256 KB cap is hit, `workspace.update` throws and the renderer's `.catch(() => {})` (`store.ts:273`) silently stops saving any layout for that workspace.

**Evidence.** Read-only query of the live release store (`~/Library/Application Support/cmd/cmd.sqlite`, `spaces.doc`), ids checked against `windows` and `panes`: workspace `cmd` has 71 `canvas.rects`, 69 dead; Home 34 of 34 dead; `cmd` `selection.history` 45 of 50 dead; `static-pages-next` 44 of 50; `jams` `grid.order` 2 of 3 dead. Key spellings appear only as string literals at 13 call sites (`useWorkspaceView("canvas.rects", …)` etc.); `docs/11-workspaces.md:171` is the only list of them.

**Proposal.** Define `WorkspaceView` in `packages/protocol/src/workspace.ts` (`mode`, `layoutMode`, `order: WindowId[]`, `strip: Record<WindowId, number>`, `canvas: { rects; camera }`, `docks`, `selection: { pane; history }`) with per-key validators, the way `SETTINGS_SCHEMA` does it; `useWorkspaceView<K extends keyof WorkspaceView>`. The core owns id hygiene: on `pane.removed`, `window.removed` and `window.move` it drops the id from every id-keyed part of the source workspace's view, and it prunes once on load. Make the too-large error reach the user as a toast rather than a swallowed rejection (see doc 08 for toasts). This also gives remote clients and the CLI a contract for layout.

**Success criteria.**
- [ ] `WorkspaceView` exported from `@cmd/protocol`; `grep -rn 'useWorkspaceView<' apps/desktop/src/renderer/src` shows only typed keys (a typo fails `pnpm typecheck`).
- [ ] Core test: closing a pane and a window removes their ids from `canvas.rects`, `strip.widths`, `grid.order`, `selection.history` and `docks`; moving a window removes them from the old workspace.
- [ ] Core test: a store with dead ids loads pruned.
- [ ] `workspace.update` with an invalid value for a known key is rejected with a message naming the key.
- [ ] No `.catch(() => {})` left on `workspace.update` in `store.ts`.

### AR1-07-03 · Make a window type one typed definition shared by core and renderer

- **Status:** open
- **Severity:** medium
- **Effort:** L (> 2 days)
- **Where:** `packages/core/src/windows/types.ts:27-53`, `packages/core/src/windows/builtin.ts:1-699`, `apps/desktop/src/renderer/src/windows/registry.ts:57-76`, `apps/desktop/src/renderer/src/windows/preview.ts:10-24`, `apps/desktop/src/renderer/src/windows/markdown.tsx:14`, `json.tsx:12`, `image.tsx:35`, `packages/core/src/core.ts:406,460,477`

**Problem.** The two halves of a type are kept in sync by convention: the renderer registers `kind: "sqlite"` as a string, the state type `WindowType<S>` never reaches the renderer, and a kind without a view only shows "No view registered" at run time. The renderer re-states facts the core owns: preview regexes repeat the core's extension lists (`/\.(md|markdown|mdx)$/` vs `opens.extensions`), so ⌘E and `open` can disagree. The core itself reads other types' opaque state by field name (`w.state.path` for markdown/text, `w.state.url` for browser, `w.state.path` for actions). In the core all 23 types share one 699-line file while the renderer has a file per type. And a type that needs its own data (SQLite, PDF) must still edit the shared registries (`Methods`, `Handlers`, remote policy), so the "no protocol change" promise of docs/09 holds only for state-only types.

**Evidence.** 201 untyped state reads in the renderer (`stateStr(…)`, `.state.x`, `.state[…]`, outside stories). Adding the SQLite viewer (`git log`): core `c766a3d` touched `core.ts`, `remote/policy.ts`, `sqlite/service.ts`, `sqlite/worker.ts`, `windows/builtin.ts`, `windows/index.ts`, `protocol/index.ts`, `protocol/rpc.ts`, `protocol/sqlite.ts`, a test; UI `bf6f197` touched `windows/builtin.tsx` (side-effect import), `sqlite.tsx`, `sqlite-view.tsx`, `sqlite.css`, the kit's grid, gallery, `index.ts`, `lucide.ts`. Image viewer `af2a223` also edited `preview.ts` and `windows/index.ts`. Renderer registration relies on six side-effect imports (`builtin.tsx:29-34`).

**Proposal.** One module per type under `packages/window-types/src/<kind>.ts` (or `packages/protocol/src/windows/`), with no Node or DOM imports:
```ts
export const sqlite = defineWindowType({
  kind: "sqlite", title: "SQLite", icon: "cylinder.split.1x2",
  state: v.object({ path: v.string(), table: v.optional(v.string()), tab: v.optional(v.picklist([...])), sql: v.optional(v.string([v.maxLength(100_000)])) }),
  opens: { extensions: [...], priority: 10 },
  preview: false,
});
```
The core imports it and adds `create`/`update` (which may touch the disk); the renderer calls `registerWindowView(sqlite, { View, describe, menu })` and gets `win.state` typed as `StateOf<typeof sqlite>`. `previewFor` derives from `opens.extensions` of types with `preview: true`. Core code that looks for "the window showing file X" asks the type (`fileOf(win)`) rather than reading `state.path`. A parity test lists both registries. Per-type RPC (sqlite, pdf) stays in its service but registers its methods through the per-service contract proposed in AR1-02-05 / AR1-03-01.

**Success criteria.**
- [ ] `packages/core/src/windows/builtin.ts` is gone or under 80 lines (only the `registerBuiltins` list).
- [ ] A test fails when a core kind has no renderer view or a view names an unknown kind (terminal included once AR1-07-05 lands).
- [ ] `preview.ts` contains no regex literal; ⌘E targets come from the type definitions.
- [ ] `grep -rn 'stateStr(' apps/desktop/src/renderer/src/windows` returns nothing.
- [ ] `grep -nE 'state\.(path|url)' packages/core/src/core.ts` returns nothing.

### AR1-07-04 · One classifier for typed text, links and drops, and fix the ones that are wrong

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `apps/desktop/src/renderer/src/actions.ts:227-232`, `apps/desktop/src/renderer/src/newItems.ts:63-71`, `packages/core/src/windows/routing.ts:48-69`, `packages/core/src/windows/builtin.ts:15-26`, `packages/core/src/windows/types.ts:81-85,109-116`, `packages/core/shell/zsh/cmd-integration.zsh:87-115`

**Problem.** Whether some text is a URL or a path is decided in four places with four sets of regexes: `openableTarget` (New…/palette), `openPath` (palette, drops, terminal links, PDFs), the core's `targetFor` + `normalizeUrl`, and each shell integration. They disagree, and some answers are wrong: typing `package.json` in New… offers "Open package.json" and opens `https://package.json`; `127.0.0.1:8080` gets `https://` from `openPath` before the core (whose `normalizeUrl` would say `http://`) sees it; `targetFor("localhost:3000")` parses `localhost` as a URL scheme and returns no type. User overrides (`open.handlers`) work only for file extensions: no way to say "folders: Finder" or "http: default browser", and a misspelt kind is ignored silently.

**Evidence.** Run against the renderer's `openPath` rule: `127.0.0.1:8080 → https://127.0.0.1:8080`, `notes.md → https://notes.md`, `package.json → https://package.json`, `[::1]:3000` unchanged. `types.ts:82` applies overrides only when `target.type === "path" && !target.isDir`. `packages/core/test/windows.test.ts` checks `normalizeUrl` and extension routing but has no table for typed text.

**Proposal.** Move classification into one pure function in `@cmd/protocol` (`classifyOpen(text, { cwd }) → { url } | { path } | null`, using `normalizeUrl`'s rules: loopback → `http`, a bare `name.ext` that could be a file → path first), used by `newItems.ts` for the offer and by the core's `window.openTarget` for the decision; `openPath` passes the raw text through. Extend `open.handlers` keys to `folder`, `scheme:<name>` and `ext`, validated against the registry when the setting changes (an unknown kind is a settings error, docs/09 "Routing rules" updated). The shell scripts keep their fast path but defer anything ambiguous to the core.

**Success criteria.**
- [ ] A table test in `packages/protocol/test` covers at least: `example.com`, `localhost:3000`, `127.0.0.1:8080`, `[::1]:3000`, `file://~/x`, `~/notes.md`, `notes.md`, `package.json`, `C:\x`, `mailto:a@b`.
- [ ] `grep -nE '/\^\[\\w-\]\+' apps/desktop/src/renderer/src/actions.ts apps/desktop/src/renderer/src/newItems.ts` returns nothing.
- [ ] `open.handlers = "folder: default"` opens folders in Finder; a test covers it.
- [ ] Setting `open.handlers` to an unknown kind reports an error in Settings and over `cmd settings set`.

### AR1-07-05 · Put attention, status and the terminal on the window model

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `packages/core/src/windows/manager.ts:18-28`, `packages/core/src/core.ts:750-754`, `apps/desktop/src/renderer/src/model.ts:13-56,129-136`, `apps/desktop/src/renderer/src/App.tsx:293-294`, `apps/desktop/src/renderer/src/components/WindowsView.tsx:959,983-987`, `apps/desktop/src/renderer/src/components/Dock.tsx:74-86`

**Problem.** The two-level model (pane = terminal, window = typed tile) leaks into every consumer. Terminals have typed `pane.attention`; other windows keep attention as an untyped `state.attention` written through `window.update`; there are two clear calls (`pane.clearAttention`, `window.clearAttention`) and every renderer predicate branches on both (`needsYou`, `wantsYou`, `workspaceAttention`, the App effect that clears them). The renderer's row type carries `pane` or `win`, and tiles choose their body with `r.pane ? <TerminalView> : <WindowContent>` in two components. docs/09 already lists "terminal windows are still special-cased" as an open item; it now costs something on every feature that touches a tile.

**Evidence.** `model.ts:24-28` reads `w.state.attention as Attention`; `model.ts:52-55` loops panes and windows separately; `App.tsx:293-294` issues both RPCs; `kind-${r.win?.kind ?? "terminal"}` appears in both `WindowsView.tsx:959` and `Dock.tsx`; 24 `r.pane`/`row.pane` reads across 9 renderer files. `window.clearAttention` is "view" in remote policy while `window.update` (which writes the same field) is "control".

**Proposal.** Give `AppWindow` typed `attention: Attention | null` (and the status the title bar shows), filled by the notification service for every window, terminals included (`terminalWindow(p)` copies `p.attention`). One `window.clearAttention` for all kinds; `pane.clearAttention` becomes an alias, then goes. In the renderer, register the terminal like any type (`registerWindowView({ kind: "terminal", View: TerminalTile })`, paneId from `state.paneId`), and let a row be `{ win: AppWindow, agent }`. This is the last step docs/09 names; do it before plugins.

**Success criteria.**
- [ ] `AppWindow.attention` exists in `model.ts`; `grep -rn 'state.attention' packages apps/desktop/src` returns nothing.
- [ ] `grep -rn '"pane.clearAttention"' apps/desktop/src` returns nothing.
- [ ] `registerWindowView({ kind: "terminal"` exists; `WindowContent` renders terminals.
- [ ] `needsYou`/`wantsYou` read one field and have a unit test with a terminal, an agent and a widget.

### AR1-07-06 · Keep a docked window mounted instead of moving its DOM

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `apps/desktop/src/renderer/src/components/Dock.tsx:1-5,45-61`, `apps/desktop/src/renderer/src/components/WindowsView.tsx:22-23,858-884`, `apps/desktop/src/renderer/src/motion.ts:333-375`

**Problem.** The board promises that "windows are never remounted or reordered in the DOM", but docking or undocking renders the window in another parent, so its subtree is unmounted and rebuilt. Dock's own header says it: "a webview reloads once (Electron reattaches a moved `<webview>`)". A browser window loses its scroll position, form input and in-page state every time it goes to or from a sidebar; editors lose undo history unless they persist it. The hand-off between the two parents needs module-level registries (`arrived`, `departed`, `settledElsewhere`, `ghost`) and `queueMicrotask` timing.

**Evidence.** `Dock.tsx:4-5` comment; `Dock.tsx` renders its own `<Window>`/`<TerminalView>`/`<WindowContent>`; `motion.ts:333-356` keeps `departures` as module state to pass rects between the two trees.

**Proposal.** Treat a sidebar as a reserved rect in the layout, not a separate tree: the board computes `rects` for docked windows (the side's column, full height) and the tiles stay children of one host, positioned by TileMotion like any other move. `Dock` becomes the resize handle and the backdrop. Docking is then a glide with no reparenting, and `arrived`/`departed` go away. Prior art: VS Code moves views between containers with `reparent` only for non-webview content and keeps webviews in an overlay positioned over their slot for exactly this reason.

**Success criteria.**
- [ ] An e2e step docks and undocks a browser window and asserts the webview's `did-start-loading` count does not change.
- [ ] `arrived`, `departed` and `settledElsewhere` are removed from `motion.ts`.
- [ ] A text window docked and undocked keeps its undo history (e2e).
- [ ] `pnpm e2e:motion` dock scenarios score no worse.

### AR1-07-07 · Validate and bound window state patches

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `packages/core/src/windows/manager.ts:111-134`, `packages/core/src/windows/builtin.ts:83-116`, `apps/desktop/src/renderer/src/components/TextView.tsx:83`, `packages/core/src/remote/policy.ts:90-91`

**Problem.** For types without `update` (measured: `magic`, `navigator`; `terminal` cannot be updated), `WindowManager.update` merges whatever keys a client sends (`{ ...w.state, ...patch.state }`), and no type's state has a size limit (the workspace view has 256 KB; window state has none). An untitled text window's `draft` is unbounded and is written to SQLite and broadcast to every connection after each 500 ms typing pause. `window.update` is open to remote "control" devices.

**Evidence.** `manager.ts:126`; `textType.update` stores `draft` with no cap (`builtin.ts:113-114`), while `sqlite.sql` caps at 100 000 chars (`builtin.ts:305`); `TextView.tsx:83` sends the whole document on each pause.

**Proposal.** Default `update` rejects unknown keys (types opt in with a state schema, see AR1-07-03); `WindowManager` refuses a state over 1 MB with a clear error; cap `draft` at `TEXT_MAX_BYTES`. Optionally send drafts only to the core's store, not as a broadcast, by marking the key as private to the owning connection.

**Success criteria.**
- [ ] Core test: `window.update` on a magic window with an unknown key is rejected.
- [ ] Core test: a state patch making a window's JSON over 1 MB is rejected and the stored state is unchanged.
- [ ] Core test: a `draft` over `TEXT_MAX_BYTES` is rejected.

### AR1-07-08 · Write the window type SDK before the first plugin

- **Status:** open
- **Severity:** low
- **Effort:** L (> 2 days)
- **Where:** `docs/09-window-types.md:100-108`, `docs/06-plugins-routines-system.md:16-70`, `packages/core/src/windows/types.ts`, `apps/desktop/src/renderer/src/windows/registry.ts`, `apps/desktop/src/renderer/src/windowActions.ts:10-25`

**Problem.** docs/09 says built-ins use "the same API a plugin will use", but a third-party window type would today need: a core module with `create`/`update` running in the core process with full Node access, a React component imported into the renderer bundle, and edits to the closed `Actions` type in `windowActions.ts` for any command it answers (save, find, zoom…). There is no manifest, no state schema, no declared capabilities and no isolation. docs/06 proposes "UI as data" and isolated iframes for custom panels; Magic widgets already run in an embed with a kit (docs/40). The pieces exist but nothing joins them into a contract.

**Evidence.** `WindowType` (types.ts:27-53) has no version or capability field; `registerWindowView` takes any `ComponentType`; `Actions` is a fixed object type with 9 optional methods; no `contributes.windowTypes` loader exists (`grep -rn contributes packages apps` finds only docs).

**Proposal.** Decide the SDK as a design doc and prove it on one built-in. Manifest: `contributes.windowTypes: [{ kind, title, icon, role, opens, state: <JSON Schema>, view: "ui://<file>.html", capabilities: ["fs.read:${state.path}", "net:https://*.youtube.com"] }]`. The view runs as an opaque-origin embed like Magic widgets, talking JSON-RPC over postMessage with capability checks in the host (MCP Apps and Zed's scoped capabilities, 00-research.md §7); `create`/`update` become declarative (schema defaults + validation) so no plugin code runs in the core. Window actions become a declared list (`actions: ["save", "find"]`) instead of a TypeScript type. Port `timer` or `youtube` to the manifest form as the proof.

**Success criteria.**
- [ ] `docs/NN-window-type-sdk.md` exists with manifest, state schema, capability list and versioning rule.
- [ ] One built-in type (timer or youtube) is defined by a manifest folder and loaded through the plugin path, with its old registrations deleted.
- [ ] A test shows a manifest view calling an undeclared capability gets an error.
- [ ] `windowActions.ts` `Actions` is derived from a declared list, not a hand-written type.

## Course corrections

1. **Split the board** (AR1-07-01). Everything else that touches tiles (docking, the terminal as a view, future modes) gets cheaper once layout, scrolling, camera and gestures are testable units outside React.
2. **Give layout and window state a schema the core enforces** (AR1-07-02, AR1-07-07). Two opaque JSON channels hold all of this system's persistent state; typing them fixes the leaks measured in the real store and makes the contract usable by the CLI and remote clients.
3. **One definition per window type, terminal included** (AR1-07-03, AR1-07-05). Removes the string-matched registries, the duplicated preview lists, and the pane/window branch in every consumer; it is the precondition docs/09 sets for plugins.
4. **Then the SDK and stable docking** (AR1-07-08, AR1-07-06).

## Quick wins

- AR1-07-07 (bound and validate window state patches).
- The `openPath`/`openableTarget` fixes from AR1-07-04 (the loopback `http` and `name.ext` cases) can land ahead of the full single-classifier change.
- The pruning half of AR1-07-02 (drop dead ids on `window.removed`/`pane.removed`) is under half a day on its own.
