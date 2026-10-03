// Controls for the Settings window: switch, segmented control, popup, number
// field, text field and secret field. Each shows the setting's current value
// and calls onChange with a valid one; text-like fields commit on Enter or blur
// (Escape reverts). They share one height and the UI font, so a page reads as
// a form rather than as the JSON behind it.

import { useEffect, useRef, useState } from "react";
import { Symbol } from "../components/Symbol.tsx";

export function Switch({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={value} aria-label={label} className="sw-switch" onClick={() => onChange(!value)}>
      <span className="sw-switch-knob" />
    </button>
  );
}

export function Segmented({
  value,
  options,
  labels,
  onChange,
}: {
  value: string;
  options: readonly string[];
  labels?: Readonly<Record<string, string>>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="sw-seg" role="radiogroup">
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={o === value} className={o === value ? "on" : ""} onClick={() => onChange(o)}>
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

export function Popup({
  value,
  options,
  labels,
  disabled,
  onChange,
}: {
  value: string;
  options: readonly string[];
  labels?: Readonly<Record<string, string>>;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <span className="sw-popup">
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? o}
          </option>
        ))}
      </select>
      <Symbol name="chevron.up.chevron.down" size={9} weight="semibold" />
    </span>
  );
}

const decimals = (step: number) => (String(step).split(".")[1] ?? "").length;
const clamp = (v: number, min = -Infinity, max = Infinity) => Math.min(max, Math.max(min, v));

/** A number as text: type it (Enter or blur commits, Escape reverts), ↑/↓ or the stepper step it (Shift ×10). */
export function NumberField({
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  const dp = decimals(step);
  const fmt = (v: number) => v.toFixed(dp);
  const [draft, setDraft] = useState(fmt(value));
  useEffect(() => setDraft(fmt(value)), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (v: number) => {
    v = clamp(Number(v.toFixed(dp)), min, max);
    setDraft(fmt(v));
    if (v !== value) onChange(v);
  };
  const commit = () => {
    const n = Number(draft);
    // Empty or not a number: "never mind", back to the current value.
    if (!draft.trim() || !Number.isFinite(n)) setDraft(fmt(value));
    else set(n);
  };
  const current = () => {
    const n = Number(draft);
    return draft.trim() && Number.isFinite(n) ? n : value;
  };
  const bump = (d: number, big = false) => set(current() + d * step * (big ? 10 : 1));
  return (
    <span className="nf">
      <span className="nf-box">
        <input
          inputMode="decimal"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") setDraft(fmt(value));
            else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              bump(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
            }
          }}
        />
        {unit && <span className="nf-unit">{unit}</span>}
      </span>
      <span className="nf-step">
        <button type="button" tabIndex={-1} aria-label="Increase" disabled={max !== undefined && value >= max} onClick={(e) => bump(1, e.shiftKey)}>
          <Symbol name="chevron.up" size={7} weight="bold" />
        </button>
        <button type="button" tabIndex={-1} aria-label="Decrease" disabled={min !== undefined && value <= min} onClick={(e) => bump(-1, e.shiftKey)}>
          <Symbol name="chevron.down" size={7} weight="bold" />
        </button>
      </span>
    </span>
  );
}

export function TextField({
  value,
  placeholder,
  font,
  code,
  onChange,
}: {
  value: string;
  placeholder?: string;
  /** Render the text in this font family (the font setting shows itself). */
  font?: string;
  /** Commands and paths: the mono font. */
  code?: boolean;
  onChange: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onChange(draft);
  return (
    <input
      className={`sw-field${code ? " code" : ""}`}
      style={font ? { fontFamily: `${font}, var(--font-mono)` } : undefined}
      value={draft}
      placeholder={placeholder}
      title={draft.length > 30 ? draft : undefined}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}

/**
 * A secret (an API key): never shown. Set, it reads "••••abcd" with Change and
 * Remove; otherwise (or while changing) a password field that saves on Enter.
 */
export function SecretField({
  set,
  hint,
  placeholder,
  onSave,
}: {
  set: boolean;
  hint?: string;
  placeholder?: string;
  onSave: (v: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  const done = () => (setEditing(false), setDraft(""));
  if (set && !editing) {
    return (
      <span className="sw-secret">
        <span className="sw-secret-set">{hint ? hint.replace(/^…/, "••••") : "Set"}</span>
        <button type="button" className="sw-button" onClick={() => setEditing(true)}>
          Change…
        </button>
        <button type="button" className="sw-button" onClick={() => onSave(null)}>
          Remove
        </button>
      </span>
    );
  }
  const save = () => {
    if (draft.trim()) onSave(draft.trim());
    done();
  };
  return (
    <span className="sw-secret">
      <input
        ref={ref}
        className="sw-field code"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          else if (e.key === "Escape") done();
        }}
        onBlur={() => !draft.trim() && done()}
      />
      <button type="button" className="sw-button primary" disabled={!draft.trim()} onMouseDown={(e) => e.preventDefault()} onClick={save}>
        Save
      </button>
    </span>
  );
}
