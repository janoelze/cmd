// Workbench stories (pnpm workbench sqliteview): the SQLite window on a real
// database, the Workbench instance's own state (cmd.sqlite, read by the real core),
// with the window's state (table, tab, query) kept here: no table yet, a table's
// rows, its structure, a query, a file that isn't a database, and every size.

import type { AppWindow, WindowId, WorkspaceId } from "@cmd/protocol";
import { useEffect, useState } from "react";
import { cmd } from "../bridge.ts";
import { AllSizes, RefWindow, type SizeName } from "../reference/RefWindow.tsx";
import { SqliteView } from "./sqlite-view.tsx";

function useStateDb(): string | null {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => void cmd.call("core.hello", {}).then((h) => setPath(`${h.stateDir}/cmd.sqlite`), () => {}), []);
  return path;
}

function Db({ size = "wide", initial = {}, file }: { size?: SizeName; initial?: Record<string, unknown>; file?: string }) {
  const db = useStateDb();
  const [state, setState] = useState<Record<string, unknown>>(initial);
  const path = file ?? db;
  const win = { id: "story-sqlite" as WindowId, kind: "sqlite", workspaceId: "story" as WorkspaceId, state: { path, ...state } } as unknown as AppWindow;
  return (
    <RefWindow icon="cylinder.split.1x2" name="cmd.sqlite" size={size}>
      {path && <SqliteView win={win} focused update={(s) => setState((o) => ({ ...o, ...s }))} />}
    </RefWindow>
  );
}

export const NoTable = () => <Db />;
export const Rows = () => <Db initial={{ table: "agent_homes" }} />;
export const Structure = () => <Db initial={{ table: "agent_homes", tab: "structure" }} />;
export const Query = () => <Db initial={{ tab: "query", sql: "SELECT kind, count(*) AS windows FROM windows GROUP BY kind ORDER BY windows DESC" }} />;
export const NotADatabase = () => <Db file="/etc/hosts" />;
export const Sizes = () => <AllSizes render={(s) => <Db size={s} initial={{ table: "agent_homes" }} />} />;
