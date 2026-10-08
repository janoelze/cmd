// JSON window type (renderer half): title fields, menu and the ⌘E switch to the
// text editor. The view itself (json-view.tsx) loads on first use.

import { cmd } from "../bridge.ts";
import { copy } from "../actions.ts";
import { shortPath } from "../model.ts";
import { lazyView, registerWindowView, stateStr } from "./registry.ts";
import { registerPreview, togglePreview } from "./preview.ts";

const dirOf = (p: string) => p.split("/").slice(0, -1).join("/") || "/";

registerPreview("json", /\.(json|jsonc|jsonl|ndjson|geojson|har|webmanifest)$/i);

registerWindowView({
  kind: "json",
  View: lazyView(() => import("./json-view.tsx").then((m) => m.JsonView)),
  describe: (w) => ({ place: shortPath(dirOf(stateStr(w, "path") ?? "")) }),
  menu: (w) => {
    const p = stateStr(w, "path");
    return [
      { label: "Edit (⌘E)", run: () => togglePreview(w) },
      ...(p
        ? [
            { label: "Open with Default App", run: () => cmd.openPath(p) },
            { label: "Copy Path", run: () => copy(p) },
          ]
        : []),
    ];
  },
});
