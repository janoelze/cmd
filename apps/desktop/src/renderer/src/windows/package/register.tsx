// Widget packages' windows (renderer half, docs/56): one view for every "pkg:<package>/<widget>"
// kind, which the core registers per package (core widgets/packages.ts); viewFor() falls back to it.
// Its title menu and context menu entries are the tree's Window `menu` and `actions` (chrome.ts).

import { PackageView } from "./PackageView.tsx";
import { registerWindowView } from "../registry.ts";
import { chromeOf, menuEntries, menuLabel } from "./chrome.ts";

registerWindowView({
  kind: "package",
  View: PackageView,
  describe: () => ({ kind: null }),
  titleMenu: (w) => {
    const c = chromeOf(w.id);
    return c?.menu?.length ? { label: menuLabel(c.menu), entries: menuEntries(c.menu, c.send) } : undefined;
  },
  menu: (w) => {
    const c = chromeOf(w.id);
    return c ? menuEntries(c.menu, c.send) : [];
  },
  actions: (w) => {
    const c = chromeOf(w.id);
    return c ? menuEntries(c.actions, c.send) : [];
  },
});
