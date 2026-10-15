// Countdown's states for the UI Workbench (`pnpm workbench widgets/timer`): the widget against
// the fake host, one variant per phase, with the native Timer's story's numbers
// (windows/timer/TimerView.story.tsx), so the two compare side by side. Running comes first:
// `Sizes` draws it at every size, as the native story's `Sizes` does.

import type { HostData } from "@cmd/widget-api/testing/host";
import Countdown, { type Timer } from "./timer.tsx";

export default Countdown;

const timer = (t: Partial<Timer>): HostData => ({ state: { timer: { duration: 25 * 60, endsAt: null, left: null, rang: null, ...t } } });

/** 17:42 left of 25 minutes: the ring emptying, when it ends in the title bar. */
export const Running: HostData = timer({ endsAt: Date.now() + (17 * 60 + 42) * 1000 });

/** Set at 25 minutes: the presets in the toolbar, only the ring's track; click the time to type one. */
export const Set: HostData = {};

/** Paused with 9:05 left: the ring and time dim. */
export const Paused: HostData = timer({ left: 9 * 60 + 5 });

/** It rang: the ring full, in the needs colour. */
export const Done: HostData = timer({ rang: Date.now() - 60_000 });

/** Set at a typed length, 1:30 (no preset checked). */
export const Custom: HostData = timer({ duration: 90 });

/** In a narrow window, as in a sidebar. */
export const Narrow: HostData & { size: "narrow" } = { ...Running, size: "narrow" };

/** In a wide window: the ring as large as the height allows. */
export const Wide: HostData & { size: "wide" } = { ...Running, size: "wide" };
