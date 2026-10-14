// Magic as a feature (docs/56, "Magic on V3"; kernel/features.ts): its service (`core.magic`,
// package/service.ts) builds a Magic window's request into a widget package; its methods make
// and stop a build, change a package widget made with Magic (Edit with Magic, Fix), list and
// bring back its versions (the edit view), answer "Download Deno?", and let the app render
// previews for builds (previews.ts).

import type { MagicRuntime } from "@cmd/protocol";
import type { CoreContext } from "../kernel/context.ts";
import type { Feature } from "../kernel/features.ts";
import { IN_CORE, slice } from "../kernel/handlers.ts";
import { sandboxAvailable } from "../lib/sandbox.ts";
import { denoVersion } from "../widgets/deno.ts";
import { MagicPackages, type MagicPackagesOptions } from "./package/service.ts";

/** The service (`core.magic`). */
export function createMagic(core: ConstructorParameters<typeof MagicPackages>[0], o: MagicPackagesOptions): MagicPackages {
  return new MagicPackages(core, o);
}

/** What widgets run on: Deno (cmd's own, once downloaded), the sandbox, who renders previews. */
async function runtime(core: CoreContext): Promise<MagicRuntime> {
  const deno = core.library.deno.find();
  const p = await core.previews.previewer().catch(() => null);
  return { deno, version: deno ? denoVersion(deno) : null, sandbox: process.platform === "darwin" && sandboxAvailable(), previewer: p?.name ?? null };
}

const handlers = (core: CoreContext) =>
  slice({
    "magic.run": (p) => (core.magic.run(p.id, p.prompt), null),
    "magic.cancel": (p) => (core.magic.cancel(p.id), null),
    "magic.editPackage": (p) => ({ id: core.magic.edit(p.windowId, { prompt: p.prompt, fix: p.fix }).id }),
    "magic.package": (p) => core.magic.info(p.windowId),
    "magic.restorePackage": (p) => (core.magic.restore(p.windowId, p.revision), null),
    "magic.runtime": () => runtime(core),
    "magic.installRuntime": async () => (await core.library.deno.install(), runtime(core)),
    "magic.skipRuntime": () => (core.library.deno.skip(), null),
    // The caller (the app's main process) renders previews from now on.
    "magic.previewer": (_, { conn } = IN_CORE) => (conn?.access === "local" && core.previews.add(conn), null),
    "magic.previewResult": (p) => (core.previews.result(p), null),
  });

export const magicFeature = {
  id: "magic",
  handlers,
  dispose: (core: CoreContext) => core.magic.dispose(),
} satisfies Feature;
