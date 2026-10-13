// Features that declare themselves in their own folder (docs/architecture-review-01/17,
// AR1-17-05; AR1-16-08): each contributes its slice of the RPC handlers, a startup job and its
// teardown, given the core's context (context.ts). Its service is a typed field of Core
// (core.journal), created there from the feature's own function; the rest comes from this list.

import type { CoreContext } from "./context.ts";
import type { Handlers } from "./handlers.ts";
import { journalFeature } from "../journal/feature.ts";
import { actionsFeature } from "../actions/feature.ts";
import { timersFeature } from "../windows/timers.ts";
import { statsFeature } from "../stats/feature.ts";
import { usageFeature } from "../data/sources/usage.ts";
import { operatorFeature } from "../operator/feature.ts";
import { toolsFeature } from "../tools/feature.ts";
import { nowPlayingFeature } from "../nowplaying/feature.ts";

/** Services the core makes from a feature (its field), without an import of its own each. */
export { createStats } from "../stats/feature.ts";

export interface Feature {
  id: string;
  /** What its methods are named after, when not only its id ("tools" has approvals.* too). */
  prefixes?: readonly string[];
  /** Its methods. They are merged into Core.handlers, where a method left out fails tsc. */
  handlers?(ctx: CoreContext): Partial<Handlers>;
  /** Run once the core answers (docs/34): label is what the footer shows while it runs. */
  startup?: { label: string; run(ctx: CoreContext): void | Promise<void> };
  dispose?(ctx: CoreContext): void;
}

export const FEATURES = [journalFeature, actionsFeature, timersFeature, usageFeature, statsFeature, toolsFeature, operatorFeature, nowPlayingFeature] as const satisfies readonly Feature[];
/** The same list, as plain Features (what loops over it need). */
export const ALL: readonly Feature[] = FEATURES;

type Intersection<T> = (T extends unknown ? (x: T) => void : never) extends (x: infer I) => void ? I : never;
type Slices = ReturnType<Extract<(typeof FEATURES)[number], { handlers: unknown }>["handlers"]>;
/** Every feature's handlers, typed as the methods they cover together. */
export const featureHandlers = (ctx: CoreContext) => Object.assign({}, ...ALL.map((f) => f.handlers?.(ctx) ?? {})) as Intersection<Slices>;
