// The access adapters that ship with cmd, registered through the same
// AccessAdapter interface a plugin would use. The hosted relay isn't one: it's
// a transport of its own (link.ts).

import type { AccessAdapters } from "./adapter.ts";
import { tailscaleAdapter } from "./tailscale.ts";
import { urlAdapter } from "./url.ts";

export function registerBuiltinAdapters(adapters: AccessAdapters): void {
  adapters.register(tailscaleAdapter);
  adapters.register(urlAdapter);
}
