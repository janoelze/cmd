// The widget host as a feature (docs/56; kernel/features.ts): its service is the Widget
// Library's (`core.library.host`, made beside the packages it runs), started once the packages
// are read, stopped with the core. Its methods are what a package widget's window calls (the
// person's interactions, a resync, where it is drawn, Restart), the grant (the grants sheet,
// `cmd widget grant`), asking for one (widget.ask: `cmd widget link`, the sheet's Decline), and
// a window's config and its package's secrets (the Configure sheet; widgets/config.ts), and a
// frame widget's source and calls (frame.ts).

import os from "node:os";
import path from "node:path";
import type { CoreContext } from "../../kernel/context.ts";
import type { Feature } from "../../kernel/features.ts";
import { slice } from "../../kernel/handlers.ts";
import { findDeno } from "../deno.ts";
import { sandboxAvailable } from "../../magic/sandbox.ts";
import type { WidgetPackages } from "../packages.ts";
import { frameCall, frameSource } from "./frame.ts";
import { WidgetHost } from "./host.ts";
import { DenoRuntime } from "./runtime.ts";

/** The host over the packages; Deno runs its processes when there is a state dir (else a test sets a runtime). */
export function createWidgetHost(core: CoreContext, packages: WidgetPackages, o: { stateDir: string | null; socket: string | null; onAsk?: () => void }): WidgetHost {
  const runtime = o.stateDir
    ? new DenoRuntime({
        deno: () => findDeno({ setting: core.settings.settings["magic.deno"], stateDir: o.stateDir! }),
        denoDir: path.join(o.stateDir ?? os.tmpdir(), "runtime", "deno-cache"),
        sandbox: () => (process.env.CMD_MAGIC_UNSANDBOXED === "1" && !sandboxAvailable() ? "off" : "required"),
      })
    : null;
  return new WidgetHost(core, { stateDir: o.stateDir, socket: o.socket, packages, runtime, onAsk: o.onAsk });
}

const handlers = (core: CoreContext) =>
  slice({
    "widget.interact": (p) => (core.library.host.interact(p.windowId, p.handler, p.event, p.value), null),
    "widget.resync": (p) => (core.library.host.resync(p.windowId), null),
    "widget.env": (p) => (core.library.host.setEnv(p.windowId, p), null),
    "widget.restart": (p) => (core.library.host.restart(p.windowId), null),
    "widget.ask": (p) => (core.library.host.ask(p.name, !!p.decline), null),
    "widget.grant": (p) => core.library.host.grant(p.name, p.permissions),
    "widget.config": (p) => (core.library.host.config.set(p.windowId, p.values), null),
    "widget.secret": (p) => (core.library.host.config.setSecret(p.name, p.widget, p.key, p.value), null),
    "widget.secrets": (p) => ({ set: core.library.host.config.secretsSet(p.name, p.widget) }),
    "widget.frameSource": (p) => frameSource(core, p.windowId),
    "widget.frame": (p) => frameCall(core, p.windowId, p.verb, p.params, p.pressed === true),
  });

export const widgetHostFeature = {
  id: "widget-host",
  prefixes: ["widget"],
  handlers,
  // After "widget-packages" (FEATURES' order): the windows of packages it read start.
  startup: { label: "Starting widgets", run: (core: CoreContext) => core.library.host.start() },
  dispose: (core: CoreContext) => core.library.host.dispose(),
} satisfies Feature;
