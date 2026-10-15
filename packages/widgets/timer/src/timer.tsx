// Countdown, a built-in widget package (docs/56, "Built-ins and dogfooding"; the native Timer's
// job): the time left, large, and a bar that fills as it runs; in the toolbar the presets, a
// field to type a length ("10", "1:30", "90s", "1h"), Start / Pause / Resume and Reset. Its
// state is the window's (cmd.state), so a reload or a restart carries on. It rings through
// cmd.notify at the end, on time, from its own process, which runs while its window is open in
// any workspace; one that ended while nothing ran (the Mac slept) still rings once, saying when.
// Start or Pause, and Reset, are in the window's context menu too, as the native Timer's are.

import { useEffect, useState } from "react";
import { Window, View, Stack, Text, Progress, WindowToolbar, ToolbarButton, ToolbarField, ToolbarSegmented, ToolbarSpacer, useNow, useStoredState, cmd } from "@cmd/widget-api";

/** What it counts from (s); running, when it ends (ms); paused, what is left (s); when it last rang (ms). */
export type Timer = { duration: number; endsAt: number | null; left: number | null; rang: number | null };

const PRESETS = [5, 10, 15, 25, 45, 60];
const fresh = (duration: number): Timer => ({ duration, endsAt: null, left: null, rang: null });

/** "25" (minutes), "1:30", "1:00:00", "90s", "2m", "1h 30m" → seconds; null if none of those. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60) || null;
  if (/^\d+(:\d{1,2}){1,2}$/.test(t)) {
    const parts = t.split(":").map(Number);
    if (parts.slice(1).some((n) => n >= 60)) return null;
    return parts.reduce((s, n) => s * 60 + n, 0) || null;
  }
  const m = t.match(/^(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+)\s*s(?:ec(?:onds?)?)?)?$/);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) || null;
}

/** 25:00, 1:05:00, 0:09. */
export function clock(s: number): string {
  const t = Math.max(0, Math.ceil(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** "25 min", "1 h 30 min", "90 s" → "1 min 30 s": what the notification calls it. */
export function durationLabel(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h ? `${h} h` : "", m ? `${m} min` : "", sec && !h ? `${sec} s` : ""].filter(Boolean).join(" ") || "0 s";
}

const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export default function Countdown() {
  const [t, setT] = useStoredState<Timer>("timer", fresh(25 * 60));
  const [typed, setTyped] = useState("");
  const running = t.endsAt !== null;
  const paused = !running && t.left !== null;
  const now = useNow(running ? 250 : 60_000);
  // useNow re-renders it; the time itself is read now (a tick may be a minute old when Start is pressed).
  const remaining = running ? Math.max(0, (t.endsAt! - Math.max(now, Date.now())) / 1000) : paused ? t.left! : t.rang ? 0 : t.duration;
  const phase = running ? "running" : paused ? "paused" : t.rang ? "done" : "idle";

  // The end, on time: a timeout to the millisecond, from the widget's own process (any workspace).
  useEffect(() => {
    if (t.endsAt === null) return;
    const endsAt = t.endsAt;
    const ring = () => {
      const late = Date.now() - endsAt > 60_000;
      void cmd.notify.send({ key: `timer-${endsAt}`, title: `${durationLabel(t.duration)} timer · done`, body: late ? `Ended at ${hhmm(endsAt)}` : "Time's up", urgent: true });
      setT({ ...t, endsAt: null, left: null, rang: endsAt });
    };
    const wait = endsAt - Date.now();
    if (wait <= 0) return ring();
    const timer = setTimeout(ring, wait);
    return () => clearTimeout(timer);
  }, [t, setT]);

  const start = () => setT({ ...t, endsAt: Date.now() + (paused ? t.left! : t.duration) * 1000, left: null, rang: null });
  const pause = () => setT({ ...t, endsAt: null, left: remaining });
  const reset = () => setT(fresh(t.duration));
  const setDuration = (s: number) => setT(fresh(s));
  const set = phase === "idle" || phase === "done";
  const caption = running ? `ends ${hhmm(t.endsAt!)}` : paused ? "paused" : t.rang ? `done at ${hhmm(t.rang)}` : null;

  return (
    <Window
      status={caption}
      actions={[
        running ? { label: "Pause", run: pause } : { label: paused ? "Resume" : "Start", run: start },
        { label: "Reset", disabled: phase === "idle", run: reset },
      ]}
    >
      <View>
        <WindowToolbar label="Timer">
          {set && (
            <ToolbarSegmented
              label="Duration"
              value={String(t.duration / 60)}
              options={PRESETS.map((m) => ({ value: String(m), label: m < 60 ? `${m}m` : `${m / 60}h` }))}
              onChange={(v) => setDuration(Number(v) * 60)}
              priority={2}
            />
          )}
          {set && (
            <ToolbarField
              value={typed}
              placeholder="Length: 10, 1:30, 90s"
              icon="timer"
              priority={1}
              onChange={setTyped}
              onSubmit={(v: string) => {
                const s = parseDuration(v);
                if (s) setDuration(s), setTyped("");
              }}
            />
          )}
          <ToolbarSpacer />
          {(phase === "paused" || phase === "done") && <ToolbarButton icon="arrow.counterclockwise" label="Reset" onClick={reset} />}
          {running ? (
            <ToolbarButton icon="pause.fill" label="Pause" showLabel onClick={pause} />
          ) : (
            <ToolbarButton icon="play.fill" label={paused ? "Resume" : phase === "done" ? "Start Again" : "Start"} showLabel tone="accent" onClick={start} />
          )}
        </WindowToolbar>
        <Stack pad="inset" gap={3} align="center" grow>
          <Text size="display" mono tone={phase === "done" ? "warning" : phase === "paused" ? "dim" : undefined}>
            {clock(remaining)}
          </Text>
          <Progress value={phase === "running" || phase === "paused" ? 1 - remaining / t.duration : phase === "done" ? 1 : 0} tone={phase === "done" ? "warning" : "accent"} label="Time passed" />
          {caption && <Text tone="dim">{caption}</Text>}
        </Stack>
      </View>
    </Window>
  );
}
