// The Widget Library's methods (widget.*, docs/16): list it (packages too, docs/56), put a
// widget in a workspace, rename, duplicate and delete the ones made with Magic.

import { parsePackageKind } from "@cmd/protocol";
import type { CoreContext } from "../kernel/context.ts";
import { slice } from "../kernel/handlers.ts";
import { magicRef, widgetRef } from "./library.ts";

export const widgetHandlers = (core: CoreContext) =>
  slice({
    "widget.list": () => core.library.entries(),
    "widget.add": (p) => {
      const broken = p.ref.startsWith("pkg:") ? core.library.entries().find((e) => e.ref === p.ref && e.problem) : undefined;
      if (broken) throw new Error(`${broken.title} can't be added: ${broken.problem}`);
      const r = widgetRef(p.ref);
      // The person adds it: a package they declined before is asked about again, at once.
      const pkg = parsePackageKind(r.kind);
      if (pkg && core.library.packages.list().some((e) => e.ok && e.pkg.name === pkg.name)) core.library.host.ask(pkg.name);
      if (!r.widgetId && core.windowTypes.get(r.kind)?.role !== "widget") throw new Error(`not a widget: ${p.ref}`);
      return core.windowOps.open({ ...p, kind: r.kind, input: r.widgetId ? { widgetId: r.widgetId } : p.cwd ? { cwd: p.cwd } : {} });
    },
    "widget.rename": (p) => (core.magic.renameWidget(magicRef(p.ref), p.title), null),
    "widget.duplicate": (p) => {
      const id = core.magic.duplicateWidget(magicRef(p.ref));
      return core.library.entries().find((e) => e.ref === `magic:${id}`)!;
    },
    "widget.delete": (p) => (core.magic.deleteWidget(magicRef(p.ref)), null),
    // A widget's data.ts says it on the widgets socket (kernel/server.ts), not here.
    "widget.hello": () => {
      throw new Error("widget.hello is for the widgets socket");
    },
  });
