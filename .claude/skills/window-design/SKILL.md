---
name: window-design
description: Design or build the inside of any cmd window or widget so it matches the rest: a built-in window type, a React widget, a sidebar or inspector, a dashboard, a table, a list of things to run, a document or media viewer, or the Magic kit and prompt that AI-made widgets use. Covers the design tokens (packages/ui/tokens, DTCG), the kit's window pieces (View, Split, List, Panes, Stat, Chart, DataGrid, Text, Stack, Inline), the five reference windows, the rules settled for insets, bars, tables, charts and lists, how to measure a layout, and Magic's kit versions. Use when adding or changing a window's layout, spacing, toolbar, footer, empty or error state, table, chart or list; when adding or changing a design token; when a stylesheet test (design-css, tokens) fails; when migrating a window off its own CSS; and when changing Magic's kit.css, prompt or kit versions.
---

# Window design

Every window in cmd, built-in or made with Magic, is drawn from one set of design tokens and a few window pieces in `@cmd/ui`. This skill is how to use them and the rules they encode. Research and history: `docs/40-window-design.md`. To iterate on a layout with the user's eye on it, use the **prototype** skill (the Workbench); this skill says what the result should be.

## The system

- **Tokens** (`packages/ui/tokens/*.tokens.json`, DTCG 2025.10, tied together by `cmd.resolver.json`): every colour, size, space, radius and duration, each with a `$description` that says when to use it. `pnpm tokens` builds them into `packages/ui/src/tokens.css`, `tokens.gen.ts` (scales as types: `SpaceName`, `TextSize`, `RadiusName`; `LIGHT_VARS`; `TOKENS`, a manifest of all of them) and the Magic frame's `tokens.css` and `preview-themes.json`. Read the generated `tokens.css`: it is the reference, each token commented with its rule.
  - `theme.tokens.json` documents what each theme sets at runtime (`--well`, `--ink`, `--accent`, `--chart-1…6`…); everything else derives from those, so it follows any theme, a person's own included.
  - A new value a view needs becomes a token (with a description), never a literal in the view.
- **Window pieces** (`packages/ui/src/frame.tsx`, `chart.tsx`, styles in `frame.css`):
  - `View`: a window's content: `toolbar` (a `WindowToolbar`), the body, `footer` (a `StatusLine`), `state` (loading, empty, no results, error; replaces the body). `inset` pads the body; leave it off for content that runs edge to edge (a table, a list, media).
  - `Split`: a sidebar (`side="start"`) or an inspector (`side="end"`), resizable between min/ideal/max, hidden below the regular size (600px). Offer what it held another way there: `<Hide above="regular">` around a `ToolbarMenu` in the toolbar (the SQLite window's table menu).
  - `List` (`variant="plain"`: rows edge to edge, as a sidebar; `"grouped"`: indented sections, for things to run or change), with `ListSection`, `ListRow`, `ListGroup`.
  - `Panes` / `Pane`: a dashboard's sections, one column, two from 720px.
  - `DataGrid`: tables. Columns as data: `grow` (takes the leftover width), `align: "end"` (numbers), `hide: "narrow" | "regular"` (dropped as space runs out), `icon` (hugs a dot or icon). `selected` / `onRowClick` for an inspector.
  - `Stat`, `Chart` (line, area, bar), `Sparkline`, `Legend`: series take `--chart-N` in order.
  - `Document`: a reading column for rendered Markdown or HTML, in the person's text and code fonts (the Markdown window).
  - `Viewport` (pan and zoom a picture: grab cursors, a loading cover; the view zooms) and `Picture` (a checkerboard behind transparency, crisp pixels far in): the Image window. Third-party markup (pdf.js) keeps a small stylesheet of its own, on tokens.
  - `Ribbon` (bars between two times on lanes, hour ticks) and `Timeline` / `TimelineEntry` (a time, a mark on a rail, the entry), marks in a hue with `--mark` (the Journal).
  - `Text` alone on a line in a `Stack` is a paragraph (line height 1.45, even wrapping); in an `Inline` it is a run of text.
  - `Stack`, `Inline`, `Tiles`, `Text`, `Measure` (a reading column), `MediaStage`, `Filmstrip`.
  - `Hide below | above="narrow" | "regular"`: what gives way as a window narrows, or what only shows when it's narrow. A window's sizes are narrow (< 360px), regular (< 600px) and wide; everything that follows the width uses these two breakpoints. Works in the toolbar too (a `View` is a size container).
  - Gaps and paddings take only the spacing scale's names (`gap="md"`), checked by the types.
- **Reference windows** (`apps/desktop/src/renderer/src/reference/*.story.tsx`, `pnpm workbench <story>`): the spec for each kind of window, every state and size included. Start from the closest one:

  | Story | For | Example windows |
  |---|---|---|
  | `datawindow` | rows of records: filter bar, table, inspector, footer | SQLite, Task Manager, Events |
  | `chartwindow` | watching numbers: status line, stats, charts, a short table | Resources, Agent Activity |
  | `contentwindow` | text to read: outline sidebar, reading column | Markdown, Journal, What's New |
  | `mediawindow` | one picture or video: stage, filmstrip, info inspector | Image, PDF, YouTube |
  | `actionswindow` | things to run: main action first, grouped list | Workspace Actions, Commands |

## Rules

Each was settled by measuring in the Workbench; keep them unless the user changes one, and then change it here too.

- **One inset, on every side, to the letters.** Content sits `--inset` (12px) from the window's edges: padded bodies, a table's first and last column, list rows' content, the footer's text. Top as well as sides: a body that opens with a line of text trims its leading (`text-box: trim-start`, done by `View` and padded `Stack`s), so the letters, not the line box, sit at the inset.
- **A row that holds controls is a toolbar.** Filters, ranges, view switches and actions go in the `WindowToolbar`, not in a line inside the content. The body opens with content.
- **Footers are quiet.** One line in `--text-faint`, the same top line as the toolbar (`--window-edge`), centred between that line and the window's outline.
- **Bars share their lines.** Toolbar and footer use `--window-edge`, like the title bar and the outline.
- **Toolbar items sit tighter than the content** (the `WindowToolbar` pads 6px: fields and pressed buttons 6–8px from the edge, icons ~10px), unlike everything else at `--inset`. Left as it is for now (2026-10-09); the audit reports it without flagging it. If it changes, it changes in the kit's toolbar, for every window.
- **Scrollbars never take room.** They float over the content (`installScrollbars`); nothing compensates for them.
- **Tables** run edge to edge with their edge columns on the inset and 16px between columns (`--grid-pad` twice); an icon column hugs its icon. Least important columns drop as the window narrows (`hide`).
- **Charts** line up on the left with their pane's title; the y axis sits on the right, right-aligned with the pane's unit (as Swift Charts does); no labels over the data, none on the baseline. A legend only for more than one series.
- **Lists of things to run** are grouped: sections apart, rows indented, no boxes around them; rows highlight as pills on hover. Lists that are navigation (a sidebar) stay plain.
- **No boxes in the box.** The window is the frame: don't wrap a section, list or table in a card.
- **States replace the body**: `View state={…}`: loading, empty (with what to do), no results (with a way back), error (plain words and Try Again). Never a spinner placed by hand. Their titles and texts are centred and wrap balanced (`text-wrap: balance`, a width in characters), titles in sentence case; the icon is small (`ICON.empty`, 20px) in `--text`, the error's too. `States.story.tsx` shows them, short and long, at three widths.

## Building or changing a window

1. Pick the reference window closest to it and copy its structure: `View` → `Split`/`List`/`Panes` → kit components. No view CSS: if the kit lacks something, add it to the kit (with a gallery specimen), using tokens.
2. Put it in a story beside the component with every state reachable and an `AllSizes` variant (`RefWindow.tsx` has the frame and stand-in data helpers).
3. Measure, don't eyeball (below), in a dark and a light theme, and at narrow, regular and wide.
4. `pnpm typecheck && pnpm test`: `tokens.test.ts` (generated files current; every variable the kit's CSS reads exists) and `design-css.test.ts` (no new literal colours, font sizes, radii or spacing; see below).

## Measuring

Shots catch what is wrong; numbers say by how much. `pnpm workbench audit <story> [variant] [--theme id]` measures every window in a story: the body's top, left and right to the nearest visible text, icon or drawing (clipped to what shows), and the toolbar's and footer's items to what's visible (a field's box, a borderless button's icon). It flags a body whose left and right differ (unless it holds a table, list, reading column, media or split, which have their own insets) and a footer whose text isn't at `--inset`, and exits 1 then. Toolbars are reported only (see Rules). Run it after every layout change, at every size (the `Sizes` variant).

For anything it doesn't cover, run JS in the Workbench (`pnpm workbench eval`; code with `;` needs an explicit `return`):

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

Widgets made with Magic share the tokens through **kit versions** (`KIT_FILES` in `packages/protocol/src/magic.ts`). A widget's `manifest.json` pins its kit (`"kit"`; absent: 1), so changing the kit never changes a widget nobody asked to change.

- **Kit 1** (`packages/core/src/magic/prompt/kits/1.css`) is Magic's kit before the tokens, frozen: a test pins its hash. Never edit it.
- **Kit 2** (current) is the generated `prompt/tokens.css` plus `prompt/kit.css`, the app's tokens and the rules above in `k-*` classes. Fixes to kit.css are fine while it is current; a change that would alter how existing kit-2 widgets lay out is a new version: copy the current CSS to `kits/2.css`, point `KIT_FILES[2]` at it, add the next version, bump `CURRENT_KIT`, write a rename table if names change (like `KIT1_RENAMES`), and pin kit 2's hash in `kits.test.ts`.
- New widgets get the current kit (Magic's write tool fills it in and keeps a widget's kit on rewrites); a change to an older widget asks the model to move it up (`kitMove` in `magic/prompt.ts`), and the lint names old variables left behind.
- The prompt (`prompt/prompt.md`, "How cmd looks", "Layout", "The kit") states these rules for the model in the kit's terms; when a rule here changes, change it there, and in the examples (`prompt/examples/`).
- Check a kit change with `pnpm cmd widget preview <dir>` on copies of the examples (dark, light, small, wide), before and after.

## Don't

- Don't write literal colours, font sizes, radii or spacing in a stylesheet or a `style={…}`; don't invent a value the scale lacks: add a token.
- Don't add margins to kit components or wrap content in cards to space it; spacing belongs to `Stack`, `Inline`, `View` and the scales.
- Don't place controls in the body, a spinner by hand, or a second toolbar.
- Don't compensate for scrollbars (gutters, padding maths): they float.
- Don't edit `tokens.css`, `tokens.gen.ts`, the Magic frame's `tokens.css` or `preview-themes.json`: they're generated.
- Don't edit `kits/1.css`, or change kit 2 in a way that moves existing widgets: version it.
