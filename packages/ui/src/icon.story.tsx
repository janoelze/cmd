// Icons: Phosphor, by name, at the sizes and in the weights the kit uses.
import { Icon, ICON, type IconName, type IconWeight } from "./icon.tsx";

const NAMES: IconName[] = ["terminal-window", "folder", "file-text", "magnifying-glass", "gear", "sparkle", "arrow-clockwise", "trash", "caret-right", "x", "check-circle", "warning"];

const Grid = ({ weight }: { weight?: IconWeight }) => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 72px)", gap: "var(--space-3)" }}>
    {NAMES.map((n) => (
      <div key={n} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-1)", color: "var(--icon)" }}>
        <Icon name={n} size={ICON.row} weight={weight} />
        <span style={{ font: "var(--text-2xs) var(--font-mono)", color: "var(--text-dim)", textAlign: "center", wordBreak: "break-all" }}>{n}</span>
      </div>
    ))}
  </div>
);

/** Regular: most icons. */
export const Regular = () => <Grid />;

/** Bold: small glyphs inside controls (steppers, a clear button, a checkbox's check). */
export const Bold = () => <Grid weight="bold" />;

/** Fill: a solid mark (a play button, a filled status). */
export const Fill = () => <Grid weight="fill" />;

/** Light: big marks (a missing album cover). */
export const Light = () => <Grid weight="light" />;

/** The kit's sizes (ICON): small, row, control, disclosure. */
export const Sizes = () => (
  <div style={{ display: "flex", gap: "var(--space-5)", alignItems: "end", color: "var(--icon)" }}>
    {Object.entries(ICON).map(([k, size]) => (
      <div key={k} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-1)" }}>
        <Icon name="sparkle" size={size} />
        <span style={{ font: "var(--text-2xs) var(--font-mono)", color: "var(--text-dim)" }}>
          {k} {size}
        </span>
      </div>
    ))}
  </div>
);
