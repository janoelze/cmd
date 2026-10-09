// Timer, a built-in widget (docs/16-widgets.md): a countdown. Its state is the
// window's (core windows/builtin.ts timerType: duration, endsAt, left, rang) and
// the core rings it (core/timers.ts), so it ends on time in any workspace. Here: the
// time left, large, in a ring that empties as it runs (Dial), and in the toolbar the
// presets and Start / Pause / Reset. Click the time to type one ("10", "1:30", "90s", "1h").

import { Dial, ToolbarButton, ToolbarSegmented, ToolbarSpacer, View, WindowToolbar } from "@cmd/ui";
import { useEffect, useState } from "react";
import { setWidgetState, useWidgetStatus } from "../widgets.ts";
import type { WindowViewProps } from "../windows/registry.ts";

const PRESETS = [5, 10, 15, 25, 45, 60];

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

const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function TimerView({ win }: WindowViewProps) {
  const duration = typeof win.state.duration === "number" ? win.state.duration : 25 * 60;
  const endsAt = typeof win.state.endsAt === "number" ? win.state.endsAt : null;
  const left = typeof win.state.left === "number" ? win.state.left : null;
  const rang = typeof win.state.rang === "number" ? win.state.rang : null;
  const running = endsAt !== null;
  const paused = !running && left !== null;

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);

  const remaining = running ? Math.max(0, (endsAt - now) / 1000) : paused ? left : rang ? 0 : duration;
  const act = (action: string) => setWidgetState(win.id, { action });
  const setDuration = (seconds: number) => setWidgetState(win.id, { duration: seconds });

  useWidgetStatus(win.id, running ? `ends ${hhmm(endsAt)}` : paused ? "paused" : rang !== null ? `done at ${hhmm(rang)}` : null);

  return (
    <Timer
      phase={running ? "running" : paused ? "paused" : rang ? "done" : "idle"}
      duration={duration}
      remaining={remaining}
      caption={running ? `ends ${hhmm(endsAt)}` : paused ? "paused" : rang ? `done at ${hhmm(rang)}` : undefined}
      onAction={act}
      onDuration={setDuration}
    />
  );
}

/** The timer, drawn (TimerView.story.tsx shows every phase). */
export function Timer(p: { phase: "idle" | "running" | "paused" | "done"; duration: number; remaining: number; caption?: string; onAction: (a: "start" | "pause" | "reset") => void; onDuration: (seconds: number) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const commit = () => {
    const s = editing === null ? null : parseDuration(editing);
    setEditing(null);
    if (s) p.onDuration(s);
  };
  const set = p.phase === "idle" || p.phase === "done";
  return (
    <View
      toolbar={
        <WindowToolbar label="Timer">
          {set && <ToolbarSegmented label="Duration" value={String(p.duration / 60)} options={PRESETS.map((m) => ({ value: String(m), label: m < 60 ? `${m}m` : `${m / 60}h` }))} onChange={(v) => p.onDuration(Number(v) * 60)} />}
          <ToolbarSpacer />
          {(p.phase === "paused" || p.phase === "done") && <ToolbarButton icon="arrow.counterclockwise" label="Reset" onClick={() => p.onAction("reset")} />}
          {p.phase === "running" ? (
            <ToolbarButton icon="pause.fill" label="Pause" showLabel onClick={() => p.onAction("pause")} />
          ) : (
            <ToolbarButton icon="play.fill" label={p.phase === "paused" ? "Resume" : p.phase === "done" ? "Start Again" : "Start"} showLabel tone="accent" onClick={() => p.onAction("start")} />
          )}
        </WindowToolbar>
      }
    >
      <Dial
        label="Time"
        value={clock(p.remaining)}
        caption={p.caption}
        // Set: only the track; running, the ring empties; done, full in the needs tone.
        progress={p.phase === "running" || p.phase === "paused" ? p.remaining / p.duration : p.phase === "done" ? 1 : 0}
        tone={p.phase === "done" ? "needs" : p.phase === "paused" ? "dim" : "accent"}
        onEdit={set ? () => setEditing(clock(p.duration)) : undefined}
        edit={editing === null ? undefined : { text: editing, onChange: setEditing, onCommit: commit, onCancel: () => setEditing(null) }}
      />
    </View>
  );
}
