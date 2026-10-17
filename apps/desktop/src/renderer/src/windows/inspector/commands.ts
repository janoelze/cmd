// Show Inspector (⌥⌘I, docs/59): on a browser window, opens its inspector where it was last
// opened, or closes it; on an Inspector window, closes it and goes back to the page.

import type { AppWindow } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import { select } from "../../lib/selection.ts";
import { getState } from "../../lib/store.ts";
import { registerCommands } from "../../shell/commands/registry.ts";
import { closeInspector, hasPage, inspectorPlace, openInspectorAgain } from "./open.ts";

/** The page an Inspector window inspects. */
const pageOf = (w: AppWindow | undefined): AppWindow | undefined => {
  const id = w?.kind === "inspector" ? w.state.for : undefined;
  return typeof id === "string" ? getState().windows.get(id) : undefined;
};

registerCommands({
  // A browser window: show its inspector, or close it; an Inspector window: close it.
  "browser.inspector": {
    when: (c) => hasPage(c.window) || c.window?.kind === "inspector",
    checked: (c) => c.window?.kind === "inspector" || (hasPage(c.window) && !!inspectorPlace(c.window!)),
    run: (c) => {
      const w = c.window;
      if (w?.kind === "inspector") {
        const page = pageOf(w);
        void cmd.call("window.close", { id: w.id }).then(() => page && select(page.id), () => {});
        return;
      }
      if (!w || !hasPage(w)) return;
      void (inspectorPlace(w) ? closeInspector(w) : openInspectorAgain(w)).catch(() => {});
    },
  },
});
