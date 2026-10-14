---
name: window-design
description: Design or build the inside of any cmd window or widget so it matches the rest: a built-in window type, a React widget, a sidebar or inspector, a dashboard, a table, a list of things to run, a document or media viewer, or how Magic's prompt tells AI-made widgets to look. Covers the design tokens (packages/ui/tokens, DTCG), the kit's window pieces (View, Split, List, Panes, Stat, Chart, DataGrid, Text, Stack, Inline), the five reference windows, the rules settled for insets, bars, tables, charts and lists, how to measure a layout, and how Magic's widgets follow it. Use when adding or changing a window's layout, spacing, toolbar, footer, empty or error state, table, chart or list; when adding or changing a design token; when a stylesheet test (design-css, tokens) fails; when migrating a window off its own CSS; and when changing what Magic's prompt says about how widgets look.
---

# Window design

Every window in cmd, built-in or made with Magic, is drawn from one set of design tokens and a few window pieces in `@cmd/ui`. This skill is how to use them and the rules they encode. Research and history: `docs/40-window-design.md`. To iterate on a layout with the user's eye on it, use the **prototype** skill (the Workbench); this skill says what the result should be.

## The system

- **Tokens** (`packages/ui/tokens/*.tokens.json`, DTCG 2025.10, tied together by `cmd.resolver.json`): every colour, size, space, radius and duration, each with a `$description` that says when to use it. `pnpm tokens` builds them into `packages/ui/src/tokens.css`, `tokens.gen.ts` (scales as types: `SpaceName`, `TextSize`, `RadiusName`; `LIGHT_VARS`; `TOKENS`, a manifest of all of them) Read the generated `tokens.css`: it is the reference, each token commented with its rule.
  - `theme.tokens.json` documents what each theme sets at runtime (`--well`, `--ink`, `--accent`, `--chart-1…6`…); everything else derives from those, so it follows any theme, a person's own included.
  - A new value a view needs becomes a token (with a description), never a literal in the view.
- **Window pieces** (`packages/ui/src/frame.tsx`, `chart.tsx`, styles in `frame.css`):
  - `View`: a window's content: `toolbar` (a `WindowToolbar`), the body, `footer` (a `StatusLine`), `state` (loading, empty, no results, error; replaces the body). `inset` pads the body; leave it off for content that runs edge to edge (a table, a list, media).
  - `Split`: a sidebar (`side="start"`) or an inspector (`side="end"`), resizable between min/ideal/max, hidden below the regular size (600px). Offer what it held another way there: `<Hide above="regular">` around a `ToolbarMenu` in the toolbar (the SQLite window's table menu).
  - `List`: one list for every window (a sidebar, things to run, records), in a View without `inset`: `ListSection` (a heading and its rows, collapsible; `role`/`aria-*` pass through, the Navigator's trees), `ListGroup` (rows without a heading: a main action), `ListRow`. Sections stand apart by `--section-gap` after an open one; collapsed ones stack. `nav` only for the pages beside a page (Settings' sidebar: pills on the inset).
  - `Panes` / `Pane`: a dashboard's sections, one column, two from 720px.
  - `DataGrid`: tables. Columns as data: `grow` (takes the leftover width), `align: "end"` (numbers), `hide: "narrow" | "regular"` (dropped as space runs out), `icon` (hugs a dot or icon). `selected` / `onRowClick` for an inspector. `rowInfo(i)` makes a row a section heading (`heading`: its cells are the section's name and totals; not selectable) or a nested row (`depth`, `expanded` + `onToggle` draw a disclosure in the first non-icon column); `onRowDoubleClick` opens a row. Task Manager uses all three.
  - `Stat`, `Chart` (line, area, bar), `Sparkline`, `Legend`: series take `--chart-N` in order.
  - `TitleBand` and `Page`: a window of its own with forms (Settings). `TitleBand` is the band under the traffic lights (`--titlebar-h`), the window drags by it: give it a `title` as a View's `toolbar` (the page's name, large, with a `line` once the body scrolls: `View onScroll`), or none at the top of a sidebar. `Page` is the column of `FormSection`s in a padded View, centred past `--page-w`. Under a section, `FormActions` (Restore Defaults; a `hint` at the left). Controls for it: `ShortcutField` (key caps to record, remove, add), `QrCode`. `Text select` is a value to copy (a path, a pid).
  - `Dial`: a value to read across the room in a ring of what's left (the Timer): as large as the view allows, click to edit (`onEdit`, `edit`); tones accent, needs, dim.
  - `Diff`: a file's changed lines in the git colours, under its `ListRow` past the disclosure (Live Diff). `Stage`: media that fills the view on the scrim, its one child stretched (YouTube's player, the Visualizer).
  - `ListRow` is built from slots, in order: a `Twisty` or `TwistySpace`, `ListRowIcon` (`icon`, `light`, `tone`), `ListRowContent` (`title`, then `place`, dim, giving way first as the row narrows; or `detail`, a second line that makes the row two lines tall; `tone="needs"` colours it; `mono`), `ListRowEnd` (chips, ages, `ListValue`s), `ListRowActions` (shown on hover, in place of a chip). The row itself takes `selected`, `active`, `dim`, `depth`, the handlers, `role`/`aria-*`. A file's row is its name with its folder as `place`.
  - `Tree`, `TreeRow`, `TreeHeader`, `TreeRename`: files and folders (the Files window and sidebar): disclosure, icon, name, git mark (`tone`), size and date (dropped when narrow), a dense sidebar version with guides, sortable column heads, rename in place, drop targets. A focused selection is the accent with `--on-accent` on it. States go inside the `Tree` (it still takes drops).
  - `WebStage`: a web page (the Browser): on white, faded in once painted; a device's page lifted with its caption; a `cover` state over the page.
  - `Mark` (the icon that gives way to a status light) also goes in a table cell (Resources); `TwistySpace` holds a disclosure's place. `LiveBadge`: a device on a window, its note fading (`--dur-note`). `IconButton` takes `tone` and `pulse`. A `Dialog` dressed as a window takes `window.status` at its title bar's right.
  - `Thumb`: a small screenshot at a row's start (first in a `ListRow`), a placeholder without one. `WebStage` also hosts an `iframe` (a frame widget).
  - `Document`: a reading column for rendered Markdown or HTML, in the person's text and code fonts (the Markdown window).
  - `Viewport` (pan and zoom a picture: grab cursors, a loading cover; the view zooms) and `Picture` (a checkerboard behind transparency, crisp pixels far in): the Image window. Third-party markup (pdf.js) keeps a small stylesheet of its own, on tokens.
  - `Ribbon` (bars between two times on lanes, hour ticks) and `Timeline` / `TimelineEntry` (a time, a mark on a rail, the entry), marks in a hue with `--mark` (the Journal).
  - `Text` alone on a line in a `Stack` is a paragraph (line height 1.45, even wrapping); in an `Inline` it is a run of text.
  - `Stack`, `Inline`, `Tiles`, `Text`, `Measure` (a reading column), `MediaStage`, `Filmstrip`.
  - `Hide below | above="narrow" | "regular"`: what gives way as a window narrows, or what only shows when it's narrow. A window's sizes are narrow (< 360px), regular (< 600px) and wide; everything that follows the width uses these two breakpoints. Works in the toolbar too (a `View` is a size container).
  - Gaps and paddings take only steps of the spacing scale, multiples of 4px (`gap={2}` is 8px, `pad={1.5}` 6px; docs/46-spacing.md), checked by the types. A pane's padding at a window's edge is `pad="inset"`.
- **Reference windows** (`apps/desktop/src/renderer/src/reference/*.story.tsx`, `pnpm workbench reference/<name>`, in the UI Workbench): the spec for each kind of window, every state and size included. Start from the closest one:

  | Story | For | Example windows |
  |---|---|---|
  | `datawindow` | rows of records: filter bar, table, inspector, footer | SQLite, Task Manager, Events |
  | `chartwindow` | watching numbers: status line, stats, charts, a short table | Resources, Agent Activity |
  | `contentwindow` | text to read: outline sidebar, reading column | Markdown, Journal, What's New |
  | `mediawindow` | one picture or video: stage, filmstrip, info inspector | Image, PDF, YouTube |
  | `actionswindow` | things to run: main action first, then sections | Workspace Actions, Commands |
  | `settingswindow` | forms: a sidebar of pages, a title band, sections of rows | Settings |

## Rules

Each was settled by measuring in the UI Workbench; keep them unless the user changes one, and then change it here too.

- **One inset, on every side, to the letters.** Content sits `--inset` (16px) from the window's edges: padded bodies, a table's first and last column, list rows' content. Bars sit tighter, at `--bar-inset` (12px): the window's title bar, the footer's text, Magic's toolbars. A title band's heading is content: it stays on `--inset`, over the page. A `Page` (Settings beside its sidebar) doubles it: its View takes `--page-inset` (32px) as `--inset`. A pane of a `Split` (an inspector, a settings sidebar) pads with `Stack pad="inset"`, never a step of the scale, so it moves with the inset. Components read roles, not steps, where one exists (docs/46-spacing.md): `--inset`, `--bar-inset`, `--page-inset`, `--list-pad` (inside a row's highlight; `--list-inset` is `--inset` less it), `--list-gap`, `--list-icon-gap`, `--section-gap`, `--heading-gap`, `--dialog-pad`, `--toolbar-pad`. Top as well as sides: a body that opens with a line of text trims its leading (`text-box: trim-start`, done by `View` and padded `Stack`s), so the letters, not the line box, sit at the inset.
- **A row that holds controls is a toolbar.** Filters, ranges, view switches and actions go in the `WindowToolbar`, not in a line inside the content. The body opens with content.
- **Players put their controls under the media.** A video's (or a sound's) transport is a `WindowToolbar bottom` with an inline `Scrubber` between its times, where people look for it in every player; its other controls (speed, loop, trim) share that bar, and there is no toolbar on top (Jan, 2026-10-10).
- **Footers are quiet.** One line in `--text-faint`, the same top line as the toolbar (`--window-edge`), centred between that line and the window's outline.
- **Bars share their lines.** Toolbar and footer use `--window-edge`, like the title bar and the outline.
- **Toolbar items sit tighter than the content** (the `WindowToolbar` pads 6px: fields and pressed buttons 6–8px from the edge, icons ~10px), unlike everything else at `--inset`. Left as it is for now (2026-10-09); the audit reports it without flagging it. If it changes, it changes in the kit's toolbar, for every window.
- **Scrollbars never take room.** They float over the content (`installScrollbars`); nothing compensates for them.
- **Tables** run edge to edge with their edge columns on the inset and 16px between columns (`--grid-pad` twice); an icon column hugs its icon. Least important columns drop as the window narrows (`hide`).
- **Charts** line up on the left with their pane's title; the y axis sits on the right, right-aligned with the pane's unit (as Swift Charts does); no labels over the data, none on the baseline. A legend only for more than one series.
- **One list.** Things to run, a sidebar, records: the same `List`, so they line up wherever they sit side by side. Sections apart, no boxes around them; rows highlight as pills on hover.
- **No boxes in the box.** The window is the frame: don't wrap a section, list or table in a card.
- **States replace the body**: `View state={…}`: loading, empty (with what to do), no results (with a way back), error (plain words and Try Again). Never a spinner placed by hand. Their titles and texts are centred and wrap balanced (`text-wrap: balance`, a width in characters), titles in sentence case; the icon is small (`ICON.empty`, 20px) in `--text`, the error's too. `States.story.tsx` shows them, short and long, at three widths.

## Building or changing a window

1. Pick the reference window closest to it and copy its structure: `View` → `Split`/`List`/`Panes` → kit components. No view CSS: if the kit lacks something, add it to the kit (documented in JSDoc, shown in a story beside it), using tokens.
2. Put it in a story beside the component with every state reachable and an `AllSizes` variant (`RefWindow.tsx` has the frame and stand-in data helpers).
3. Measure, don't eyeball (below), in a dark and a light theme, and at narrow, regular and wide.
4. `pnpm typecheck && pnpm test`: `tokens.test.ts` (generated files current; every variable the kit's CSS reads exists) and `design-css.test.ts` (no new literal colours, font sizes, radii or spacing; see below).

## Measuring

Shots catch what is wrong; numbers say by how much. `pnpm workbench audit <story> [variant] [--theme id]` measures every window in a story: the body's top, left and right to the nearest visible text, icon or drawing (clipped to what shows), and the toolbar's and footer's items to what's visible (a field's box, a borderless button's icon). It flags a body whose left and right differ (unless it holds a table, list, reading column, media or split, which have their own insets) and a footer whose text isn't at `--bar-inset`, and exits 1 then. Toolbars are reported only (see Rules). The UI Workbench's ruler button draws the same measurements over the stage, live (`renderer/src/workbench/audit.ts` is the one copy). Run it after every layout change, at every size (the `Sizes` variant); `pnpm workbench audit --all` walks every story and its `Sizes`, prints only problems and exits 1 on one: run that before handing back.

For anything it doesn't cover, run JS in the UI Workbench (`pnpm workbench eval`; code with `;` needs an explicit `return`):

```js
// The insets of each window body in the current story: to the nearest visible element on each side.
return [...document.querySelectorAll(".ui-view-body")].map(function (body) {
  var b = body.getBoundingClientRect(), t = 1e9, l = 1e9, r = -1e9;
  body.querySelectorAll("*").forEach(function (e) {
    if (e.children.length && !(e instanceof SVGElement)) return;
    var x = e.getBoundingClientRect();
    if (x.width < 1 || x.height < 1) return;
    t = Math.min(t, x.top); l = Math.min(l, x.left); r = Math.max(r, x.right);
  });
  return Math.round(b.width) + "px wide: top " + Math.round(t - b.top) + ", left " + Math.round(l - b.left) + ", right " + Math.round(b.right - r);
}).join("\n");
```

For text, measure ink, not boxes: a `Range` over a text node gives its line box; to compare letters with edges, crop a 2× shot and scan pixel rows (Pillow), as the footer's centring was checked (equal rows above and below the text).

## Tokens: adding or changing one

- Edit the `*.tokens.json` file of its kind, with a `$description` that says when to use it, then `pnpm tokens`. Names are their paths joined with `-` (`control.h.sm` → `--control-h-sm`; `$root` is the group's own name).
- Derived colours are a reference plus `org.cmd.mix` (`{ "space": "srgb", "amount": 0.06, "with": "transparent" }`), so they follow every theme. Values the format can't express use `org.cmd.css` (raw CSS); keep those few.
- Light themes override in `appearance-light.tokens.json`, reduced motion in `motion-reduced.tokens.json`; both only override what the base set has.
- Renaming a token means changing every reader (`grep -r -- --old-name packages apps`); the tokens test fails on kit CSS that reads a variable nothing defines.

## Design debt

`apps/desktop/test/design-css.test.ts` counts the literal colours, font sizes, radii and spacings left in every stylesheet (`packages/ui/src`, the renderer) against `design-debt.json`. Adding one fails with the declaration; use a token. Removing some fails until `pnpm design-debt` writes the lower count, which belongs in the same commit. Hairlines (1px) and 0 don't count. Migrating a window is mostly this: move it onto the kit's pieces, delete its CSS, lock in the lower numbers.

## Magic widgets

Widgets made with Magic are packages (docs/56): their views are trees of the kit's own components, drawn by the app through the element table (`windows/package/elements.tsx`), so they follow these rules and every token change at once. There are no kit versions any more: the CSS kit (`k-*` classes), its versions (`kits/1.css`, `kits/2.css`, kit 3) and the frame's generated `tokens.css` were deleted with the cmd:2 runtime in phase 2b; a person's old widgets were moved to `$CMD_HOME/widgets-old`.

- What the model is told about how widgets look is the prompt (`packages/core/src/magic/prompt/prompt.md`, "Writing the UI") and the example packages (`prompt/examples/`): when a rule here changes, change it there.
- A widget gets a component the kit lacks only through the kit: add it to `@cmd/ui`, then to the element table and protocol's `widget-tree.ts` (docs/56, "Elements": a minor of the API).
- A frame widget (`"surface": "frame"`, pixels only) draws its own page in the one frame host; it reads the theme's variables, never a kit.
- Check a widget's look with the edit view's screenshots, `pnpm cmd magic` (the lab writes `preview.png`), or the Workbench (`pnpm workbench widgets/elements`).

## Don't

- Don't write literal colours, font sizes, radii or spacing in a stylesheet or a `style={…}`; don't invent a value the scale lacks: add a token.
- Don't add margins to kit components or wrap content in cards to space it; spacing belongs to `Stack`, `Inline`, `View` and the scales.
- Don't place controls in the body, a spinner by hand, or a second toolbar.
- Don't compensate for scrollbars (gutters, padding maths): they float.
- Don't edit `tokens.css` or `tokens.gen.ts`: they're generated.
