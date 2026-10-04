// Theme registry and the active theme. applyThemeSettings picks the theme from
// the theme.* settings (Auto follows the system), writes its tokens on :root,
// and tells listeners (terminals, editors) and the main process (native
// appearance, window background). Both the app and the Settings window call it.

import { useSyncExternalStore } from "react";
import type { Settings } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import type { SyntaxColors, TerminalColors, Theme } from "./types.ts";

const themes = new Map<string, Theme>();

export function registerTheme(theme: Theme): void {
  themes.set(theme.id, theme);
}

export function themeFor(id: string): Theme | undefined {
  return themes.get(id);
}

export function allThemes(): Theme[] {
  return [...themes.values()];
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The terminal colours with defaults filled in. */
export function terminalColors(t: Theme): Required<TerminalColors> {
  return { ...t.terminal, background: t.terminal.background ?? t.colors.well };
}

/** The syntax colours with defaults from the terminal palette filled in. */
function syntaxColors(t: Theme): SyntaxColors {
  const p = t.terminal;
  return {
    keyword: p.magenta,
    string: p.green,
    number: p.yellow,
    comment: p.brightBlack,
    function: p.blue,
    type: p.cyan,
    property: p.brightBlue,
    heading: t.colors.text,
    punct: t.colors.textDim,
    cursor: p.cursor,
    selection: p.selectionBackground,
    ...t.syntax,
  };
}

const ink = (pct: number) => `color-mix(in srgb, var(--ink) ${pct}%, transparent)`;

/**
 * What every light theme overrides in styles.css (whose derived values are tuned
 * for dark); a theme's own `vars` still win.
 */
const LIGHT_VARS: Readonly<Record<string, string>> = {
  // Light windows need far less darkening to read as unfocused.
  "window-dim": "0.25",
  "shadow": "rgb(0 0 0 / 0.18)",
  "field": "var(--well)",
  "recess": ink(3.5),
  "recess-edge": ink(8),
  "pane-edge": ink(10),
  "chip-fg": "55% 38%",
  "chip-bg": "60% 92%",
};

/** Every CSS custom property a theme sets, name → value. */
export function themeVars(t: Theme): Record<string, string> {
  const vars: Record<string, string> = {};
  if (t.appearance === "light") for (const [k, v] of Object.entries(LIGHT_VARS)) vars[`--${k}`] = v;
  for (const [k, v] of Object.entries(t.colors)) vars[`--${kebab(k)}`] = v;
  for (const [k, v] of Object.entries(syntaxColors(t))) vars[`--syn-${k}`] = v;
  // Git states in file windows, from the terminal palette.
  const p = t.terminal;
  for (const [k, v] of Object.entries({ added: p.green, modified: p.yellow, deleted: p.red, conflict: p.magenta })) vars[`--git-${k}`] = v;
  for (const [k, v] of Object.entries(t.vars ?? {})) vars[`--${k}`] = v;
  return vars;
}

// ── the active theme ───────────────────────────────────

let current: Theme | undefined;
let applied: string[] = [];
let lastSettings: Pick<Settings, "theme.appearance" | "theme.dark" | "theme.light"> | undefined;
const listeners = new Set<() => void>();
const systemDark = matchMedia("(prefers-color-scheme: dark)");

/** The theme in use; the built-in dark one until settings arrive. */
export function currentTheme(): Theme {
  return current ?? themes.get("dark") ?? themes.values().next().value!;
}

export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useTheme(): Theme {
  return useSyncExternalStore(onThemeChange, currentTheme);
}

/** The theme for these settings: unknown ids (a removed theme) fall back to the built-in of that appearance. */
export function resolveTheme(s: NonNullable<typeof lastSettings>): Theme {
  const appearance = s["theme.appearance"] === "auto" ? (systemDark.matches ? "dark" : "light") : s["theme.appearance"];
  const t = themes.get(appearance === "dark" ? s["theme.dark"] : s["theme.light"]);
  return t?.appearance === appearance ? t : (themes.get(appearance) ?? currentTheme());
}

function apply(t: Theme): void {
  const root = document.documentElement.style;
  const vars = themeVars(t);
  for (const name of applied) if (!(name in vars)) root.removeProperty(name);
  for (const [name, value] of Object.entries(vars)) root.setProperty(name, value);
  applied = Object.keys(vars);
  document.documentElement.dataset.appearance = t.appearance;
  root.colorScheme = t.appearance;
  if (t === current) return;
  current = t;
  // The next launch paints its first frame in this theme (see boot).
  try {
    localStorage.setItem("cmd.theme", t.id);
  } catch {}
  listeners.forEach((fn) => fn());
}

/** Apply the theme the settings choose; call on every settings snapshot. */
export function applyThemeSettings(s: Settings): void {
  lastSettings = { "theme.appearance": s["theme.appearance"], "theme.dark": s["theme.dark"], "theme.light": s["theme.light"] };
  sync();
}

function sync(): void {
  if (!lastSettings) return;
  const t = resolveTheme(lastSettings);
  apply(t);
  // Auto lets macOS decide, so prefers-color-scheme (above) tracks the system.
  const source = lastSettings["theme.appearance"] === "auto" ? "system" : t.appearance;
  cmd.setAppearance({ source, background: t.colors.bg });
}

// Auto: the system switched between light and dark.
systemDark.addEventListener("change", sync);

/** Before settings arrive: the theme the last run used, so the first frame isn't the wrong one. */
export function bootTheme(): void {
  let id: string | null = null;
  try {
    id = localStorage.getItem("cmd.theme");
  } catch {}
  apply((id && themes.get(id)) || currentTheme());
}
