// The changes widget's states: a busy working tree, and a clean one.

import type { HostData } from "@cmd/widget-api/testing";
import busy from "../fixtures/busy.json" with { type: "json" };
import Changes from "./changes.tsx";

export default Changes;

/** Four files changed, two commits to push, one to pull. */
export const Busy = busy as HostData;

/** Nothing to commit. */
export const Clean: HostData = { git: { root: "/Users/me/src/shop", branch: "main", ahead: 0, behind: 0, files: [] } };
