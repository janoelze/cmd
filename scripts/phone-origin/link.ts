// A core's pairing link, pointed at the phone origin (docs/56-phone-development.md):
// the page opens at the phone origin and the device dials /c/<target> there,
// which the Vite proxy forwards to that core. Route, host key and one-time key
// stay as the core made them; nothing changes in the core.

import { decodePairing, encodePairing } from "../../packages/remote-crypto/src/index.ts";
import type { TargetName } from "./targets.ts";

/** `link` (https://CLIENT/pair#v1.…) with its client and socket moved to `origin` and its /c/<target>. */
export function rewriteLink(link: string, origin: string, target: TargetName): string {
  const url = new URL(link);
  const p = decodePairing(url.hash);
  const base = new URL(origin);
  const socket = `${base.protocol === "https:" ? "wss:" : "ws:"}//${base.host}/c/${target}`;
  return `${base.origin}/pair#${encodePairing({ ...p, socket })}`;
}
