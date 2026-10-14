// The CI widget's states: a deploy running after a failed test run.

import type { HostData } from "@cmd/widget-api/testing";
import failing from "../fixtures/failing.json" with { type: "json" };
import Ci from "./ci.tsx";

export default Ci;

/** A deploy running, the tests failed before it. */
export const Failing = failing as HostData;
