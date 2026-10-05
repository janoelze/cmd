// Typing: TextField, SearchField, TextArea, NumberField and SecretField. All
// share the control height and the field look (the well, a hairline edge, the
// accent halo on focus).
//
// Two ways to report a value: live (onChange on every keystroke, for search and
// forms the caller submits) or commit (onCommit on Enter or blur, Escape
// reverts: for values that apply at once, like a setting, so half-typed text
// never does).

import { forwardRef, useEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from "react";
import { ICON, Icon, iconNode } from "./icon.tsx";
import { Button, type Size } from "./button.tsx";
import { Spinner } from "./status.tsx";

const cls = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "value" | "onChange" | "prefix">;

export interface TextFieldProps extends InputProps {
  value: string;
  /** Live: every keystroke. */
  onChange?: (v: string) => void;
  /** Commit: Enter or blur, when the text changed; Escape reverts. With onCommit the field keeps its own draft. */
  onCommit?: (v: string) => void;
  size?: Size;
  /** Commands, paths, keys: the mono font. */
  code?: boolean;
  /** An SF Symbol name or a node inside the field, at the start. */
  icon?: string | ReactNode;
  /** Inside the field at the end: a unit, a count, a clear button. */
  end?: ReactNode;
  /** CSS width; default 240px (fill: 100%). */
  width?: number | string;
  fill?: boolean;
  invalid?: boolean;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { value, onChange, onCommit, size = "md", code, icon, end, width, fill, invalid, className, onKeyDown, onBlur, style, ...rest },
  ref,
) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const committing = !!onCommit;
  const shown = committing ? draft : value;
  const commit = () => committing && draft !== value && onCommit!(draft);
  return (
    <span
      className={cls("ui-field", className)}
      data-size={size}
      data-code={code || undefined}
      data-invalid={invalid || undefined}
      data-disabled={rest.disabled || undefined}
      style={{ width: fill ? "100%" : width, ...style }}
    >
      {icon != null && <span className="ui-field-icon">{iconNode(icon, ICON.control + 2)}</span>}
      <input
        ref={ref}
        spellCheck={false}
        value={shown}
        data-tip={shown.length > 30 && !rest.type ? shown : undefined}
        onChange={(e) => (committing ? setDraft(e.target.value) : onChange?.(e.target.value))}
        onBlur={(e) => (commit(), onBlur?.(e))}
        onKeyDown={(e) => {
          if (committing && e.key === "Enter") commit();
          else if (committing && e.key === "Escape") setDraft(value);
          onKeyDown?.(e);
        }}
        aria-invalid={invalid || undefined}
        {...rest}
      />
      {end != null && <span className="ui-field-end">{end}</span>}
    </span>
  );
});

/** Filter-as-you-type: a magnifier, a clear button once there is text, Escape clears. */
export const SearchField = forwardRef<HTMLInputElement, Omit<TextFieldProps, "onCommit" | "icon"> & { onChange: (v: string) => void; status?: ReactNode }>(
  function SearchField({ value, onChange, status, end, onKeyDown, placeholder = "Search", ...rest }, ref) {
    return (
      <TextField
        ref={ref}
        {...rest}
        className={cls("ui-search", rest.className)}
        icon="magnifyingglass"
        value={value}
        placeholder={placeholder}
        onChange={onChange}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onChange("");
          }
          onKeyDown?.(e);
        }}
        end={
          (status || value || end) && (
            <>
              {status}
              {value && <ClearButton label="Clear" onClick={() => onChange("")} />}
              {end}
            </>
          )
        }
      />
    );
  },
);

/** The small round × inside a field or on a chip. */
export function ClearButton({ label = "Clear", onClick }: { label?: string; onClick: () => void }) {
  return (
    <button type="button" className="ui-clear" aria-label={label} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <Icon name="xmark.circle.fill" size={ICON.control + 3} />
    </button>
  );
}

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> {
  value: string;
  onChange: (v: string) => void;
  /** ⌘↩ (or ↩ with submitOnEnter; ⇧↩ then breaks the line). */
  onSubmit?: () => void;
  submitOnEnter?: boolean;
  code?: boolean;
  /** Grow with the text up to this many rows (then scroll). */
  autoGrow?: number;
  /** A prompt: larger text, no box (the field is the view). */
  bare?: boolean;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { value, onChange, onSubmit, submitOnEnter, code, autoGrow, bare, className, onKeyDown, rows = 3, ...rest },
  outer,
) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = inner.current;
    if (!el || !autoGrow) return;
    const css = getComputedStyle(el);
    const line = parseFloat(css.lineHeight) || 18;
    // scrollHeight counts padding, not borders.
    const pad = parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
    const edge = el.offsetHeight - el.clientHeight;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, line * autoGrow + pad) + edge}px`;
  }, [value, autoGrow]);
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (onSubmit && e.key === "Enter" && !e.nativeEvent.isComposing && (e.metaKey || (submitOnEnter && !e.shiftKey))) {
      e.preventDefault();
      onSubmit();
    }
    onKeyDown?.(e);
  };
  return (
    <textarea
      ref={(el) => {
        inner.current = el;
        if (typeof outer === "function") outer(el);
        else if (outer) outer.current = el;
      }}
      className={cls("ui-textarea", className)}
      data-code={code || undefined}
      data-bare={bare || undefined}
      rows={rows}
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={keys}
      {...rest}
    />
  );
});

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
  disabled,
  label,
  width,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
  label?: string;
  width?: number;
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
    <span className="ui-number" data-disabled={disabled || undefined}>
      <span className="ui-field" data-size="md" style={width ? { width } : undefined}>
        <input
          inputMode="decimal"
          spellCheck={false}
          aria-label={label}
          disabled={disabled}
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
        {unit && <span className="ui-field-end ui-unit">{unit}</span>}
      </span>
      <span className="ui-stepper">
        <button type="button" tabIndex={-1} aria-label="Increase" disabled={disabled || (max !== undefined && value >= max)} onClick={(e) => bump(1, e.shiftKey)}>
          <Icon name="chevron.up" size={7} weight="bold" />
        </button>
        <button type="button" tabIndex={-1} aria-label="Decrease" disabled={disabled || (min !== undefined && value <= min)} onClick={(e) => bump(-1, e.shiftKey)}>
          <Icon name="chevron.down" size={7} weight="bold" />
        </button>
      </span>
    </span>
  );
}

/**
 * A secret (an API key, a token): never shown. Set, it reads "••••abcd" with
 * Change and Remove; otherwise (or while changing) a password field that saves
 * on Enter or Save. An onSave that returns a promise is waited for (a key being
 * checked): the field stays as typed if it rejects, so it can be corrected.
 * live: no Save button; it saves as soon as a key is pasted, or after a pause in
 * typing (a key the app checks, so half a key is only ever rejected).
 */
export function SecretField({
  set,
  hint,
  placeholder,
  onSave,
  width = 190,
  fill,
  autoFocus,
  live,
}: {
  set: boolean;
  /** The last characters ("…abcd"), shown masked. */
  hint?: string;
  placeholder?: string;
  /** null removes it. */
  onSave: (v: string | null) => void | Promise<unknown>;
  width?: number;
  /** As wide as its container (a stacked row). */
  fill?: boolean;
  autoFocus?: boolean;
  live?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pasted = useRef(false);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const done = () => (setEditing(false), setDraft(""), setFailed(false));
  if (set && !editing) {
    return (
      <span className="ui-secret" data-fill={fill || undefined}>
        <span className="ui-secret-set">{hint ? hint.replace(/^…/, "••••") : "Set"}</span>
        <Button onClick={() => setEditing(true)}>Change…</Button>
        <Button onClick={() => onSave(null)}>Remove</Button>
      </span>
    );
  }
  const save = (value = draft) => {
    clearTimeout(timer.current);
    const v = value.trim();
    if (!v || busy) return;
    const r = onSave(v);
    if (!(r instanceof Promise)) return done();
    setBusy(true);
    r.then(
      () => (setBusy(false), done()),
      () => (setBusy(false), setFailed(true), setEditing(true), requestAnimationFrame(() => ref.current?.select())),
    );
  };
  const change = (v: string) => {
    setDraft(v);
    setFailed(false);
    if (!live) return;
    clearTimeout(timer.current);
    const now = pasted.current;
    pasted.current = false;
    if (v.trim()) timer.current = setTimeout(() => save(v), now ? 0 : 900);
  };
  return (
    <span className="ui-secret" data-fill={fill || undefined}>
      <TextField
        ref={ref}
        code
        type="password"
        autoComplete="off"
        autoFocus={autoFocus}
        width={width}
        fill={fill}
        value={draft}
        placeholder={placeholder}
        readOnly={busy}
        invalid={failed}
        end={busy && live ? <Spinner size={11} label="Checking" /> : undefined}
        onChange={change}
        onPaste={() => (pasted.current = true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          else if (e.key === "Escape") (clearTimeout(timer.current), done());
        }}
        onBlur={() => !draft.trim() && !busy && done()}
      />
      {!live && (
        <Button variant="primary" disabled={!draft.trim() || busy} onMouseDown={(e) => e.preventDefault()} onClick={() => save()}>
          {busy ? <Spinner size={11} label="Checking" /> : "Save"}
        </Button>
      )}
    </span>
  );
}
