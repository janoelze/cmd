// Inspector windows (renderer half, docs/59): the title is the inspected page's host; right-click
// moves it into the page's window or shows the page.

import type { AppWindow } from "@cmd/protocol";
import { getState } from "../../lib/store.ts";
import { select } from "../../lib/selection.ts";
import { hostOf } from "../../lib/model.ts";
import type { MenuEntry } from "../../lib/context.ts";
import { registerWindowView, stateStr } from "../registry.ts";
import { InspectorView } from "./InspectorView.tsx";
import { openInspector } from "./open.ts";
import "./commands.ts"; // Show Inspector (shell/commands/registry.ts)

const pageOf = (w: AppWindow) => {
  const id = stateStr(w, "for");
  const page = id ? getState().windows.get(id) : undefined;
  return page?.kind === "browser" ? page : undefined;
};

registerWindowView({
  kind: "inspector",
  View: InspectorView,
  describe: (w) => {
    const page = pageOf(w);
    return { name: "Inspector", place: page ? hostOf(stateStr(page, "url") ?? null).replace(/^www\./, "") : undefined, kind: null };
  },
  menu: (w): MenuEntry[] => {
    const page = pageOf(w);
    return page
      ? [
          { label: "Show Page", run: () => select(page.id) },
          { label: "Move Into Page's Window", run: () => void openInspector(page, "inside").catch(() => {}) },
        ]
      : [];
  },
});
