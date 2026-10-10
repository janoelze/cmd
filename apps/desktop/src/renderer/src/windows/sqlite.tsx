// SQLite window type (renderer half): title fields and menu. The view itself
// (sqlite-view.tsx) loads on first use.

import { cmd } from "../bridge.ts";
import { copy } from "../actions.ts";
import { shortPath } from "../model.ts";
import { windowActions } from "../windowActions.ts";
import { lazyView, registerWindowView, stateStr } from "./registry.ts";
import { exportTableCsv } from "./sqlite-export.ts";

const dirOf = (p: string) => p.split("/").slice(0, -1).join("/") || "/";

registerWindowView({
  kind: "sqlite",
  View: lazyView(() => import("./sqlite-view.tsx").then((m) => m.SqliteView)),
  describe: (w) => ({ place: shortPath(dirOf(stateStr(w, "path") ?? "")) }),
  menu: (w) => {
    const p = stateStr(w, "path");
    const table = stateStr(w, "table");
    return [
      { label: "Refresh", run: () => windowActions(w.id)?.refresh?.() },
      { label: table ? `Export ${table} as CSV…` : "Export Table as CSV…", enabled: !!(p && table), run: () => void exportTableCsv(p!, table!) },
      "-",
      ...(p
        ? [
            { label: "Open with Default App", run: () => cmd.openPath(p, { from: "user" }) },
            { label: "Show in Finder", run: () => cmd.revealPath(p) },
            { label: "Copy Path", run: () => copy(p) },
          ]
        : []),
    ];
  },
});
