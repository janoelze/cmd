// SQLite window type (renderer half): title fields and menu. The view itself
// (sqlite-view.tsx) loads on first use.

import { cmd } from "../bridge.ts";
import { copy } from "../actions.ts";
import { shortPath } from "../model.ts";
import { windowActions } from "../windowActions.ts";
import { lazyView, registerWindowView, stateStr } from "./registry.ts";

const dirOf = (p: string) => p.split("/").slice(0, -1).join("/") || "/";

registerWindowView({
  kind: "sqlite",
  View: lazyView(() => import("./sqlite-view.tsx").then((m) => m.SqliteView)),
  describe: (w) => ({ place: shortPath(dirOf(stateStr(w, "path") ?? "")) }),
  menu: (w) => {
    const p = stateStr(w, "path");
    return [
      { label: "Refresh", run: () => windowActions(w.id)?.refresh?.() },
      "-",
      ...(p
        ? [
            { label: "Open with Default App", run: () => cmd.openPath(p) },
            { label: "Show in Finder", run: () => cmd.revealPath(p) },
            { label: "Copy Path", run: () => copy(p) },
          ]
        : []),
    ];
  },
});
