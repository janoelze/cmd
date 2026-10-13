// Media controls: the Scrubber, a video's or a sound's timeline. Plain, a slim
// track with what has played (`inline`: inside a toolbar, between its times); with `thumbs`, a strip of frames to find a place by
// eye; with `trim`, a range with a handle at each end, what falls outside it shaded.
// Click or drag anywhere to seek; drag a handle to move that end (the caller shows
// the frame there); the time under the pointer floats above it. The TimeBar: a track's
// position drawn like a chart's bar, a rectangle with what has played filled.

import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export interface TrimRange {
  start: number;
  end: number;
}

export interface ScrubberProps {
  /** Seconds. */
  duration: number;
  time: number;
  onSeek: (t: number) => void;
  /** Frames along the track, evenly spaced (data URLs); the strip grows tall enough to show them. */
  thumbs?: readonly string[];
  /** The range kept; null: no handles. */
  trim?: TrimRange | null;
  onTrim?: (range: TrimRange, end: "start" | "end") => void;
  /** The shortest range a trim can be (s). */
  minTrim?: number;
  label?: string;
  /** No band of its own: in a toolbar (where it takes the row's spare width) or on a view's background. */
  inline?: boolean;
}

/** "1:05", "1:02:03"; `tenths` adds ".4". */
export function formatTime(s: number, tenths = false): string {
  const t = Math.max(0, Number.isFinite(s) ? s : 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = tenths ? Math.floor(t % 60) : Math.round(t % 60) === 60 ? 59 : Math.floor(t % 60);
  const ss = String(sec).padStart(2, "0");
  const frac = tenths ? `.${Math.floor((t * 10) % 10)}` : "";
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}${frac}` : `${m}:${ss}${frac}`;
}

export function Scrubber({ duration, time, onSeek, thumbs, trim, onTrim, minTrim = 0.5, label = "Timeline", inline }: ScrubberProps) {
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<"seek" | "start" | "end" | null>(null);
  const d = duration > 0 ? duration : 1;
  const frac = (t: number) => `${(Math.max(0, Math.min(d, t)) / d) * 100}%`;
  const at = (e: { clientX: number }) => {
    const r = track.current!.getBoundingClientRect();
    return (Math.max(0, Math.min(r.width, e.clientX - r.left)) / (r.width || 1)) * d;
  };

  const move = (what: "seek" | "start" | "end", t: number) => {
    if (what === "seek") {
      onSeek(trim ? Math.max(trim.start, Math.min(trim.end, t)) : t);
    } else if (trim && onTrim) {
      const next = what === "start" ? { start: Math.min(t, trim.end - minTrim), end: trim.end } : { start: trim.start, end: Math.max(t, trim.start + minTrim) };
      next.start = Math.max(0, next.start);
      next.end = Math.min(d, next.end);
      onTrim(next, what);
    }
  };
  const down = (what: "seek" | "start" | "end") => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(what);
    if (what === "seek") move("seek", at(e));
  };
  const onMove = (e: ReactPointerEvent) => {
    const t = at(e);
    setHover(t);
    if (drag) move(drag, t);
  };
  const up = () => setDrag(null);

  const shown = drag === "start" ? trim?.start : drag === "end" ? trim?.end : hover;
  return (
    <div className="ui-scrub" data-inline={inline || undefined} data-thumbs={thumbs ? "" : undefined} data-trim={trim ? "" : undefined} data-drag={drag ?? undefined}>
      <div
        ref={track}
        className="ui-scrub-track"
        role="slider"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.round(d)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={formatTime(time)}
        onPointerDown={down("seek")}
        onPointerMove={onMove}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={() => !drag && setHover(null)}
      >
        {thumbs ? (
          <div className="ui-scrub-frames">
            {thumbs.map((src, i) => (
              <img key={i} src={src} alt="" draggable={false} />
            ))}
          </div>
        ) : (
          <div className="ui-scrub-played" style={{ width: frac(time) }} />
        )}
        {trim && (
          <>
            <div className="ui-scrub-shade" style={{ left: 0, width: frac(trim.start) }} />
            <div className="ui-scrub-shade" style={{ left: frac(trim.end), right: 0 }} />
            <div className="ui-scrub-range" style={{ left: frac(trim.start), right: `calc(100% - ${frac(trim.end)})` }}>
              <span className="ui-scrub-handle" data-end="start" aria-label="Start" onPointerDown={down("start")} onPointerMove={onMove} onPointerUp={up} onPointerCancel={up} />
              <span className="ui-scrub-handle" data-end="end" aria-label="End" onPointerDown={down("end")} onPointerMove={onMove} onPointerUp={up} onPointerCancel={up} />
            </div>
          </>
        )}
        <div className="ui-scrub-head" style={{ left: frac(time) }} />
        {shown != null && (
          <div className="ui-scrub-tip" style={{ left: frac(shown) }}>
            {formatTime(shown, !!trim)}
          </div>
        )}
      </div>
    </div>
  );
}

export interface TimeBarProps {
  /** Seconds. */
  duration: number;
  /** Where it is now (s). */
  time: number;
  /** Runs on by itself from `time` at `rate`, smoothly (a CSS animation, no re-render per frame). */
  playing?: boolean;
  rate?: number;
  /** Click or drag to seek; called once, where the pointer is let go. */
  onSeek?: (t: number) => void;
  label?: string;
}

/**
 * A track's position, drawn like a chart's bar: a plain rectangle, what has played filled in the
 * accent. While `playing` it moves on by itself, so a caller only passes a new `time` when the
 * player reports one (a seek, a pause). Click or drag to seek; the time under the pointer floats above it.
 */
export function TimeBar({ duration, time, playing, rate = 1, onSeek, label = "Position" }: TimeBarProps) {
  const bar = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const d = duration > 0 ? duration : 1;
  const frac = (t: number) => Math.max(0, Math.min(1, t / d));
  const at = (e: { clientX: number }) => {
    const r = bar.current!.getBoundingClientRect();
    return (Math.max(0, Math.min(r.width, e.clientX - r.left)) / (r.width || 1)) * d;
  };

  // From `time` to the end at the playing rate, as one linear animation of the fill's scale.
  useLayoutEffect(() => {
    const el = fill.current;
    if (!el) return;
    const from = frac(drag ?? time);
    el.style.transform = `scaleX(${from})`;
    if (!playing || drag !== null || from >= 1 || rate <= 0) return;
    const a = el.animate([{ transform: `scaleX(${from})` }, { transform: "scaleX(1)" }], { duration: ((d - (drag ?? time)) / rate) * 1000, easing: "linear", fill: "forwards" });
    return () => a.cancel();
  }, [time, playing, rate, d, drag]);

  const down = (e: ReactPointerEvent) => {
    if (e.button !== 0 || !onSeek) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(at(e));
  };
  const move = (e: ReactPointerEvent) => {
    const t = at(e);
    setHover(t);
    if (drag !== null) setDrag(t);
  };
  const up = () => {
    if (drag !== null) onSeek?.(drag);
    setDrag(null);
  };
  const shown = drag ?? hover;
  return (
    <div
      ref={bar}
      className="ui-timebar"
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(d)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={formatTime(time)}
      data-seek={onSeek ? "" : undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => drag === null && setHover(null)}
    >
      <div ref={fill} className="ui-timebar-fill" />
      {shown !== null && onSeek && (
        <div className="ui-scrub-tip" style={{ left: `${frac(shown) * 100}%` }}>
          {formatTime(shown)}
        </div>
      )}
    </div>
  );
}
