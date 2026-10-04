// Spaces (docs/11-spaces.md): constants and helpers shared by core, CLI and UI.

/** The Space that always exists, rooted at the home folder; it catches everything without a better Space. */
export const HOME_SPACE_ID = "home";

/** A Space's icon: its own SF Symbol, else a house for Home and a folder for the rest. */
export function spaceIcon(s: { icon: string | null; home: boolean }): string {
  return s.icon ?? (s.home ? "house" : "folder");
}

/** SF Symbol names: lowercase words joined by dots. */
export const ICON_NAME = /^[a-z0-9]+(\.[a-z0-9]+)*$/;

/** Stable hue for a name (FNV-1a), as the ghostty-agents fork colored project tabs. */
export function hueOf(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return (h >>> 0) % 360;
}
