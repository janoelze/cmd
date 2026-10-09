# 10 UI kit, tokens and styling

**Score: 7/10** · reviewed 2026-10-10 against commit ddb7832 · scope: `@cmd/ui` (controls, window pieces, tokens pipeline, themes, gallery, tests), the app's stylesheets, theme/look/fonts glue, reference windows, the design ratchets and the window-design/prototype process

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 7/10 | Clean token tiers and one kit, but Magic and the web client keep their own copies of the design language |
| Correctness & robustness | 5/10 | Dialog claims `aria-modal` without trapping focus; lists, grids and menus are mouse-first for assistive tech |
| Performance | 8/10 | ~100 KB shared CSS chunk, no runtime CSS-in-JS; the scrollbar fade is cheap and justified |
| Security | n/a | Nothing security-relevant in scope (the Magic sandbox is doc 11) |
| Testability & tests | 4/10 | Strong ratchets on CSS, zero behaviour tests for any control, screenshots with no baseline |
| Extensibility | 7/10 | Themes are data, tokens are DTCG, variants are data attributes; new pieces land without specimens |
| Code health | 8/10 | Terse, well-commented files; 496 literals left and falling; 8 dead tokens |

## What this system is

`packages/ui` (`@cmd/ui`, 12,407 lines including generated files) is cmd's design system. Its tokens are DTCG 2025.10 JSON in `packages/ui/tokens/` (10 files, tied by `cmd.resolver.json`: a base set, a `light` appearance modifier, a `reduced` motion modifier). `tokens/build.ts` (222 lines) generates `src/tokens.css` (190 lines, on `:root, .ui-theme`), `src/tokens.gen.ts` (817 lines: the `SPACE`/`TEXT_SIZES`/`RADII` unions, `LIGHT_VARS`, a `TOKENS` catalogue) and, across the package boundary, Magic's `core/src/magic/prompt/tokens.css` and `preview-themes.json`. There are 140 tokens; 37 are set at runtime by the active theme. Themes (`src/themes/`, 29 built-ins, 18 dark / 11 light) are plain data (`Theme`: 16 `colors`, an ANSI terminal palette, optional syntax and `vars` overrides); `registry.ts` (117 lines) turns one into CSS variables on `:root` (`applyTheme`), and `apps/desktop/src/renderer/src/theme.ts` (30 lines) picks one from settings, following the system for Auto. The controls (`button.tsx`, `fields.tsx`, `choice.tsx`, `overlay.tsx` 565, `toolbar.tsx` 445, `status.tsx`, `layout.tsx`, `list.tsx`, `grid.tsx`, `ai.tsx`, `find.tsx`) and the window pieces (`frame.tsx` 255: View, Split, Panes, Stat, Stack, Inline, Tiles, Text, List, Document; `chart.tsx`; `timeline.tsx`; `window.tsx`) are styled by `components.css` (1,453 lines), `frame.css` (203) and `tooltips.css`, all loaded through `ui.css`. `scrollbars.ts` (402) and `tooltips.tsx` (300) install document-wide behaviour. `gallery/Gallery.tsx` (1,574 lines) is a Vite page with every family of components in every theme; `gallery/shots.mjs` screenshots it. The app adds `styles.css` (1,206 lines) and eight smaller sheets (settings, tasks, workbench, magic, widgets, library, jam, pdf, image; 3,661 lines of CSS in all). Two ratchet tests guard the CSS: `design-css.test.ts` (literal colours, font sizes, radii, spacing per file against `design-debt.json`, only going down) and `motion-css.test.ts` (durations and curves from tokens, no layout animation). The design is docs/07-ui-vision.md, docs/37-motion.md, docs/40-window-design.md (status: in progress; next steps are promoting the draft pieces and migrating the built-in windows) and the kit-version part of docs/16-widgets.md; the process is `.claude/skills/window-design` and `.claude/skills/prototype` (the Workbench, `scripts/workbench.mjs`, 371 lines).

## What is good

- **The token pipeline is the right investment and it is complete.** DTCG source, one generator, a staleness test (`tokens.test.ts:24`), a test that every `var(--x)` the kit's CSS reads is a token or a declared app input (`tokens.test.ts:45`), and TS unions generated from the scales so `<Stack gap>` cannot drift from `--space-*`. Semantic layering is real: 16 theme primitives → 53 colour tokens (21 of them `color-mix` derivations, so any user theme gets correct hovers, edges and fills for free) → window tokens. Copy this "data in, everything generated, test the output" shape elsewhere.
- **Themes are data, applied atomically.** One `Theme` drives CSS, xterm.js, CodeMirror and the native window (`types.ts:1`); `bootTheme` paints the first frame in the last theme; 16 themes use `vars` overrides and all 16 name real tokens (measured).
- **The ratchet.** `design-debt.json` went 539 → 533 → 523 → 517 → 496 literals across its five commits (bf4047a..b6a11d0), never up. 00-research.md §9 already names it the model for every architectural rule.
- **Uniform control API.** Every value control is controlled with `value`/`checked` + `onChange(v)` (`choice.tsx:55,78,114,162,229,290`, `fields.tsx:21-25,124,200`); text fields add `onCommit` for commit-on-blur/Enter. Variants are data attributes: 51 `data-variant|size|tone|align|state|kind` uses in the kit, one template-literal className (`icon.tsx:47`). Every input control forwards its ref.
- **Menu keyboard model** (`overlay.tsx:154-260`): arrows, Home/End, type-ahead, Enter/Space, Tab and Escape returning focus to the anchor, opens on the checked item. The Palette (`Palette.tsx:230`) shows the right AT pattern with `aria-activedescendant`.
- **Scrollbars are justified, not gold plating.** The header (`scrollbars.ts:1-16`) explains why: `::-webkit-scrollbar` does not repaint on `:hover` nor transition, and styling a page's scrollbar turns macOS overlay scrollbars into classic ones. The registered `@property` trick is the cheapest thing that gets macOS behaviour.
- **Reduced motion is a token modifier**, not ad-hoc media queries: durations collapse in one place (`motion-reduced.tokens.json`), plus a base rule that stops loops.

## Issues

### AR1-10-01 · Make Dialog actually modal: trap focus and make the page behind it inert

- **Status:** open
- **Severity:** high
- **Effort:** S (< ½ day)
- **Where:** `packages/ui/src/overlay.tsx:323-420`, `packages/ui/src/overlay.tsx:68-130`

**Problem.** `Dialog` sets `role="dialog" aria-modal` and moves focus in on open (`overlay.tsx:372-381`), but nothing keeps it there: Tab from the last button walks into the app behind the scrim, including a terminal's xterm textarea. A person can then type into a live shell while a confirm ("Close 3 terminals?") is still up, and screen readers are told the rest of the page is unavailable while it is reachable. Escape is handled on the scrim's `onKeyDown`, so once focus has left, Escape no longer closes the dialog either. `Popover` defaults to `role="dialog"` but never moves focus into itself, so its content is unreachable by keyboard unless the caller does it.

**Evidence.** `grep -n 'Tab' overlay.tsx` finds only the Menu's handler (`:239`); the Dialog has no keydown for Tab and sets no `inert` on siblings (`grep -n inert apps/desktop/src/renderer/src/App.tsx` returns nothing). The `inert` attribute is used only on the closing overlay itself (`:400`).

**Proposal.** Use the platform: render the dialog in a `<dialog>` element opened with `showModal()`, which gives a real focus trap, top-layer stacking, `inert` on everything else and Escape (`cancel` event) for free in Chromium; keep the scrim as `::backdrop` styled from tokens and keep `usePresence` for the exit fade. If the top layer conflicts with tooltips, the fallback is setting `inert` on `#root` while a Dialog is open plus a Tab wrap. For Popover with `role="dialog"`, move focus to its first focusable child on open (or set `role` to `group` when the content is non-interactive).

**Success criteria.**
- [ ] With a ConfirmDialog open over a terminal, pressing Tab 10 times never focuses an element outside the dialog (behaviour test, see AR1-10-04).
- [ ] Escape closes the dialog wherever focus is inside it, and focus returns to the element that had it.
- [ ] `pnpm e2e:a11y` snapshot of an open dialog lists no controls outside it.
- [ ] `pnpm e2e:motion` still scores the dialog's exit without a pop.

### AR1-10-02 · Give lists, grids and menus keyboard focus and an active-item announcement

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `packages/ui/src/list.tsx:145-180`, `packages/ui/src/grid.tsx:90-112`, `packages/ui/src/overlay.tsx:265-290`

**Problem.** `ListRow` is a `div` with `onClick`, no `role`, no `tabIndex`, no key handling; selection and keyboard-highlight are bare class names (`"sel"`, `"active"`, `list.tsx:148`). `DataGrid` rows take `onRowClick` and set `aria-selected` on a `<tr>` that is not focusable and is in a plain `table` (no `grid` role), so a row cannot be reached, moved through or opened by keyboard. In `Menu` focus sits on the list container and the highlighted item is only `data-active`, so VoiceOver announces nothing while arrowing. These are the pieces every new window is told to build from (window-design skill, "The system"), so each migrated window inherits the gap.

**Evidence.** `grep -n 'aria-activedescendant' packages/ui/src` returns nothing; the only use is the app's `Palette.tsx:230`. `grep -nE 'tabIndex|onKeyDown' packages/ui/src/list.tsx packages/ui/src/grid.tsx` returns nothing. The a11y audit (`e2e/a11y-audit.mjs:1-6`) only checks that controls have names, so it cannot see this.

**Proposal.** One roving-focus helper in the kit (`useListNav({ count, active, onActive, onOpen })`) used by `List`/`ListRow` (`role="listbox"`/`option` or `tree`/`treeitem` with the Twisty), `DataGrid` (`role="grid"`, rows focusable, ↑/↓/Home/End/Enter, `aria-rowindex`) and `Menu` (`aria-activedescendant` on the list, ids on items, as Palette does). This is the WAI-ARIA APG listbox/grid/menu pattern; VS Code's list widget is the prior art for a single keyboard model across trees, lists and tables. Move the bare `sel`/`active`/`open`/`tall` classes in `list.tsx` to `data-selected`/`data-active`/`data-open` like the rest of the kit (see AR1-10-08).

**Success criteria.**
- [ ] A ListRow list and a DataGrid in the gallery can be entered with Tab and walked with ↑/↓/Home/End; Enter fires the row's open action (behaviour tests).
- [ ] `grep -c aria-activedescendant packages/ui/src/overlay.tsx` ≥ 1 and the active menu item's id matches it in a test.
- [ ] `grep -nE '&& "(sel|active|open|tall|short)"' packages/ui/src/list.tsx` returns nothing.
- [ ] The a11y audit adds a keyboard-only pass over the Navigator and a table window that reaches a row and opens it.

### AR1-10-03 · Hold secondary text to a contrast floor in every theme, and test it

- **Status:** open
- **Severity:** medium
- **Effort:** S (< ½ day)
- **Where:** `packages/ui/test/themes.test.ts:31-37`, `packages/ui/src/themes/*.ts`

**Problem.** The theme test checks only body text on `well`, the terminal foreground and white-on-accent. `textDim` is what the kit uses for descriptions, footers, status lines and table notes, at `--text-sm` (11.5px), the size where contrast matters most, and it is not checked. Several light themes are hard to read in exactly the places the design guide sends secondary information.

**Evidence.** Measured over the 29 built-ins: 49 of 87 `textDim` pairs (on `bg`, `well`, `bgSidebar`) fall under 4.5:1, and three under 3:1: ayu-light `textDim/bg` 2.85, everforest-light `textDim/bg` 2.77 and `textDim/bgSidebar` 2.90. Derived `--text-faint` is lower still by construction.

**Proposal.** Extend the test with a table of required pairs and floors: `text` on `bg`/`well`/`bgSidebar`/`bgElevated` ≥ 4.5, `textDim` on the same ≥ 3.0 now (ratcheted toward 4.5 with a per-theme allowlist that can only shrink, same pattern as design-debt), `link` on `well` ≥ 3, `state*` on `well` ≥ 3 (non-text contrast). Where an upstream palette is below the floor, adjust `textDim` in cmd's port (the files already carry ported, not verbatim, palettes) rather than lowering the floor. Expose the computed ratios in the gallery's Themes page.

**Success criteria.**
- [ ] `themes.test.ts` checks the pairs above for every built-in theme.
- [ ] No built-in has `textDim` under 3:1 on `bg`, `well` or `bgSidebar`.
- [ ] Any allowlist for 4.5 is a JSON file with a test that fails when an entry becomes unnecessary.

### AR1-10-04 · Test the controls' behaviour, and compare gallery screenshots against a baseline

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `packages/ui/test/`, `packages/ui/gallery/shots.mjs`, `vitest.config.ts`

**Problem.** The kit has five test files with 32 tests: tokens, themes, motion maths, scrollbar thumb maths and tooltip placement. Not one renders a component. Menu type-ahead, Dialog focus return, NumberField clamping and Shift×10, SearchField Escape, Tabs arrow keys and DataGrid sort cycling are all promised in the gallery's notes and nowhere checked. `apps/desktop/test/fields.test.ts` and `grid.test.ts`, listed as kit tests in this scope, test window-title fields and tile layout in `model.ts`, not the kit. `shots.mjs` writes PNGs for 11 pages × 4 themes but compares them with nothing, so a regression in a control's look is caught only if someone opens the folder.

**Evidence.** `grep -c 'expect(' packages/ui/test/*.ts`: 17+9+19+5+12 = 62 assertions, 0 in a rendered component. No DOM environment is configured (`vitest.config.ts` has none; no jsdom/happy-dom/testing-library in `node_modules`). `shots.mjs` has no `toHaveScreenshot`/pixel diff.

**Proposal.** Two layers. (1) Behaviour: add `happy-dom` and `@testing-library/react` as dev deps of `@cmd/ui`, set `environment: "happy-dom"` per file (`// @vitest-environment happy-dom`), and write one file per family: overlay (Dialog trap and return, Menu keys and type-ahead, Popover dismiss reasons), fields (NumberField clamp/step, SearchField Escape, TextField onCommit), choice (Tabs/Segmented arrows), grid (sort cycle, selection). (2) Look: turn `shots.mjs` into a Playwright test with `expect(page).toHaveScreenshot()` per page in Dark and Light, baselines committed, run in `pnpm e2e`. 00-research.md §9 asks for exactly this kind of ratchet on quality.

**Success criteria.**
- [ ] `pnpm vitest run packages/ui/test` runs ≥ 30 tests that render a component.
- [ ] Each of Dialog, Menu, NumberField, SearchField, Tabs, DataGrid has at least one keyboard test.
- [ ] A gallery visual test exists with committed baselines for at least Dark and Light, and fails on a 1px change to `--radius`.
- [ ] CLAUDE.md "Tests" names where kit tests live.

### AR1-10-05 · Make the Magic kit and the web client consume the kit, not copy it

- **Status:** open
- **Severity:** medium
- **Effort:** L (> 2 days)
- **Where:** `packages/core/src/magic/prompt/kit.css`, `apps/web/src/styles.css:1-40`, `packages/ui/tokens/build.ts:26-28`

**Problem.** docs/40 (§"Two kits", item 9, and step 6 "One vocabulary") set out to end parallel design languages. Tokens are now shared with Magic, but components are not: `kit.css` (197 lines, 50 `k-*` classes) re-implements buttons, tables, stats, badges, segmented controls and panes in vanilla CSS beside `components.css`'s `ui-*` versions, so a change to a control's look must be made twice and the two drift. The web client (`apps/web`) does not depend on `@cmd/ui` at all: its `styles.css` restates the Dark and Light theme colours by hand ("cmd's own Dark and Light themes (apps/desktop themes/dark.ts, light.ts)") with 36 colour literals and its own names (`--font`, `--mono`, `--bg-bar`, `--term-bg`), so a theme change in the kit never reaches the phone.

**Evidence.** `grep -oE '^\.k-[a-z0-9-]+' kit.css | sort -u | wc -l` ≈ 50; `.k-table` (`kit.css:103-107`) vs `.ui-grid` (`components.css:838-869`). `apps/web/package.json` deps: protocol, remote-crypto, xterm, react; no `@cmd/ui`. `grep -cE '#[0-9a-fA-F]{3,8}|rgba?\(' apps/web/src/styles.css` = 36.

**Proposal.** The generator is already the right seam. (1) Web: have `build.ts` emit a third target, or simply import `@cmd/ui/ui.css` (or a tokens-only entry `@cmd/ui/tokens.css`) and `applyTheme` from `@cmd/ui/themes` in `apps/web`, renaming its variables to the kit's; the phone then follows the Mac's chosen theme for free. (2) Magic: generate `kit.css`'s component rules from the same source as `components.css` (an alias layer `k-btn → ui-button` emitted by a small build step, or ship `components.css` into the frame as kit 3 with `k-*` kept as aliases for kit 2). Kit versioning (docs/16, `KIT_FILES`) already lets kit 3 differ without breaking pinned widgets. Sandbox concerns belong to doc 11.

**Success criteria.**
- [ ] `apps/web/package.json` depends on `@cmd/ui` and `grep -cE '#[0-9a-fA-F]{3,8}' apps/web/src/styles.css` is 0.
- [ ] Switching the Mac's theme changes the web client's colours in `pnpm e2e:web` (screenshot or computed-style check).
- [ ] A test fails when a control's rule in `components.css` and its Magic counterpart diverge, or the Magic counterpart is generated (no hand-written `.k-btn` rules).
- [ ] docs/40 status line records the kit-3 decision.

### AR1-10-06 · Point the ratchets at every stylesheet the product ships, and catch dead tokens

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `apps/desktop/test/design-css.test.ts:13`, `apps/desktop/test/motion-css.test.ts:10`, `packages/ui/src/scrollbars.ts:18-75`

**Problem.** Both ratchets scan only `packages/ui/src` and `apps/desktop/src/renderer`, and only `.css` files. CSS that ships from elsewhere is invisible to them: Magic's `kit.css` (9 literal sizes/colours by grep), `apps/web/src/styles.css` (36 colours), and CSS-in-TS strings: `scrollbars.ts` hard-codes its thumb colours as `rgb()` literals and its fade as `350ms ease-out`/`100ms`, outside the motion tokens and outside Reduce Motion. The token set itself has no "used" check, so 8 of 140 tokens are dead.

**Evidence.** Dead (no reference anywhere in apps/packages/e2e outside the generated files): `--row-h-sm`, `--row-h`, `--row-h-lg`, `--radius-xl`, `--pane-edge`, `--info`, `--sheet-elev`, `--sheet-sh`. `scrollbars.ts:29`: `* { --cmd-scrollbar: transparent; transition: --cmd-scrollbar 350ms ease-out; }`.

**Proposal.** Make `dirs` a shared list in one module (`apps/desktop/test/stylesheets.ts`) that includes `packages/core/src/magic/prompt` (excluding frozen `kits/1.css`) and `apps/web/src`, with baselines added for their current counts. Move the scrollbar colours to tokens (`--scrollbar-thumb`, `-hover`, `-active`, derived from `--ink` with `color-mix`) and the durations to `--dur-*` tokens. Add a `tokens.test.ts` case: every token is read somewhere or carries `$deprecated`.

**Success criteria.**
- [ ] `design-debt.json` has entries for `kit.css` and `apps/web/src/styles.css` (or zero literals there).
- [ ] `grep -nE 'rgb\(|[0-9]+ms' packages/ui/src/scrollbars.ts` returns only comments.
- [ ] A test fails on an unreferenced, non-deprecated token; the 8 above are removed or used.

### AR1-10-07 · Require a gallery specimen for every exported component

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `packages/ui/gallery/Gallery.tsx:1-4`, `packages/ui/src/index.ts`, `apps/desktop/src/renderer/src/reference/*.story.tsx`

**Problem.** The gallery's header says "Adding a component means adding its specimen here", and the window-design skill says the same, but nothing checks it, and the newest window pieces skipped it. Pieces with no specimen cannot be reviewed in every theme, are not in the screenshots, and an agent following the skill has no example to copy. The reference windows likewise don't exercise Timeline, Ribbon, Document, Hide, Legend or ViewState on their own, so docs/40's claim that the five windows cover the layout language is no longer true.

**Evidence.** Exported names from `index.ts` absent from `Gallery.tsx` include the components `Document`, `Ribbon`, `Timeline`, `TimelineEntry`, `Filmstrip`, `MediaStage`, `Measure`, `Hide`, `Legend`, `ListGroup`, `ListHeading`, `ListMark`, `Twisty`, `TabPanel`, `InfoButton`, `ClearButton`, `Group`, `Glyph`, `ToolbarMenu`, `ToolbarSegmented`, `ToolbarSeparator`, `ToolbarText`, `ToolbarField`, `ViewState` (by grep of each name). Ribbon/Timeline/Document arrived in b6a11d0 and ddb7832. In the app, Chart, Filmstrip, MediaStage and Measure have no non-story use yet; 6 of 22 registered window views use `View`.

**Proposal.** A test in `packages/ui/test/gallery.test.ts` that reads `index.ts`'s runtime exports that are capitalised React components and asserts each name appears in `Gallery.tsx` (an explicit `NO_SPECIMEN` set with reasons for helpers like `Glyph`). Add a Journal-like reference story covering Timeline/Ribbon/Document, and list in the window-design skill which reference covers which piece.

**Success criteria.**
- [ ] `gallery.test.ts` exists and passes; removing a specimen makes it fail.
- [ ] Document, Ribbon and Timeline have gallery specimens and appear in a `*.story.tsx` under `reference/`.
- [ ] The window-design skill's piece list names a reference window for each piece.

### AR1-10-08 · Layer the cascade (kit below app) and stop reaching into kit internals

- **Status:** open
- **Severity:** low
- **Effort:** M (1–2 days)
- **Where:** `apps/desktop/src/renderer/src/styles.css:221,255,371,378,502,786-787,837,1134-1137,1148,1170-1172,1206`, `packages/ui/src/ui.css`, `apps/desktop/src/renderer/src/settings/settings.css:1`

**Problem.** The kit and the app share one unlayered cascade; which rule wins depends on import order (`main.tsx:6-7`: kit, then app) and on matching specificity. The app overrides kit internals in 16 selectors (`.workspace-item .ui-menu-detail`, `.ui-icon-button.remote-indicator.connected`, `.term-sized.ui-toast`, …), so renaming a kit class silently breaks app views with no test failing. The kit's own state classes in `list.tsx` are unprefixed (`sel`, `active`, `open`, `tall`, `short`, `mono`) and can be hit by any global rule with the same name. The Settings window reuses the main window's sidebar classes (`.sidebar`, `.sb-search`, `.row`, `settings.css:1`) from the 1,206-line `styles.css` instead of the kit's `List`, which is why every secondary page loads the whole app shell's CSS (the shared chunk is ~100 KB / 19 KB gzipped in the last local build).

**Evidence.** `grep -cE '\.ui-[a-z-]+' styles.css` = 16 lines; `grep -c '@layer' packages/ui/src/*.css apps/desktop/src/renderer/src/*.css` = 0; `list.tsx:76,87,105,148,167,187` (8 bare modifiers, all other kit files use data attributes).

**Proposal.** Wrap `ui.css` in `@layer kit` and app sheets in `@layer app` (declared once: `@layer kit, app;`), so app rules win by layer, not specificity, and kit internals can be restyled only through custom properties the component exposes (`--h`, `--tone`, `--pad-x` already exist: document them as the component's styling API). Replace each of the 16 reach-ins with a prop/data attribute or a documented variable. Move list state to data attributes. Port the Settings sidebar to the kit's `Panel`/`ListRow` and drop the `styles.css` import from `settings/main.tsx` and `tasks/main.tsx` if nothing else needs it.

**Success criteria.**
- [ ] `ui.css` declares `@layer kit` and every app sheet is in `@layer app`.
- [ ] `grep -cE '\.ui-[a-z-]+' apps/desktop/src/renderer/src/styles.css` ≤ 3, each with a comment why.
- [ ] `settings/main.tsx` no longer imports `../styles.css`, or the doc says what it still needs.
- [ ] `pnpm e2e` screenshots of main, Settings and Task Manager are unchanged.

### AR1-10-09 · Show a visible placeholder for an unmapped icon, and test the mapping

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `packages/ui/src/icon.tsx:52`, `packages/ui/src/lucide.ts:82-160`, `apps/desktop/src/main/index.ts:790`

**Problem.** Components name icons by SF Symbol; outside the native renderer (the gallery, the main process's fallback when the helper is missing) names map to Lucide. An unmapped name renders `opacity: 0`: a blank square, no warning. So an icon-only button in the gallery or on a machine without the native helper is invisible, and nobody learns the mapping is short.

**Evidence.** `LUCIDE` maps 75 names. A scan of literal icon names in `apps/desktop/src`, `packages/ui/src` and the gallery finds about 25 real SF names with no mapping, among them `play`, `pause`, `stop.fill`, `lock`, `book`, `tray`, `paperplane`, `square.and.arrow.up`, `arrow.up`, `arrow.triangle.branch`, `gearshape.2`, `waveform`, `rotate.right`, `plus.magnifyingglass`, `minus.magnifyingglass`, `text.alignleft`, `photo.on.rectangle`, `internaldrive`. Window-type icons come from the core and are not even scannable.

**Proposal.** Unmapped names draw a neutral placeholder (Lucide `CircleHelp` or a dotted square from tokens) and log once per name in development. Add a test that collects icon names from source (the same regex as above, plus the window types registered in `builtin.ts`) and asserts each is mapped or listed in an explicit exemption.

**Success criteria.**
- [ ] `grep -n 'opacity: 0' packages/ui/src/icon.tsx` returns nothing.
- [ ] A test lists unmapped literal icon names and passes with none (or an exemption file).
- [ ] The gallery's toolbar and buttons pages show no blank icon slots in `shots`.

### AR1-10-10 · Keep app specifics out of the kit package

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `packages/ui/src/scrollbars.ts:46-75`, `packages/ui/tokens/build.ts:26-28`, `packages/ui/src/scrollbars.ts:29`

**Problem.** `@cmd/ui` is meant to be the design system any surface uses (docs/40; AR1-10-05 wants the web client and Magic on it), but it knows about the desktop app: `scrollbars.ts` styles xterm.js internals and the app's own `.xterm-host.scrollable` class with eight `!important`s, and `tokens/build.ts` writes into `packages/core/src/magic/prompt/`, so the UI package's build has a side effect in the core package. Separately, the scrollbar fade is installed as `* { transition: --cmd-scrollbar … }`: any kit or app rule that sets its own `transition` shorthand on a scroller (57 `transition:` declarations in scope) silently drops that scroller's fade.

**Evidence.** `scrollbars.ts:52-74` (`.xterm .xterm-scrollable-element > .scrollbar.vertical > .slider { … !important }`, `.xterm-host.scrollable …`); `build.ts:26` `const MAGIC = path.join(DIR, "../../core/src/magic/prompt")`.

**Proposal.** Move `XTERM_CSS` to the terminal view (`apps/desktop/src/renderer/src/terminals.ts` or its stylesheet), importing the thumb tokens from AR1-10-06. Have `build.ts` export the widget CSS and previews as functions and let a core-side script (or `pnpm tokens` at the root) write them, so the kit never writes outside itself. Install the scrollbar fade with `transition-property` appended via a custom property convention, or apply it only to `.cmd-scrolling`/scroller elements the watcher has seen, rather than `*`.

**Success criteria.**
- [ ] `grep -n 'xterm' packages/ui/src/*.ts` returns nothing.
- [ ] `grep -n '\.\./\.\./core' packages/ui/tokens/build.ts` returns nothing, and `pnpm tokens --check` still covers the Magic files.
- [ ] A scroller with its own `transition` (e.g. a Dialog body) still fades its thumb (a test or a scripted check in `pnpm e2e:motion`).

## Course corrections

1. **Make the overlays and lists honest for keyboard and assistive tech** (AR1-10-01, AR1-10-02). The kit claims modal dialogs and selectable lists; today they are mouse-first. Every window migrated onto View/List/DataGrid inherits the fix, so it is cheapest now, while 16 of 22 views are still unmigrated.
2. **Test behaviour and look, not only stylesheets** (AR1-10-04, AR1-10-07). The CSS ratchets are excellent; the controls themselves have no tests and new pieces ship without specimens. A DOM test environment and a screenshot baseline turn the gallery from a catalogue into a spec.
3. **Finish "one vocabulary"** (AR1-10-05, AR1-10-06). The generator already feeds Magic; feed the web client and Magic's components from it too, and point the ratchets at everything that ships CSS.
4. **Layer the cascade** (AR1-10-08). `@layer kit, app` plus documented styling variables removes the class of breakages where renaming a kit class silently restyles the app.

## Quick wins

AR1-10-01, AR1-10-03, AR1-10-06, AR1-10-07, AR1-10-09, AR1-10-10.
