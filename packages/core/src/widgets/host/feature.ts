// The widget host's making (docs/56): the Widget Library's (`core.library.host`, made beside the
// packages it runs), with Deno running its processes when the core has a state folder. Its
// methods (what a package window calls, grants, config and secrets) are the widgets feature's
// (widgets/feature.ts).

import os from "node:os";
import path from "node:path";
import type { CoreContext } from "../../kernel/context.ts";
import { sandboxMode } from "../../lib/sandbox.ts";
import type { WidgetPackages } from "../packages.ts";
import { WidgetHost } from "./host.ts";
import { DenoRuntime } from "./runtime.ts";
import { toolsOf } from "../../tools/feature.ts";

/** The host over the packages; Deno runs its processes when there is a state dir (else a test sets a runtime). */
export function createWidgetHost(core: CoreContext, packages: WidgetPackages, o: { stateDir: string | null; socket: string | null; deno: () => string | null; onAsk?: () => void }): WidgetHost {
  const runtime = o.stateDir
    ? new DenoRuntime({
        deno: o.deno,
        denoDir: path.join(o.stateDir ?? os.tmpdir(), "runtime", "deno-cache"),
        sandbox: sandboxMode,
      })
    : null;
  // Acts ask through the tools' approvals and show on the board as their calls do (made on first use).
  return new WidgetHost(core, { stateDir: o.stateDir, socket: o.socket, packages, runtime, onAsk: o.onAsk, acts: () => toolsOf(core) });
}
