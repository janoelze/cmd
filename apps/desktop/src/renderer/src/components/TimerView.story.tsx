// Workbench stories (pnpm workbench timerview): the Timer widget in each phase (set,
// running, paused, done), a custom time, and every size.

import { useState } from "react";
import { AllSizes, RefWindow, type SizeName } from "../reference/RefWindow.tsx";
import { Timer } from "./TimerView.tsx";

type Phase = "idle" | "running" | "paused" | "done";
const CAPTION: Record<Phase, string | undefined> = { idle: undefined, running: "ends 14:32", paused: "paused", done: "done at 14:32" };

function W({ size = "regular", phase = "idle", remaining, duration = 25 * 60 }: { size?: SizeName | readonly [number, number]; phase?: Phase; remaining?: number; duration?: number }) {
  const [d, setD] = useState(duration);
  return (
    <RefWindow icon="timer" name="Timer" size={size}>
      <Timer phase={phase} duration={d} remaining={remaining ?? d} caption={CAPTION[phase]} onAction={() => {}} onDuration={setD} />
    </RefWindow>
  );
}

export const Set = () => <W />;
export const Running = () => <W phase="running" remaining={17 * 60 + 42} />;
export const Paused = () => <W phase="paused" remaining={9 * 60 + 5} />;
export const Done = () => <W phase="done" remaining={0} />;
export const Custom = () => <W duration={90} />;
export const Small = () => <W phase="running" size={[240, 200]} remaining={4 * 60 + 12} />;
export const Sizes = () => <AllSizes render={(s) => <W size={s} phase="running" remaining={17 * 60 + 42} />} />;
