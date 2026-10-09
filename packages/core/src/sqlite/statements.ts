// Statements the SQLite window never runs (docs/36-sqlite-viewer.md): ATTACH
// would let a query read any database the core can open (and the alias outlives
// the call, the worker keeps its connection), DETACH goes with it, VACUUM INTO
// writes a copy anywhere. All of them pass a read-only connection and
// query_only. Shared by the worker and remote/policy.ts.

/** The statement with leading whitespace, comments and empty statements removed. */
export function stripLeading(sql: string): string {
  let s = sql;
  for (;;) {
    const t = s.replace(/^[\s;]+/, "");
    if (t.startsWith("--")) {
      const nl = t.indexOf("\n");
      s = nl < 0 ? "" : t.slice(nl + 1);
    } else if (t.startsWith("/*")) {
      const end = t.indexOf("*/", 2);
      s = end < 0 ? "" : t.slice(end + 2);
    } else return t;
  }
}

/** Why `sql` may not run here, or null. */
export function refusedStatement(sql: string): string | null {
  const m = /^(?:EXPLAIN\s+(?:QUERY\s+PLAN\s+)?)?(ATTACH|DETACH|VACUUM)\b/i.exec(stripLeading(sql));
  return m ? `${m[1]!.toUpperCase()} isn't allowed: this window reads only the database it opened.` : null;
}
