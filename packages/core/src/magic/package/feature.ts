// Magic making widget packages as a feature (docs/56, "Magic on V3"; kernel/features.ts): its
// service is made on first use beside MagicService (package/service.ts magicPackages), its
// method is Edit with Magic for a package window (magic.editPackage), and magic.run and
// magic.cancel reach it through MagicService's handlers (magic/handlers.ts) for package builds.

import type { MagicPackageMethods } from "@cmd/protocol";
import type { CoreContext } from "../../kernel/context.ts";
import type { Feature } from "../../kernel/features.ts";
import type { HandlerSlice } from "../../kernel/handlers.ts";
import { magicPackages } from "./service.ts";

export const magicPackagesFeature = {
  id: "magic-packages",
  prefixes: ["magic"],
  handlers: (core: CoreContext): HandlerSlice<keyof MagicPackageMethods> => ({
    "magic.editPackage": (p) => ({ id: magicPackages(core).edit(p.windowId, { prompt: p.prompt, fix: p.fix }).id }),
  }),
  dispose: (core: CoreContext) => magicPackages(core).dispose(),
} satisfies Feature;
