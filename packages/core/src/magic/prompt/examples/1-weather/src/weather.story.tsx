// The weather widget's states for the Workbench and the preview: a forecast for Lisbon.

import type { HostData } from "@cmd/widget-api/testing";
import lisbon from "../fixtures/lisbon.json" with { type: "json" };
import Weather from "./weather.tsx";

export default Weather;

/** A sunny week in Lisbon. */
export const Lisbon = lisbon as HostData;
