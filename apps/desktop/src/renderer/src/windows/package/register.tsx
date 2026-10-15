// Widget packages' windows (renderer half, docs/56): one view for every "pkg:<package>/<widget>"
// kind, which the core registers per package (core widgets/packages.ts); viewFor() falls back to it.
// Its title menu and context menu entries are the tree's Window `menu` and `actions` (chrome.ts),
// then Configure… for a widget with config fields (ConfigSheet.tsx). A widget made with Magic
// has an edit view too (⌘E: its versions, Restore; magic/MagicEditor.tsx).

import type { AppWindow } from "@cmd/protocol";
import type { MenuEntry } from "../../lib/context.ts";
import { getState } from "../../lib/store.ts";
import { PackageView } from "./PackageView.tsx";
import { registerWindowView } from "../registry.ts";
import { chromeOf, menuEntries, menuLabel } from "./chrome.ts";
import { magicPackageActions } from "../magic/package-actions.ts";
import { withMagicEdit } from "../magic/MagicEditor.tsx";
import { configurable, configure } from "./ConfigSheet.tsx";

/** Configure… when the window's widget has config fields, after a line when the tree's entries come first. */
function configureEntry(w: AppWindow, before: MenuEntry[]): MenuEntry[] {
  if (!configurable(getState().library.find((e) => e.kind === w.kind))) return before;
  return [...before, ...(before.length ? ["-" as const] : []), { label: "Configure…", run: () => configure(w.id) }];
}

registerWindowView({
  kind: "package",
  View: withMagicEdit(PackageView),
  describe: () => ({ kind: null }),
  titleMenu: (w) => {
    const c = chromeOf(w.id);
    const entries = configureEntry(w, c?.menu?.length ? menuEntries(c.menu, c.send) : []);
    return entries.length ? { label: c?.menuLabel ?? menuLabel(c?.menu), entries } : undefined;
  },
  menu: (w) => {
    const c = chromeOf(w.id);
    return c ? menuEntries(c.menu, c.send) : [];
  },
  actions: (w) => {
    const c = chromeOf(w.id);
    return [...magicPackageActions(w), ...configureEntry(w, c ? menuEntries(c.actions, c.send) : [])];
  },
});
