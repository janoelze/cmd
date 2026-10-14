// Countdown's states for the UI Workbench (`pnpm workbench widgets/timer`): the widget against
// the fake host, one variant per phase.

import type { HostData } from "@cmd/widget-api/testing/host";
import Countdown from "./timer.tsx";

export default Countdown;

/** Set at 25 minutes, the presets and the length field in the toolbar. */
export const Set: HostData = {};

/** Twelve minutes in. */
export const Running: HostData = { state: { timer: { duration: 25 * 60, endsAt: Date.now() + 13 * 60_000, left: null, rang: null } } };

/** Paused with 4:20 left. */
export const Paused: HostData = { state: { timer: { duration: 10 * 60, endsAt: null, left: 260, rang: null } } };

/** It rang. */
export const Done: HostData = { state: { timer: { duration: 5 * 60, endsAt: null, left: null, rang: Date.now() - 60_000 } } };

/** In a narrow window, as in a sidebar. */
export const Narrow: HostData & { size: "narrow" } = { size: "narrow", state: { timer: { duration: 25 * 60, endsAt: Date.now() + 13 * 60_000, left: null, rang: null } } };
