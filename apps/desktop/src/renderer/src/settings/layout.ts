// The Settings window's information architecture: pages of named sections, in
// the order people look for things, independent of the key prefixes (which stay
// what `cmd settings set` uses). Every setting and secret must be placed exactly
// once (test/settings-layout.test.ts); one that isn't still gets a row, under
// "Other" on the last settings page.

import { SECRETS, SETTINGS_SCHEMA, type AiProvider, type SecretKey, type SecretsStatus, type SettingKey, type Settings } from "@cmd/protocol";

export type ItemKey = SettingKey | SecretKey;
/** A row; `when` hides it unless it matters for the current settings and keys. */
export type Item = ItemKey | { key: ItemKey; when: (s: Settings, secrets: SecretsStatus | null) => boolean };
export interface Section {
  title?: string;
  items: Item[];
}
export interface Page {
  id: string;
  title: string;
  /** SF Symbol for the sidebar. */
  icon: string;
  sections: Section[];
}

/** A provider's model rows matter once it has a key; the choice between providers once both do. */
const hasKey = (p: AiProvider) => (_: Settings, k: SecretsStatus | null) => !!k?.[`ai.${p}.apiKey`].set;
const bothKeys = (s: Settings, k: SecretsStatus | null) => hasKey("anthropic")(s, k) && hasKey("openai")(s, k);

export const SETTINGS_PAGES: Page[] = [
  {
    id: "appearance",
    title: "Appearance",
    icon: "paintpalette",
    sections: [
      { title: "Theme", items: ["theme.appearance", "theme.dark", "theme.light", "theme.dockIcon"] },
      { title: "Fonts", items: ["font.code", "font.codeSize", "font.text", "font.textSize"] },
      { title: "Sidebar", items: ["ui.sidebarRecent"] },
    ],
  },
  {
    id: "windows",
    title: "Windows",
    icon: "macwindow",
    sections: [
      { title: "Layout", items: ["ui.defaultView", "ui.gutter", "ui.paddingX", "ui.paddingY", "ui.windowRadius"] },
      { title: "Outline", items: ["ui.windowOutline", "ui.windowOutlineContrast", "ui.windowShadow", "ui.attentionOutline"] },
      { title: "Selected window", items: ["ui.focusOutline", "ui.focusColor", "ui.focusGlow", "ui.focusTitleBar", "ui.unfocusedDim", "ui.unfocusedDesaturation", "ui.showResources"] },
      { title: "Canvas", items: ["canvas.minimap", "canvas.minZoom", "canvas.maxZoom"] },
      { title: "File windows", items: ["files.git"] },
    ],
  },
  {
    id: "terminal",
    title: "Terminal",
    icon: "terminal",
    sections: [
      {
        title: "Display",
        items: ["terminal.cursorStyle", "terminal.cursorBlink", "terminal.lineHeight", "terminal.minimumContrast", "terminal.images", "terminal.scrollback", "terminal.renderer", "terminal.webglPool"],
      },
      { title: "Keyboard and clipboard", items: ["terminal.optionAsMeta", "terminal.clickMovesCursor", "terminal.hideMouseWhileTyping", "terminal.copyOnSelect", "terminal.pasteProtection", "terminal.clipboardWrite"] },
      { title: "Shell", items: ["shell.program", "shell.login", "shell.integration"] },
      { title: "After a restart", items: ["restore.terminals", "restore.scrollback", "restore.resumeAgents"] },
    ],
  },
  {
    id: "open",
    title: "Opening Files",
    icon: "arrow.up.forward.app",
    sections: [
      { title: "The open command", items: ["shell.openFolders", "shell.openFiles", "shell.openUrls"] },
      { title: "File types", items: ["open.handlers"] },
      { title: "Links", items: ["open.links"] },
    ],
  },
  {
    id: "notifications",
    title: "Notifications",
    icon: "bell",
    sections: [
      { title: "Notify me when", items: ["notifications.needsInput", "notifications.done", "notifications.longCommand", "notifications.terminalSequences", "notifications.widgets"] },
      { title: "Wording", items: ["notifications.ai"] },
      { title: "Delivery", items: ["notifications.when", "notifications.sound", "notifications.bounceDock", "notifications.dockBadge"] },
      { title: "Terminal bell", items: ["notifications.bell", "notifications.visualBell"] },
    ],
  },
  {
    id: "ai",
    title: "AI & Agents",
    icon: "sparkles",
    sections: [
      { title: "Providers", items: ["ai.anthropic.apiKey", "ai.openai.apiKey", { key: "ai.provider", when: bothKeys }] },
      {
        title: "Anthropic models",
        items: [
          { key: "ai.anthropic.model", when: hasKey("anthropic") },
          { key: "ai.anthropic.fastModel", when: hasKey("anthropic") },
        ],
      },
      {
        title: "OpenAI models",
        items: [
          { key: "ai.openai.model", when: hasKey("openai") },
          { key: "ai.openai.fastModel", when: hasKey("openai") },
        ],
      },
      { title: "Commands", items: ["agents.claude.command", "agents.codex.command", "agents.qwen.command", "agents.copilot.command"] },
      { title: "Names", items: ["agents.names.ai"] },
      { title: "Working together", items: ["agents.peers"] },
      { title: "Setup", items: ["agents.hooks.auto", "agents.homes"] },
      { title: "Transcript search", items: ["search.archiveDirs"] },
    ],
  },
  {
    id: "remote",
    title: "Remote Access",
    icon: "iphone",
    sections: [
      { items: ["remote.enabled"] },
      { title: "Connection", items: ["remote.relay", "remote.client"] },
      { title: "Devices", items: ["remote.deviceExpiryDays"] },
    ],
  },
  {
    id: "magic",
    title: "Magic Widgets",
    icon: "wand.and.stars",
    sections: [
      { title: "While building", items: ["magic.explore", "magic.showSteps"] },
      { title: "Running widgets", items: ["magic.autoFix", "magic.deno"] },
      { title: "Widget Library", items: ["widgets.developer"] },
    ],
  },
  {
    id: "data",
    title: "Data",
    icon: "internaldrive",
    sections: [
      { title: "What cmd keeps", items: ["data.record.transcripts", "data.record.output", "data.record.browsing", "data.record.actions"] },
      { title: "For how long", items: ["data.keepDays"] },
      { title: "Never record", items: ["data.exclude"] },
    ],
  },
];

/** Settings shown on a page of their own making (About shows the update mode, crash reports and usage stats). */
export const PLACED_ELSEWHERE: readonly ItemKey[] = ["updates.mode", "diagnostics.crashReports", "diagnostics.usageStats"];

export const itemKey = (it: Item): ItemKey => (typeof it === "string" ? it : it.key);
export const itemShown = (it: Item, s: Settings, secrets: SecretsStatus | null) => typeof it === "string" || it.when(s, secrets);

/** Keys no page places: listed under "Other" so every setting stays reachable. */
export function unplacedKeys(): ItemKey[] {
  const placed = new Set<ItemKey>([...SETTINGS_PAGES.flatMap((p) => p.sections.flatMap((s) => s.items.map(itemKey))), ...PLACED_ELSEWHERE]);
  return ([...Object.keys(SETTINGS_SCHEMA), ...Object.keys(SECRETS)] as ItemKey[]).filter((k) => !placed.has(k));
}

/** The pages with a trailing "Other" section on the last one if anything is unplaced. */
export function settingsPages(): Page[] {
  const rest = unplacedKeys();
  if (!rest.length) return SETTINGS_PAGES;
  const last = SETTINGS_PAGES.at(-1)!;
  return [...SETTINGS_PAGES.slice(0, -1), { ...last, sections: [...last.sections, { title: "Other", items: rest }] }];
}
