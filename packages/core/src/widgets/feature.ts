// Widget packages as a feature (docs/56; kernel/features.ts): the service (`core.packages`),
// read once the core answers and watched from then on, its window types taken away at
// the end. Its methods are the Widget Library's (widgets/handlers.ts: widget.list, widget.add).

import { widgetsHome } from "@cmd/protocol/node";
import type { CoreContext } from "../kernel/context.ts";
import type { Feature } from "../kernel/features.ts";
import { WidgetPackages } from "./packages.ts";

/** The service over $CMD_WIDGETS_HOME or ~/.cmd/widgets; it reads them from its startup job (a core with a state dir) on. */
export function createPackages(core: Pick<CoreContext, "windowTypes" | "library">): WidgetPackages {
  return new WidgetPackages({ home: widgetsHome(), types: () => core.windowTypes, onChange: () => core.library.changed() });
}

export const packagesFeature = {
  id: "widget-packages",
  startup: { label: "Reading widget packages", run: (core: CoreContext) => core.packages.start() },
  dispose: (core: CoreContext) => core.packages.dispose(),
} satisfies Feature;
