# Window design: one language for every window

> Status (2026-10-09): **in progress**, branch `window-design`. Built: the token system (`packages/ui/tokens/*.tokens.json`, DTCG 2025.10 with a resolver for light themes and reduced motion; `pnpm tokens` generates `tokens.css` and `tokens.gen.ts`; a test keeps them current and checks every variable the kit's CSS reads); draft window pieces in the kit (`frame.tsx`, `chart.tsx`: View, Split, List, Panes, Stat, Chart, Text…); five reference windows as Workbench stories (`renderer/src/reference/`: data, chart, media, content, actions); scrollbars that float over the app's own windows; Magic widgets on the same tokens, with versioned kits: a widget's manifest pins its kit (`"kit"`, absent: 1); kit 1 is Magic's old kit, frozen (pixel-identical renders); kit 2 is the app's generated tokens.css plus kit.css; new widgets get kit 2, and changing a kit-1 widget moves it up (the request says how, the lint checks). the enforcement test (`design-css.test.ts`, literal values per file against `design-debt.json`, only going down); the `window-design` skill. Next: promote the draft pieces, an audit command, migrating the built-in windows.

cmd has a kit (`@cmd/ui`) with good colour discipline and solid controls, but the windows built from it don't share a layout language: each picks its own paddings, bar heights, row heights and empty states. And there are two kits: the app's `@cmd/ui` and Magic's `kit.css`, which has the better layout vocabulary and a written guide, but different token names. Soon AI will build windows with the kit too, so the patterns have to be easy to follow and hard to get wrong.

This doc is what other design systems do about that, what cmd has today, and what's missing.

## What cmd has today

**Strong:**
- **Colour.** Every colour comes from a theme. Renderer CSS has ~9 literal colours, all behind webviews, players and PDF pages. `themes.test.ts` checks contrast.
- **Window shell.** `Window`/`WindowBody`/`WindowFrame`/`WindowBar` draw every tile and dock.
- **Toolbar.** `WindowToolbar` has overflow into ⋯ and secondary items. Browser, Files, PDF, Image, Navigator, Events, Magic and Jam use it.
- **Lists and states.** `Panel`/`ListRow` (Commands, Actions, Notifications, Resources, Events) and `EmptyState` (25 files).
- **Motion.** One vocabulary of tokens, and `motion-css.test.ts` enforces it.

**Missing:**
1. **No spacing scale.** `tokens.css` has scales for type, radius, control height and motion, but not for space. The only spacing variable is `--dialog-pad`. Kit CSS alone uses 13 different px values for padding and gap (2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 18, 20, 22). Window insets differ by view:

   | View | Inset |
   |---|---|
   | SQLite `.sq-pad` | 12/14 |
   | Magic edit | 14/16/24 |
   | Settings `.sw-scroll` | 6/20/28 |
   | Markdown | 28/32/64 |
   | PDF | 16/24 |
   | Journal | 10/14 |
   | Agent Activity rows | 5/10 |

2. **No layout primitives.** There is no Stack, Inline, Columns, Box or ScrollArea, so every view writes `display: flex; gap: Npx` itself. Magic's `kit.css` has `k-stack`, `k-row`, `k-grid`, `k-edges` and `k-panes`; the app kit has none of these.
3. **No metrics for bars and rows:**
   - Bars: toolbar 31, SQLite bars 34/32/28, panel head 28, window bar 26, task manager head 26, status bar 34.
   - List rows: 22 (JSON), 24 (Files, Task Manager), 28 (sidebar), 38.
4. **No window frame.** Nothing fixes the order of toolbar, banner, scrolling body, footer and status bar, so SQLite, Settings, Task Manager and Journal each build their own (`.sq-bar`, `.sw-bar`, `.tm-bar`).
5. **No split pane, sidebar or inspector.** The PDF thumbnails, the SQLite table list and Settings' sidebar are each custom.
6. **No loading or error state.** Spinner is placed ad hoc in six views. Magic's error is its own (`magic-error-inline`). The lazy-load fallback is a grey div.
7. **No charts and no series colours** in the app. Magic has `--c1…--c6` and `cmd.chart`; Resources has no chart.
8. **No container-query convention.** Files, Timer, SQLite and the toolbar search each pick their own breakpoints, while Magic has `k-hide-narrow` at 320px.
9. **Two token vocabularies.** In Magic, `--bg` is the app's `--well`, and `--radius` is 8 against the app's 6. Magic has `--surface`/`--line`/`--fill`/`--good`/`--warn`/`--bad` where the app has `--group-bg`/`--separator`/`--success`/`--warning`/`--danger`.
10. **Off-scale type.** Renderer CSS has 61 literal font sizes against 33 `var(--text-*)`. Some aren't on the scale at all: 11, 12, 14, 16. Radii: 32 literal, 12 tokens.
11. **No enforcement.** There are no lint rules for spacing, sizes or font sizes. The rules exist only as prose in CLAUDE.md, the prototype skill and the `tokens.css` header. `magic/lint.ts` checks Magic widgets for literal colours only.
12. **References cover components, not windows.** The gallery's Patterns page has one pattern, and the Workbench has 9 stories, none of them a whole window.

**The surprise:** Magic's prompt (`packages/core/src/magic/prompt/prompt.md`, "Layout" and "How cmd looks") is the best written guide to cmd's window design in the repo:
- cover the window edge to edge, never a block floating in the middle;
- a status line, not tiles;
- sections are panes that drop the last first when space runs out;
- no boxes in the box;
- one text size;
- archetypes (status + table, feed, player, tool, value + context, dashboard) drawn as ASCII.

It applies to the built-in windows just as well, and none of them follow it on purpose.

## What other systems do

### 1. Layout primitives own all spacing

- **Braid (SEEK):** "components never provide their own surrounding white space."
  - `Box` pads; `Stack`, `Inline`, `Columns`, `Spread` and `Tiles` space their children.
  - `Bleed` undoes a parent's inset and can't go further.
  - The space scale is named (`xxsmall`…`xxxlarge`), and a separate `gutter` is used only for insets.
- **Atlassian:** primitives (Box, Stack, Inline, Flex, Grid, Text, Pressable, Bleed) backed by tokens. Their styling library calls itself "bounded".
- **Every Layout:** *intrinsic* primitives (Stack, Cluster, Sidebar, Switcher, Cover, Grid) that adapt to the space they're given, not to the viewport.
- **Radix Themes** has the same primitives but accepts any CSS value and margin props. That freedom is what an LLM misuses.
- **SwiftUI:** `VStack`/`HStack` with `spacing:`. Spacing lives in the container, not on the children.

**For cmd:**
- Add `Stack`, `Inline`, `Columns`, `Spread` and `Tiles` to `@cmd/ui`. Their `gap`/`pad` props take only names from a spacing scale, typed as a union, so `gap={13}` doesn't compile.
- No margin props, and no kit component has an outer margin.

Sources: [Braid layout](https://seek-oss.github.io/braid-design-system/foundations/layout), [Atlassian primitives](https://atlassian.design/components/primitives/overview), [Every Layout](https://every-layout.dev/layouts).

### 2. Windows come from a few templates with named regions

- **Primer:** `PageLayout` and `SplitPageLayout` have Header, Content, Pane and Footer regions. Panes take width presets (min/default/max), are resizable or sticky, and scroll on their own.
- **SwiftUI:** `NavigationSplitView` (sidebar, content, detail) and `.inspector` (a trailing panel with `inspectorColumnWidth(min:ideal:max:)`, which becomes a sheet when space is short). The template owns how it adapts.
- **VS Code UX guidelines:** a closed set of containers and items (views, view toolbars, welcome views, panels, status bar). Every contribution says where it goes.
- **Raycast**, the strongest case: extensions build UI only from `List`, `Grid`, `Detail` and `Form`, plus an `ActionPanel`. "There isn't any HTML or CSS involved." The first actions get ↵ and ⌘↵ for free. Thousands of third-party extensions look native because there is no escape hatch.
- **Polaris:** `Page` (title, primary and secondary actions) → `Layout.Section` → `Card`, plus page templates like the resource index.

**For cmd:**
- A small set of **window templates**, each with named slots, on top of the window shell. Each owns its toolbar slot, scroll regions, pane widths and empty/loading/error states. The archetypes Magic already names map onto them:
  - `Document` (toolbar + scrolling body, optionally a footer)
  - `Split` (sidebar + content, resizable, min/ideal/max)
  - `Inspector` (trailing panel)
  - `Edges` (status at the top, the bulk to the bottom edge)
  - `Panes` (dashboard sections that drop the last first)
  - `Hero` (one centred control between top and bottom)
- Actions feed the command palette and shortcuts, as every app command already does.

Sources: [Primer PageLayout](https://primer.style/product/components/page-layout), [WWDC23 Inspectors](https://developer.apple.com/videos/play/wwdc2023/10161/), [VS Code UX](https://code.visualstudio.com/api/ux-guidelines/overview), [Raycast UI API](https://developers.raycast.com/api-reference/user-interface).

### 3. Responsive to the panel, not the screen

- **Container queries** are baseline in every engine, Electron included. Use media queries for app structure and `@container` for components, with container breakpoints as tokens so everything switches at the same widths.
- **Intrinsic layouts** avoid most breakpoints: Braid's `collapseBelow`, `auto-fit`/`minmax` grids, Every Layout's Sidebar and Switcher.
- **Atlassian lints `no-container-queries`** in product code. Responsiveness belongs to the primitives, not to views.
- **Density:**
  - Cloudscape has comfortable and compact modes, switched globally; compact takes 4px steps off padding and gaps everywhere.
  - JetBrains has Compact Mode.
  - Primer's DataTable takes `cellPadding` condensed/normal/spacious.

**For cmd:**
- Every window body is a container (`container-type: inline-size`).
- Three or four container-size tokens: narrow, regular, wide.
- Primitives take responsive values (`<Columns collapseBelow="narrow">`, `<Hide below="narrow">`), and views write no `@container` or `@media` of their own.
- A `data-density` attribute rescales the spacing tokens, so a data-heavy window is compact without one-off CSS.

Sources: [Cloudscape density](https://cloudscape.design/foundation/visual-foundation/content-density/), [Every Layout Sidebar](https://every-layout.dev/layouts/sidebar/).

### 4. Data and charts

- **Tables:**
  - Primer's DataTable declares columns as data: field, header, `align: "end"` for numbers, width `grow`/`auto`/min/max, and sort.
  - A sortable table has a default sort.
  - Row actions go in a last, header-less column, at most one shown, the rest in a menu.
  - Polaris' IndexTable gives the UI for selection, sort, filter and paging, while the app owns the logic; filters live in a bar above the table.
- **Empty states** (Carbon), in three kinds:
  - first use (no data yet);
  - no results (after a filter or search);
  - error (plain words, no codes, a way forward).

  The empty state *replaces* the element (an empty table loses its header), and there is one focus per state.
- **Chart colour:**
  - Carbon: an ordered 14-colour categorical palette applied in order, and sequential palettes that flip in dark themes.
  - Atlassian: `color.chart.*` tokens, used in order, with `chart.neutral` to de-emphasise.
  - Primer: a legend only for more than one series, and marks at 3:1 contrast with the background.
- **Polaris Viz is deprecated.** Shopify now says to build charts with a library and keep the design system for the rest. Owning a chart library is expensive.

**For cmd:**
- Grow `DataGrid` toward this:
  - column widths (`grow`/`auto`);
  - density;
  - a toolbar slot for filters;
  - built-in empty, no-results and error states.
- One `ViewState` (loading, empty, no results, error with Retry) that every template uses, so no view places its own spinner.
- Chart tokens in every theme: `--chart-1…6` (the theme's ANSI colours, as Magic already does), `--chart-axis`, `--chart-grid`, `--chart-neutral`.
- A thin `Chart` (line, area, bar, sparkline) that reads only those tokens. Magic's `cmd.chart` is the starting point.

Sources: [Primer DataTable](https://primer.style/product/components/data-table), [Polaris IndexTable](https://polaris.shopify.com/components/index-table), [Carbon empty states](https://carbondesignsystem.com/patterns/empty-states-pattern/), [Carbon palettes](https://carbondesignsystem.com/data-visualization/color-palettes/), [Primer data viz](https://primer.style/product/ui-patterns/data-visualization).

### 5. Enforcement

- **Atlassian:**
  - `ensure-design-token-usage` flags `padding: '16px'` and `color: 'red'`, configured per domain (color, spacing, shape).
  - The UI Styling Standard bans `className` on components, dynamic styles, nested selectors, `!important`, global styles and container queries in product code. Its premise: styles must be "static and locally analyzable".
  - Codemods migrate old code.
- **Shopify `stylelint-polaris`:**
  - Groups rules by domain so coverage can be *measured*.
  - A disable needs a written reason.
  - A migrator inserts disable comments into legacy code, so the rule can be switched on today and the debt paid down.
- **Primer** deprecated its `sx` escape hatch and is removing it component by component. Stylelint has `primer/spacing` and `primer/colors`.
- **Visual regression:** every story, every theme, diffed in CI.

**For cmd:**
- No linter setup is needed. `motion-css.test.ts` already shows how: a test that scans the CSS. Extend it to colours, font sizes, radii and (once there is a scale) spacing.
- An allowlist with a reason per line counts the remaining debt; the number only goes down.
- Diff the gallery shots (`pnpm --filter @cmd/ui shots`) across themes.

Sources: [ensure-design-token-usage](https://atlassian.design/components/eslint-plugin-design-system/ensure-design-token-usage), [UI Styling Standard](https://atlassian.design/components/eslint-plugin-ui-styling-standard/overview), [stylelint-polaris](https://polaris.shopify.com/tools/stylelint-polaris/rules), [Primer sx migration](https://primer.style/product/primitives/migrating/).

### 6. For AI

- **Atlassian** publishes `llms.txt`: an index of tokens, primitives, components, lint rules and an MCP server. It says plainly which package is legacy.
- **Primer's MCP** offers:
  - `list_components` and `get_pattern`;
  - `find_tokens` by intent;
  - `lint_css`, so the agent checks its own CSS against the rules;
  - coding guidelines.
- **Storybook MCP** builds a component manifest (props plus the first stories) because agents otherwise produce "wrong props, hallucinated states".
- **shadcn** has a registry of *blocks*: whole vetted compositions that an agent installs instead of assembling primitives.
- Docs written as rules ("Use X. Never Y.") with one canonical example beat prose.

**For cmd:**
- The window-design skill holds the rules and the reference windows.
- A manifest of `@cmd/ui` is generated from the source: components, props, allowed values, one example each.
- A check an agent can run on its own work (`cmd ui lint`, or the CSS test) closes the loop, as `magic/lint.ts` already does for colours.

Sources: [Atlassian llms.txt](https://atlassian.design/llms.txt), [Primer MCP](https://primer.style/product/getting-started/foundations/mcp), [Storybook MCP](https://storybook.js.org/docs/ai/mcp/overview), [shadcn MCP](https://ui.shadcn.com/docs/mcp).

### 7. One source for the tokens: the DTCG format (2025.10)

- **The format.** The Design Tokens Community Group released [Format Module 2025.10](https://www.designtokens.org/tr/2025.10/) on 2025-10-28 as its first stable version. It is a community-group report, not a W3C standard.
  - Files are JSON (`*.tokens.json`). A token is an object with `$value`, plus optional `$type`, `$description`, `$deprecated` and `$extensions`.
  - `$type` can be set on a group and is inherited by the tokens in it.
  - Typed values:
    - `dimension` is `{value, unit}`, with px or rem;
    - `color` is `{colorSpace, components, alpha}` in any CSS Color 4 space;
    - other types: `duration`, `cubicBezier`, `fontFamily`, `fontWeight`, `number`, and composites (`shadow`, `border`, `typography`, `transition`, `gradient`).
  - References: `{group.token}` for a whole value, or a JSON-pointer `$ref` for one property. Groups can `$extends` other groups.
  - The [Resolver Module](https://www.w3.org/community/reports/design-tokens/CG-FINAL-resolver-20251028/) adds *sets* and *modifiers* (theme: light/dark, density…). Each input (`{theme: "nord"}`) resolves to one flat set of tokens.
- **Tooling:**
  - [Terrazzo](https://terrazzo.app/docs/guides/dtcg/) 2.x supports 2025.10 fully, resolvers included. Its CSS plugin writes each resolver input under a selector of your choice (`[data-theme="dark"]`, an `@media`).
  - [Style Dictionary](https://styledictionary.com/info/dtcg/) has supported the older DTCG draft since v4. In v5, 2025.10 is "not fully supported" (work in progress).
  - Some tools still read only the older draft ([Hyvä](https://docs.hyva.io/hyva-themes/working-with-tailwindcss/design-tokens/formats.html)).
- **Desktop precedent.** No Electron or macOS app turned up that publishes its use of DTCG. The closest is **Firefox**:
  - its desktop design system keeps [JSON tokens](https://firefox-source-docs.mozilla.org/toolkit/themes/shared/design-system/docs/README.json-design-tokens.stories.html) as the source of truth, split into one file per category (`border.tokens.json` → `--border-*`);
  - Style Dictionary builds the CSS;
  - the same JSON drives its stylelint rules ([bug 1979109](https://bugzilla.mozilla.org/show_bug.cgi?id=1979109)).

  Write-ups such as [Porsche's tech radar](https://opensource.porsche.com/porschedigital-technology-radar/methods-and-patterns/design-tokens/) give the same lessons: name tokens by meaning, lint for literal values, and version tokens with the components.

**Where it fits cmd, and where it doesn't:**
- **Fits:**
  - the foundations: spacing, sizes, radii, the type scale, durations and curves (`--glide` is a `linear()`, which `cubicBezier` can't express, so it needs an extension);
  - each theme's base colours (`ThemeColors`, 17 themes) as the resolver's theme contexts.
- **Doesn't fit:**
  - the derived layer. `tokens.css` builds most surfaces with `color-mix(in srgb, var(--ink) 6%, transparent)` at runtime, so they follow any theme, including a person's own. DTCG has no colour functions, so these would be either precomputed per theme (losing custom themes) or written as `$extensions` (`"org.cmd.mix": {"of": "{color.ink}", "amount": 0.06}`) that only our generator understands;
  - the values the app sets from settings at runtime (`--window-radius`, `--window-elevation`). These stay CSS variables, with the token as their default.
- **The payoff is one source with many outputs**, more than the format itself:
  - `tokens.css`;
  - **TypeScript unions** for the primitives' props (`Space = "1" | … | "8"`), so the kit's types can't drift from the scale;
  - Magic's widget tokens (today `widgetTokens()` in `protocol/src/magic.ts` keeps a second vocabulary by hand);
  - the gallery's token page;
  - the manifest and skill an AI reads, with each token's `$description` as its rule ("between rows in a list", "a window's inset");
  - the CSS test's list of allowed values.
- **Generator:**
  - A small script of our own (TypeScript, run on Node like the rest, no dependency) reads `packages/ui/tokens/*.tokens.json` and writes those outputs. A test fails when they are stale, as the motion tokens' test does today.
  - Terrazzo is the alternative if we'd rather not own the parser. It is the only tool with full 2025.10 support.
  - Style Dictionary isn't there yet.

## Plan

In order of leverage:

0. **Tokens in the DTCG format** (`packages/ui/tokens/*.tokens.json`) and a generator, starting with the new spacing and metrics tokens and the existing foundations. Theme colours follow once the derived layer has an extension.
1. **Spacing and metrics tokens.**
   - A spacing scale on a 4px base: `--space-1` 2, `-2` 4, `-3` 6, `-4` 8, `-5` 12, `-6` 16, `-7` 24, `-8` 32.
   - One window inset (`--inset`).
   - Row heights (`--row-h-sm` 22, `--row-h` 24, `--row-h-lg` 28).
   - Bar heights settled to two: the toolbar and a footer/status bar.
   - Map the kit's own 13 values onto the scale.
2. **Layout primitives** in `@cmd/ui`:
   - `Stack`, `Inline`, `Columns`, `Spread`, `Tiles`, `Scroll`;
   - `gap`/`pad` take only scale names;
   - no margins;
   - responsive props keyed by container size.
3. **Window templates:** `WindowView` (toolbar, banner, body, footer, status slots, and `state` for loading/empty/error), `Split`/`Inspector`, `Edges`, `Panes`, `Hero`. These carry over Magic's archetypes.
4. **Reference windows** as Workbench stories, one per kind, built only from the kit with no view CSS:
   - **content:** a document or article reader with an outline sidebar;
   - **media:** an image or video viewer with a filmstrip and an inspector;
   - **data:** a table with a filter bar, a selection inspector and every state;
   - **charts:** a dashboard of panes with a line, bars, sparklines and stats.

   Every gap they hit becomes a kit change.
5. **Chart tokens and `Chart`.**
6. **One vocabulary.** Magic's `kit.css` uses the same token names as `@cmd/ui`, ideally generated from it, so widgets and windows can't drift apart.
7. **Enforcement:** the CSS-scanning test for colour, type, radius and spacing, with a reasoned allowlist.
8. **The window-design skill:** rules, the archetypes, the reference windows, and how to check.
9. **Migration:** move the built-in windows onto the templates one by one (SQLite, Settings, Task Manager and Journal first).

## Continuing the migration (handoff, 2026-10-10)

For the next agent picking this up. Read the `window-design` skill first (`.claude/skills/window-design/SKILL.md`): it has the system, the rules and the checks. This is where things stand and how the work has been done.

### What exists

- **Tokens**: `packages/ui/tokens/*.tokens.json` (DTCG 2025.10, `cmd.resolver.json`), built by `pnpm tokens` into `packages/ui/src/tokens.css`, `tokens.gen.ts` (scales as types, `LIGHT_VARS`, the `TOKENS` manifest) and Magic's `prompt/tokens.css` and `preview-themes.json`. `tokens.test.ts` keeps them current and fails on any variable the kit's CSS reads that nothing defines.
- **Window pieces** in `@cmd/ui` (`frame.tsx`, `chart.tsx`, `timeline.tsx`, styles in `frame.css`): `View` (toolbar, body, footer, `state`, `inset`, `focusable`, `bodyRef`), `ViewState`, `StatusLine`, `Split`, `List` (plain, grouped), `ListGroup`, `Panes`/`Pane`, `Stat`, `Chart`/`Sparkline`/`Legend`, `Stack`/`Inline`/`Tiles`/`Hide` (`below`, `above`), `Text`, `Measure`, `Document`, `MediaStage`, `Filmstrip`, `Viewport`, `Picture`, `Ribbon`, `Timeline`/`TimelineEntry`. `DataGrid` has `grow`, `hide`, `icon` columns and selection. The gallery's Windows page shows them.
- **Reference windows** (`renderer/src/reference/*.story.tsx`): data, chart, content, media, actions, and `States` (every view state, short and long texts, three widths).
- **Floating scrollbars** in every app window (`installScrollbars` uses the page overlay); nothing compensates for scrollbars any more.
- **Magic** shares the tokens through kit versions (`KIT_FILES` in `packages/protocol/src/magic.ts`): kit 1 frozen (`prompt/kits/1.css`, hash pinned in `kits.test.ts`), kit 2 current; a widget's manifest pins its kit.
- **Enforcement**: `design-css.test.ts` counts literal colours, font sizes, radii and spacing per stylesheet against `apps/desktop/test/design-debt.json`; counts only go down (`pnpm design-debt` locks in a lower count, in the same commit). `pnpm workbench audit <story> [variant]` measures where content sits against each window's edges.

### Migrated (merged to master, local, not pushed)

Workspace Actions (`ActionsView`), Resources (sparklines, tables), SQLite (Split sidebar → toolbar menu below 600px), Markdown (`Document`), Journal (`Ribbon`, `Timeline`), Image (`Viewport`, `Picture`) and PDF (no sidebar any more, pages full width from the top; `pdf.css` keeps only pdf.js's own markup). The **Task Manager** is no longer its own Electron window but a sheet in the app window, drawn like Send Feedback and What's New (`components/TaskManager.tsx`), on `View` and `DataGrid` (`rowInfo`: section headings with totals, terminals that expand to their processes); the user preferred that over a separate window with a title-bar toolbar. **Settings**, still its own window, is on `View`, `Split`, `List`, `TitleBand`, `Page`, `FormActions`, `ShortcutField`, `QrCode`; `settings.css` and the old sidebar rules in `styles.css` are gone. On branch **`migrate-widgets`** (`~/src/cmd-migrate-widgets`): **Agent Activity** (`ListRow`s), **Live Diff** (`ListRow` + `Diff`), the **Timer** (redesigned with the user: presets and Start/Pause/Reset in the toolbar, the time in a `Dial`), **YouTube** and the **Visualizer** (`Stage`); `widgets.css` is gone. On branch **`migrate-files`** (`~/src/cmd-migrate-files`): the **Files** window and sidebar (`Tree`, with sortable columns the user asked for, and a focused selection readable in every theme) and the **Browser** (`WebStage`); their rules left `styles.css`. The Workbench now pins its picked theme (`theme.ts` `pinTheme`) and shows webviews. Nothing has been pushed or released.

Design debt went 539 → 388. What's left, by file (`design-debt.json`): the kit's `components.css` 192, the app's `styles.css` 110 (the sidebar and Navigator, tiles, the palette, title fields, remote), `magic.css` 50 (the Magic window's own UI, not widgets), `library.css` 13, `tooltips.css` 13, small rest.

### Next, in the order agreed with the user

1. ~~Settings and the Task Manager~~ (merged, above).
2. ~~The remaining widgets~~ (on their branch, above).
3. **The Files and Browser windows and the sidebar** (most of `styles.css`), then the **Magic window's** chrome (`magic.css`) and the Widget Library (`library.css`).
4. **The kit's own `components.css`** (192 literals: move its spacing onto the scale) and `tooltips.css`.

### How each migration has gone (keep doing it this way)

1. New worktree per window (`git -C ~/src/cmd worktree add ~/src/cmd-migrate-<name> -b migrate-<name> master`, `pnpm install`), as CLAUDE.md says.
2. Split the view: the window keeps data and effects; a presentational component (or the same one with injected bits) draws, so a **story** can show every state. Patterns used: `Actions`/`ActionsView`, `Resources`/`ResourcesView`; an optional `update` prop for window state (`SqliteView`); real files through the Workbench's real core (`reference/RepoFile.tsx`: `useRepoFile`, `storyWindow`); the instance's own `cmd.sqlite` as a database (`core.hello` gives `stateDir` and `root`).
3. Rebuild on the pieces, closest reference window first; delete the view's CSS. A look the kit lacks becomes a kit piece (with tokens, a gallery specimen when it's general), not view CSS. Third-party markup (pdf.js) may keep a small stylesheet on tokens.
4. Check: `pnpm workbench shot` in a dark and a light theme, `pnpm workbench audit` on every variant (incl. `Sizes`), before/after shots (`git stash push -- packages apps`, shoot, `git stash pop`: the story keeps working against the old component when its props didn't change).
5. `pnpm design-debt`, `pnpm typecheck && pnpm test`, commit; update the skill when a piece or rule is added. Show the user in the Workbench, iterate, merge when they say so.

### Decisions the user made (keep them)

- One inset (12px) on every side, to the letters; a row of controls is a toolbar (but a single action stays by its heading, as Journal's Write Again); footers quiet (`--text-faint`, the toolbar's line colour); tables edge to edge; chart axes on the right; lists of things to run grouped, indented, no boxes; states centred, balanced, sentence case, small icons in `--text`.
- Toolbar items stay at their tighter 6–8px inset for now (open; the audit reports, doesn't flag).
- Keep windows as simple as they were (Markdown); drop what isn't needed (the PDF sidebar). Behaviour stays unless the user asks.
- Sidebars and inspectors collapse below 600px; window sizes are narrow (< 360), regular (< 600), wide.

### Gotchas

- `pnpm workbench eval '<js>'`: code containing `;` needs an explicit `return`. The user sometimes closes the Workbench window; don't reopen it uninvited (`pnpm workbench <story>` starts it again).
- The Workbench page now has the app's CSP (`workbench.html`), so `cmd-file:` images, media and PDFs load in stories.
- `packages/core/test/actions.test.ts` "lists a folder and tells when its files change" fails now and then in the full suite under load (the Workbench running); it passes alone. Not caused by this work; worth a look.
- The repo isn't formatted by a tool: write code in the surrounding hand-formatted style; no prettier.
- Other agents work in parallel (`cmd ls`); merges happen only from the main checkout, when the user asks.
