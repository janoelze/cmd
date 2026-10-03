// Settings schema. Flat dotted keys (VS Code style), stored as JSON in
// ~/.config/cmd/settings.json. The schema drives validation, the CLI and the
// generated settings UI. Plugins will contribute keys under "plugins.<id>.*".

type Def =
  | { type: "string"; default: string; description: string; multiline?: boolean }
  | { type: "number"; default: number; description: string; min?: number; max?: number; step?: number }
  | { type: "boolean"; default: boolean; description: string }
  | { type: "enum"; default: string; description: string; options: readonly string[] };

export const SETTINGS_SCHEMA = {
  "terminal.fontFamily": {
    type: "string",
    default: '"Monaspace Neon", "SF Mono", Menlo, monospace',
    description: "Font family list for terminals. Use installed fonts; they render with native smoothing.",
  },
  "terminal.fontSize": { type: "number", default: 14, min: 8, max: 32, description: "Terminal font size in px." },
  "terminal.renderer": {
    type: "enum",
    default: "dom",
    options: ["dom", "webgl"],
    description: "dom draws text natively (matches macOS rendering); webgl is faster for heavy output but rasterizes glyphs itself.",
  },
  "terminal.lineHeight": { type: "number", default: 1.15, min: 1, max: 2, step: 0.05, description: "Terminal line height." },
  "terminal.cursorBlink": { type: "boolean", default: true, description: "Blink the terminal cursor." },
  "terminal.scrollback": { type: "number", default: 10000, min: 0, max: 200000, description: "Lines of scrollback per terminal." },
  "terminal.webglPool": {
    type: "number",
    default: 8,
    min: 0,
    max: 14,
    description: "With the webgl renderer: max terminals using WebGL at once; others fall back to DOM. Browsers allow ~16 contexts.",
  },

  "shell.program": { type: "string", default: "", description: "Shell to run in new terminals. Empty uses $SHELL." },
  "shell.login": { type: "boolean", default: true, description: "Start shells as login shells (-l)." },
  "shell.integration": {
    type: "boolean",
    default: true,
    description: "zsh integration: report the working directory and prompt marks to cmd. Loads your normal config first.",
  },
  "shell.openFolders": { type: "boolean", default: true, description: "With shell integration, `open <folder>` opens a cmd file window instead of Finder." },
  "shell.openFiles": {
    type: "boolean",
    default: true,
    description: "With shell integration, `open <file>` opens text in a text window and html/images/pdf in a browser window; other files still use their app.",
  },
  "open.handlers": {
    type: "string",
    default: "",
    description: "Which window type opens which file extension, overriding the defaults, e.g. \"md: browser, log: text\".",
  },
  "shell.openUrls": { type: "boolean", default: false, description: "With shell integration, `open <http(s) URL>` opens a cmd browser window." },

  "ui.defaultView": { type: "enum", default: "focus", options: ["focus", "grid", "strip", "canvas"], description: "View mode on first launch; after that the last used mode is remembered." },
  "ui.showResources": {
    type: "boolean",
    default: true,
    description: "Show memory and CPU of each terminal's process tree in its title bar and the status bar.",
  },
  "ui.sidebarWidth": { type: "number", default: 280, min: 200, max: 480, description: "Sidebar width in px." },

  "canvas.minZoom": { type: "number", default: 30, min: 10, max: 100, step: 5, description: "Canvas: how far you can zoom out (%). Windows stay live at every zoom." },
  "canvas.maxZoom": { type: "number", default: 150, min: 100, max: 300, step: 25, description: "Canvas: how far you can zoom in (%)." },

  "notifications.needsInput": { type: "boolean", default: true, description: "Notify when an agent needs input." },
  "notifications.done": { type: "boolean", default: true, description: "Notify when an agent finishes a turn." },
  "notifications.dockBadge": { type: "boolean", default: true, description: "Show the attention count on the Dock icon." },

  "search.enabled": { type: "boolean", default: true, description: "Index Claude Code and Codex transcripts for search (? in the palette)." },
  "search.archiveDirs": {
    type: "string",
    default: "~/claude-transcripts-archive",
    description: "Extra folders of archived Claude transcripts (*.jsonl) to index, comma-separated.",
  },

  "agents.claude.command": {
    type: "string",
    default: "claude",
    description: "Command used to start Claude Code (e.g. \"claude --model opus\"). Typed into your shell, so aliases apply.",
  },
  "agents.codex.command": { type: "string", default: "codex", description: "Command used to start Codex." },
} as const satisfies Record<string, Def>;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;
type ValueOf<D> = D extends { type: "number" }
  ? number
  : D extends { type: "boolean" }
    ? boolean
    : D extends { type: "enum"; options: readonly (infer O)[] }
      ? O
      : string;
export type Settings = { [K in SettingKey]: ValueOf<(typeof SETTINGS_SCHEMA)[K]> };
export type SettingDef = Def;

export const DEFAULT_SETTINGS = Object.fromEntries(
  Object.entries(SETTINGS_SCHEMA).map(([k, d]) => [k, d.default]),
) as Settings;

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS_SCHEMA, key);
}

/** Returns the coerced value, or an error message. */
export function validateSetting(key: string, value: unknown): { value: unknown } | { error: string } {
  if (!isSettingKey(key)) return { error: `unknown setting "${key}"` };
  const d: Def = SETTINGS_SCHEMA[key];
  switch (d.type) {
    case "string":
      return typeof value === "string" ? { value } : { error: `${key}: expected a string` };
    case "boolean":
      return typeof value === "boolean" ? { value } : { error: `${key}: expected true or false` };
    case "enum":
      return d.options.includes(value as string)
        ? { value }
        : { error: `${key}: expected one of ${d.options.join(", ")}` };
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return { error: `${key}: expected a number` };
      if (d.min !== undefined && value < d.min) return { error: `${key}: must be ≥ ${d.min}` };
      if (d.max !== undefined && value > d.max) return { error: `${key}: must be ≤ ${d.max}` };
      return { value };
    }
  }
}

/** Parse a CLI string into the setting's type ("14" → 14, "true" → true). */
export function parseSettingValue(key: string, raw: string): unknown {
  if (!isSettingKey(key)) return raw;
  const t = SETTINGS_SCHEMA[key].type;
  if (t === "number") return Number(raw);
  if (t === "boolean") return raw === "true" ? true : raw === "false" ? false : raw;
  return raw;
}

/** Defaults overlaid with the user's valid values; invalid entries are reported and ignored. */
export function resolveSettings(user: Record<string, unknown>): { settings: Settings; errors: string[] } {
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  const errors: string[] = [];
  for (const [k, v] of Object.entries(user)) {
    if (k.startsWith("plugins.")) continue; // owned by plugins
    const r = validateSetting(k, v);
    if ("error" in r) errors.push(r.error);
    else settings[k] = r.value;
  }
  return { settings: settings as Settings, errors };
}

/** Lenient JSON: allows // and /* *\/ comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
