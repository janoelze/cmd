// The access modes that ship with cmd, registered through the same AccessMode
// interface a plugin would use: the hosted relay, and the port publishers
// (Tailscale, your own URL) wrapped by publishedMode(). Fresh modes per
// registry: a mode holds the state of its run.

import type { AccessModes } from "./mode.ts";
import { publishedMode } from "./published.ts";
import { relayMode } from "./relay.ts";
import { tailscaleAdapter } from "./tailscale.ts";
import { urlAdapter } from "./url.ts";

export function registerBuiltinModes(modes: AccessModes): void {
  modes.register(relayMode());
  modes.register(publishedMode(tailscaleAdapter));
  modes.register(publishedMode(urlAdapter));
}
