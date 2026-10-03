// Settings schema. Flat dotted keys (VS Code style), stored as JSON in
// ~/.config/cmd/settings.json. The schema drives validation, the CLI and the
// generated settings UI. Plugins will contribute keys under "plugins.<id>.*".
//
// Every key applies live unless its `applies` says otherwise: consumers read
// settings when they act, or subscribe to the keys they cache (SettingsService.bind
// in the core, the settings.updated event in the UI).

/** When a change takes effect, for keys that can't apply to what is already running. Omitted = immediately. */
export type SettingApplies = "newTerminals" | "firstLaunch";

/**
 * title: the label in the settings window (default: from the key). The rest are
 * display hints (unit, placeholder, option labels, a font preview).
 */
type Common = { title?: string; description: string; applies?: SettingApplies };
type Def = Common &
  (
    | {
        type: "string";
        default: string;
        multiline?: boolean;
        placeholder?: string;
        /** font: previews itself in that font. theme: a popup of the UI's registered themes of `appearance`. */
        control?: "font" | "theme";
        appearance?: "dark" | "light";
      }
    | { type: "number"; default: number; min?: number; max?: number; step?: number; unit?: string }
    | { type: "boolean"; default: boolean }
    | { type: "enum"; default: string; options: readonly string[]; labels?: Readonly<Record<string, string>> }
  );

export const SETTINGS_SCHEMA = {
  "font.code": {
    title: "Code font",
    control: "font",
    type: "string",
    default: '"Monaspace Neon", "SF Mono", Menlo, monospace',
    description: "Font family list for terminals, the text editor, file browsers and code in Markdown. Use installed fonts; they render with native smoothing.",
  },
  "font.codeSize": { title: "Code font size", unit: "px", type: "number", default: 14, min: 8, max: 32, description: "Size of the code font. ⌘+ and ⌘− zoom terminals on top of it." },
  "font.text": {
    title: "Text font",
    control: "font",
    placeholder: "System font",
    type: "string",
    default: "",
    description: "Font family list for reading text: Markdown documents. Empty uses the system font.",
  },
  "font.textSize": { title: "Text font size", unit: "px", type: "number", default: 14, min: 10, max: 24, description: "Size of the text font." },

  "theme.appearance": {
    title: "Appearance",
    type: "enum",
    default: "dark",
    options: ["auto", "dark", "light"],
    labels: { auto: "Auto", dark: "Dark", light: "Light" },
    description: "Dark, light, or follow the system (Auto). Each uses the theme chosen below.",
  },
  "theme.dark": { title: "Dark theme", type: "string", control: "theme", appearance: "dark", default: "dark", description: "Theme used in dark appearance." },
  "theme.light": { title: "Light theme", type: "string", control: "theme", appearance: "light", default: "light", description: "Theme used in light appearance." },

  "terminal.renderer": {
    title: "Renderer", labels: { dom: "DOM", webgl: "WebGL" },
    type: "enum",
    default: "dom",
    options: ["dom", "webgl"],
    description: "dom draws text natively (matches macOS rendering); webgl is faster for heavy output but rasterizes glyphs itself.",
  },
  "terminal.lineHeight": { title: "Line height", type: "number", default: 1.15, min: 1, max: 2, step: 0.05, description: "Terminal line height." },
  "terminal.cursorBlink": { title: "Blinking cursor", type: "boolean", default: true, description: "Blink the terminal cursor." },
  "terminal.scrollback": { title: "Scrollback", unit: "lines", type: "number", default: 10000, min: 0, max: 200000, description: "Lines of scrollback per terminal." },
  "terminal.webglPool": {
    title: "WebGL terminals",
    type: "number",
    default: 8,
    min: 0,
    max: 14,
    description: "With the webgl renderer: max terminals using WebGL at once; others fall back to DOM. Browsers allow ~16 contexts.",
  },

  "shell.program": { title: "Shell", placeholder: "$SHELL", type: "string", default: "", applies: "newTerminals", description: "Shell to run in new terminals. Empty uses $SHELL." },
  "shell.login": { title: "Login shell", type: "boolean", default: true, applies: "newTerminals", description: "Start shells as login shells (-l)." },
  "shell.integration": {
    title: "Shell integration",
    type: "boolean",
    default: true,
    applies: "newTerminals",
    description: "zsh integration: report the working directory and prompt marks to cmd. Loads your normal config first.",
  },
  "shell.openFolders": { title: "Open folders in cmd", type: "boolean", default: true, description: "With shell integration, `open <folder>` opens a cmd file window instead of Finder." },
  "shell.openFiles": {
    title: "Open files in cmd",
    type: "boolean",
    default: true,
    description: "With shell integration, `open <file>` opens text in a text window and html/images/pdf in a browser window; other files still use their app.",
  },
  "open.handlers": {
    title: "Extension overrides", placeholder: "md: browser, log: text",
    type: "string",
    default: "",
    description: "Which window type opens which file extension, overriding the defaults, e.g. \"md: browser, log: text\".",
  },
  "shell.openUrls": { title: "Open URLs in cmd", type: "boolean", default: false, description: "With shell integration, `open <http(s) URL>` opens a cmd browser window." },

  "ui.defaultView": { title: "Default view", labels: { focus: "Focus", grid: "Grid", strip: "Strip", canvas: "Canvas" }, type: "enum", default: "focus", applies: "firstLaunch", options: ["focus", "grid", "strip", "canvas"], description: "View mode on first launch; after that the last used mode is remembered." },
  "ui.showResources": {
    title: "Show resource usage",
    type: "boolean",
    default: true,
    description: "Show memory and CPU of the selected window's processes in the status bar.",
  },
  "ui.unfocusedDesaturation": { title: "Desaturate other windows", unit: "%", type: "number", default: 0, min: 0, max: 100, step: 10, description: "Drain the colour from windows other than the selected one (%): 0 = off, 100 = grayscale." },
  "ui.paddingX": { title: "Horizontal padding", unit: "px", type: "number", default: 8, min: 0, max: 48, step: 1, description: "Space between the windows and the left and right edges in grid and strip view (px)." },
  "ui.paddingY": { title: "Vertical padding", unit: "px", type: "number", default: 8, min: 0, max: 48, step: 1, description: "Space between the windows and the top and bottom edges in grid and strip view (px)." },
  "ui.gutter": { title: "Gap between windows", unit: "px", type: "number", default: 8, min: 0, max: 32, step: 1, description: "Space between windows in grid and strip view (px). The canvas places windows on its own dot grid." },
  "ui.windowRadius": { title: "Window corner radius", unit: "px", type: "number", default: 8, min: 0, max: 16, step: 1, description: "Corner radius of windows in px (0 = square). Focus mode always fills the pane edge to edge." },

  "canvas.minZoom": { title: "Minimum zoom", unit: "%", type: "number", default: 30, min: 10, max: 100, step: 5, description: "Canvas: how far you can zoom out (%). Windows stay live at every zoom." },
  "canvas.maxZoom": { title: "Maximum zoom", unit: "%", type: "number", default: 150, min: 100, max: 300, step: 25, description: "Canvas: how far you can zoom in (%)." },
  "canvas.minimap": { title: "Show minimap", type: "boolean", default: true, description: "Canvas: an overview of all windows in the bottom-right corner; click or drag it to move around." },

  "notifications.needsInput": { title: "Agent needs input", type: "boolean", default: true, description: "Notify when an agent needs input." },
  "notifications.done": { title: "Agent finished a turn", type: "boolean", default: true, description: "Notify when an agent finishes a turn." },
  "notifications.dockBadge": { title: "Badge the Dock icon", type: "boolean", default: true, description: "Show the attention count on the Dock icon." },
  "notifications.when": {
    title: "Show notifications",
    type: "enum",
    default: "background",
    options: ["background", "always", "never"],
    labels: { background: "When I'm not looking at that window", always: "Always", never: "Never" },
    description: "When to show system notifications. Attention markers in the sidebar and title bars show either way.",
  },
  "notifications.sound": {
    title: "Sound",
    type: "enum",
    default: "default",
    options: ["default", "none", "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"],
    labels: { default: "System default", none: "None" },
    description: "Sound for notifications that need you (input, bells, failed commands). Others are silent.",
  },
  "notifications.bounceDock": {
    title: "Bounce the Dock icon",
    type: "enum",
    default: "needsInput",
    options: ["needsInput", "any", "off"],
    labels: { needsInput: "When something needs me", any: "For every notification", off: "Never" },
    description: "Bounce the Dock icon once when a notification arrives while cmd is in the background.",
  },
  "notifications.bell": {
    title: "Terminal bell",
    type: "enum",
    default: "mark",
    options: ["mark", "notify", "ignore"],
    labels: { mark: "Mark the window", notify: "Mark and notify", ignore: "Ignore" },
    description: "What a terminal bell (\\a, e.g. tput bel) does. Bells from agents are left to the agent's own state.",
  },
  "notifications.visualBell": { title: "Flash on bell", type: "boolean", default: true, description: "Briefly flash a window's outline when its terminal rings the bell." },
  "notifications.terminalSequences": {
    title: "Notifications from programs",
    type: "boolean",
    default: true,
    description: "Show notifications that programs request with terminal escape codes (OSC 9, OSC 777, kitty's OSC 99).",
  },
  "notifications.longCommand": {
    title: "Long commands",
    unit: "s",
    type: "number",
    default: 30,
    min: 0,
    max: 3600,
    step: 5,
    description: "Notify when a command that ran at least this long finishes (needs shell integration). 0 = off.",
  },

  "search.enabled": { title: "Index transcripts", type: "boolean", default: true, description: "Index Claude Code and Codex transcripts for search (? in the palette)." },
  "search.archiveDirs": {
    title: "Archive folders", placeholder: "~/claude-transcripts-archive",
    type: "string",
    default: "~/claude-transcripts-archive",
    description: "Extra folders of archived Claude transcripts (*.jsonl) to index, comma-separated.",
  },

  "agents.claude.command": {
    title: "Claude Code command",
    type: "string",
    default: "claude",
    description: "Command used to start Claude Code (e.g. \"claude --model opus\"). Typed into your shell, so aliases apply.",
  },
  "agents.codex.command": { title: "Codex command", type: "string", default: "codex", description: "Command used to start Codex." },

  "magic.provider": {
    title: "Model provider",
    labels: { auto: "Automatic", anthropic: "Anthropic API", "openai-compatible": "OpenAI-compatible", "claude-cli": "Claude Code login" },
    type: "enum",
    default: "auto",
    options: ["auto", "anthropic", "openai-compatible", "claude-cli"],
    description: "Who makes Magic windows. Automatic uses the Anthropic API when ANTHROPIC_API_KEY is set, else your Claude Code login.",
  },
  "magic.model": { title: "Model", type: "string", default: "claude-opus-5-5", placeholder: "claude-opus-5-5", description: "Model id for Magic windows, e.g. claude-opus-5-5, claude-haiku-4-5, or your endpoint's model name." },
  "magic.baseUrl": { title: "Endpoint", type: "string", default: "", placeholder: "http://localhost:11434/v1", description: "OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter, …); its key comes from CMD_MAGIC_API_KEY." },
  "updates.mode": {
    title: "Updates",
    type: "enum",
    default: "auto",
    options: ["auto", "notify", "off"],
    labels: { auto: "Install automatically", notify: "Notify me", off: "Don't check" },
    description: "Auto downloads new versions in the background and installs them when you quit cmd; terminals keep running. Check for Updates… in the cmd menu checks now.",
  },
  "magic.explore": { title: "Look around this Mac", type: "boolean", default: true, description: "Let the Magic agent run read-only commands and read files to answer requests about this Mac. Private files (keys, keychains, browser profiles) stay off limits." },
} as const satisfies Record<string, Def>;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;
type GroupOf<K> = K extends `${infer G}.${string}` ? G : never;

/** Section titles in the settings UI, in display order. Every key prefix needs one (tsc checks). */
export const SETTINGS_GROUPS = {
  theme: "Theme",
  font: "Fonts",
  terminal: "Terminal",
  shell: "Shell",
  open: "Opening Files",
  ui: "Interface",
  canvas: "Canvas",
  notifications: "Notifications",
  search: "Search",
  agents: "Agents",
  magic: "Magic Windows",
  updates: "Updates",
} as const satisfies Record<GroupOf<SettingKey>, string>;

/** Keys that were renamed: old settings files keep working (old → new). */
export const RENAMED_SETTINGS: Readonly<Record<string, SettingKey>> = {
  "terminal.fontFamily": "font.code",
  "terminal.fontSize": "font.codeSize",
};

/** The current name of a key (renamed keys map to their new name). */
export const currentKey = (key: string): string => RENAMED_SETTINGS[key] ?? key;

/** Keys that no longer exist; ignored without an error (ui.sidebarWidth: drag the sidebar edge). */
export const REMOVED_SETTINGS: ReadonlySet<string> = new Set(["ui.sidebarWidth"]);

export const APPLIES_LABEL: Record<SettingApplies, string> = {
  newTerminals: "new terminals only",
  firstLaunch: "first launch only",
};

/** A new settings.json. */
export const SETTINGS_TEMPLATE = `// cmd settings. Keys and defaults: \`cmd settings\` or ⌘, in the app.
// Changes apply live.
{
}
`;

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

/** The label for a key: its title, else the key's last part spelled out ("cursorBlink" → "Cursor blink"). */
export function settingTitle(key: SettingKey): string {
  const d: Def = SETTINGS_SCHEMA[key];
  if (d.title) return d.title;
  const words = key.split(".").slice(1).join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

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
  key = currentKey(key);
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
    if (k.startsWith("plugins.") || REMOVED_SETTINGS.has(k)) continue; // owned by plugins / gone
    const key = currentKey(k);
    if (key !== k && key in user) continue; // the new name wins over the old one
    const r = validateSetting(key, v);
    if ("error" in r) errors.push(r.error);
    else settings[key] = r.value;
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
