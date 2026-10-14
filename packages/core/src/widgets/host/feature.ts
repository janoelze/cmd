// The widget host as a feature (docs/56; kernel/features.ts): its service is the Widget
// Library's (`core.library.host`, made beside the packages it runs), started once the packages
// are read, stopped with the core. Its methods are what a package widget's window calls (the
// person's interactions, a resync, where it is drawn, Restart) and the grant (`cmd widget grant`
// today, the grants sheet later).

import os from "node:os";
import path from "node:path";
import type { CoreContext } from "../../kernel/context.ts";
import type { Feature } from "../../kernel/features.ts";
import { slice } from "../../kernel/handlers.ts";
import { findDeno } from "../deno.ts";
import { sandboxAvailable } from "../../magic/sandbox.ts";
import type { WidgetPackages } from "../packages.ts";
import { WidgetHost } from "./host.ts";
import { DenoRuntime } from "./runtime.ts";

/** The host over the packages; Deno runs its processes when there is a state dir (else a test sets a runtime). */
export function createWidgetHost(core: CoreContext, packages: WidgetPackages, o: { stateDir: string | null; socket: string | null }): WidgetHost {
  const runtime = o.stateDir
    ? new DenoRuntime({
        deno: () => findDeno({ setting: core.settings.settings["magic.deno"], stateDir: o.stateDir! }),
        denoDir: path.join(o.stateDir ?? os.tmpdir(), "runtime", "deno-cache"),
        sandbox: () => (process.env.CMD_MAGIC_UNSANDBOXED === "1" && !sandboxAvailable() ? "off" : "required"),
      })
    : null;
  return new WidgetHost(core, { stateDir: o.stateDir, socket: o.socket, packages, runtime });
}

const handlers = (core: CoreContext) =>
  slice({
    "widget.interact": (p) => (core.library.host.interact(p.windowId, p.handler, p.event, p.value), null),
    "widget.resync": (p) => (core.library.host.resync(p.windowId), null),
    "widget.env": (p) => (core.library.host.setEnv(p.windowId, p), null),
    "widget.restart": (p) => (core.library.host.restart(p.windowId), null),
    "widget.grant": (p) => core.library.host.grant(p.name, p.permissions),
  });

export const widgetHostFeature = {
  id: "widget-host",
  prefixes: ["widget"],
  handlers,
  // After "widget-packages" (FEATURES' order): the windows of packages it read start.
  startup: { label: "Starting widgets", run: (core: CoreContext) => core.library.host.start() },
  dispose: (core: CoreContext) => core.library.host.dispose(),
} satisfies Feature;
