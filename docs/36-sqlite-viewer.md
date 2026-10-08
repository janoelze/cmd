# SQLite viewer

> Status (2026-10-09): **built** on branch `sqlite`, the MVP below. Not yet: editing rows, exports beyond Copy as CSV, find (⌘F) over a grid, a virtualized grid (rows come 200 at a time instead), ⌘E to a text view (the file is binary, so there's nothing to switch to), the Widget Library.

A window that shows a `.sqlite` or `.db` file: its tables and views, each one's rows and structure, and a read-only query over the whole database. Read first: this doc, docs/09-window-types.md, the JSON window it copies (docs/35-json-viewer.md, `packages/core/src/windows/builtin.ts` `jsonType`, `renderer/src/windows/json.tsx`).

## What the field calls an MVP

The tools people call minimal converge on the same set, which this window takes as its scope: a list of tables and views; each one's rows, sorted by a column and filtered by text, a page at a time; its columns, keys and the CREATE statement; one read-only SELECT with a cap on rows; nothing that writes. (VS Code's SQLite Viewer by qwtel: read-only, sort and filter, no query runner. Obsidian's SQL Viewer: read-only, `sqlite_master`, 100-row previews, one SELECT or WITH under `query_only`. sqlite-web: Structure / Content / Query per table, 50 rows a page, sort by header, CSV export.) Full tools (DB Browser for SQLite, TablePlus, Beekeeper) add editing, schema design and imports, which none of the minimal ones have and this window leaves out.

## What exists

- **`node:sqlite`** is already how the core stores its own state (`store.ts`): no native module. A `DatabaseSync` opens a file with `readOnly: true`; a statement's `columns()` gives names and declared types; `setReturnArrays(true)` gives rows as arrays; `sourceSQL` says how much of the text `prepare()` compiled, which is how a second statement is caught.
- **Window types**: a core type with `opens: { extensions }` routes `open shop.db` in a shell, the file tree and the palette to it (`open.handlers` overrides); the renderer registers its view with `registerWindowView` and a `lazyView`. The JSON window shows the whole pattern, including live reload from `fs.watch` + `onFsChanged`.
- **Workers**: the core runs heavy reads in `worker_threads` (`data/sources/ingest-worker.ts` and others), because the scheduler's watchdog flags any block of the thread over 100 ms.
- **The kit** had lists (Panel, ListSection, ListRow) and a FindBar but nothing with columns.

## What it does

- **Routing**: `sqlite`, `sqlite3`, `db`, `db3` open in a **SQLite** window (`sqliteType`, priority over text). `create` checks the 16-byte header (`SQLite format 3\0`; an empty file counts, SQLite opens it as empty), so a `.db` that isn't SQLite fails with "isn't a SQLite database" instead of opening a broken window. A `-wal`, `-shm` or `-journal` sidecar opens the database beside it (`databaseOf`).
- **Sidebar**: tables with their row counts, then views (no count: counting a view can mean running it in full). Right-click: Copy Name, Copy CREATE Statement, Query This Table.
- **Content**: the first 200 rows, Show More for the next 200; a click on a column sorts (asc, desc, off); a filter field matches text in any column (`CAST(col AS TEXT) LIKE`, with `%` and `_` escaped). The count says "200 of 437 rows". NULL and blobs are dim; numbers sit right; a long cell is cut at 300 characters with the whole in its tooltip; text over 10,000 characters travels cut, with its length. Right-click a row: Copy Row as JSON / CSV, Copy <column>.
- **Structure**: columns with type and constraints (primary key, not null, default, → foreign key), indexes, triggers, the CREATE statement.
- **Query**: one statement, ⌘↩ or Run; the result in the same grid, "8 rows · 3 ms", Copy as CSV. The draft is kept in the window's state (`sql`), so it survives a reload and a restart. A statement that writes gets "That would change the database…"; a second statement after a `;` gets "Run one statement at a time."
- **Live**: the file and its `-wal` are watched; a change reloads the schema (so counts update) and what's shown, and runs the last query again.
- **Status**: "3 tables · 80 KB" in the title bar. Menu: Refresh, Open with Default App, Show in Finder, Copy Path.

## Under the hood

- **Protocol** (`packages/protocol/src/sqlite.ts`): `sqlite.schema { path }` → tables, views, indexes, triggers, size, page size, encoding, journal mode; `sqlite.rows { path, table, sort?, filter?, offset?, limit? }` and `sqlite.query { path, sql, limit? }` → `{ columns, rows, total, truncated, took }`. Values: number, string, null, `{ blob: bytes }`, `{ text, chars }` for cut text. Remotely these are `view` calls under the same path policy as `fs.read`.
- **Core** (`packages/core/src/sqlite/`): `SqliteService` keeps a worker per open database (`worker.ts`, `SqliteReader`), started on first use and stopped after a minute idle. The worker opens the file `readOnly` and sets `PRAGMA query_only = ON`, so nothing can write, whatever is typed. A request over 30 s ends its worker (and rejects what waited on it) rather than hang the window; the next request starts a fresh one. The same `SqliteReader` runs in-process in tests.
- **Kit**: `DataGrid` (`packages/ui/src/grid.tsx`): a sticky header, sortable columns, a type under each name, cells as `{ node, kind, tip }`, a numbered column, a footer. In the gallery.
- **Renderer**: `windows/sqlite.tsx` (registration, menu), `sqlite-view.tsx` (the view, three tabs), `sqlite.css`. The window's state is `{ path, table?, tab?, sql? }`.

## Later

- Find (⌘F) over the grid, and a filter per column.
- Export a table or result as CSV or JSON to a file.
- A virtualized grid, so a result can be 5,000 rows without a page.
- Follow a foreign key: click a `customer_id` to the row it points at.
- Editing, behind a switch, with a copy of the file first (the way the text editor keeps file history).
- CSV and TSV files in the same grid (the text window opens them today).
