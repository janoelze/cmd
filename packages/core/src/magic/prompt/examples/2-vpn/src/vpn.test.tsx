// The VPN widget against the fake host: through a VPN's exit, and through the person's own provider.

import { describe, expect, it } from "vitest";
import { render, createHost, type HostData } from "@cmd/widget-api/testing";
import connected from "../fixtures/connected.json" with { type: "json" };
import home from "../fixtures/home.json" with { type: "json" };
import Vpn from "./vpn.tsx";

describe("VPN", () => {
  it("says traffic goes through the VPN when the exit isn't the person's provider", async () => {
    const tree = await render(<Vpn />, createHost(connected as HostData));
    expect(tree.find("Window").props.status).toBe("Through M247 Europe SRL");
    expect(tree.text()).toContain("185.65.134.1");
  });

  it("says when it leaves through the provider", async () => {
    const tree = await render(<Vpn />, createHost(home as HostData));
    expect(tree.find("Window").props.status).toBe("Not through the VPN");
  });

  it("shows why when ipinfo.io doesn't answer", async () => {
    const tree = await render(<Vpn />, createHost({ fetch: { "https://ipinfo.io/json": { status: 429 } } }));
    expect(tree).toShowState("error", "Can't tell");
  });
});
