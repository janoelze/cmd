// What happened to settings keys that left the schema or changed what they
// hold, so old settings.json files keep working (resolveSettings applies these).

import type { SettingKey } from "./settings.ts";

/**
 * What happened to keys that left the schema or changed what they hold, so old
 * settings files keep working: renamed (`to`, the new key), removed (`to: null`:
 * ignored without an error), or kept with a new kind of value (`to` the same
 * key). `value` carries the old value over to the new key's type, and must be
 * idempotent (it may see a value already in the new form). Applied in order, so
 * a key renamed twice follows both. Every key ever shipped is in
 * settings-keys.lock; a test fails when one is in neither the schema nor here.
 */
export interface SettingsMigration {
  from: string;
  to: SettingKey | null;
  value?: (old: unknown) => unknown;
}

export const SETTINGS_MIGRATIONS: readonly SettingsMigration[] = [
  { from: "search.enabled", to: "data.record.transcripts" },
  { from: "terminal.fontFamily", to: "font.code" },
  { from: "terminal.fontSize", to: "font.codeSize" },
  { from: "magic.model", to: "ai.anthropic.model" },
  { from: "magic.provider", to: "ai.provider" },
  { from: "magic.anthropic.model", to: "ai.anthropic.model" },
  { from: "magic.openai.model", to: "ai.openai.model" },
  { from: "spaces.ownWindow", to: "workspaces.ownWindow" },
  { from: "ui.sidebarWidth", to: null }, // drag the sidebar edge
  { from: "magic.baseUrl", to: null }, // only Anthropic and OpenAI are providers now
  { from: "ui.sidebarPadding", to: null }, // the app's to set
  { from: "canvas.cardZoom", to: null }, // cards are never read-only (98e7664)
  { from: "agents.peers", to: "agents.integration" }, // peer briefings became part of Agent integration (docs/54)
  { from: "magic.autoFix", to: null }, // widgets made before packages fixed themselves; packages have Fix with Magic (docs/56)
];

/** Keys that were renamed (old → new). */
export const RENAMED_SETTINGS: Readonly<Record<string, SettingKey>> = Object.fromEntries(
  SETTINGS_MIGRATIONS.flatMap((m) => (m.to && m.to !== m.from ? [[m.from, m.to]] : [])),
);

/** The current name of a key (renamed keys map to their new name). */
export const currentKey = (key: string): string => RENAMED_SETTINGS[key] ?? key;

/** Keys that no longer exist; ignored without an error. */
export const REMOVED_SETTINGS: ReadonlySet<string> = new Set(SETTINGS_MIGRATIONS.filter((m) => m.to === null).map((m) => m.from));
