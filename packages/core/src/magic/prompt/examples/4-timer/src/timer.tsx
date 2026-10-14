// A pomodoro timer: 25 (or 50) minutes of focus, then a break. The end time is kept in the
// window's state, so a reload or a restart carries on; at the end cmd notifies once.

import { useEffect } from "react";
import { Window, View, Stack, Text, Progress, WindowToolbar, ToolbarButton, ToolbarSegmented, ToolbarSpacer, useNow, useStoredState, cmd } from "@cmd/widget-api";

type Phase = "focus" | "break";
// A type, not an interface: stored state is plain data (WireValue).
type Timer = {
  phase: Phase;
  minutes: number;
  /** When it ends (ms), or null while paused. */
  endsAt: number | null;
  /** What is left while paused (ms). */
  left: number;
};

const BREAK = 5;
const fresh = (minutes: number, phase: Phase = "focus"): Timer => ({ phase, minutes, endsAt: null, left: (phase === "focus" ? minutes : BREAK) * 60_000 });
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export default function Pomodoro() {
  const [t, setT] = useStoredState<Timer>("timer", fresh(25));
  const now = useNow(1000);
  const left = t.endsAt ? t.endsAt - now : t.left;
  const total = (t.phase === "focus" ? t.minutes : BREAK) * 60_000;

  // At the end: say so, and line up the next phase (paused).
  useEffect(() => {
    if (!t.endsAt || left > 0) return;
    const next: Phase = t.phase === "focus" ? "break" : "focus";
    void cmd.notify.send({ key: `pomodoro-${t.endsAt}`, title: next === "break" ? "Time for a break" : "Back to work", body: next === "break" ? `${BREAK} minutes` : `${t.minutes} minutes of focus` });
    setT(fresh(t.minutes, next));
  }, [left, t, setT]);

  const running = !!t.endsAt;
  const start = () => setT({ ...t, endsAt: Date.now() + t.left });
  const pause = () => setT({ ...t, endsAt: null, left: Math.max(0, left) });

  return (
    <Window status={`${t.phase === "focus" ? "Focus" : "Break"} · ${running ? clock(left) + " left" : "paused"}`}>
      <View>
        <WindowToolbar label="Timer">
          <ToolbarButton label={running ? "Pause" : "Start"} icon={running ? "pause" : "play"} showLabel onClick={running ? pause : start} />
          <ToolbarButton label="Reset" icon="arrow.counterclockwise" onClick={() => setT(fresh(t.minutes))} />
          <ToolbarSpacer />
          <ToolbarSegmented
            label="Length"
            value={String(t.minutes)}
            options={[
              { value: "25", label: "25 min" },
              { value: "50", label: "50 min" },
            ]}
            onChange={(v) => setT(fresh(Number(v)))}
          />
        </WindowToolbar>
        <Stack pad="inset" gap={3} align="center" grow>
          <Text tone="dim">{t.phase === "focus" ? "Focus" : "Break"}</Text>
          <Text size="display" mono>
            {clock(left)}
          </Text>
          <Progress value={1 - Math.max(0, left) / total} label="Time passed" />
        </Stack>
      </View>
    </Window>
  );
}
