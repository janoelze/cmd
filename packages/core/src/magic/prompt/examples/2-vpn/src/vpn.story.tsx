// The VPN widget's states: through the VPN, and without it.

import type { HostData } from "@cmd/widget-api/testing";
import connected from "../fixtures/connected.json" with { type: "json" };
import home from "../fixtures/home.json" with { type: "json" };
import Vpn from "./vpn.tsx";

export default Vpn;

/** Leaving through a VPN's exit in Amsterdam. */
export const Connected = connected as HostData;

/** Leaving through the person's own provider. */
export const Home = home as HostData;
