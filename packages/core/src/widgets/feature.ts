// Widgets as one feature (docs/56; kernel/features.ts): the Widget Library's service
// (`core.library`: the packages, their processes, hot reload, the versions of those Magic made)
// and its methods (widget.*: list it, add a widget, delete a package Magic made, what a package
// window calls, grants, config and secrets, a frame widget's source and calls: host/frame.ts). Its startup job moves the widgets of before
// packages aside (old.ts), reads the packages and starts their windows' processes; its teardown
// stops them. Nothing here imports Magic: Magic (magic/) builds packages through this library.

import { parsePackageKind } from "@cmd/protocol";
import type { CoreContext } from "../kernel/context.ts";
import type { Feature } from "../kernel/features.ts";
import { slice } from "../kernel/handlers.ts";
import { frameCall, frameSource } from "./host/frame.ts";
import { widgetRef } from "./library.ts";
import { dropOldWidgets } from "./old.ts";

const handlers = (core: CoreContext) =>
  slice({
    "widget.list": () => core.library.entries(),
    "widget.add": (p) => {
      const broken = p.ref.startsWith("pkg:") ? core.library.entries().find((e) => e.ref === p.ref && e.problem) : undefined;
      if (broken) throw new Error(`${broken.title} can't be added: ${broken.problem}`);
      const r = widgetRef(p.ref);
      // The person adds it: a package they declined before is asked about again, at once.
      const pkg = parsePackageKind(r.kind);
      if (pkg && core.library.packages.list().some((e) => e.ok && e.pkg.name === pkg.name)) core.library.host.ask(pkg.name);
      if (core.windowTypes.get(r.kind)?.role !== "widget") throw new Error(`not a widget: ${p.ref}`);
      return core.windowOps.open({ ...p, kind: r.kind, input: p.cwd ? { cwd: p.cwd } : {} });
    },
    // A package made with Magic goes with its folder; others aren't the Library's to delete.
    "widget.delete": (p) => (core.library.remove(parsePackageKind(p.ref)?.name ?? p.ref), null),
    // A widget's process says it on the widgets socket (kernel/server.ts), not here.
    "widget.hello": () => {
      throw new Error("widget.hello is for the widgets socket");
    },
    // A press from a paired device (control scope, remote/policy.ts): an act it leads to asks on the Mac.
    "widget.interact": (p, c) => (core.library.host.interact(p.windowId, p.handler, p.event, p.value, !!c?.conn && c.conn.access !== "local"), null),
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

export const widgetsFeature = {
  id: "widgets",
  prefixes: ["widget"],
  handlers,
  startup: {
    label: "Starting widgets",
    run: (core: CoreContext) => {
      if (core.library.stateDir) dropOldWidgets(core.library.stateDir, core);
      core.library.packages.start();
      core.library.host.start();
    },
  },
  dispose: (core: CoreContext) => {
    core.library.host.dispose();
    core.library.packages.dispose();
  },
} satisfies Feature;
