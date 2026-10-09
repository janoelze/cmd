// SQLite window view (docs/36-sqlite-viewer.md), the window-design skill's data
// window: the database's tables and views down the side (a menu in the toolbar
// when the window is narrow); the chosen one as its rows (sorted, filtered, a page at
// a time), its structure (columns, keys, indexes, the CREATE statement), or a
// read-only query over the whole database. Live: the file and its -wal are
// watched, and what's shown reloads when they change. The core reads the file
// (sqlite.schema / rows / query) in a worker, read-only; nothing here writes.

import { Button, Callout, CodeBlock, DataGrid, Hide, KeyValue, List, ListRow, ListSection, ListValue, Pane, Panes, Split, Stack, StatusLine, Text, TextArea, ToolbarButton, ToolbarMenu, ToolbarSearchField, ToolbarSegmented, ToolbarSpacer, View, ViewState, WindowToolbar, type GridCell, type GridColumn, type GridSort } from "@cmd/ui";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SqliteResult, SqliteSchema, SqliteTable, SqliteValue } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { copy } from "../actions.ts";
import { showContextMenu } from "../context.ts";
import { formatBytes } from "../model.ts";
import { onFsChanged } from "../store.ts";
import { registerWindowActions, setWindowStatus } from "../windowActions.ts";
import { stateStr, type WindowViewProps } from "./registry.ts";
import { exportTableCsv } from "./sqlite-export.ts";

type Tab = "content" | "structure" | "query";
const TABS: { id: Tab; label: string }[] = [
  { id: "content", label: "Content" },
  { id: "structure", label: "Structure" },
  { id: "query", label: "Query" },
];

/** Rows per page of a table. */
const PAGE = 200;
/** Characters of a cell shown; the rest is in the tooltip, up to TIP. */
const SHOWN = 300;
const TIP = 600;

const n = (x: number) => x.toLocaleString();
const rowsLabel = (count: number) => `${n(count)} ${count === 1 ? "row" : "rows"}`;

/** How a value is shown: NULL and blobs dim, numbers right, long text cut with the whole in the tooltip. */
function cellOf(v: SqliteValue): GridCell {
  if (v === null) return { node: "NULL", kind: "null" };
  if (typeof v === "number") return { node: String(v), kind: "number" };
  if (typeof v === "string") return v.length > SHOWN ? { node: `${v.slice(0, SHOWN)}…`, tip: `${v.slice(0, TIP)}${v.length > TIP ? "…" : ""}`, kind: "text" } : { node: v, kind: "text" };
  if ("blob" in v) return { node: `${formatBytes(v.blob)} blob`, kind: "blob" };
  return { node: `${v.text.slice(0, SHOWN)}…`, tip: `${n(v.chars)} characters`, kind: "text" };
}

/** The value as text, for copying. */
const textOf = (v: SqliteValue): string => (v === null ? "" : typeof v === "object" ? ("blob" in v ? `<${v.blob} bytes>` : v.text) : String(v));
const jsonOf = (v: SqliteValue): unknown => (v !== null && typeof v === "object" ? ("blob" in v ? `<${v.blob} bytes>` : v.text) : v);

const csvField = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
const csvOf = (columns: string[], rows: SqliteValue[][]) => [columns, ...rows.map((r) => r.map(textOf))].map((r) => r.map(csvField).join(",")).join("\n");

/** Declared numeric types sit to the right even when a value is NULL. */
const numeric = (type: string) => /INT|REAL|FLOA|DOUB|NUM|DEC|BOOL/i.test(type);

/** A result's columns for the grid, with the declared type under each name when the table is known. */
function gridColumns(columns: string[], table?: SqliteTable): GridColumn[] {
  return columns.map((c) => {
    const col = table?.columns.find((x) => x.name === c);
    return { key: c, label: c, note: col?.type || undefined, align: col && numeric(col.type) ? "end" : undefined };
  });
}

function rowMenu(columns: string[], row: SqliteValue[]): void {
  void showContextMenu([
    { label: "Copy Row as JSON", run: () => copy(JSON.stringify(Object.fromEntries(columns.map((c, i) => [c, jsonOf(row[i] ?? null)])), null, 2)) },
    { label: "Copy Row as CSV", run: () => copy(csvOf(columns, [row])) },
    "-",
    ...columns.map((c, i) => ({ label: `Copy ${c}`, run: () => copy(textOf(row[i] ?? null)) })).slice(0, 12),
  ]);
}

/** A message for the person, from what the core said. */
const friendly = (e: unknown): string => {
  const m = (e as Error).message ?? String(e);
  if (/file is not a database|not a SQLite database/i.test(m)) return "This file isn't a SQLite database.";
  if (/database is locked|SQLITE_BUSY/i.test(m)) return "The database is busy right now. It reloads when it's free.";
  if (/readonly database/i.test(m)) return "That would change the database. It's opened read-only here, so only statements that read work.";
  return m.replace(/^SQLITE_\w+: /, "");
};

/** `update` changes the window's state (its table, tab and query); the real window by default, a stand-in in stories. */
export function SqliteView({ win, focused: _focused, update }: WindowViewProps & { update?: (state: Record<string, unknown>) => void }) {
  const file = stateStr(win, "path") ?? "";
  const picked = stateStr(win, "table");
  const tab: Tab = win.state.tab === "structure" || win.state.tab === "query" ? win.state.tab : "content";

  const [schema, setSchema] = useState<SqliteSchema | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped when the file changes on disk: rows reload. */
  const [version, setVersion] = useState(0);
  /** What the tab puts in the toolbar and the footer (ContentTab, QueryTab, StructureTab). */
  const [bar, setBar] = useState<TabBar>({});

  const load = useCallback(async () => {
    try {
      setSchema(await cmd.call("sqlite.schema", { path: file }));
      setError(null);
    } catch (e) {
      setError(friendly(e));
    }
    setVersion((v) => v + 1);
  }, [file]);
  useEffect(() => void load(), [load]);

  // Live: the database, and its write-ahead log when it has one.
  useEffect(() => {
    const files = [file, `${file}-wal`];
    for (const f of files) void cmd.call("fs.watch", { path: f }).catch(() => {});
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onFsChanged((p) => {
      if (!files.includes(p)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 300);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
      for (const f of files) void cmd.call("fs.unwatch", { path: f }).catch(() => {});
    };
  }, [file, load]);

  useEffect(() => registerWindowActions(win.id, { refresh: () => void load() }), [win.id, load]);

  useEffect(() => {
    if (!schema) return setWindowStatus(win.id, null);
    const parts = [`${schema.tables.length} ${schema.tables.length === 1 ? "table" : "tables"}`, formatBytes(schema.size)];
    setWindowStatus(win.id, { label: parts.join(" · "), key: "info" });
  }, [win.id, schema]);
  useEffect(() => () => setWindowStatus(win.id, null), [win.id]);

  const set = (state: Record<string, unknown>) => (update ? update(state) : void cmd.call("window.update", { id: win.id, state }).catch(() => {}));
  const all = useMemo(() => (schema ? [...schema.tables, ...schema.views] : []), [schema]);
  const table = all.find((t) => t.name === picked);

  const tableMenu = (t: SqliteTable) =>
    void showContextMenu([
      { label: "Copy Name", run: () => copy(t.name) },
      { label: "Copy CREATE Statement", enabled: !!t.sql, run: () => copy(t.sql ?? "") },
      "-",
      { label: "Query This Table", run: () => set({ table: t.name, tab: "query", sql: `SELECT * FROM "${t.name.replaceAll('"', '""')}" LIMIT 100` }) },
      { label: "Export as CSV…", run: () => void exportTableCsv(file, t.name) },
    ]);
  // Narrow windows: the sidebar gives way to a menu of the tables in the toolbar.
  const pickMenu = () => void showContextMenu(all.map((t) => ({ label: t.name, checked: t.name === picked, run: () => set({ table: t.name }) })));

  const sidebar = schema && (
    <List>
      <ListSection title="Tables" count={schema.tables.length}>
        {schema.tables.map((t) => (
          <ListRow key={t.name} icon="tablecells" title={t.name} mono selected={t.name === picked} end={t.rows !== null && <ListValue>{n(t.rows)}</ListValue>} onClick={() => set({ table: t.name })} onContextMenu={() => tableMenu(t)} />
        ))}
      </ListSection>
      {schema.views.length > 0 && (
        <ListSection title="Views" count={schema.views.length}>
          {schema.views.map((t) => (
            <ListRow key={t.name} icon="eye" title={t.name} mono selected={t.name === picked} onClick={() => set({ table: t.name })} onContextMenu={() => tableMenu(t)} />
          ))}
        </ListSection>
      )}
    </List>
  );

  return (
    <View
      scroll={false}
      state={!schema ? (error ? { kind: "error", title: "Couldn't read this database", text: error, action: <Button icon="arrow.clockwise" onClick={() => void load()}>Try Again</Button> } : { kind: "loading" }) : null}
      toolbar={
        <WindowToolbar label="Database">
          <ToolbarSegmented label="Show" value={tab} options={TABS.map((t) => ({ value: t.id, label: t.label }))} onChange={(t) => set({ tab: t })} />
          {schema && all.length > 0 && (
            <Hide above="regular">
              <ToolbarMenu label="Table" onClick={pickMenu}>
                {picked ?? "Pick a Table"}
              </ToolbarMenu>
            </Hide>
          )}
          <ToolbarSpacer />
          {bar.tools}
        </WindowToolbar>
      }
      footer={bar.status != null ? <StatusLine end={bar.statusEnd}>{bar.status}</StatusLine> : undefined}
    >
      <Split side="start" pane={sidebar} width={{ min: 150, ideal: 200, max: 320 }}>
        {error && (
          <Callout tone="warning" banner compact>
            {error}
          </Callout>
        )}
        {!schema ? null : tab === "query" ? (
          <QueryTab win={win} file={file} version={version} onBar={setBar} update={set} />
        ) : !table ? (
          <Overview schema={schema} onBar={setBar} />
        ) : tab === "structure" ? (
          <StructureTab schema={schema} table={table} onBar={setBar} />
        ) : (
          <ContentTab key={table.name} file={file} table={table} version={version} onBar={setBar} />
        )}
      </Split>
    </View>
  );
}

/** A tab's own toolbar items (after the tabs) and its footer line. */
interface TabBar {
  tools?: ReactNode;
  status?: ReactNode;
  statusEnd?: ReactNode;
}

/** With no table chosen: what the file is. */
function Overview({ schema, onBar }: { schema: SqliteSchema; onBar: (b: TabBar) => void }) {
  useEffect(() => onBar({}), [onBar]);
  return (
    <Stack pad="lg" gap="xl">
      <Panes>
        <Pane title="Database">
          <KeyValue
            items={[
              ["Size", formatBytes(schema.size)],
              ["Pages", `${n(schema.pageCount)} × ${formatBytes(schema.pageSize)}`],
              ["Encoding", schema.encoding],
              ["Journal", schema.wal ? "Write-ahead log" : "Rollback"],
              ["User version", String(schema.userVersion)],
              ["Indexes", String(schema.indexes.length)],
              ["Triggers", String(schema.triggers.length)],
            ]}
          />
        </Pane>
      </Panes>
      <Text tone="dim">{schema.tables.length ? "Pick a table: its rows, its structure, and a query over the whole database show here." : "An empty database: nothing has made a table in it yet."}</Text>
    </Stack>
  );
}

/** A table's rows: sorted by a column, filtered by text, a page at a time. */
function ContentTab({ file, table, version, onBar }: { file: string; table: SqliteTable; version: number; onBar: (b: TabBar) => void }) {
  const [sort, setSort] = useState<GridSort | null>(null);
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [result, setResult] = useState<SqliteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The filter applies a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setApplied(filter.trim()), 200);
    return () => clearTimeout(t);
  }, [filter]);

  const fetch = useCallback(
    async (offset: number) => {
      setBusy(true);
      try {
        const r = await cmd.call("sqlite.rows", { path: file, table: table.name, sort: sort ? { column: sort.key, desc: sort.desc } : undefined, filter: applied || undefined, offset, limit: PAGE });
        setResult((prev) => (offset && prev ? { ...r, rows: [...prev.rows, ...r.rows] } : r));
        setError(null);
      } catch (e) {
        setError(friendly(e));
      } finally {
        setBusy(false);
      }
    },
    [file, table.name, sort, applied],
  );
  // A new sort or filter starts over; a change on disk reloads what's shown, keeping the scroll position.
  useEffect(() => void fetch(0), [fetch, version]);

  const columns = useMemo(() => gridColumns(result?.columns ?? table.columns.map((c) => c.name), table), [result?.columns, table]);
  const rows = useMemo(() => result?.rows.map((r) => r.map(cellOf)) ?? [], [result]);
  const shown = result?.rows.length ?? 0;
  const total = result?.total ?? null;

  useEffect(
    () =>
      onBar({
        tools: <ToolbarSearchField value={filter} onChange={setFilter} placeholder="Filter rows" minWidth={90} />,
        status: busy && !result ? "Loading…" : result ? (total !== null && total !== shown ? `${n(shown)} of ${rowsLabel(total)}` : rowsLabel(shown)) : null,
      }),
    [filter, busy, result, total, shown, onBar],
  );

  return (
    <>
      {error && (
        <Callout tone="danger" banner compact>
          {error}
        </Callout>
      )}
      {result && !rows.length ? (
        <ViewState
          state={
            applied
              ? { kind: "noResults", title: "No rows match", text: `Nothing in ${table.name} contains “${applied}”.`, action: <Button onClick={() => setFilter("")}>Clear Filter</Button> }
              : { kind: "empty", icon: "tablecells", title: "No rows", text: `${table.name} is empty.` }
          }
        />
      ) : (
        <DataGrid
          mono
          numbered
          columns={columns}
          rows={rows}
          sort={sort}
          onSort={setSort}
          onRowContextMenu={(i) => result && rowMenu(result.columns, result.rows[i]!)}
          footer={
            result?.truncated ? (
              <Button size="sm" busy={busy} onClick={() => void fetch(shown)}>
                Show More
              </Button>
            ) : undefined
          }
        />
      )}
    </>
  );
}

/** Columns, keys, indexes, triggers and the CREATE statement. */
function StructureTab({ schema, table, onBar }: { schema: SqliteSchema; table: SqliteTable; onBar: (b: TabBar) => void }) {
  const indexes = schema.indexes.filter((i) => i.table === table.name);
  const triggers = schema.triggers.filter((t) => t.table === table.name);
  const fk = (name: string) => table.foreignKeys.find((f) => f.from === name);
  const rows: GridCell[][] = table.columns.map((c) => {
    const f = fk(c.name);
    const notes = [c.pk ? (table.columns.filter((x) => x.pk).length > 1 ? `primary key ${c.pk}` : "primary key") : "", c.notNull ? "not null" : "", c.default !== null ? `default ${c.default}` : "", f ? `→ ${f.table}${f.to ? `.${f.to}` : ""}` : ""].filter(Boolean);
    return [{ node: c.name, kind: "text" }, c.type ? { node: c.type, kind: "text" } : { node: "any", kind: "null" }, { node: notes.join(" · "), kind: "text" }];
  });
  useEffect(
    () => onBar({ status: [`${table.columns.length} ${table.columns.length === 1 ? "column" : "columns"}`, indexes.length ? `${indexes.length} ${indexes.length === 1 ? "index" : "indexes"}` : null, triggers.length ? `${triggers.length} ${triggers.length === 1 ? "trigger" : "triggers"}` : null].filter(Boolean).join(" · ") }),
    [table, indexes.length, triggers.length, onBar],
  );
  return (
    <Stack gap="none">
      <DataGrid
        mono
        columns={[
          { key: "name", label: "Column" },
          { key: "type", label: "Type" },
          { key: "notes", label: "Constraints", grow: true },
        ]}
        rows={rows}
      />
      {(indexes.length > 0 || triggers.length > 0 || table.sql) && (
        <Stack pad="lg" gap="xl">
          {indexes.length > 0 && (
            <Pane title="Indexes">
              <KeyValue mono items={indexes.map((i) => [i.name, `${i.unique ? "unique · " : ""}${i.columns.join(", ")}`])} />
            </Pane>
          )}
          {triggers.length > 0 && (
            <Pane title="Triggers">
              {triggers.map((t) => (
                <CodeBlock key={t.name}>{t.sql ?? t.name}</CodeBlock>
              ))}
            </Pane>
          )}
          {table.sql && (
            <Pane title="Definition">
              <CodeBlock maxHeight={400}>{table.sql}</CodeBlock>
            </Pane>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/** One read-only statement over the database; its draft lives in the window's state. */
function QueryTab({ win, file, version, onBar, update }: { win: WindowViewProps["win"]; file: string; version: number; onBar: (b: TabBar) => void; update: (state: Record<string, unknown>) => void }) {
  const saved = stateStr(win, "sql") ?? "";
  const [sql, setSql] = useState(saved);
  const [result, setResult] = useState<SqliteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ran = useRef<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  // Another window showing this database set a query (Query This Table): take it.
  useEffect(() => setSql(saved), [saved]);
  // The draft is kept in the window, so it survives a reload and a restart.
  useEffect(() => {
    if (sql === saved) return;
    const t = setTimeout(() => update({ sql }), 500);
    return () => clearTimeout(t);
  }, [sql, saved, update]);
  useEffect(() => area.current?.focus(), []);

  const run = useCallback(
    async (text = sql) => {
      if (!text.trim()) return;
      setBusy(true);
      ran.current = text;
      try {
        setResult(await cmd.call("sqlite.query", { path: file, sql: text }));
        setError(null);
      } catch (e) {
        setError(friendly(e));
        setResult(null);
      } finally {
        setBusy(false);
      }
    },
    [file, sql],
  );
  // The file changed: a query that ran runs again, so the result stays true.
  useEffect(() => {
    if (ran.current !== null && version > 1) void run(ran.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const columns = useMemo(() => gridColumns(result?.columns ?? []), [result?.columns]);
  const rows = useMemo(() => result?.rows.map((r) => r.map(cellOf)) ?? [], [result]);

  useEffect(
    () =>
      onBar({
        tools: (
          <>
            {result && result.rows.length > 0 && <ToolbarButton icon="doc.on.doc" label="Copy as CSV" secondary priority={1} onClick={() => copy(csvOf(result.columns, result.rows))} />}
            <ToolbarButton icon="play.fill" label="Run" showLabel shortcut="⌘↩" disabled={!sql.trim() || busy} onClick={() => void run()} priority={3} />
          </>
        ),
        status: busy ? "Running…" : result ? `${rowsLabel(result.rows.length)}${result.truncated ? " shown" : ""} · ${result.took || "under 1"} ms` : null,
      }),
    [result, sql, busy, run, onBar],
  );

  return (
    <>
      <Stack pad="md">
        <TextArea ref={area} value={sql} onChange={setSql} onSubmit={() => void run()} code rows={4} placeholder="SELECT name, count(*) FROM … GROUP BY name" spellCheck={false} aria-label="SQL" />
      </Stack>
      {error && (
        <Callout tone="danger" banner compact title="Couldn't run that">
          {error}
        </Callout>
      )}
      {result ? (
        rows.length ? (
          <DataGrid mono numbered columns={columns} rows={rows} onRowContextMenu={(i) => rowMenu(result.columns, result.rows[i]!)} />
        ) : (
          <ViewState state={{ kind: "empty", icon: "tablecells", title: "No rows", text: "The statement ran and returned nothing." }} />
        )
      ) : (
        !error && <ViewState state={{ kind: "empty", icon: "play.fill", title: "Run a statement", text: "SELECT and WITH work. The database is opened read-only, so nothing here can change it." }} />
      )}
    </>
  );
}
