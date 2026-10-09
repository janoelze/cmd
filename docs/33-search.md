# Search

> Status (2026-10-08): **phases 1–4 built in their first form.** The palette's search (⇧⌘F) finds the workspace's files live (names and lines, `search/files.ts`: ripgrep, else git; the Home workspace searches the selected window's project), past sessions, commands by their line and output (`search.history`; output indexed from now on and once at startup for older commands), pages and files opened in cmd, each kind under its name; a line opens its file there (`reveal` on text windows). Not yet: ripgrep bundled with the app (it uses the system's `rg`, else `git grep` in repositories), `in:`/`kind:`/`since:` words, sessions `claude -p` ran left out. Before that (2026-10-07): **phase 1 built** (branch `search-design`): the kit's `FindBar`, `Glyph` and `Highlight`; `useFind` (`renderer/src/find.tsx`) in terminals (floating), text windows (CodeMirror's panel replaced, replace on ⌥⌘F), PDF, browser pages (`findInPage`), Markdown previews and Files (`find-dom.ts`, the CSS Custom Highlight API); Use Selection for Find (no shortcut: ⌘E is Toggle Preview / Edit); a shared last query for ⌘G; Find disabled where a window can't. Search in the palette: "Search…" (⇧⌘F, a magnifier in the top bar) opens it with `?`, open windows above past sessions; no Search view of its own. Not yet: Magic widgets (needs find in the widget runtime, `host.js`, over postMessage), phases 2, 4, 5 and the rest of 3. A user asked for full-text search. cmd has two kinds of search today, built separately and unevenly: find in a window (⌘F) and past-session search (⇧⌘F). This doc makes them one story with two keys, extends ⇧⌘F to everything cmd remembers and to the files in your projects, and says where an index of file contents fits (later, as an accelerator, never as the source of truth). Read first: this doc; `packages/core/src/data/views/search.ts`; `packages/core/src/search/query.ts`; docs/26 (S7, C3) and docs/30 ("Search everything"), which already promise most of it. Work in a worktree with its own `CMD_HOME` (CLAUDE.md).

## What exists

**Find in a window** (⌘F ⌘G ⇧⌘G, `edit.find*`). `findIn` (`renderer/src/App.tsx`) passes the request to the selected window: terminals through `terminals.requestFind`, other types through their `windowActions.find`. Each type does its own thing:

| Window | Find | How |
|---|---|---|
| Terminal | yes | own `FindBar` (`TerminalView.tsx`): `WindowToolbar` + `ToolbarSearchField`, "3 of 12", case and regex toggles, seeded from the selection, incremental. The renderer's scrollback only |
| Text | yes | CodeMirror's stock search panel (`openSearchPanel`): its own look and keys, has replace; only the match colours are ours |
| PDF | yes | own bar in its toolbar (`PdfView.tsx`, pdf.js find controller), counts, no case or word options |
| Browser | **no** | ⌘F does nothing; nothing calls `webContents.findInPage` |
| Markdown preview, Files, Magic, Journal, YouTube | **no** | ⌘F does nothing |

No ⌘E (Use Selection for Find). The menu items are always enabled.

**Session search** (⇧⌘F, `view.search`, "Search Sessions…"):

- The Navigator's field (`components/Navigator.tsx`): filters the open rows (`filterRows`) and, from two characters, 150 ms debounced, asks `search.query` for past sessions; `IndexRing` shows indexing progress.
- The palette's `?query` (`App.tsx` `searchSessions`): a "History" group with highlighted snippets (`\x01…\x02`).
- The CLI: `cmd search <text>`, `cmd resume <id>`.
- The core: `SearchView` (`data/views/search.ts`) over the event log's FTS5 index (`events_fts`, unicode61, contentless), **restricted to `transcript.*` events**. `SearchQuery` (`search/query.ts`): prefix terms, `"phrases"`, `-excluded`, typo tolerance from `events_vocab`. Ranks sessions by best event (bm25, titles weigh more, recency a little), one hit per session, snippet cut from the event's text.

**Indexed but never searched.** Every event with `text` or `body` goes into `events_fts` (`data/store.ts`): commands (`body` is the command line), `browser.visit` (title, address), `file.open` (path), notifications (title, body), agent notes, window titles. Only `data.query {text}` reaches them, as a raw FTS5 `MATCH` without `SearchQuery`'s parsing or typo tolerance. Two things are stored but **not** indexed: a command's output and an agent turn's `agent.output` are blobs (`content`), and `agent.output`'s `text` is only "turn 3: 1200 characters".

**Nowhere:** the contents of files in a project, a file by name, all open terminals at once.

## The story

Two keys, each meaning one thing everywhere, both with the field, the keys and the result rows people know from other Mac apps and editors.

| | ⌘F **Find** | ⇧⌘F **Search** |
|---|---|---|
| Looks in | the selected window, as it is now | everything cmd remembers, and the files in your projects |
| Shows | matches in place, "n of m" | a list of results, grouped by kind |
| Lives | a bar on the window | the command palette in search mode |

### ⌘F: Find in the window

One `FindBar` in `@cmd/ui`, with a gallery specimen: the field, "n of m" / "No matches", previous and next, toggles for Match Case, Whole Word and Regex, ⎋ to close, ↩ / ⇧↩ to step. A window type implements a small interface and gets the bar:

```ts
interface Findable {
  find(query: string, o: { caseSensitive: boolean; wholeWord: boolean; regex: boolean }, dir: 1 | -1, incremental: boolean): void;
  clear(): void;
  /** Results arrive asynchronously (pdf.js, findInPage). */
  onResults(fn: (r: { index: number; count: number }) => void): () => void;
  /** Seed for ⌘E and for opening the bar. */
  selectionText(): string;
}
```

- Terminal and PDF move to the kit's bar (the terminal's is the model).
- Browser: `webContents.findInPage` / `stopFindInPage`, counts from `found-in-page`. New.
- Markdown preview: the DOM, with the CSS Custom Highlight API for matches. New.
- Text: CodeMirror's panel replaced through `search({ createPanel })`, keeping replace (a second row, shown with ⌥⌘F like other Mac editors).
- Files: the bar filters the tree by name (and expands to show matches).
- Magic widgets: the bar runs in the widget's frame (`findInPage` on its webContents).
- ⌘E (Use Selection for Find) everywhere; ⌘G / ⇧⌘G reuse the last query, also in a window that never had the bar open, like macOS's find pasteboard.
- Edit → Find is disabled when the selected window isn't `Findable`, instead of doing nothing.

### ⇧⌘F: Search

The command palette in search mode, not a view of its own (decided 2026-10-07: no specialised search UI). "Search…" in the menu (renamed from "Search Sessions…"), ⇧⌘F and a magnifier in the top bar open the palette with `?` typed; backspace it and it's the command palette again. The palette already has what search needs: grouped rows with a meta line and a highlighted snippet, ↑↓ / ↩ / ⌘↵, a debounced async search that drops stale answers, the index's progress.

Scope, kinds and time are words in the query, not controls (the palette has one field):

- **Scope:** `in:workspace`, `in:project`; everywhere by default.
- **Kinds:** `kind:command`, `kind:page`, `kind:file`… (several allowed); all by default. "Files" means file contents (below); a file you opened in cmd is a history hit and shows under Files too.
- **Time:** `since:7d`, `since:today`.

Results are grouped by kind, each group ranked on its own (one ranked list across kinds compares bm25 scores of different corpora, which means nothing). Each row: a title, a meta line (where, when) and a highlighted snippet. ↩ does the obvious thing:

| Kind | Row | ↩ |
|---|---|---|
| Session | title · agent · folder · when | switch to it if open, else resume (today's behaviour) |
| Command | the command · exit code · folder · when; snippet from its output | the pane with the command scrolled to (OSC 133 marks) if it's still there, else a text window with its output |
| Page | title · host · when | open in a browser window |
| File (history) | path · when opened | open it |
| File (contents) | path:line · the line | open a text window at the line, the query in its find bar |
| Note, journal entry | text · when | the Journal at that day |

⌘↵ on a session forks it, on a command runs it again in a new terminal in its folder.

**Built (2026-10-07):** the top bar's magnifier, "Search…" on ⇧⌘F, and the palette's search matching open windows (its Sessions group) above past sessions. The Navigator's field stays a filter over its rows plus past sessions, from the same method; ⇧⌘F no longer goes there.

**The trade-off:** the palette is modal and closes on ↩, which suits "find it and go there" and not working through fifty grep matches one by one (an editor's find-in-files panel stays open). If that's missed: ⌘↵ on a Files group opens its matches as a list in a text window, still no new UI.

### UI kit pieces

The kit already has the two densities this needs, and new search UI uses them rather than adding search widgets of its own:

| | Toolbar items (`toolbar.tsx`) | General controls (`fields.tsx`, `list.tsx`) |
|---|---|---|
| Where | a window's toolbar, in a tile or a sidebar, at any width | sheets, dialogs, Settings |
| Field | `ToolbarSearchField`: ghost at rest, `--toolbar-item-h`, a `count` slot, Escape clears then `onEscape`, shrinks last as the bar gives way | `SearchField`: a `TextField` with sizes (`lg` in the widget library's sheet), a `status` slot (`IndexRing`), Escape clears |
| Options | `ToolbarButton pressed`, `ToolbarSegmented`, `ToolbarMenu`; `priority` moves them into ⋯ | `Segmented`, `Checkbox`, `Select` |

Where each surface sits:

- **Find bar** (⌘F): toolbar items only. It is a `WindowToolbar` row: `ToolbarSearchField` with the count, the option toggles, previous and next, close. Windows that have a toolbar get it as a second row under theirs (as PDF does now); windows without one (terminals) get it `floating` (as now). The toggles get a `priority`, so in a narrow tile they move into ⋯ and the field, the count and the arrows stay. One component, both placements; no "small find bar" to keep in step.
- **Search** (⇧⌘F): the palette, as it is; its rows draw snippets with the kit's `Highlight`.
- **Navigator** keeps its `ToolbarSearchField`; the palette keeps its own input (it is a command field, not a search field).

What the kit lacks, added to it (with gallery specimens), not to views' CSS:

1. **Text glyphs as toolbar icons.** "Aa", "ab" (whole word) and ".*" are app CSS today (`.find-glyph` in `renderer/src/styles.css`). Either SF Symbols that say it (`textformat` for case; no good one for regex) or a kit `glyph` icon kind that `iconNode` draws at `ICON.toolbar`, so every find bar's toggles match.
2. **Highlighted text.** `Highlighted` (`\x01…\x02` marks → `<mark>`) lives in `Palette.tsx`. Move it to the kit as `<Highlight text>`, with the match colour token (`--match`) the terminal and CodeMirror already use, so a snippet looks the same in the palette and the Navigator. Built.
3. **The palette, for streamed results.** Rows appended as file matches arrive without the active one moving (the Navigator's `useFrozenOrder` idea), and a group header per kind. Changes to the palette, not a new list.
4. **The find bar** itself (`FindBar`, the `Findable` interface above), composed of 1 and the toolbar items, in the kit so any window type, built-in or plugin, gets it. Built.

Settled in the Workbench with the user (prototype skill): the find bar in a narrow tile and a wide one (`FindBar.story.tsx`).

## Ranking, measured

Sixteen "find that session" queries over the author's history (3,047 sessions), each with the one right answer, phrased as remembered rather than copied from the title (2026-10-08):

| | first | top 5 | MRR |
|---|---|---|---|
| before | 10 | 13 | 0.70 |
| tools' calls and output weigh 0.3 | 13 | 13 | 0.81 |
| and English endings off query words (`stem`) | 13 | 14 | 0.84 |

Built: `weightOf` in `views/search.ts` (title 2, messages 1, tool results, tool calls and messages that are only tool calls 0.3) and `stem` in `search/query.ts`. Tried and dropped: less recency (no change), an any-word fallback when every word finds too little (the right session came 46th). Left: synonyms ("computer name" for "my pc name", "united states" for "US") need more than words; sessions cmd's own evals ran with `claude -p` (6% of the index, `"entrypoint": "sdk-cli"` in the transcript) show up in results and should be left out, which needs the ingest to keep the field and the sessions view to be rebuilt.

## Backend

### Search everything cmd has

`SearchView` grows from sessions to kinds:

- The transcript-only filter becomes a filter by kind (event types per kind: `transcript.*` → Sessions, `command` → Commands, `browser.visit` → Pages, `file.open` → Files, `agent.note` / journal notes → Notes), plus the identities `data.query` already filters by (`workspaceId`, `projectId`, `at`).
- One hit type per kind (a discriminated union), so the UI renders and opens each without guessing. `SearchHit` stays as the session variant.
- Sessions keep "one hit per session". Commands collapse runs of the same command line in the same folder into one row with a count ("ran 14 times, last failed").
- Ranking per kind: bm25, then recency, then signals the log has: the project you're in, files and pages you opened often, files agents edited.

**Index command output and agent output.** Write a capped `body` for `command` (the output's last 20 KB, where errors are) and for `agent.output` (the turn's screen, capped the same), and a real `text` for `agent.output` (the prompt's first line). Needs an `events_fts` rebuild (`buildFts` with a `bodyOf`), done once by a version bump of the search view. Measure the index size before and after on a real log; docs/30 had the old transcript index at 352 MB.

### Files: ripgrep first

File contents are searched on disk, with ripgrep, streamed:

- `rg --json` in the core, one process per search, killed when the query changes. Respects `.gitignore`, skips binary files. Bundled with the app (`@vscode/ripgrep` ships binaries); users won't have Homebrew's.
- Scope: This project → the project's root (`checkout.ts`); This Workspace → the workspace's root; Everywhere → every project root the log has seen recently, newest first, so the first results come from where you work.
- Literal by default (smart case: case-sensitive only with a capital), regex with the toggle, whole word with the toggle.
- Results stream as `search.results` events per search id; the view shows them as they come, grouped by file, at most N lines per file with "N more".
- `data.exclude` folders are never searched; `.env*`, keys and the like are skipped by a default glob list.
- Ranking files (not lines): files opened or edited recently (log), files in the current project, shorter paths; lines in order within a file.

Measured on this machine: `rg` for a word over one repo (`~/src/cmd`) 0.34 s; over all of `~/src` 15 s. So This project and This workspace are instant with ripgrep, and Everywhere is slow; it shows results as they come, nearest projects first.

### Files: a trigram index, later

When Everywhere has to be instant, add an index of file contents **as an accelerator behind the same method**: the UI and the results don't change, they come faster.

- **Trigrams, not words.** The transcript index's unicode61 tokens can't find substrings or punctuation in code (`earchVie`, `?.find(`). Code search engines (Zoekt, GitHub's Blackbird, Google Code Search) index trigrams. SQLite's FTS5 `trigram` tokenizer does substring and case-insensitive matching; the bundled SQLite (3.53.4) has it. A regex is narrowed to candidate files by its literal trigrams, then run.
- **The index picks candidates; the file on disk decides.** Every candidate is read and matched before it's shown, so lines and line numbers are always the file's current ones. A stale index can be slow, never wrong.
- **Changed files bypass it.** Files changed since they were indexed (FSEvents per root, `git status`) are searched by ripgrep directly. A whole-tree change (`git checkout`, a rebase) marks the root dirty and ripgrep covers it until the reindex catches up.
- In the views file (docs/28: disposable, rebuildable), never the facts file. Only roots cmd knows (Workspaces, projects in the log), never `$HOME`; ignored and excluded files never indexed; a size cap per file (skip generated and minified files).
- Indexing runs in a worker at low priority, on power only for the first pass, with progress in `IndexRing`.
- A trigram index is typically 2–4× the text it covers. Report it in Settings → Data with the other views, with a switch.

Build it only after ripgrep's version is in use and Everywhere is shown to be too slow in practice.

## Protocol

```ts
type SearchKind = "session" | "command" | "page" | "file" | "content" | "note";

"search.query": {
  params: { text: string; kinds?: SearchKind[]; workspaceId?: WorkspaceId; projectId?: string; since?: number; until?: number; limit?: number };
  result: { history: SearchResult[]; contentSearch: string | null }; // contentSearch: id of the streamed file-contents search, when "content" is asked
};
"search.cancel": { params: { id: string }; result: null };
// CoreEvent
| { type: "search.results"; id: string; hits: ContentHit[]; done: boolean }
```

`SearchResult` is the union of the history hits (session, command, page, file, note), each with `id`, `kind`, `title`, `meta` fields, `snippet`, `at` and what ↩ needs (session id and env, pane id and command mark, URL, path). `ContentHit`: `path`, `line`, `column`, `text` with `\x01…\x02` marks, `root`. Existing callers (palette, Navigator, CLI) ask for `kinds: ["session"]` until they show the rest.

CLI: `cmd search <text>` keeps its output for sessions; `--kind command,page`, `--here` (this project), `--space`, `--since 7d`, `--files` (contents only, `rg`-like output: `path:line: text`), `--json`.

## Phases

1. **⌘F everywhere.** Glyph icons, `Highlight`, `FindBar` and `Findable` in the kit; terminal and PDF moved onto it; browser, markdown, Files, Magic new; CodeMirror's panel replaced; ⌘E; Find disabled where it can't. Small, and the most visible inconsistency today.
2. **History search over every kind.** Built: `search.history` (commands with their output, pages, files opened in cmd; one row per command line and folder with its runs and last exit code), the workspace's history (Home: all of it). Next: notes and journal entries, `kind:`/`since:` words.
3. **Search in the palette.** Built: "Search…" (⇧⌘F, the top bar's magnifier) opens the palette with `?`, open windows matched above past sessions. Next: a group per kind from phase 2, ↩ and ⌘↵ per kind, `in:` / `kind:` / `since:` words.
4. **File contents with ripgrep.** Built: `search.files`, names then lines (definitions first, nearer files next), bounded in hits and time, `.gitignore`, secrets and `data.exclude` left out; a line opens a text window at it with the match selected and ⌘G finding the next. Next: bundle `rg` (`@vscode/ripgrep`, unpacked from the asar) instead of needing the system's; stream results as they arrive.
5. **Trigram index**, if Everywhere is too slow in use: the worker, FSEvents and git dirtiness, verify-on-read, Settings → Data.

Each phase ships on its own. e2e: a fixture project and fixture transcripts (`CMD_TRANSCRIPTS_HOME`) with known matches per kind; the smoke test types into ⇧⌘F and opens one of each.

## Open questions

1. **What the asking user meant by "full text search":** history (phases 2–3) or project files (phase 4)? Decides whether 4 comes before 3.
2. **Command output cap:** the last 20 KB of each, or the first and last 10 KB? Errors are usually at the end, the command's own header at the start.
3. **Replace in files.** Editors pair find-in-files with replace-in-files. Out of scope here; agents do bulk edits better, and a wrong bulk replace has no Undo across files.
4. **Semantic search** (docs/26 C3 "may later"): `sqlite-vec` in the views file over the same corpus, as another ranking signal. Not before phase 3 is in use.
