// Stats as one feature (docs/49-stats.md; kernel/features.ts): the service with the built-in
// stats, its RPC methods (StatsMethods, protocol stats.ts), the startup job that starts
// listening to the log and builds what isn't built, and its teardown.

import type { StatsMethods } from "@cmd/protocol";
import type { Feature } from "../kernel/features.ts";
import type { CoreContext } from "../kernel/context.ts";
import type { HandlerSlice } from "../kernel/handlers.ts";
import { scopedWidget } from "../windows/scoped.ts";
import { BUILTIN_STATS } from "./builtin.ts";
import { StatsService, type StatsCore } from "./service.ts";

/** The Stats widget (registered with the built-in types through windows/featured.ts). */
export const statsType = scopedWidget("stats", "Stats", "chart-bar", "How you and your agents used cmd: time, turns, commands and what failed, tokens, commits.");

/** The service (`core.stats`). It reads nothing until start(): the core makes it before the services it reads. */
export function createStats(core: StatsCore): StatsService {
  return new StatsService(core, BUILTIN_STATS);
}

export const statsFeature = {
  id: "stats",
  handlers: (core: CoreContext): HandlerSlice<keyof StatsMethods> => ({
    "stats.catalog": () => core.stats.catalog(),
    "stats.query": (p) => core.stats.query(p),
    "stats.queryMany": (p) => core.stats.queryMany(p.queries),
    "stats.rebuild": (p) => ({ stats: core.stats.rebuild(p.stat) }),
  }),
  startup: {
    label: "Counting stats",
    run: async (core: CoreContext) => {
      core.stats.start();
      core.scheduler.on("stall", (s) => core.stats.sample("core.stalls", [s.in], s.ms, s.at));
      // A new stat's history fills in behind the socket: shown with its progress until it's done.
      await core.stats.built((done, total) => core.scheduler.progress("stats", done, total));
    },
  },
  dispose: (core: CoreContext) => core.stats.dispose(),
} satisfies Feature;
