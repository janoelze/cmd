// The tools as one feature (docs/54; kernel/features.ts): what every caller of the tools shares
// in a core (the approvals, waiting and remembered) and the methods for them (ToolsMethods,
// protocol tools.ts). Made with the first use, one per core.

import type { ToolsMethods } from "@cmd/protocol";
import type { CoreContext } from "../kernel/context.ts";
import type { Feature } from "../kernel/features.ts";
import type { HandlerSlice } from "../kernel/handlers.ts";
import { Approvals } from "./approvals.ts";

export interface ToolsService {
  approvals: Approvals;
}

const services = new WeakMap<Pick<CoreContext, "store">, ToolsService>();

/** The core's tools service, made on first use. */
export function toolsOf(core: Pick<CoreContext, "store">): ToolsService {
  let s = services.get(core);
  if (!s) services.set(core, (s = { approvals: new Approvals(core.store.db) }));
  return s;
}

export const toolsFeature = {
  id: "tools",
  prefixes: ["tools", "approvals"],
  handlers: (core: CoreContext): HandlerSlice<keyof ToolsMethods> => ({
    "approvals.answer": (p) => (toolsOf(core).approvals.answer(p.workspaceId, p.itemId, { allow: p.allow, reason: p.reason, remember: p.remember }), null),
    "approvals.list": (p) => toolsOf(core).approvals.list(p.workspaceId),
    "approvals.forget": (p) => (toolsOf(core).approvals.forget(p.workspaceId, p.key), null),
  }),
} satisfies Feature;
