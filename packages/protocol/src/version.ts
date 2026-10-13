// The wire's version (DEVELOPMENT.md, "Versions on the wire"): the protocol number a
// core and its clients compare in core.hello, the code a missing method answers with,
// and the one rule for whether a core runs this app's code.

import type { Method } from "./rpc.ts";

/**
 * The wire's version, the same for the core, the app, the CLI and the web
 * client of one build. Bump it on any change a client or core of the previous
 * value can't read: a method or event removed or renamed, a param or result
 * field removed, renamed or changed in meaning. Additions never bump it: a
 * client asks `has(method)` (core.hello's `methods`) before using a new one.
 * The app restarts a core of another protocol; the CLI refuses to talk to one.
 */
export const PROTOCOL = 2;

/**
 * Whether a core runs this app's code: its protocol, its source build and the folder
 * it runs from (a same-build core from another checkout counts as another). Main
 * restarts a core that isn't on launch; the sidebar footer says it's outdated.
 */
export function isCurrentCore(core: { protocol?: number; build: string; root?: string }, app: { build: string; root: string }): boolean {
  const same = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  return core.protocol === PROTOCOL && core.build === app.build && (!core.root || same(core.root, app.root));
}

/** JSON-RPC's code for a method the core doesn't have (an older core, or a newer client). */
export const UNKNOWN_METHOD = -32601;

/**
 * The codes an error answer carries: JSON-RPC's own (not JSON, not a request, no such
 * method, bad params) and cmd's for what a client may handle without reading the message
 * (a thing that isn't there, a feature that's off, a paired device's limits). Anything
 * else a handler throws is `failed`.
 */
export const RPC_CODES = { parse: -32700, invalidRequest: -32600, unknownMethod: UNKNOWN_METHOD, invalidParams: -32602, failed: -32000, denied: -32001, unavailable: -32002, notFound: -32003, conflict: -32004 } as const;
export type RpcCode = keyof typeof RPC_CODES;

export interface CoreHello {
  /** PROTOCOL of the core's build; absent from cores before it existed. */
  protocol?: number;
  /** The app version the core came with ($CMD_APP_VERSION), "source" when run from a checkout. */
  app?: string;
  /** Every method this core serves; absent from cores before it existed. */
  methods?: Method[];
  pid: number;
  socket: string;
  build: string;
  /** The core's $CMD_HOME, so an app can tell its own core from another instance's (older cores omit it). */
  stateDir?: string;
  /** The code folder it runs from, so an app restarts a core of another checkout even when the code is the same. */
  root?: string;
}
