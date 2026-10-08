// Export a SQLite table or view as CSV: a save dialog beside the database,
// then the core writes the file (sqlite.export), and a toast says how many rows.
// Shared by the window's menu (sqlite.tsx) and the view's table menu.

import { toast } from "@cmd/ui";
import { cmd } from "../bridge.ts";

const dirOf = (p: string) => p.split("/").slice(0, -1).join("/") || "/";

export async function exportTableCsv(path: string, table: string): Promise<void> {
  const file = await cmd.chooseSavePath(`${dirOf(path)}/${table}.csv`);
  if (!file) return;
  try {
    const r = await cmd.call("sqlite.export", { path, table, file });
    toast(`Exported ${r.rows.toLocaleString()} ${r.rows === 1 ? "row" : "rows"} to ${file.split("/").pop()}`, { action: { label: "Show in Finder", run: () => cmd.revealPath(file) } });
  } catch (e) {
    toast(`Couldn't export ${table}. ${(e as Error).message}`, { tone: "danger" });
  }
}
