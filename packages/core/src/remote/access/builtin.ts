// The access adapters that ship with cmd. The hosted relay isn't one: it's a
// transport of its own (link.ts). Tailscale joins in phase 3 (docs/38).

import type { AccessAdapters } from "./adapter.ts";
import { urlAdapter } from "./url.ts";

export function registerBuiltinAdapters(adapters: AccessAdapters): void {
  adapters.register(urlAdapter);
}
