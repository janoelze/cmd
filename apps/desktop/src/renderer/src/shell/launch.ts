// What an app window wires up once: commands from the menu bar (main), links opened from
// elsewhere, onboarding and What's New after a launch, `open` from a terminal, its title, and
// the e2e test's hooks.

import { useEffect } from "react";
import type { PaneId } from "@cmd/protocol";
import { openLink } from "../lib/actions.ts";
import { cmd } from "../lib/bridge.ts";
import { select } from "../lib/selection.ts";
import { getState, onWindowFocus, workspaceOfWindow } from "../lib/store.ts";
import { showSetup, stepsAtLaunch } from "../onboarding/Onboarding.tsx";
import { runCommand } from "./commands/registry.ts";
import { quickOfMenuId, runQuickCommand } from "./quick/quick.ts";
import { queueSheet } from "./sheets.ts";
import { releasesSince } from "./WhatsNew.tsx";

export function useLaunch(title: string): void {
  useEffect(() => {
    performance.mark("boot:app-mounted");
    // Test hook for the e2e smoke test.
    (window as unknown as { __cmdSelect?: (id: PaneId) => void }).__cmdSelect = select;
    const offCommand = cmd.onCommand((id) => {
      const quick = quickOfMenuId(id);
      if (quick) void runQuickCommand(quick);
      else runCommand(id, "menu");
    });
    const offUrl = cmd.onOpenUrl(openLink);
    // `open` in a terminal: follow it, unless it came from another workspace while this window is in the background.
    const offFocus = onWindowFocus((id) => (document.hasFocus() || workspaceOfWindow(id) === getState().workspaceId) && select(id));
    // Once, in the first window after a launch: onboarding steps this Mac hasn't
    // seen, then (after an update) what changed since the version it last ran as.
    void Promise.all([cmd.onboarding().then(stepsAtLaunch), cmd.whatsNew()]).then(([steps, claim]) => {
      const since = claim && releasesSince(claim.after);
      if (steps.length) showSetup(steps);
      if (since?.length) queueSheet({ kind: "whatsNew", releases: since });
    });
    return () => (offCommand?.(), offUrl?.(), offFocus());
  }, []);
  useEffect(() => void (document.title = title), [title]);
}
