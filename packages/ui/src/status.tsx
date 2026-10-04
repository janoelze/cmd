// Showing state: StatusDot (the agent states and good/bad lights), Badge (a
// count or a short tag), Kbd (a key or shortcut), Progress (a bar), Spinner,
// and ProgressRing (a small determinate ring).

import { useLayoutEffect, useRef, type ReactNode } from "react";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

/**
 * A small light: a 2×2 dot matrix. Agent states follow the sidebar's: needs
 * (wants you, blinks), unseen (finished, not looked at), working (chases round),
 * done, idle, off. The tones are for anything else (a check passed, data failing).
 */
export type DotState = "needs" | "unseen" | "working" | "done" | "idle" | "off" | Tone;

/** States entered with a one-off animation (components.css, data-enter). */
const ENTER = new Set<DotState>(["needs", "unseen"]);
/** The loops' period; their phase follows the document clock so every dot is in step. */
const LOOP_MS = 1200;

export function StatusDot({ state = "neutral", size = "md", label }: { state?: DotState; size?: "sm" | "md"; label?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(state);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--ui-dot-phase", `${-((performance.now() % LOOP_MS) / 1000).toFixed(3)}s`);
    if (prev.current === state) return;
    prev.current = state;
    if (!ENTER.has(state)) return void delete el.dataset.enter;
    el.dataset.enter = state;
    // The pop ends on the dot, the burst on its pixels (bubbling); loops never end.
    const end = () => delete el.dataset.enter;
    el.addEventListener("animationend", end, { once: true });
    return () => el.removeEventListener("animationend", end);
  }, [state]);
  return (
    <span ref={ref} className="ui-dot" data-state={state} data-size={size} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

/** A count ("3") or a short tag ("Beta", "Default"). */
export function Badge({ tone = "neutral", size = "md", solid, children, tip }: { tone?: Tone; size?: "sm" | "md"; solid?: boolean; children: ReactNode; tip?: string }) {
  return (
    <span className="ui-badge" data-tone={tone} data-size={size} data-solid={solid || undefined} data-tip={tip}>
      {children}
    </span>
  );
}

/** A shortcut as keycaps: "⌘⇧P" or ["⌘", "K"]. */
export function Kbd({ keys, plain }: { keys: string | readonly string[]; plain?: boolean }) {
  if (plain || typeof keys === "string") return <kbd className="ui-kbd" data-plain={plain || undefined}>{typeof keys === "string" ? keys : keys.join("")}</kbd>;
  return (
    <span className="ui-kbd-group">
      {keys.map((k, i) => (
        <kbd key={i} className="ui-kbd">
          {k}
        </kbd>
      ))}
    </span>
  );
}

/** Done so far (0–1), or indeterminate without a value. */
export function Progress({ value, tone = "accent", width, label }: { value?: number; tone?: Tone; width?: number | string; label?: string }) {
  const pct = value == null ? undefined : Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span
      className="ui-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      data-tone={tone}
      data-indeterminate={pct == null || undefined}
      style={{ width }}
    >
      <span style={pct == null ? undefined : { width: `${pct}%` }} />
    </span>
  );
}

/** Something is happening and will take a moment. */
export function Spinner({ size = 12, label }: { size?: number; label?: string }) {
  return <span className="ui-spinner" role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true} style={{ width: size, height: size }} />;
}

/** A small determinate ring, for progress inside a field or a row (indexing). */
export function ProgressRing({ value, size = 14, label }: { value: number; size?: number; label?: string }) {
  const r = (size - 2) / 2;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, value));
  return (
    <svg className="ui-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
      <circle className="ui-ring-track" cx={size / 2} cy={size / 2} r={r} />
      <circle
        className="ui-ring-fill"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeDasharray={`${f * c} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
