// Arranging: forms (Section, Group, Row: the Settings window's grouped rows),
// headings, toolbars, separators, key–value lists, cards, code blocks, and the
// messages a view shows instead of or above its content (Callout, EmptyState).

import { useId, type MouseEvent, type ReactNode } from "react";
import { RowLabels } from "./labels.ts";
import { ICON, Icon, iconNode } from "./icon.tsx";
import { IconButton } from "./button.tsx";
import { useTooltip } from "./tooltips.tsx";
import type { Tone } from "./status.tsx";

const cls = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

// ── forms ──────────────────────────────────────────────

/** A titled part of a page: a heading, then its rows in a group box. */
export function FormSection({ title, aside, children, plain }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; plain?: boolean }) {
  return (
    <section className="ui-form-section">
      {(title || aside) && (
        <div className="ui-form-section-head">
          {title && <h2 className="ui-form-section-title">{title}</h2>}
          {aside && <span className="ui-form-section-aside">{aside}</span>}
        </div>
      )}
      {plain ? children : <div className="ui-group">{children}</div>}
    </section>
  );
}

/** Buttons for a FormSection, under it at the right (Restore Defaults); a hint at the left. */
export function FormActions({ hint, children }: { hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="ui-form-actions">
      {hint && <span className="ui-form-actions-hint">{hint}</span>}
      {children}
    </div>
  );
}

/** A QR code (an SVG's markup) on white, the way a camera reads it in any theme. */
export function QrCode({ svg }: { svg: string }) {
  return <div className="ui-qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * One setting: the title and description on the left, the control on the right
 * in a column that lines up down the page whatever the labels.
 */
export function FormRow({
  title,
  description,
  note,
  noteTone = "accent",
  tip,
  accessory,
  children,
  compact,
  stacked,
  titleAside,
  info,
}: {
  title: ReactNode;
  /** One short line: what the setting does. The rest goes in `info`. */
  description?: ReactNode;
  /** More about it (caveats, examples), in a card from an info button after the title. */
  info?: ReactNode;
  /** Under the description: what just happened, or what's wrong. */
  note?: ReactNode;
  noteTone?: "accent" | "danger" | "warning" | "dim";
  /** The title's tooltip (the setting's key). */
  tip?: string;
  /** After the title: a tag, a reset button. */
  accessory?: ReactNode;
  children?: ReactNode;
  /** Shorter rows for long lists (shortcuts). */
  compact?: boolean;
  /** The control under the text, full width (a long text, a list). */
  stacked?: boolean;
  /** At the end of the title's line: a link that helps fill the row in ("Get a key"). */
  titleAside?: ReactNode;
}) {
  // The controls in the row are named by its title and described by its description (labels.ts).
  const id = useId();
  const rowNote = note && (
    <div className="ui-row-note" data-tone={noteTone}>
      {note}
    </div>
  );
  return (
    <div className="ui-row" data-compact={compact || undefined} data-stacked={stacked || undefined}>
      <div className="ui-row-text">
        <div className="ui-row-title">
          {/* The tip on the name only: an accessory or a title aside has its own. */}
          <span className="ui-row-name" id={`${id}-name`} data-tip={tip}>
            {title}
          </span>
          {info ? <InfoButton>{info}</InfoButton> : null}
          {accessory}
          {titleAside ? <span className="ui-row-title-aside">{titleAside}</span> : null}
        </div>
        {description && (
          <div className="ui-row-desc" id={`${id}-desc`}>
            {description}
          </div>
        )}
        {!stacked && rowNote}
      </div>
      {children != null && (
        <div className="ui-row-control">
          <RowLabels.Provider value={{ label: `${id}-name`, desc: description ? `${id}-desc` : undefined }}>{children}</RowLabels.Provider>
        </div>
      )}
      {/* Stacked, the note is about the control above it (a key that was rejected). */}
      {stacked && rowNote}
    </div>
  );
}

/** An info button whose card (a rich tooltip, on hover or focus) says more than fits a row. */
export function InfoButton({ children }: { children: ReactNode }) {
  const tip = useTooltip<HTMLButtonElement>(() => <div className="ui-info-card">{children}</div>);
  return (
    <button ref={tip} type="button" className="ui-info-button" aria-label="More Info">
      {iconNode("info.circle", 12)}
    </button>
  );
}

/** The top of a sheet that greets or explains (onboarding, a welcome): an icon, a large title and a line under it. */
export function SheetHeader({ icon, title, subtitle }: { icon?: string | ReactNode; title: ReactNode; subtitle?: ReactNode }) {
  return (
    <header className="ui-sheet-header">
      {icon && <span className="ui-sheet-header-icon">{iconNode(icon, 40)}</span>}
      <h1 className="ui-sheet-header-title">{title}</h1>
      {subtitle && <p className="ui-sheet-header-subtitle">{subtitle}</p>}
    </header>
  );
}

/** What something offers, one feature a line: a large icon, a title and a line under it (a welcome sheet). */
export function FeatureList({ items }: { items: readonly { icon: string | ReactNode; title: ReactNode; description?: ReactNode }[] }) {
  return (
    <ul className="ui-features">
      {items.map((f, i) => (
        <li key={i} className="ui-feature">
          <span className="ui-feature-icon">{iconNode(f.icon, ICON.feature)}</span>
          <div>
            <div className="ui-feature-title">{f.title}</div>
            {f.description && <div className="ui-feature-desc">{f.description}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export type StepState = "done" | "todo" | "failed";
export interface Step {
  title: ReactNode;
  state: StepState;
  /** What's there (a done step, on its line) or what to do (the step that needs you). */
  detail?: ReactNode;
  /** What fixes it: a button, shown on the step that needs you and on failed ones. */
  action?: ReactNode;
}

const STEP_ICON: Record<StepState, string> = { done: "checkmark.circle.fill", failed: "xmark.circle.fill", todo: "circle" };
const STEP_LABEL: Record<StepState, string> = { done: "Done", failed: "Failed", todo: "To do" };

/**
 * A setup checklist: steps in order, titled as things to do. Done steps are one
 * compact line; the first that isn't done is the current one, with what to do
 * and its fix (and a way to check it again); the steps after it wait, dimmed.
 */
export function Checklist({ steps }: { steps: readonly Step[] }) {
  const current = steps.findIndex((s) => s.state !== "done");
  return (
    <div className="ui-group">
      <ol className="ui-checklist">
        {steps.map((s, i) => {
          const at = i === current ? "current" : current >= 0 && i > current ? "later" : "past";
          const open = at !== "later" && s.state !== "done";
          return (
            <li key={i} className="ui-row ui-step" data-state={s.state} data-at={at} data-compact={open ? undefined : ""} aria-current={at === "current" ? "step" : undefined}>
              <span className="ui-step-mark" role="img" aria-label={STEP_LABEL[s.state]}>
                <Icon name={STEP_ICON[s.state]} size={ICON.row + 2} />
              </span>
              <div className="ui-row-text">
                <div className="ui-row-title">{s.title}</div>
                {open && s.detail && <div className="ui-row-desc">{s.detail}</div>}
              </div>
              {s.state === "done" && s.detail && <span className="ui-step-value">{s.detail}</span>}
              {open && s.action && <div className="ui-row-control">{s.action}</div>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Running text: paragraphs, headings (h2, h3 with a dim <small>), lists, links,
 * `code`, <hr>. For Markdown-ish content (release notes, a help page), styled by
 * the elements, so the content needs no classes.
 */
export function Prose({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cls("ui-prose", className)}>{children}</div>;
}

/** A group box of rows without a section (or with your own heading). */
export function Group({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cls("ui-group", className)}>{children}</div>;
}

/** The reset glyph beside a changed setting's title. */
export function ResetButton({ onClick, label = "Reset to default" }: { onClick: () => void; label?: string }) {
  return <IconButton className="ui-reset" icon="arrow.uturn.backward" iconSize={9} size="sm" label={label} onClick={onClick} />;
}

// ── headings, bars, lines ──────────────────────────────

/**
 * A heading over a part of a view. "caps" (small capitals, dim) for dense panes
 * and sidebars, where it labels a list; "title" for a page's sections.
 */
export function SectionHeading({ children, aside, variant = "caps", tone }: { children: ReactNode; aside?: ReactNode; variant?: "caps" | "title"; tone?: "warning" }) {
  return (
    <div className="ui-heading" data-variant={variant} data-tone={tone}>
      <span>{children}</span>
      {aside != null && <span className="ui-heading-aside">{aside}</span>}
    </div>
  );
}

/** A bar of controls along a view's edge: the window toolbar, an editor's tab bar. */
export function Toolbar({ children, edge = "bottom", className, label }: { children: ReactNode; edge?: "top" | "bottom" | "none"; className?: string; label?: string }) {
  return (
    <div className={cls("ui-toolbar", className)} role="toolbar" aria-label={label} data-edge={edge}>
      {children}
    </div>
  );
}

/** Pushes what follows to the end of a row or toolbar. */
export function Spacer() {
  return <span className="ui-spacer" />;
}

export function Separator({ vertical }: { vertical?: boolean }) {
  return <span className="ui-separator" role="separator" aria-orientation={vertical ? "vertical" : "horizontal"} data-vertical={vertical || undefined} />;
}

// ── content ────────────────────────────────────────────

/** Names and values in two aligned columns (a tooltip's details, a manifest's permissions). */
export function KeyValue({ items, mono }: { items: readonly (readonly [ReactNode, ReactNode])[]; mono?: boolean }) {
  return (
    <dl className="ui-kv" data-mono={mono || undefined}>
      {items.map(([k, v], i) => (
        <div key={i} className="ui-kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A box around a piece of content that isn't a row of a form. */
export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <div className={cls("ui-card", className)} data-padded={padded || undefined}>
      {children}
    </div>
  );
}


/**
 * A file's changed lines, from a unified diff: added and removed lines on a tint of
 * their git colour, hunk headers dim, each line as it is (no wrapping; the block
 * scrolls sideways). Under a file's row in a list (Live Diff), indented past its
 * disclosure. `note` in place of lines: "Binary file".
 */
export function Diff({ lines, note }: { lines?: readonly string[]; note?: ReactNode }) {
  if (note) return <div className="ui-diff-note">{note}</div>;
  return (
    <pre className="ui-diff">
      {lines?.map((l, i) => (
        <div key={i} className="ui-diff-line" data-kind={l.startsWith("@@") ? "hunk" : l[0] === "+" ? "add" : l[0] === "-" ? "del" : undefined}>
          {l || " "}
        </div>
      ))}
    </pre>
  );
}
/** Output, errors, a command: mono, wrapped, scrolls past a height. */
export function CodeBlock({ children, maxHeight = 180, tone }: { children: ReactNode; maxHeight?: number; tone?: "danger" }) {
  return (
    <pre className="ui-code" data-tone={tone} style={{ maxHeight }}>
      {children}
    </pre>
  );
}

const TONE_ICON: Record<Tone, string> = {
  neutral: "info.circle",
  accent: "info.circle",
  success: "checkmark.circle.fill",
  warning: "exclamationmark.triangle.fill",
  danger: "exclamationmark.triangle.fill",
};

/**
 * A message above content: something failed, needs doing, or is worth knowing.
 * One line with actions on the right, or a title and text.
 */
export function Callout({
  tone = "neutral",
  title,
  children,
  actions,
  onDismiss,
  icon,
  banner,
  compact,
  className,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  /** An SF Symbol name, a node, or false for none; by default the tone's. */
  icon?: string | ReactNode | false;
  /** Full width along a view's edge, not a box: the top (a line under it) or "bottom" (a line over it). */
  banner?: boolean | "bottom";
  /** One small line (under a widget, in a narrow pane). */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cls("ui-callout", className)} data-tone={tone} data-banner={banner === "bottom" ? "bottom" : banner ? "top" : undefined} data-compact={compact || undefined} role={tone === "danger" || tone === "warning" ? "alert" : "status"}>
      {icon !== false && <span className="ui-callout-icon">{iconNode(icon ?? TONE_ICON[tone], ICON.row)}</span>}
      <div className="ui-callout-text">
        {title && <div className="ui-callout-title">{title}</div>}
        {children && <div className="ui-callout-body">{children}</div>}
      </div>
      {actions && <div className="ui-callout-actions">{actions}</div>}
      {onDismiss && <IconButton icon="xmark" size="sm" label="Dismiss" onClick={onDismiss} />}
    </div>
  );
}

/** What a view shows when it has nothing: an icon, what's missing, and how to get some. */
export function EmptyState({
  icon,
  title,
  children,
  action,
  compact,
  className,
  onMouseDown,
}: {
  icon?: string | ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
  onMouseDown?: (e: MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div className={cls("ui-empty", className)} data-compact={compact || undefined} onMouseDown={onMouseDown}>
      {icon && <span className="ui-empty-icon">{iconNode(icon, compact ? 18 : ICON.empty, "light")}</span>}
      {title && <div className="ui-empty-title">{title}</div>}
      {children && <div className="ui-empty-text">{children}</div>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}
