// The pomodoro's states: paused at the start, and running.

import type { HostData } from "@cmd/widget-api/testing";
import Pomodoro from "./timer.tsx";

export default Pomodoro;

/** Paused, 25 minutes to go. */
export const Paused: HostData = {};

/** Twelve minutes into a focus. */
export const Running: HostData = { state: { timer: { phase: "focus", minutes: 25, endsAt: Date.now() + 13 * 60_000, left: 0 } } };
