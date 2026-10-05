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
 * display hints (unit, placeholder, option labels, a font preview, code). Where
 * a key appears in the window is the window's business (renderer settings/layout.ts).
 */
type Common = { title?: string; description: string; applies?: SettingApplies };
type Def = Common &
  (
    | {
        type: "string";
        default: string;
        multiline?: boolean;
        placeholder?: string;
        /** A command, path or similar: edited in the mono font. */
        code?: boolean;
        /**
         * font: previews itself in that font. theme: a popup of the UI's registered
         * themes of `appearance`. model: a popup of `provider`'s models that the
         * user's API key can use (ai.models), with Auto first, for `tier`.
         */
        control?: "font" | "theme" | "model";
        appearance?: "dark" | "light";
        provider?: "anthropic" | "openai";
        tier?: "smart" | "fast";
      }
    | { type: "number"; default: number; min?: number; max?: number; step?: number; unit?: string }
    | { type: "boolean"; default: boolean }
    | { type: "enum"; default: string; options: readonly string[]; labels?: Readonly<Record<string, string>> }
  );

/** macOS's system sounds (/System/Library/Sounds), by name: notifications and widgets (cmd.sound) play these. */
export const SYSTEM_SOUNDS = ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"] as const;
export type SystemSound = (typeof SYSTEM_SOUNDS)[number];

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
  "theme.dark": { title: "Dark theme", type: "string", control: "theme", appearance: "dark", default: "pastel-dark", description: "Theme used in dark appearance." },
  "theme.light": { title: "Light theme", type: "string", control: "theme", appearance: "light", default: "pastel-light", description: "Theme used in light appearance." },
  "theme.dockIcon": {
    title: "Themed Dock icon",
    type: "boolean",
    default: true,
    description: "Show the app icon in the theme's colours in the Dock while cmd runs. Built-in themes only; the Tinted and Clear icon styles keep the standard icon.",
  },

  "terminal.renderer": {
    title: "Renderer", labels: { dom: "DOM", webgl: "WebGL" },
    type: "enum",
    default: "webgl",
    options: ["dom", "webgl"],
    description: "webgl is much cheaper for heavy output and scrolling (up to terminal.webglPool terminals; the rest use dom); dom draws text natively (matches macOS rendering).",
  },
  "terminal.lineHeight": { title: "Line height", type: "number", default: 1.1, min: 1, max: 2, step: 0.05, description: "Terminal line height." },
  "terminal.cursorBlink": { title: "Blinking cursor", type: "boolean", default: true, description: "Blink the terminal cursor." },
  "terminal.scrollback": { title: "Scrollback", unit: "lines", type: "number", default: 10000, min: 0, max: 200000, description: "Lines of scrollback per terminal." },
  "terminal.cursorStyle": {
    title: "Cursor",
    type: "enum",
    default: "block",
    options: ["block", "bar", "underline"],
    labels: { block: "Block", bar: "Bar", underline: "Underline" },
    description: "Cursor shape. Programs can still change it (vim's insert mode, a shell's vi mode).",
  },
  "terminal.minimumContrast": {
    title: "Minimum contrast",
    type: "number",
    default: 1,
    min: 1,
    max: 21,
    step: 0.5,
    description: "Lighten or darken text whose colors are too close to its background (WCAG ratio; 1 is off, 4.5 is readable). Helps with programs that assume another theme.",
  },
  "terminal.optionAsMeta": {
    title: "Option key as Meta",
    type: "enum",
    default: "both",
    options: ["both", "left", "right", "off"],
    labels: { both: "Both", left: "Left Option", right: "Right Option", off: "Off" },
    description: "Option+key sends Escape+key (Meta), for shell and editor shortcuts. Off, or on one side only, keeps that Option key typing characters like @ and € on international layouts.",
  },
  "terminal.clickMovesCursor": {
    title: "Click moves the cursor",
    type: "boolean",
    default: true,
    description: "At a shell prompt, clicking in the command line moves the cursor there. Needs shell integration.",
  },
  "terminal.hideMouseWhileTyping": { title: "Hide pointer while typing", type: "boolean", default: false, description: "Hide the mouse pointer over a terminal while you type; moving the mouse brings it back." },
  "terminal.copyOnSelect": { title: "Copy on select", type: "boolean", default: false, description: "Copy text to the clipboard as soon as it's selected." },
  "terminal.pasteProtection": {
    title: "Confirm risky pastes",
    type: "boolean",
    default: true,
    description: "Ask before pasting several lines into a program that would run each one as it arrives (no bracketed paste), or text with control characters.",
  },
  "terminal.clipboardWrite": {
    title: "Programs can copy",
    type: "boolean",
    default: true,
    description: "Let programs put text on the clipboard (OSC 52): tmux, vim and Neovim, also over ssh. Reading the clipboard is never allowed.",
  },
  "terminal.images": { title: "Inline images", type: "boolean", default: true, description: "Show images programs print (Sixel and iTerm2's inline image protocol: imgcat, chafa, viu…)." },
  "terminal.webglPool": {
    title: "WebGL terminals",
    type: "number",
    default: 8,
    min: 0,
    max: 14,
    description: "With the webgl renderer: max terminals using WebGL at once; others fall back to DOM. Browsers allow ~16 contexts.",
  },

  "restore.terminals": {
    title: "Reopen terminals",
    type: "boolean",
    default: true,
    description: "After cmd or the Mac restarts, bring back the terminals that were open, in their folders, with what they showed. Commands that were running are put on the command line, not run.",
  },
  "restore.scrollback": { title: "Lines kept", unit: "lines", type: "number", default: 2000, min: 0, max: 20000, description: "Lines of each terminal's output kept for reopening it after a restart. 0 keeps none." },
  "restore.resumeAgents": {
    title: "Resume agent sessions",
    type: "boolean",
    default: true,
    description: "In reopened terminals, resume the Claude and Codex sessions they ran. Off: the resume command is put on the command line for you to run.",
  },

  "shell.program": { title: "Shell", placeholder: "$SHELL", code: true, type: "string", default: "", applies: "newTerminals", description: "Shell to run in new terminals. Empty uses $SHELL." },
  "shell.login": { title: "Login shell", type: "boolean", default: true, applies: "newTerminals", description: "Start shells as login shells (-l)." },
  "shell.integration": {
    title: "Shell integration",
    type: "boolean",
    default: true,
    applies: "newTerminals",
    description: "zsh, bash and fish integration: report the working directory, prompt marks and running command to cmd, and route `open` to it. Loads your normal config first.",
  },
  "shell.openFolders": { title: "Open folders in cmd", type: "boolean", default: true, description: "With shell integration, `open <folder>` opens a cmd file window instead of Finder." },
  "shell.openFiles": {
    title: "Open files in cmd",
    type: "boolean",
    default: true,
    description: "With shell integration, `open <file>` opens text in a text window and html/images/pdf in a browser window; other files still use their app.",
  },
  "open.handlers": {
    title: "Extension overrides", placeholder: "md: browser, log: text", code: true,
    type: "string",
    default: "",
    description: "Which window type opens which file extension, overriding the defaults, e.g. \"md: browser, log: text\".",
  },
  "open.links": {
    title: "Open links in", labels: { cmd: "cmd browser window", browser: "Default browser" },
    type: "enum",
    default: "cmd",
    options: ["cmd", "browser"],
    description: "Where http(s) links you click go: in Magic widgets, Markdown, and pages that open a new window from a browser window.",
  },
  "shell.openUrls": { title: "Open URLs in cmd", type: "boolean", default: false, description: "With shell integration, `open <http(s) URL>` opens a cmd browser window." },

  "ui.defaultView": { title: "Default view", labels: { focus: "Focus", grid: "Grid", strip: "Strip", canvas: "Canvas" }, type: "enum", default: "focus", applies: "firstLaunch", options: ["focus", "grid", "strip", "canvas"], description: "View mode on first launch; after that the last used mode is remembered." },
  "files.git": {
    title: "Show git status",
    type: "boolean",
    default: true,
    description: "File windows inside a git repository colour changed files, mark them (M, A, U, D) and show the branch, which switches to a list of the changes.",
  },
  "ui.showResources": {
    title: "Show resource usage",
    type: "boolean",
    default: true,
    description: "Show memory and CPU of the selected window's processes in the status bar.",
  },
  "ui.unfocusedDim": { title: "Dim other windows", unit: "%", type: "number", default: 20, min: 0, max: 60, step: 5, description: "Darken windows other than the selected one: 0 = off. Light themes darken a quarter as much." },
  "ui.unfocusedDesaturation": { title: "Desaturate other windows", unit: "%", type: "number", default: 0, min: 0, max: 100, step: 10, description: "Drain the colour from windows other than the selected one: 0 = off, 100 = grayscale." },
  "ui.paddingX": { title: "Horizontal padding", unit: "px", type: "number", default: 14, min: 0, max: 48, step: 1, description: "Space between the windows and the left and right edges in grid and strip view." },
  "ui.paddingY": { title: "Vertical padding", unit: "px", type: "number", default: 14, min: 0, max: 48, step: 1, description: "Space between the windows and the top and bottom edges in grid and strip view." },
  "ui.gutter": { title: "Gap between windows", unit: "px", type: "number", default: 11, min: 0, max: 32, step: 1, description: "Space between windows in grid and strip view. The canvas places windows on its own dot grid." },
  "ui.sidebarPadding": { title: "Sidebar padding", unit: "px", type: "number", default: 14, min: 0, max: 24, step: 1, description: "Space between the sidebar's rows and its edges, in the main and Settings windows." },
  "ui.windowOutline": { title: "Outline width", unit: "px", type: "number", default: 1, min: 0, max: 3, step: 1, description: "Width of every window's outline (0 = none). On the canvas it stays this wide on screen at any zoom." },
  "ui.windowOutlineContrast": { title: "Outline contrast", unit: "%", type: "number", default: 20, min: 0, max: 40, step: 1, description: "How strongly outlines and the line under title bars stand out from the background. The colour comes from the theme." },
  "ui.windowShadow": { title: "Shadow", labels: { none: "None", subtle: "Subtle", strong: "Strong" }, type: "enum", default: "subtle", options: ["none", "subtle", "strong"], description: "A drop shadow under windows, in the theme's shadow colour." },
  "ui.focusOutline": { title: "Selected outline width", unit: "px", type: "number", default: 2, min: 1, max: 4, step: 1, description: "Width of the selected window's outline. Also used when a window needs you or rings its bell." },
  "ui.focusColor": { title: "Selected outline colour", labels: { accent: "Accent", neutral: "Neutral" }, type: "enum", default: "neutral", options: ["accent", "neutral"], description: "The theme's accent colour, or a neutral one in the theme's text colour." },
  "ui.focusGlow": { title: "Selected glow", unit: "%", type: "number", default: 0, min: 0, max: 100, step: 10, description: "The soft halo around the selected window's outline: 0 = a crisp outline only." },
  "ui.focusTitleBar": { title: "Tint selected title bar", labels: { off: "Off", subtle: "Subtle", strong: "Strong" }, type: "enum", default: "subtle", options: ["off", "subtle", "strong"], description: "Tint the selected window's title bar in its outline colour." },
  "ui.attentionOutline": { title: "Outline windows that need you", type: "boolean", default: true, description: "A window whose agent waits for input, or whose terminal asked for attention, gets an outline in the theme's attention colour until you select it." },
  "ui.windowRadius": { title: "Window corner radius", unit: "px", type: "number", default: 11, min: 0, max: 16, step: 1, description: "Corner radius of windows (0 = square). Focus mode always fills the pane edge to edge." },

  "canvas.minZoom": { title: "Minimum zoom", unit: "%", type: "number", default: 30, min: 10, max: 100, step: 5, description: "Canvas: how far you can zoom out. Windows stay live at every zoom." },
  "canvas.maxZoom": { title: "Maximum zoom", unit: "%", type: "number", default: 150, min: 100, max: 300, step: 25, description: "Canvas: how far you can zoom in." },
  "canvas.minimap": { title: "Show minimap", type: "boolean", default: true, description: "Canvas: an overview of all windows in the bottom-right corner; click or drag it to move around." },

  "notifications.needsInput": { title: "Agent needs input", type: "boolean", default: true, description: "Notify when an agent needs input." },
  "notifications.done": { title: "Agent finished a turn", type: "boolean", default: true, description: "Notify when an agent finishes a turn." },
  "notifications.widgets": { title: "Widgets report something", type: "boolean", default: true, description: "Notify when a Magic widget reports news (a failed build, a dropped VPN). Mute a single widget from its menu." },
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
    options: ["default", "none", ...SYSTEM_SOUNDS],
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

  "search.enabled": { title: "Index transcripts", type: "boolean", default: true, description: "Index coding agent transcripts (Claude Code, Codex, Qwen Code, Copilot CLI) for search (? in the palette)." },
  "search.archiveDirs": {
    title: "Archive folders", placeholder: "~/claude-transcripts-archive", code: true,
    type: "string",
    default: "~/claude-transcripts-archive",
    description: "Extra folders of archived transcripts (*.jsonl, any supported agent) to index, comma-separated.",
  },

  "remote.enabled": {
    title: "Remote access",
    type: "boolean",
    default: false,
    description: "Use this Mac's Spaces from your phone or any browser, end-to-end encrypted.",
  },
  "remote.relay": {
    title: "Relay",
    placeholder: "wss://relay.endtime-instruments.org",
    code: true,
    type: "string",
    default: "wss://relay.endtime-instruments.org",
    description: "Where this Mac connects to. Changing it means pairing devices again.",
  },
  "remote.client": {
    title: "Web client",
    placeholder: "https://cmd.endtime-instruments.org",
    code: true,
    type: "string",
    default: "https://cmd.endtime-instruments.org",
    description: "Where phones open cmd.",
  },
  "remote.deviceExpiryDays": { title: "Unpair devices unseen for", unit: "days", type: "number", default: 30, min: 1, max: 365, description: "Unused devices are unpaired after this." },

  "agents.claude.command": {
    title: "Claude Code command",
    code: true,
    type: "string",
    default: "claude",
    description: "Command used to start Claude Code (e.g. \"claude --model opus\"). Typed into your shell, so aliases apply.",
  },
  "agents.codex.command": { title: "Codex command", code: true, type: "string", default: "codex", description: "Command used to start Codex." },
  "agents.qwen.command": { title: "Qwen Code command", code: true, type: "string", default: "qwen", description: "Command used to resume Qwen Code sessions." },
  "agents.peers": {
    title: "Tell agents about each other (beta)",
    type: "boolean",
    default: false,
    description: "When an agent starts in a repository where other agents are working (in any of its worktrees), tell it who they are, where and on what, and that it can message them with `cmd send`. Told again when agents come or go. Needs cmd's hook in the agent (Hooks, above).",
  },
  "agents.copilot.command": { title: "Copilot CLI command", code: true, type: "string", default: "copilot", description: "Command used to resume GitHub Copilot CLI sessions." },

  "ai.provider": {
    title: "Use",
    type: "enum",
    default: "anthropic",
    options: ["anthropic", "openai"],
    labels: { anthropic: "Anthropic", openai: "OpenAI" },
    description: "The provider AI features use when you've added keys for both. With one key, that provider is used.",
  },
  "ai.anthropic.model": {
    title: "Model",
    type: "string",
    control: "model",
    provider: "anthropic",
    tier: "smart",
    default: "auto",
    description: "For work that needs the best model: building Magic widgets. Auto uses the newest Claude Opus your key can use.",
  },
  "ai.anthropic.fastModel": {
    title: "Fast model",
    type: "string",
    control: "model",
    provider: "anthropic",
    tier: "fast",
    default: "auto",
    description: "For short tasks that should be quick and cheap, like summaries. Auto uses the newest Claude Haiku your key can use.",
  },
  "ai.openai.model": {
    title: "Model",
    type: "string",
    control: "model",
    provider: "openai",
    tier: "smart",
    default: "auto",
    description: "For work that needs the best model: building Magic widgets. Auto uses the newest GPT your key can use.",
  },
  "ai.openai.fastModel": {
    title: "Fast model",
    type: "string",
    control: "model",
    provider: "openai",
    tier: "fast",
    default: "auto",
    description: "For short tasks that should be quick and cheap, like summaries. Auto uses the newest GPT mini your key can use.",
  },
  "updates.mode": {
    title: "Updates",
    type: "enum",
    default: "auto",
    options: ["auto", "notify", "off"],
    labels: { auto: "Install automatically", notify: "Notify me", off: "Don't check" },
    description: "Auto downloads new versions in the background and installs them when you quit cmd; terminals keep running. Check for Updates… in the cmd menu checks now.",
  },
  "diagnostics.crashReports": {
    title: "Send crash reports",
    type: "boolean",
    default: true,
    description: "When cmd crashes or hits an internal error, send the error, its stack trace, the app version, macOS version, a random id for this Mac (not tied to its hardware) and the last lines of the log to the developer. Your home folder is replaced by ~. Reports are also kept in the logs folder.",
  },
  "diagnostics.usageStats": {
    title: "Send anonymous usage stats",
    type: "boolean",
    default: true,
    description: "Once a minute, count app launches, windows opened by type, agents started by kind and crashes, and send those counts with the app version, macOS version, processor type and this Mac's random id (the one crash reports use). Never commands, paths, titles or anything you type, and no location. The totals are public at endtime-instruments.org/cmd/usage.",
  },
  "magic.explore": { title: "Look around this Mac", type: "boolean", default: true, description: "Let the Magic agent run read-only commands and read files to answer requests about this Mac. Private files (keys, keychains, browser profiles) stay off limits." },
  "magic.deno": { title: "Deno", code: true, type: "string", default: "", placeholder: "found automatically", description: "The Deno that runs widgets' data.ts. Empty: cmd's own copy, else the one on your PATH or in the usual places (Homebrew, ~/.deno)." },
  "magic.autoFix": { title: "Fix broken widgets automatically", type: "boolean", default: false, description: "When a widget's data keeps failing (not just a slow or busy server), let the Magic agent try to fix it once, as if you had pressed Fix." },
  "magic.showSteps": { title: "Show commands while building", type: "boolean", default: false, description: "Show the commands, files and URLs the Magic agent looks at while it builds a widget, with their output. Off: only what it is doing, in a few words." },
} as const satisfies Record<string, Def>;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;

/** Keys that were renamed: old settings files keep working (old → new). */
export const RENAMED_SETTINGS: Readonly<Record<string, SettingKey>> = {
  "terminal.fontFamily": "font.code",
  "terminal.fontSize": "font.codeSize",
  "magic.model": "ai.anthropic.model",
  "magic.provider": "ai.provider",
  "magic.anthropic.model": "ai.anthropic.model",
  "magic.openai.model": "ai.openai.model",
};

/** The current name of a key (renamed keys map to their new name). */
export const currentKey = (key: string): string => RENAMED_SETTINGS[key] ?? key;

/**
 * Keys that no longer exist; ignored without an error (ui.sidebarWidth: drag the
 * sidebar edge; magic.baseUrl: only Anthropic and OpenAI are providers now).
 */
export const REMOVED_SETTINGS: ReadonlySet<string> = new Set(["ui.sidebarWidth", "magic.baseUrl"]);

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
