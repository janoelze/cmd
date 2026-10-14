// Magic's methods (magic.*, docs/14): build and change a widget, its data, config, secrets and
// state, its runtime (Deno), and the app rendering previews for it.

import type { CoreContext } from "../kernel/context.ts";
import { IN_CORE, slice } from "../kernel/handlers.ts";
import { magicPackages } from "./package/service.ts";

export const magicHandlers = (core: CoreContext) =>
  slice({
    // A new request is a widget package (package/service.ts); the fast paths and changes to widgets made before packages stay here.
    "magic.run": (p) => (magicPackages(core).takes(p.id, p.prompt) ? magicPackages(core).run(p.id, p.prompt) : core.magic.run(p.id, p.prompt), null),
    "magic.cancel": (p) => (magicPackages(core).building(p.id) ? magicPackages(core).cancel(p.id) : core.magic.cancel(p.id), null),
    "magic.refresh": (p) => (core.magic.refresh(p.id), null),
    "magic.setRefresh": (p) => (core.magic.setRefresh(p.id, p.seconds), null),
    "magic.media": (p) => (core.magic.media(p.id, p.allow), null),
    "magic.widget": (p) => core.magic.widget(p.id),
    "magic.restore": (p) => (core.magic.restore(p.id, p.revision), null),
    "magic.config": (p) => (core.magic.setConfig(p.id, p.values ?? {}), null),
    "magic.secret": (p) => (core.magic.setSecret(p.id, p.key, p.value), null),
    "magic.state": (p) => (core.magic.setState(p.id, p.key, p.value), null),
    "magic.fix": (p) => (core.magic.fix(p.id), null),
    "magic.mute": (p) => (core.magic.setMuted(p.id, p.muted), null),
    "magic.runtime": () => core.magic.runtime(),
    "magic.installRuntime": () => core.magic.installRuntime(),
    "magic.skipRuntime": () => (core.magic.skipRuntime(), null),
    // The caller (the app's main process) renders previews from now on.
    "magic.previewer": (_, { conn } = IN_CORE) => (conn?.access === "local" && core.previews.add(conn), null),
    "magic.previewResult": (p) => (core.previews.result(p), null),
  });
