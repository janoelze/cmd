// API 1.3's Dial in a countdown (docs/57 A6, A7, A11): the time left in a ring that empties
// as it runs, typed into by a click (Return sends it, Escape puts it back), its length in the
// title menu's button (`menuLabel`), "7 min" as the app says it (`fmt.dur(s, { coarse })`).
// The Workbench draws it beside the native Timer (windows/package/display.story.tsx).

import { Window, View, WindowToolbar, ToolbarButton, ToolbarSpacer, Dial, useNow, useStoredState, fmt } from "@cmd/widget-api";

/** A typed length in seconds: "10" (minutes), "1:30", "90s", "1h"; null when it isn't one. */
export function parseLength(text: string): number | null {
  const t = text.trim().toLowerCase();
  const clock = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (clock) return clock[3] ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : Number(clock[1]) * 60 + Number(clock[2]);
  const unit = /^(\d+(?:\.\d+)?)\s*(h|m|min|s)?$/.exec(t);
  if (!unit) return null;
  const n = Number(unit[1]);
  const s = unit[2] === "h" ? n * 3600 : unit[2] === "s" ? n : n * 60;
  return s > 0 ? Math.round(s) : null;
}

/** "17:42", "1:05:00". */
const clock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

const PRESETS = [5 * 60, 15 * 60, 25 * 60, 50 * 60];

export default function Countdown() {
  const [length, setLength] = useStoredState("length", 25 * 60);
  // Running: when it ends. Paused: the seconds left.
  const [endsAt, setEndsAt] = useStoredState<number | null>("endsAt", null);
  const [paused, setPaused] = useStoredState<number | null>("paused", null);
  const now = useNow(1000);
  const left = endsAt !== null ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : (paused ?? length);
  const done = endsAt !== null && left === 0;
  const running = endsAt !== null && !done;
  const set = !running && paused === null;
  const start = () => (setEndsAt(Date.now() + (paused ?? length) * 1000), setPaused(null));
  const reset = () => (setEndsAt(null), setPaused(null));

  return (
    <Window status={running ? `ends ${fmt.time(endsAt ?? now)}` : null} menuLabel={fmt.dur(length, { coarse: true })} menu={PRESETS.map((s) => ({ label: fmt.dur(s, { coarse: true }), checked: s === length, run: () => (setLength(s), reset()) }))}>
      <View>
        <WindowToolbar label="Countdown">
          <ToolbarSpacer />
          {!set && <ToolbarButton icon="arrow.counterclockwise" label="Reset" onClick={reset} />}
          {running ? (
            <ToolbarButton icon="pause.fill" label="Pause" showLabel onClick={() => (setPaused(left), setEndsAt(null))} />
          ) : (
            <ToolbarButton icon="play.fill" label={paused !== null ? "Resume" : done ? "Start Again" : "Start"} showLabel tone="accent" onClick={done ? () => (setEndsAt(Date.now() + length * 1000), setPaused(null)) : start} />
          )}
        </WindowToolbar>
        <Dial
          label="Time"
          value={clock(left)}
          progress={running || paused !== null ? left / length : done ? 1 : 0}
          tone={done ? "needs" : paused !== null ? "dim" : "accent"}
          caption={running ? `ends ${fmt.time(endsAt ?? now)}` : paused !== null ? "paused" : done ? `done at ${fmt.time(endsAt ?? now)}` : undefined}
          editable={set || done}
          onSubmit={(text) => {
            const s = parseLength(text);
            if (s) (setLength(s), reset());
          }}
        />
      </View>
    </Window>
  );
}
