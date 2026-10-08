# JSON viewer

> Status (2026-10-08): **plan**, nothing built. Branch `json-viewer` (worktree `~/src/cmd-json-viewer`).

A window that shows a `.json` file as a collapsible tree, live like the Markdown window, with ⌘E switching the same window to the text editor and back. Read first: this doc; docs/09-window-types.md; the Markdown window it copies (`packages/core/src/windows/builtin.ts` `markdownType`, `apps/desktop/src/renderer/src/windows/markdown.tsx`, `markdown-view.tsx`).

## What exists

The Markdown window (commit `15ff1ab`) is the template, and almost everything it needed is already general:

- **Core type** (`markdownType`, `builtin.ts`): `opens: { extensions: [...], priority: 10 }` beats `textType`'s extension match for the same files; `create`/`update` keep `{ path }`. Nothing else in the core knows it exists.
- **Switching type in place**: `window.update` takes `kind` (`windows/manager.ts` `update`), keeping id, slot and size. Any type but terminal can be the target.
- **⌘E** is `view.toggleEdit` (`shared/commands.ts`, "Toggle Preview / Edit"). `App.tsx` runs the window's own `windowActions.toggleEdit` if it registered one, else `toggleMarkdownEdit(w)` (`windows/markdown.tsx`), which hard-codes markdown ⇄ text and the `.md` check. The text window's menu has "Preview (⌘E)" behind the same `.md` regex (`windows/builtin.tsx`).
- **Live reload**: `fs.read` + `fs.watch` + `onFsChanged`, re-render in the same scroll container so the position holds.
- **Find**: `domFindable` (`find-dom.ts`) finds over rendered DOM text with the CSS Custom Highlight API; `useFind` + `registerWindowActions({ find })` wires ⌘F.
- **Status**: `setWindowStatus` ("1,234 words").
- **Reveal**: text windows take `state.reveal = { line, column, at }` and scroll there (`TextView.tsx`), used by search. This is how "edit here" can land on the right line.
- **Highlighting**: `editor/syntax.ts`'s `syntax` palette, already mounted for static use by the Markdown view.
- **Size limits**: `fs.read` returns at most 5 MB (`READ_MAX`, `manager.ts`) with `truncated`; routing sends files over 10 MB to the default app (`TEXT_MAX_BYTES`).
- **Tree rows**: Files (`FilesView.tsx`) draws a tree with `role="treeitem"`, `--depth`, a twisty button and `ICON.disclosure`; the kit has `Twisty` (`packages/ui/src/list.tsx`).

## What it does

- `.json` (and `.geojson`, `.har`, `.webmanifest`, `.jsonc` with comments stripped) opens in a **JSON** window by default; `open.handlers` (`json: text`) sends them to the editor instead, as with Markdown.
- **Tree**: objects and arrays collapse; each row shows key, value (strings quoted and in the string colour, numbers, booleans, `null` in the syntax palette's colours), and for a collapsed container its size (`{12}`, `[340]`). Top two levels open on first load; open state survives reloads (kept by JSON pointer, in view state, not in the core).
- **Keyboard**: ↑↓ move, ←→ collapse/expand (→ on an open node goes to its first child), ⌥-click or ⌥→ expands everything below, Enter/⌘E on a row opens the editor at that row's line.
- **Copy**: right-click a row → Copy Value (pretty JSON for containers), Copy Key, Copy Path (`$.items[3].name`, also JSON pointer `/items/3/name` as a second entry). ⌘C copies the selected row's value.
- **Find** (⌘F): over keys and values of the whole document, not only what is expanded: a match inside a collapsed node opens its ancestors.
- **Live**: file changes re-parse and re-render; open state and selection kept by path.
- **Invalid JSON**: show the parse error with line and column in an `EmptyState`/`Callout` and a button "Edit at Line N" that switches to the editor with `reveal` there. While an agent writes a file it can be invalid for a moment: keep the last good tree under a small "Can't read this version" banner rather than flashing an error.
- **Status**: `340 items · 1.2 MB` (top-level count and size); "Edited" isn't needed, the view is read-only.
- **JSON Lines** (`.jsonl`, `.ndjson`): later, not phase 1. They stay in the editor until then (each line a top-level row is the obvious shape).

## ⌘E: generalise the toggle

Today `toggleMarkdownEdit` knows one pair. Replace it with a small table so JSON (and later CSV, SVG, …) are one entry each:

```ts
// windows/preview.ts
/** A preview kind and the files it previews; ⌘E switches between it and the text editor. */
const previews: { kind: string; ext: RegExp }[] = [];
export function registerPreview(kind: string, ext: RegExp): void;
export function previewFor(path: string): string | undefined;   // text → which preview
export function togglePreview(win, reveal?): boolean;            // preview ⇄ text, same window
```

- `markdown.tsx` calls `registerPreview("markdown", /\.(md|markdown|mdx)$/i)`, `json.tsx` `registerPreview("json", /\.(json|jsonc|geojson|har|webmanifest)$/i)`.
- `App.tsx`'s `view.toggleEdit` and the text window's "Preview (⌘E)" menu entry use `togglePreview`/`previewFor` instead of the regex.
- **Which line**: from the JSON view, the switch passes `reveal` for the selected row (the view knows each node's source offset, below), so ⌘E on `items[3].name` lands the cursor on that line. Back from the editor to the tree, select the node at the cursor: the text view needs to expose its cursor offset through a window action (`windowActions(id).cursor?.()`), read before the switch and passed as `state.select` to the JSON window. Markdown can use the same later (scroll to the heading above the cursor).
- Settings: none. Whether `.json` opens as tree or text is `open.handlers`.

## Parsing with positions

`JSON.parse` loses where each value came from, which "edit at this row", errors and reveal need. Options:

1. **Lezer's JSON grammar** (`@lezer/json`, already in the lockfile through `@codemirror/language-data`'s `lang-json`): parse once, walk the syntax tree into nodes `{ key, kind, from, to, children }`. Error-tolerant, gives positions, same parser the editor uses for highlighting. Values read with `JSON.parse` on each scalar's slice.
2. A hand-written recursive-descent parser with offsets (~150 lines), strict and fast, exact error messages.
3. `JSON.parse` for values plus a second pass for offsets.

Recommend **1** for the tree and positions, and `JSON.parse` once for the "is it valid" verdict and its error message (V8's message has the position). Measure on a 5 MB file before deciding; if the Lezer walk is slow, parse in a worker (the file is already read in the renderer; a worker keeps a 5 MB parse off the UI thread).

`.jsonc`: Lezer's JSON grammar has no comments, so strip `//` and `/* */` outside strings first (keeping offsets: replace with spaces).

## Rendering large files

A 5 MB file can be 200k nodes. Render only **visible rows**: flatten the open part of the tree into a row list (like `FilesView`'s `rows`) and virtualise it (fixed row height, render the window plus a margin). Collapsed containers cost nothing. Find works on the flat node list, not the DOM, so it can't use `domFindable` as is: implement a `Findable` over nodes (match → expand ancestors → scroll the row in → highlight the range inside the row). Files over 5 MB arrive truncated: show "Too large to show as a tree" with Edit and Open with Default App, as the text window does for read-only.

Long strings: one line, ellipsised, full value on hover tooltip and in Copy Value. Very long arrays: show the first 1000 children and a "Show 9,000 more" row.

## Pieces

| Where | What |
|---|---|
| `packages/core/src/windows/builtin.ts` | `jsonType`: kind `json`, title "JSON", icon `curlybraces`, `opens: { extensions: ["json", "jsonc", "geojson", "har", "webmanifest"], priority: 10 }`, `create`/`update` like `markdownType` plus optional `select` (a JSON pointer, set by ⌘E from the editor). Register in `registerBuiltins`. |
| `renderer/src/windows/preview.ts` | `registerPreview`, `previewFor`, `togglePreview` (replaces `toggleMarkdownEdit`). |
| `renderer/src/windows/json.tsx` | `registerWindowView({ kind: "json", View: lazyView(...) })`, `describe` (place = folder), menu: Edit (⌘E), Expand All, Collapse All, Copy Path, Open with Default App. `registerPreview("json", …)`. |
| `renderer/src/windows/json-view.tsx` | The view: load/watch (as `MarkdownView`), parse, flat rows, virtual list, keyboard, context menu, find, status. Lazily loaded. |
| `renderer/src/windows/json-parse.ts` | Source → node tree with offsets; error with line/column; JSON path/pointer helpers. Pure, unit-tested. |
| `renderer/src/windows/builtin.tsx`, `App.tsx` | Use `previewFor`/`togglePreview`. |
| `renderer/src/components/TextView.tsx` | Window action `cursor()` (offset/line) for ⌘E back to the tree. |
| `styles.css` | `.json-scroll`, `.json-row` (indent by `--depth`, same metrics as `.file-row`), value colours from `syntax.ts`'s palette tokens, no literal colours. |
| `packages/core/test/windows.test.ts` | `.json` resolves to `json`; `json: text` override; `window.update` kind json ⇄ text. |
| `apps/desktop/test/json-parse.test.ts` | Offsets, nesting, errors, jsonc comments, pointers with `~0`/`~1` escapes. |
| `e2e/smoke.mjs` | A fixture `.json` opens as a tree, a row expands, ⌘E shows the editor at that line, ⌘E back, an edit to the file re-renders. |
| `docs/09-window-types.md` | Mention previews and `registerPreview` next to the Markdown example. |
| README | JSON windows in the feature list; ⌘E description becomes "Markdown and JSON". |

Copy (tooltips, menu items, errors) through the copywriting skill.

## Phases

1. **Generalise ⌘E** (`preview.ts`), Markdown on it, no behaviour change. Small, mergeable alone.
2. **JSON window**: core type, parser with offsets, tree with virtual rows, keyboard, live reload, invalid-file state, ⌘E both ways with reveal/select, copy entries, status. Tests and e2e.
3. **Find** over nodes.
4. Later: JSON Lines; a filter field (`items[*].name`, jq-like) in the toolbar; schema hints; the same preview pattern for CSV (table) and SVG.

## Open questions

- Should **API responses** in the browser (a URL returning `application/json`) open here too? It would need the core to fetch, or the browser view to hand its body over. Out of scope for now; worth it if people use cmd's browser for local dev servers.
- Should the tree be **editable** (rename a key, change a value inline)? Recommend no: ⌘E is one key away and the editor has undo, find/replace and save conflicts handled. Revisit if people ask.
- Default **expand depth**: two levels, or "open until 50 rows are visible"? Try both on real files (package.json, a HAR, a Claude transcript line).
