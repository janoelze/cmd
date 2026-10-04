// Choosing: Switch (on/off that applies at once), Checkbox (on/off in a list or
// beside a sentence), RadioGroup (one of a few, each with room to explain),
// Segmented (one of a few short ones, side by side), Tabs (which view is
// shown), Select (one of many: a native popup menu).
//
// Options are given as values with an optional labels map (how the settings
// schema describes enums), or as { value, label, icon } objects.

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { ICON, Icon, iconNode } from "./icon.tsx";
import type { Size } from "./button.tsx";

export type Option<T extends string> = T | { value: T; label?: ReactNode; icon?: string | ReactNode; disabled?: boolean; tip?: string; shortcut?: string };

interface Opt<T extends string> {
  value: T;
  label: ReactNode;
  icon?: string | ReactNode;
  disabled?: boolean;
  tip?: string;
  shortcut?: string;
}

function normalize<T extends string>(options: readonly Option<T>[], labels?: Readonly<Partial<Record<T, ReactNode>>>): Opt<T>[] {
  return options.map((o) =>
    typeof o === "string" ? { value: o, label: labels?.[o] ?? o } : { ...o, label: o.label ?? labels?.[o.value] ?? (o.icon ? undefined : o.value) },
  );
}

const cls = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/** Arrow keys move between a group's buttons and choose (radio groups and tab lists behave so on macOS). */
function arrowNav(e: KeyboardEvent<HTMLElement>, choose: (el: HTMLButtonElement) => void, vertical = false): void {
  const keys = vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
  if (!keys.includes(e.key) && e.key !== "Home" && e.key !== "End") return;
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  e.preventDefault();
  const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (e.key === keys[1] ? 1 : -1) + items.length) % items.length;
  items[next]!.focus();
  choose(items[next]!);
}

// ── on/off ─────────────────────────────────────────────

export function Switch({
  checked,
  onChange,
  label,
  size = "md",
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** The accessible name (the row's title says it visually). */
  label: string;
  size?: "sm" | "md";
  disabled?: boolean;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="ui-switch" data-size={size} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="ui-switch-knob" />
    </button>
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
  disabled,
  mixed,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** The label; clicking it toggles too. */
  children?: ReactNode;
  disabled?: boolean;
  /** Some but not all (a group's parent). */
  mixed?: boolean;
  description?: ReactNode;
}) {
  const state = mixed ? "mixed" : checked;
  return (
    <label className="ui-check" data-disabled={disabled || undefined}>
      <button type="button" role="checkbox" aria-checked={state} className="ui-check-box" disabled={disabled} onClick={() => onChange(!checked)}>
        {mixed ? <span className="ui-check-dash" /> : checked && <Icon name="checkmark" size={9} weight="bold" />}
      </button>
      {children != null && (
        <span className="ui-check-text">
          <span>{children}</span>
          {description && <span className="ui-check-desc">{description}</span>}
        </span>
      )}
    </label>
  );
}

// ── one of several ─────────────────────────────────────

export function RadioGroup<T extends string>({
  value,
  options,
  labels,
  descriptions,
  onChange,
  label,
  horizontal,
}: {
  value: T;
  options: readonly Option<T>[];
  labels?: Readonly<Partial<Record<T, ReactNode>>>;
  descriptions?: Readonly<Partial<Record<T, ReactNode>>>;
  onChange: (v: T) => void;
  label?: string;
  horizontal?: boolean;
}) {
  const opts = normalize(options, labels);
  return (
    <div className="ui-radios" role="radiogroup" aria-label={label} data-horizontal={horizontal || undefined} onKeyDown={(e) => arrowNav(e, (el) => onChange(el.value as T), !horizontal)}>
      {opts.map((o) => (
        <label key={o.value} className="ui-check" data-disabled={o.disabled || undefined}>
          <button
            type="button"
            role="radio"
            value={o.value}
            aria-checked={o.value === value}
            tabIndex={o.value === value ? 0 : -1}
            className="ui-radio"
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
          />
          <span className="ui-check-text">
            <span>{o.label}</span>
            {descriptions?.[o.value] && <span className="ui-check-desc">{descriptions[o.value]}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * A few short, mutually exclusive choices side by side (Auto | Dark | Light,
 * or icons for a view mode). The chosen one is a raised thumb.
 */
export function Segmented<T extends string>({
  value,
  options,
  labels,
  onChange,
  size = "md",
  label,
  fill,
}: {
  value: T;
  options: readonly Option<T>[];
  labels?: Readonly<Partial<Record<T, ReactNode>>>;
  onChange: (v: T) => void;
  size?: Size;
  label?: string;
  /** Stretch to the container's width, segments equal. */
  fill?: boolean;
}) {
  const opts = normalize(options, labels);
  return (
    <div
      className="ui-seg"
      role="radiogroup"
      aria-label={label}
      data-size={size}
      data-fill={fill || undefined}
      onKeyDown={(e) => arrowNav(e, (el) => onChange(el.value as T))}
    >
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          value={o.value}
          aria-checked={o.value === value}
          aria-label={typeof o.label === "string" ? undefined : o.tip}
          tabIndex={o.value === value ? 0 : -1}
          disabled={o.disabled}
          data-tip={o.tip}
          data-tip-key={o.shortcut}
          onClick={() => onChange(o.value)}
        >
          {iconNode(o.icon, size === "sm" ? ICON.small : ICON.row)}
          {o.label != null && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  icon?: string | ReactNode;
  /** A count, or "dot" for "something here wants you". */
  badge?: number | "dot";
  /** The badge's tone. */
  tone?: "accent" | "warning" | "danger" | "success";
  disabled?: boolean;
}

/**
 * Which of a view's panes is shown. "pill" (default) for a window's own bar
 * (the Magic editor); "underline" for a page divided into parts. Pair with
 * <TabPanel> for the content, or switch it yourself.
 */
export function Tabs<T extends string>({
  value,
  items,
  onChange,
  variant = "pill",
  label,
  idPrefix,
}: {
  value: T;
  items: readonly TabItem<T>[];
  onChange: (v: T) => void;
  variant?: "pill" | "underline";
  label?: string;
  /** Links each tab to its TabPanel (aria-controls). */
  idPrefix?: string;
}) {
  return (
    <div className="ui-tabs" role="tablist" aria-label={label} data-variant={variant} onKeyDown={(e) => arrowNav(e, (el) => onChange(el.value as T))}>
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          value={t.id}
          id={idPrefix && `${idPrefix}-tab-${t.id}`}
          aria-controls={idPrefix && `${idPrefix}-panel-${t.id}`}
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          disabled={t.disabled}
          onClick={() => onChange(t.id)}
        >
          {iconNode(t.icon, ICON.row)}
          <span>{t.label}</span>
          {t.badge === "dot" ? (
            <span className="ui-tab-dot" data-tone={t.tone ?? "warning"} />
          ) : t.badge != null && t.badge > 0 ? (
            <span className="ui-badge" data-tone={t.tone ?? "neutral"} data-size="sm">
              {t.badge}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ id, idPrefix, children, className }: { id: string; idPrefix: string; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} className={className}>
      {children}
    </div>
  );
}

/**
 * One of many: a native popup menu (macOS draws the menu, with type-to-select
 * and the checkmark). For a few short choices prefer Segmented.
 */
export function Select<T extends string>({
  value,
  options,
  labels,
  onChange,
  disabled,
  size = "md",
  width,
  label,
  placeholder,
}: {
  value: T;
  options: readonly Option<T>[];
  labels?: Readonly<Partial<Record<T, ReactNode>>>;
  onChange: (v: T) => void;
  disabled?: boolean;
  size?: Size;
  /** CSS width; by default it fits the longest option, at least 150px. */
  width?: number | string;
  label?: string;
  /** Shown (and not choosable) when the value isn't one of the options. */
  placeholder?: string;
}) {
  const opts = normalize(options, labels);
  const known = opts.some((o) => o.value === value);
  const ref = useRef<HTMLSelectElement>(null);
  return (
    <span className={cls("ui-select")} data-size={size} style={width != null ? { width } : undefined}>
      <select ref={ref} value={value} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.value as T)}>
        {!known && (
          <option value={value} disabled>
            {placeholder ?? value}
          </option>
        )}
        {opts.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {typeof o.label === "string" || typeof o.label === "number" ? o.label : o.value}
          </option>
        ))}
      </select>
      <Icon name="chevron.up.chevron.down" size={ICON.control} weight="semibold" />
    </span>
  );
}
