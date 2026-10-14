// The weather widget against the fake host: the forecast from the fixture's answers, and a
// city Open-Meteo doesn't know.

import { describe, expect, it } from "vitest";
import { render, createHost, type HostData } from "@cmd/widget-api/testing";
import lisbon from "../fixtures/lisbon.json" with { type: "json" };
import Weather from "./weather.tsx";

describe("Weather", () => {
  it("shows the temperature now, the next hours and the days ahead", async () => {
    const tree = await render(<Weather />, createHost(lisbon as HostData));
    expect(tree).toHaveStat("Lisbon, PT", "22°");
    expect(tree.find("Window").props.status).toBe("22° · Partly cloudy");
    expect(tree).toHaveSection("Next days", { count: 2 });
    expect(tree.rows()).toHaveLength(2);
  });

  it("says so when the city isn't found", async () => {
    const host = createHost({ config: { city: "Nowhere" }, fetch: { "https://geocoding-api.open-meteo.com/v1/search?name=Nowhere&count=1": { body: {} } } });
    const tree = await render(<Weather />, host);
    expect(tree).toShowState("error", "No forecast");
  });
});
