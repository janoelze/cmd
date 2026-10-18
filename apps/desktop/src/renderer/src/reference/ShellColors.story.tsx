// A tuning bench for the window shell's
// colours. The backdrop behind windows, the title bar, the toolbar, the outline and how
// unselected windows are dimmed are each a recipe over the theme's tokens (a base token,
// shifted lighter or darker), so one recipe is judged in every theme at once. Board is
// the workbench's theme, large; Themes is every built-in theme side by side. The recipe
// is kept in localStorage, so shots and remounts show the current tuning; the panel
// prints it as the CSS it would become.

import { Button, Segmented, Select, Switch, ToolbarButton, ToolbarGroup, ToolbarSearchField, ToolbarSpacer, Window, WindowBar, WindowBody, WindowFrame, WindowToolbar, type IconName } from "@cmd/ui";
import { allThemes, themeVars, useTheme } from "@cmd/ui/themes";
import type { Theme } from "@cmd/ui/themes/types";
import { useState, type CSSProperties, type ReactNode } from "react";
import tokensCss from "../../../../../../packages/ui/src/tokens.css?raw";

type Base = "bg" | "bg-sidebar" | "well" | "bg-elevated";
/** A base token, optionally mixed toward another (`toward` at `mix` %), then shifted lighter or darker. */
type Surface = { base: Base; shift: number; toward?: Base | null; mix?: number };
type Recipe = {
  backdrop: Surface;
  bar: Surface;
  toolbar: Surface;
  /** The toolbar takes the title bar's recipe: one chrome surface. */
  toolbarIsBar?: boolean;
  /** The outline premixed over the title bar's colour instead of --bg-sidebar. */
  edgeOverChrome?: boolean;
  /** Toolbar fields: in the well (before), or recessed into the toolbar (its colour toward --scrim by `fieldDim` %) with the window's outline colour. */
  field?: "well" | "recessed";
  fieldDim?: number;
  edgeMix: number;
  /** ui.unfocusedDim, %: times the theme's --window-dim. */
  dim: number;
  dimScope: "window" | "content" | "off";
  tint: "off" | "subtle" | "strong";
  barLine: boolean;
};

const BEFORE: Recipe = {
  backdrop: { base: "bg", shift: 0 },
  bar: { base: "bg-sidebar", shift: 0 },
  toolbar: { base: "bg", shift: 0 },
  edgeMix: 20,
  dim: 20,
  dimScope: "window",
  tint: "subtle",
  barLine: true,
  toolbarIsBar: false,
  edgeOverChrome: false,
  field: "well",
  fieldDim: 6,
};
/** Backdrop → chrome → content, one step each way: chrome between --bg and --well, one tone for bar and toolbar. */
const ORDERED: Recipe = { ...BEFORE, bar: { base: "bg", toward: "well", mix: 50, shift: 0 }, toolbarIsBar: true, edgeOverChrome: true, field: "recessed", fieldDim: 14, edgeMix: 10, dim: 23, tint: "off", dimScope: "content" };
const PRESETS: Record<string, Recipe> = {
  Ordered: ORDERED,
  Before: BEFORE,
  "Toolbar = bar": { ...BEFORE, toolbar: { base: "bg-sidebar", shift: 0 } },
  "One chrome, no line": { ...BEFORE, toolbar: { base: "bg-sidebar", shift: 0 }, barLine: false },
  "Chrome from well": { ...BEFORE, bar: { base: "well", shift: 2 }, toolbar: { base: "well", shift: 2 }, barLine: false },
  "Dim content only": { ...BEFORE, toolbar: { base: "bg-sidebar", shift: 0 }, dimScope: "content" },
};

const KEY = "wb.shellcolors";
function load(): Recipe {
  try {
    return { ...ORDERED, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return ORDERED;
  }
}
function useRecipe(): [Recipe, (r: Recipe) => void] {
  const [r, set] = useState(load);
  return [r, (n) => (set(n), localStorage.setItem(KEY, JSON.stringify(n)))];
}

/** A base token shifted lighter (+) or darker (−) by |shift| % of white or black. */
function surface({ base, shift, toward, mix = 50 }: Surface): string {
  const c = toward ? `color-mix(in oklab, var(--${toward}) ${mix}%, var(--${base}))` : `var(--${base})`;
  return shift === 0 ? c : `color-mix(in oklab, ${shift > 0 ? "#fff" : "#000"} ${Math.abs(shift)}%, ${c})`;
}
const TINT = { off: 0, subtle: 8, strong: 18 };

function recipeVars(r: Recipe): Record<string, string> {
  return {
    "--shell-backdrop": surface(r.backdrop),
    "--window-bar-bg": surface(r.bar),
    "--toolbar-bg": r.toolbarIsBar ? "var(--window-bar-bg)" : surface(r.toolbar),
    "--window-edge-mix": `${r.edgeMix}%`,
    "--window-dim-amount": String(r.dim / 100),
  };
}

// tokens.css's :root, so a cell re-derives every token from its own theme's colours
// (derived tokens resolve where they're declared, which is :root, the workbench's theme).
const ROOT = (() => {
  const block = tokensCss.slice(tokensCss.indexOf(":root {"), tokensCss.indexOf("\n}", tokensCss.indexOf(":root {")));
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]!.trim()]));
})();
const themed = (t: Theme, r: Recipe) => ({ ...ROOT, ...themeVars(t), ...recipeVars(r) }) as CSSProperties;

// ── the scene ──────────────────────────────────────────

const LINES = ["~/src/cmd master", "❯ pnpm test", " ✓ packages/core/test/osc.test.ts (42)", " ✓ packages/ui/test/tokens.test.ts (9)", " Test Files  2 passed", "❯ "];

function Shell({ r, name, icon, selected, toolbar = true, width, height }: { r: Recipe; name: string; icon: IconName; selected?: boolean; toolbar?: boolean; width: number | string; height: number }) {
  const dimTop = r.dimScope === "content" ? `calc(var(--window-bar-h) + ${toolbar ? "var(--toolbar-h)" : "0px"})` : "0px";
  const tint = selected && TINT[r.tint] ? { background: `color-mix(in srgb, var(--ring-color) ${TINT[r.tint]}%, var(--window-bar-bg))` } : undefined;
  return (
    <Window selected={selected} style={{ width, height, flex: width === "auto" ? 1 : "none", minWidth: 0, position: "relative", "--window-edge": `color-mix(in srgb, var(--ink) var(--window-edge-mix), var(${r.edgeOverChrome ? "--window-bar-bg" : "--bg-sidebar"}))`, "--toolbar-field-bg": r.field === "recessed" ? `color-mix(in oklab, var(--scrim) ${r.fieldDim ?? 6}%, var(--toolbar-bg))` : "var(--well)" } as CSSProperties}>
      <WindowBody style={{ height: "100%" }}>
        <WindowBar icon={icon} name={name} style={{ ...tint, ...(r.barLine || !toolbar ? null : { boxShadow: "none" }) }} />
        {toolbar && (
          <WindowToolbar label={name}>
            <ToolbarGroup>
              <ToolbarButton icon="caret-left" label="Back" />
              <ToolbarButton icon="caret-right" label="Forward" />
            </ToolbarGroup>
            <ToolbarSpacer />
            <ToolbarSearchField value="" onChange={() => {}} placeholder="Find" minWidth={70} />
            <ToolbarButton icon="sidebar-simple" label="Inspector" />
          </WindowToolbar>
        )}
        <div style={{ flex: 1, padding: "var(--space-1-5) var(--inset)", font: "var(--text-sm) var(--font-mono)", color: "var(--text)", lineHeight: 1.5, whiteSpace: "pre", overflow: "hidden" }}>
          {LINES.map((l, i) => (
            <div key={i} style={{ color: l.startsWith(" ✓") ? "var(--state-done)" : l.startsWith("~") ? "var(--accent)" : undefined }}>
              {l}
            </div>
          ))}
        </div>
      </WindowBody>
      {!selected && r.dimScope !== "off" && (
        <div style={{ position: "absolute", inset: 0, top: dimTop, zIndex: 2, pointerEvents: "none", background: "var(--scrim)", opacity: "min(1, calc(var(--window-dim) * var(--window-dim-amount)))", borderRadius: r.dimScope === "content" ? "0 0 var(--window-radius-inner) var(--window-radius-inner)" : "var(--window-radius-inner)" }} />
      )}
      <WindowFrame />
    </Window>
  );
}

function Scene({ theme, r, height, label }: { theme: Theme; r: Recipe; height: number; label?: string })  {
  return (
    <div style={{ ...themed(theme, r), background: "var(--shell-backdrop)", color: "var(--text)", padding: 12, borderRadius: 6, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      {label && <div style={{ font: "500 var(--text-xs) var(--font-ui)", color: "var(--text-dim)" }}>{label}</div>}
      <div style={{ display: "flex", gap: 10, minWidth: 0 }}>
        <Shell r={r} name="Files" icon="folder" toolbar={false} width={height * 0.45} height={height} />
        <Shell r={r} name="zsh" icon="terminal-window" selected width="auto" height={height} />
        <Shell r={r} name="claude" icon="sparkle" width="auto" height={height} />
      </div>
    </div>
  );
}

// ── the panel ──────────────────────────────────────────

const BASES: Base[] = ["bg", "bg-sidebar", "well", "bg-elevated"];

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 28 }}>
      <span style={{ width: 84, flex: "none", color: "var(--text-dim)" }}>{title}</span>
      {children}
    </div>
  );
}

function Range({ value, min, max, onChange, unit = "" }: { value: number; min: number; max: number; onChange: (v: number) => void; unit?: string }) {
  return (
    <>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={() => onChange(0)} style={{ flex: 1, minWidth: 0, accentColor: "var(--accent)" }} />
      <span style={{ width: 34, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {value > 0 && unit === "" ? "+" : ""}
        {value}
        {unit}
      </span>
    </>
  );
}

function SurfaceRow({ title, s, onChange }: { title: string; s: Surface; onChange: (s: Surface) => void }) {
  return (
    <>
      <Row title={title}>
        <Select size="sm" width={104} value={s.base} options={BASES} onChange={(base) => onChange({ ...s, base })} />
        <Range value={s.shift} min={-12} max={12} onChange={(shift) => onChange({ ...s, shift })} />
      </Row>
      <Row title="  toward">
        <Select size="sm" width={104} value={s.toward ?? "none"} options={["none", ...BASES]} labels={{ none: "—" }} onChange={(t) => onChange({ ...s, toward: t === "none" ? null : t })} />
        {s.toward && <Range value={s.mix ?? 50} min={0} max={100} unit="%" onChange={(mix) => onChange({ ...s, mix })} />}
      </Row>
    </>
  );
}

function css(r: Recipe): string {
  const v = recipeVars(r);
  return [
    `--shell-backdrop: ${v["--shell-backdrop"]};`,
    `--window-bar-bg: ${v["--window-bar-bg"]};`,
    `--toolbar-bg: ${v["--toolbar-bg"]};`,
    ...(r.edgeOverChrome ? ["--window-edge: color-mix(in srgb, var(--ink) var(--window-edge-mix), var(--window-bar-bg));"] : []),
    `--window-edge-mix: ${v["--window-edge-mix"]};`,
    ...(r.field === "recessed" ? [`--toolbar-field-bg: color-mix(in oklab, var(--scrim) ${r.fieldDim ?? 6}%, var(--toolbar-bg));`] : []),
    `/* ui.unfocusedDim ${r.dim}, dim ${r.dimScope}, title tint ${r.tint}, bar line ${r.barLine ? "on" : "off"} */`,
  ].join("\n");
}

function Panel({ r, set }: { r: Recipe; set: (r: Recipe) => void }) {
  const preset = Object.entries(PRESETS).find(([, p]) => JSON.stringify(p) === JSON.stringify(r))?.[0] ?? "Custom";
  return (
    <div style={{ width: 300, flex: "none", display: "flex", flexDirection: "column", gap: 4, padding: 12, font: "var(--text-sm) var(--font-ui)", color: "var(--text)", background: "var(--bg-sidebar)", border: "1px solid var(--window-edge)", borderRadius: "var(--radius-md)", alignSelf: "flex-start", position: "sticky", top: 0 }}>
      <Row title="Preset">
        <Select size="sm" value={preset} options={["Custom", ...Object.keys(PRESETS)]} onChange={(p) => p !== "Custom" && set(PRESETS[p]!)} />
      </Row>
      <SurfaceRow title="Backdrop" s={r.backdrop} onChange={(backdrop) => set({ ...r, backdrop })} />
      <SurfaceRow title="Title bar" s={r.bar} onChange={(bar) => set({ ...r, bar })} />
      <Row title="Toolbar">
        <Switch size="sm" label="Toolbar takes the title bar's colour" checked={!!r.toolbarIsBar} onChange={(toolbarIsBar) => set({ ...r, toolbarIsBar })} />
        <span style={{ color: "var(--text-dim)" }}>same as title bar</span>
      </Row>
      {!r.toolbarIsBar && <SurfaceRow title="" s={r.toolbar} onChange={(toolbar) => set({ ...r, toolbar })} />}
      <Row title="Bar line">
        <Switch size="sm" label="Line between title bar and toolbar" checked={r.barLine} onChange={(barLine) => set({ ...r, barLine })} />
      </Row>
      <Row title="Outline over">
        <Segmented size="sm" value={r.edgeOverChrome ? "chrome" : "sidebar"} options={["sidebar", "chrome"]} labels={{ sidebar: "bg-sidebar", chrome: "Title bar" }} onChange={(v) => set({ ...r, edgeOverChrome: v === "chrome" })} />
      </Row>
      <Row title="Outline">
        <Range value={r.edgeMix} min={0} max={30} unit="%" onChange={(edgeMix) => set({ ...r, edgeMix })} />
      </Row>
      <Row title="Fields">
        <Segmented size="sm" value={r.field ?? "well"} options={["well", "recessed"]} labels={{ well: "Well", recessed: "Recessed" }} onChange={(field) => set({ ...r, field })} />
      </Row>
      {r.field === "recessed" && (
        <Row title="  dimmed">
          <Range value={r.fieldDim ?? 6} min={0} max={30} unit="%" onChange={(fieldDim) => set({ ...r, fieldDim })} />
        </Row>
      )}
      <Row title="Dim others">
        <Range value={r.dim} min={0} max={60} unit="%" onChange={(dim) => set({ ...r, dim })} />
      </Row>
      <Row title="Dim what">
        <Segmented size="sm" value={r.dimScope} options={["window", "content", "off"]} labels={{ window: "Window", content: "Content", off: "Off" }} onChange={(dimScope) => set({ ...r, dimScope })} />
      </Row>
      <Row title="Title tint">
        <Segmented size="sm" value={r.tint} options={["off", "subtle", "strong"]} labels={{ off: "Off", subtle: "Subtle", strong: "Strong" }} onChange={(tint) => set({ ...r, tint })} />
      </Row>
      <pre style={{ margin: "8px 0 0", padding: 8, font: "var(--text-2xs) var(--font-mono)", whiteSpace: "pre-wrap", background: "var(--well)", borderRadius: "var(--radius-sm)", userSelect: "text" }}>{css(r)}</pre>
      <div style={{ display: "flex", gap: 6 }}>
        <Button size="sm" onClick={() => navigator.clipboard.writeText(css(r))}>Copy CSS</Button>
        <Button size="sm" variant="ghost" onClick={() => set(ORDERED)}>Reset</Button>
      </div>
    </div>
  );
}

// ── variants ───────────────────────────────────────────

/** The workbench's theme, large, with the recipe before Ordered under it for comparison. */
export const Board = () => {
  const [r, set] = useRecipe();
  const theme = useTheme();
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start", width: "min(1200px, 100%)" }}>
      <Panel r={r} set={set} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        <Scene theme={theme} r={r} height={260} />
        <Scene theme={theme} r={BEFORE} height={140} label="Before" />
      </div>
    </div>
  );
};

/** Every built-in theme, dark ones first. */
export const Themes = () => {
  const [r, set] = useRecipe();
  const themes = allThemes().sort((a, b) => (a.appearance === b.appearance ? 0 : a.appearance === "dark" ? -1 : 1));
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start", width: "100%" }}>
      <Panel r={r} set={set} />
      <div style={{ flex: 1, minWidth: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))", gap: 8 }}>
        {themes.map((t) => (
          <Scene key={t.id} theme={t} r={r} height={150} label={t.title} />
        ))}
      </div>
    </div>
  );
};
