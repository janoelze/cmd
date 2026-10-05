// Timer, a built-in widget (docs/16-widgets.md): a countdown. Its state is the
// window's (core windows/builtin.ts timerType: duration, endsAt, left, rang) and
// the core rings it (core/timers.ts), so it ends on time in any Space. Here: the
// time left, large, a bar, Start / Pause / Reset, and presets. Click the time to
// type one ("10", "1:30", "90s", "1h").

import { Button, ButtonGroup, Panel, Progress } from "@cmd/ui";
import { useEffect, useRef, useState } from "react";
import { setWidgetState, useWidgetStatus } from "../widgets.ts";
import type { WindowViewProps } from "../windows/registry.ts";
import "./widgets.css";

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

  const [editing, setEditing] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing !== null) input.current?.select();
  }, [editing !== null]);
  const commit = () => {
    const s = editing === null ? null : parseDuration(editing);
    setEditing(null);
    if (s) setDuration(s);
  };

  useWidgetStatus(win.id, running ? `ends ${hhmm(endsAt)}` : paused ? "paused" : rang !== null ? `done at ${hhmm(rang)}` : null);

  return (
    <Panel className="tm">
      <div className="tm-body" data-state={running ? "running" : paused ? "paused" : rang ? "done" : "idle"}>
        {editing !== null ? (
          <input
            ref={input}
            className="tm-time tm-input"
            value={editing}
            aria-label="Time"
            onChange={(e) => setEditing(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(null);
            }}
          />
        ) : (
          <button className="tm-time" data-tip={running ? undefined : "Set Time"} disabled={running} onClick={() => setEditing(clock(duration))}>
            {clock(remaining)}
          </button>
        )}
        <div className="tm-bar">
          <Progress value={running || paused ? 1 - remaining / duration : rang ? 1 : 0} tone={rang && !running && !paused ? "warning" : "accent"} />
        </div>
        <ButtonGroup>
          {running ? (
            <Button onClick={() => act("pause")}>Pause</Button>
          ) : (
            <Button variant="primary" onClick={() => act("start")}>
              {paused ? "Resume" : rang ? "Start Again" : "Start"}
            </Button>
          )}
          {(paused || (rang && !running)) && <Button onClick={() => act("reset")}>Reset</Button>}
        </ButtonGroup>
        {!running && !paused && (
          <div className="tm-presets">
            {PRESETS.map((m) => (
              <Button key={m} size="sm" variant="ghost" pressed={duration === m * 60} onClick={() => setDuration(m * 60)}>
                {m} min
              </Button>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
