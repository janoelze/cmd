# Search

> Status (2026-10-07): **design, not built.** A user asked for full-text search. cmd has two kinds of search today, built separately and unevenly: find in a window (⌘F) and past-session search (⇧⌘F). This doc makes them one story with two keys, extends ⇧⌘F to everything cmd remembers and to the files in your projects, and says where an index of file contents fits (later, as an accelerator, never as the source of truth). Read first: this doc; `packages/core/src/data/views/search.ts`; `packages/core/src/search/query.ts`; docs/26 (S7, C3) and docs/30 ("Search everything"), which already promise most of it. Work in a worktree with its own `CMD_HOME` (CLAUDE.md).

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
| Lives | a bar on the window | the Search view |

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

One view for everything, "Search…" in the menu (renamed from "Search Sessions…"). One field, the same query syntax as today, a scope and kinds:

- **Scope:** This Space · This project · Everywhere. Defaults to the selected window's project, else the Space.
- **Kinds** (toggles, all on by default): Sessions · Commands · Pages · Files · Notes. "Files" means file contents (below); a file you opened in cmd is a Pages-and-files history hit and shows under Files too.
- **Time:** any time, today, this week, a custom range; `since:` in the query does the same.

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

**Where the view lives:** a window type (`search`), opened as a sheet over the workspace by ⇧⌘F and kept as a window if you drag it out or pin it. The Navigator's sidebar is too narrow for grouped results with snippets; its field stays a quick filter over its rows plus the Sessions group, from the same backend. The palette's `?` shows the top hits of each kind and "Show All in Search" (opens the view with the query). All three agree because they ask the same method.

## Backend

### Search everything cmd has

`SearchView` grows from sessions to kinds:

- The transcript-only filter becomes a filter by kind (event types per kind: `transcript.*` → Sessions, `command` → Commands, `browser.visit` → Pages, `file.open` → Files, `agent.note` / journal notes → Notes), plus the identities `data.query` already filters by (`spaceId`, `projectId`, `at`).
- One hit type per kind (a discriminated union), so the UI renders and opens each without guessing. `SearchHit` stays as the session variant.
- Sessions keep "one hit per session". Commands collapse runs of the same command line in the same folder into one row with a count ("ran 14 times, last failed").
- Ranking per kind: bm25, then recency, then signals the log has: the project you're in, files and pages you opened often, files agents edited.

**Index command output and agent output.** Write a capped `body` for `command` (the output's last 20 KB, where errors are) and for `agent.output` (the turn's screen, capped the same), and a real `text` for `agent.output` (the prompt's first line). Needs an `events_fts` rebuild (`buildFts` with a `bodyOf`), done once by a version bump of the search view. Measure the index size before and after on a real log; docs/30 had the old transcript index at 352 MB.

### Files: ripgrep first

File contents are searched on disk, with ripgrep, streamed:

- `rg --json` in the core, one process per search, killed when the query changes. Respects `.gitignore`, skips binary files. Bundled with the app (`@vscode/ripgrep` ships binaries); users won't have Homebrew's.
- Scope: This project → the project's root (`checkout.ts`); This Space → the Space's root; Everywhere → every project root the log has seen recently, newest first, so the first results come from where you work.
- Literal by default (smart case: case-sensitive only with a capital), regex with the toggle, whole word with the toggle.
- Results stream as `search.results` events per search id; the view shows them as they come, grouped by file, at most N lines per file with "N more".
- `data.exclude` folders are never searched; `.env*`, keys and the like are skipped by a default glob list.
- Ranking files (not lines): files opened or edited recently (log), files in the current project, shorter paths; lines in order within a file.

Measured on this machine: `rg` for a word over one repo (`~/src/cmd`) 0.34 s; over all of `~/src` 15 s. So This project and This Space are instant with ripgrep, and Everywhere is slow; it shows results as they come, nearest projects first.

### Files: a trigram index, later

When Everywhere has to be instant, add an index of file contents **as an accelerator behind the same method**: the UI and the results don't change, they come faster.

- **Trigrams, not words.** The transcript index's unicode61 tokens can't find substrings or punctuation in code (`earchVie`, `?.find(`). Code search engines (Zoekt, GitHub's Blackbird, Google Code Search) index trigrams. SQLite's FTS5 `trigram` tokenizer does substring and case-insensitive matching; the bundled SQLite (3.53.4) has it. A regex is narrowed to candidate files by its literal trigrams, then run.
- **The index picks candidates; the file on disk decides.** Every candidate is read and matched before it's shown, so lines and line numbers are always the file's current ones. A stale index can be slow, never wrong.
- **Changed files bypass it.** Files changed since they were indexed (FSEvents per root, `git status`) are searched by ripgrep directly. A whole-tree change (`git checkout`, a rebase) marks the root dirty and ripgrep covers it until the reindex catches up.
- In the views file (docs/28: disposable, rebuildable), never the facts file. Only roots cmd knows (Spaces, projects in the log), never `$HOME`; ignored and excluded files never indexed; a size cap per file (skip generated and minified files).
- Indexing runs in a worker at low priority, on power only for the first pass, with progress in `IndexRing`.
- A trigram index is typically 2–4× the text it covers. Report it in Settings → Data with the other views, with a switch.

Build it only after ripgrep's version is in use and Everywhere is shown to be too slow in practice.

## Protocol

```ts
type SearchKind = "session" | "command" | "page" | "file" | "content" | "note";

"search.query": {
  params: { text: string; kinds?: SearchKind[]; spaceId?: SpaceId; projectId?: string; since?: number; until?: number; limit?: number };
  result: { history: SearchResult[]; contentSearch: string | null }; // contentSearch: id of the streamed file-contents search, when "content" is asked
};
"search.cancel": { params: { id: string }; result: null };
// CoreEvent
| { type: "search.results"; id: string; hits: ContentHit[]; done: boolean }
```

`SearchResult` is the union of the history hits (session, command, page, file, note), each with `id`, `kind`, `title`, `meta` fields, `snippet`, `at` and what ↩ needs (session id and env, pane id and command mark, URL, path). `ContentHit`: `path`, `line`, `column`, `text` with `\x01…\x02` marks, `root`. Existing callers (palette, Navigator, CLI) ask for `kinds: ["session"]` until they show the rest.

CLI: `cmd search <text>` keeps its output for sessions; `--kind command,page`, `--here` (this project), `--space`, `--since 7d`, `--files` (contents only, `rg`-like output: `path:line: text`), `--json`.

## Phases

1. **⌘F everywhere.** `FindBar` and `Findable` in the kit; terminal and PDF moved onto it; browser, markdown, Files, Magic new; CodeMirror's panel replaced; ⌘E; Find disabled where it can't. Small, and the most visible inconsistency today.
2. **History search over every kind.** `SearchView` by kind with filters and the union result; command and agent output indexed (rebuild, size measured); CLI flags. No new UI yet beyond the palette's `?` groups.
3. **The Search view.** The `search` window type as a sheet, scope, kinds, time, grouped results, ↩ and ⌘↵ per kind; Navigator and palette on the same method; "Search…" in the menu.
4. **File contents with ripgrep.** Bundled `rg`, streamed `search.results`, scopes, ranking from the log, open at line with the find bar seeded.
5. **Trigram index**, if Everywhere is too slow in use: the worker, FSEvents and git dirtiness, verify-on-read, Settings → Data.

Each phase ships on its own. e2e: a fixture project and fixture transcripts (`CMD_TRANSCRIPTS_HOME`) with known matches per kind; the smoke test types into ⇧⌘F and opens one of each.

## Open questions

1. **What the asking user meant by "full text search":** history (phases 2–3) or project files (phase 4)? Decides whether 4 comes before 3.
2. **⇧⌘F with no window selected and no project:** Everywhere, or the Space?
3. **Command output cap:** the last 20 KB of each, or the first and last 10 KB? Errors are usually at the end, the command's own header at the start.
4. **Replace in files.** Editors pair find-in-files with replace-in-files. Out of scope here; agents do bulk edits better, and a wrong bulk replace has no Undo across files.
5. **Semantic search** (docs/26 C3 "may later"): `sqlite-vec` in the views file over the same corpus, as another ranking signal. Not before phase 3 is in use.
