// Widgets made before packages, dropped but not lost (docs/56, "cmd:2 widgets are dropped"): a
// startup job moves the instance's old widgets folder ($CMD_HOME/widgets, the cmd:2 folders
// Magic made) aside to widgets-old once, never when widgets-old is there already and never the
// packages folder (~/.cmd/widgets, $CMD_WIDGETS_HOME) or the instance's widget-packages, and
// closes the Magic windows that showed one: nothing runs or lists them any more. A Magic window
// that shows no old widget (a request not yet made, a build, a command to run) stays.

import fs from "node:fs";
import path from "node:path";
import type { AppWindow } from "@cmd/protocol";
import { logger, widgetsHome } from "@cmd/protocol/node";
import type { CoreContext } from "../kernel/context.ts";

const log = logger("widgets");

/** A Magic window showing a widget of before packages: a cmd:2 widget (widgetId, its page) or a v1 source. */
export function showsOldWidget(w: AppWindow): boolean {
  if (w.kind !== "magic") return false;
  const s = w.state as Record<string, unknown>;
  return typeof s.widgetId === "string" || typeof s.html === "string" || (!!s.source && typeof s.source === "object");
}

const same = (a: string, b: string) => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
};

/** Move $CMD_HOME/widgets to widgets-old (once) and close the windows that showed its widgets; what it did. */
export function dropOldWidgets(stateDir: string, core: Pick<CoreContext, "windows" | "closed">): { moved: boolean; closed: number } {
  const from = path.join(stateDir, "widgets");
  const to = path.join(stateDir, "widgets-old");
  let moved = false;
  if (fs.existsSync(from) && !fs.existsSync(to) && !same(from, widgetsHome())) {
    try {
      fs.renameSync(from, to);
      moved = true;
    } catch (e) {
      log.warn(`couldn't move the old widgets aside: ${(e as Error).message}`);
    }
  }
  const old = core.windows.others().filter(showsOldWidget);
  for (const w of old) {
    core.windows.close(w.id);
    core.closed.forget(w.id); // nothing to reopen it with
  }
  if (moved || old.length) log.info(`widgets made before packages: ${moved ? `moved to ${to}` : "folder left as it was"}, ${old.length} ${old.length === 1 ? "window" : "windows"} closed`);
  return { moved, closed: old.length };
}
