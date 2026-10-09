// The access modes that ship with cmd, registered through the same AccessMode
// interface a plugin would use: the hosted relay, and the port publishers
// (Tailscale, your own URL) wrapped by publishedMode(). Modes are stateless,
// so every registry shares the same ones.

import type { AccessModes } from "./mode.ts";
import { publishedMode } from "./published.ts";
import { relayMode } from "./relay.ts";
import { tailscaleAdapter } from "./tailscale.ts";
import { urlAdapter } from "./url.ts";

const BUILTIN = [relayMode(), publishedMode(tailscaleAdapter), publishedMode(urlAdapter)];

export function registerBuiltinModes(modes: AccessModes): void {
  for (const m of BUILTIN) modes.register(m);
}
