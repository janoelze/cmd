// The hosted relay as an access mode (docs/13-remote-access.md): the Mac
// connects out to remote.relay (link.ts), which forwards each device's
// encrypted channel; phones open the web client at remote.client. Nothing to
// set up. A route belongs to one relay, so switching relays registers a new one.

import { RelayLink } from "../link.ts";
import type { AccessMode } from "./mode.ts";

export function relayMode(): AccessMode {
  return {
    id: "relay",
    title: "Hosted relay",
    icon: "cloud",
    description: "cmd's relay passes on the encrypted traffic and serves the web page.",
    settings: ["remote.relay", "remote.client"],
    // The web client is read when a pairing link is made: changing it doesn't reconnect.
    config: (s) => s["remote.relay"].trim(),
    missing: (s) => (s["remote.relay"].trim() ? null : "Set a relay (remote.relay)."),
    connecting: "Connecting to the relay…",
    messages: {
      offline: () => "Remote access isn't connected to its relay yet.",
      noAddress: "Set the web client's address first, like https://cmd.example.com (remote.client).",
    },

    start(ctx) {
      const relay = ctx.settings["remote.relay"].trim();
      const known = ctx.keys.relayRoute();
      const same = known.relay === relay;
      ctx.audit("enabled", relay);
      const transport = new RelayLink({
        relay,
        client: () => ctx.settings["remote.client"],
        route: same ? known.route : null,
        secret: same ? known.secret : null,
        onRegistered: (route, secret) => ctx.keys.setRoute(relay, route, secret),
      });
      return { transport, stop: async () => null };
    },
  };
}
