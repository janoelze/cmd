// The CPU widget's states: a busy Mac, and ps failing.

import type { HostData } from "@cmd/widget-api/testing";
import busy from "../fixtures/busy.json" with { type: "json" };
import Processes from "./processes.tsx";

export default Processes;

/** A browser tab at 96%, the window server behind it. */
export const Busy = busy as HostData;

/** ps refused. */
export const Failing: HostData = { run: { "ps -Ao pid,pcpu,pmem,comm -r": { code: 1, stderr: "ps: not allowed" } } };
