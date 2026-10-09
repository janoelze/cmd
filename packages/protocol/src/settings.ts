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
 * title: the label in the settings window (default: from the key). description:
 * one short line under it, what the setting does (a test keeps it short).
 * details: only what would surprise someone (what's sent where, which files
 * change, a format to follow), behind the row's info button; most keys have none. `code` spans work in both. The rest are display hints (unit,
 * placeholder, option labels, a font preview, code). Where a key appears in the
 * window is the window's business (renderer settings/layout.ts).
 */
type Common = { title?: string; description: string; details?: string; applies?: SettingApplies };
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
    description: "Terminals, the text editor and code in Markdown.",
  },
  "font.codeSize": { title: "Code font size", unit: "px", type: "number", default: 14, min: 8, max: 32, description: "Size of the code font." },
  "font.text": {
    title: "Text font",
    control: "font",
    placeholder: "System font",
    type: "string",
    default: "",
    description: "For reading Markdown. Empty uses the system font.",
  },
  "font.textSize": { title: "Text font size", unit: "px", type: "number", default: 14, min: 10, max: 24, description: "Size of the text font." },

  "theme.appearance": {
    title: "Appearance",
    type: "enum",
    default: "dark",
    options: ["auto", "dark", "light"],
    labels: { auto: "Auto", dark: "Dark", light: "Light" },
    description: "Dark, light, or follow the system.",
  },
  "theme.dark": { title: "Dark theme", type: "string", control: "theme", appearance: "dark", default: "pastel-dark", description: "Used in dark appearance." },
  "theme.light": { title: "Light theme", type: "string", control: "theme", appearance: "light", default: "pastel-light", description: "Used in light appearance." },
  "theme.dockIcon": {
    title: "Themed Dock icon",
    type: "boolean",
    default: true,
    description: "The Dock icon in the theme's colours.",
  },

  "terminal.renderer": {
    title: "Renderer", labels: { dom: "DOM", webgl: "WebGL" },
    type: "enum",
    default: "webgl",
    options: ["dom", "webgl"],
    description: "WebGL is faster; DOM matches macOS text rendering.",
  },
  "terminal.lineHeight": { title: "Line height", type: "number", default: 1.1, min: 1, max: 2, step: 0.05, description: "Space between terminal lines." },
  "terminal.cursorBlink": { title: "Blinking cursor", type: "boolean", default: true, description: "Blink the terminal cursor." },
  "terminal.scrollback": { title: "Scrollback", unit: "lines", type: "number", default: 10000, min: 0, max: 200000, description: "Lines kept per terminal." },
  "terminal.cursorStyle": {
    title: "Cursor",
    type: "enum",
    default: "block",
    options: ["block", "bar", "underline"],
    labels: { block: "Block", bar: "Bar", underline: "Underline" },
    description: "Shape of the terminal cursor.",
  },
  "terminal.minimumContrast": {
    title: "Minimum contrast",
    type: "number",
    default: 1,
    min: 1,
    max: 21,
    step: 0.5,
    description: "Fix text too close to its background's colour.",
  },
  "terminal.optionAsMeta": {
    title: "Option key as Meta",
    type: "enum",
    default: "both",
    options: ["both", "left", "right", "off"],
    labels: { both: "Both", left: "Left Option", right: "Right Option", off: "Off" },
    description: "Option+key sends Escape+key, for shell shortcuts.", details: "Off, or on one side only, keeps that Option key typing characters like @ and € on international layouts.",
  },
  "terminal.clickMovesCursor": {
    title: "Click moves the cursor",
    type: "boolean",
    default: true,
    description: "Click in the command line to move the cursor.",
  },
  "terminal.hideMouseWhileTyping": { title: "Hide pointer while typing", type: "boolean", default: false, description: "Hide the pointer over a terminal while you type." },
  "terminal.copyOnSelect": { title: "Copy on select", type: "boolean", default: false, description: "Copy text as soon as it's selected." },
  "terminal.pasteProtection": {
    title: "Confirm risky pastes",
    type: "boolean",
    default: true,
    description: "Ask before pastes that could run commands.",
  },
  "terminal.clipboardWrite": {
    title: "Programs can copy",
    type: "boolean",
    default: true,
    description: "Let programs copy to the clipboard (OSC 52).",
  },
  "terminal.images": { title: "Inline images", type: "boolean", default: true, description: "Show images programs print." },
  "terminal.webglPool": {
    title: "WebGL terminals",
    type: "number",
    default: 8,
    min: 0,
    max: 14,
    description: "Most terminals drawn with WebGL at once.",
  },

  "restore.terminals": {
    title: "Reopen terminals",
    type: "boolean",
    default: true,
    description: "Bring back open terminals after a restart.",
  },
  "restore.scrollback": { title: "Lines kept", unit: "lines", type: "number", default: 2000, min: 0, max: 20000, description: "Output kept per terminal for reopening it." },
  "restore.resumeAgents": {
    title: "Resume agent sessions",
    type: "boolean",
    default: true,
    description: "Resume Claude and Codex sessions in reopened terminals.",
  },

  "shell.program": { title: "Shell", placeholder: "$SHELL", code: true, type: "string", default: "", applies: "newTerminals", description: "Empty uses `$SHELL`." },
  "shell.login": { title: "Login shell", type: "boolean", default: true, applies: "newTerminals", description: "Start shells as login shells (`-l`)." },
  "shell.integration": {
    title: "Shell integration",
    type: "boolean",
    default: true,
    applies: "newTerminals",
    description: "Tell cmd the folder, prompts and running command.",
  },
  "shell.openFolders": { title: "Open folders in cmd", type: "boolean", default: true, description: "`open <folder>` opens a file window." },
  "shell.openFiles": {
    title: "Open files in cmd",
    type: "boolean",
    default: true,
    description: "`open <file>` opens text and pages in cmd.",
  },
  "open.handlers": {
    title: "Extension overrides", placeholder: "md: browser, log: text", code: true,
    type: "string",
    default: "",
    description: "Which window opens which file extension.", details: "Comma-separated pairs that override the defaults, e.g. `md: browser, log: text`.",
  },
  "open.links": {
    title: "Open links in", labels: { cmd: "cmd browser window", browser: "Default browser" },
    type: "enum",
    default: "cmd",
    options: ["cmd", "browser"],
    description: "Where http(s) links you click open.",
  },
  "shell.openUrls": { title: "Open URLs in cmd", type: "boolean", default: false, description: "`open <url>` opens a browser window." },

  "ui.defaultView": { title: "Default view", labels: { focus: "Focus", grid: "Grid", strip: "Strip", canvas: "Canvas" }, type: "enum", default: "focus", applies: "firstLaunch", options: ["focus", "grid", "strip", "canvas"], description: "The view mode cmd starts in." },
  "files.git": {
    title: "Show git status",
    type: "boolean",
    default: true,
    description: "Show changes and the branch in file windows.",
  },
  "ui.showResources": {
    title: "Show resource usage",
    type: "boolean",
    default: true,
    description: "The selected window's memory and CPU, in the status bar.",
  },
  "ui.unfocusedDim": { title: "Dim other windows", unit: "%", type: "number", default: 20, min: 0, max: 60, step: 5, description: "Darken windows other than the selected one." },
  "ui.unfocusedDesaturation": { title: "Desaturate other windows", unit: "%", type: "number", default: 0, min: 0, max: 100, step: 10, description: "Drain the colour from other windows." },
  "ui.paddingX": { title: "Horizontal padding", unit: "px", type: "number", default: 14, min: 0, max: 48, step: 1, description: "Space at the left and right edges." },
  "ui.paddingY": { title: "Vertical padding", unit: "px", type: "number", default: 14, min: 0, max: 48, step: 1, description: "Space at the top and bottom edges." },
  "ui.gutter": { title: "Gap between windows", unit: "px", type: "number", default: 11, min: 0, max: 32, step: 1, description: "Space between windows." },
  "spaces.ownWindow": {
    title: "Open each Space in its own window",
    type: "boolean",
    default: false,
    description: "A Space you switch to opens in a new window, not this one.",
  },
  "ui.sidebarRecent": { title: "Recent sessions", unit: "sessions", type: "number", default: 5, min: 0, max: 20, step: 1, description: "Past sessions under Recent. 0 hides them." },
  "ui.windowOutline": { title: "Outline width", unit: "px", type: "number", default: 1, min: 0, max: 3, step: 1, description: "Width of every window's outline. 0 is none." },
  "ui.windowOutlineContrast": { title: "Outline contrast", unit: "%", type: "number", default: 20, min: 0, max: 40, step: 1, description: "How much outlines stand out." },
  "ui.windowShadow": { title: "Shadow", labels: { none: "None", subtle: "Subtle", medium: "Medium", strong: "Strong", deep: "Deep" }, type: "enum", default: "subtle", options: ["none", "subtle", "medium", "strong", "deep"], description: "A drop shadow under windows and sidebars." },
  "ui.focusOutline": { title: "Selected outline width", unit: "px", type: "number", default: 2, min: 1, max: 4, step: 1, description: "Width of the selected window's outline." },
  "ui.focusColor": { title: "Selected outline colour", labels: { accent: "Accent", neutral: "Neutral" }, type: "enum", default: "neutral", options: ["accent", "neutral"], description: "The theme's accent, or its text colour." },
  "ui.focusGlow": { title: "Selected glow", unit: "%", type: "number", default: 0, min: 0, max: 100, step: 10, description: "A soft halo around the selected window." },
  "ui.focusTitleBar": { title: "Tint selected title bar", labels: { off: "Off", subtle: "Subtle", strong: "Strong" }, type: "enum", default: "subtle", options: ["off", "subtle", "strong"], description: "Tint the selected title bar in the outline colour." },
  "ui.attentionOutline": { title: "Outline windows that need you", type: "boolean", default: true, description: "Outline windows that wait for you." },
  "ui.windowRadius": { title: "Window corner radius", unit: "px", type: "number", default: 11, min: 0, max: 16, step: 1, description: "Corner radius of windows. 0 is square." },

  "canvas.minZoom": { title: "Minimum zoom", unit: "%", type: "number", default: 30, min: 10, max: 100, step: 5, description: "How far the canvas zooms out." },
  "canvas.maxZoom": { title: "Maximum zoom", unit: "%", type: "number", default: 150, min: 100, max: 300, step: 25, description: "How far the canvas zooms in." },
  "canvas.minimap": { title: "Show minimap", type: "boolean", default: true, description: "An overview of all windows, bottom right." },

  "notifications.needsInput": { title: "Agent needs input", type: "boolean", default: true, description: "When an agent needs input." },
  "notifications.done": { title: "Agent finished a turn", type: "boolean", default: true, description: "When an agent finishes a turn or stops on an error." },
  "agents.names.ai": {
    title: "Name agents with AI",
    type: "boolean",
    default: true,
    description: "Your AI provider names each agent after what it works on.",
    details: "Sends your recent prompts to it. Agents in a worktree take the branch's name, and names you give always stay.",
  },
  "notifications.ai": {
    title: "Write agent notifications with AI",
    type: "boolean",
    default: true,
    description: "Your AI provider sums up what the agent did.",
  },
  "actions.describe": { title: "Describe actions with AI", type: "boolean", default: true, description: "A few words on what each action does, from the fast model.", details: "Only the scripts' names and commands and the shell commands in the README go to the model. Descriptions written in the files are always kept." },
  "actions.openBrowser": { title: "Open dev servers in a browser", type: "boolean", default: false, description: "Open a dev server's local address in a browser window beside it." },
  "widgets.developer": { title: "Developer widgets", type: "boolean", default: false, description: "Offer widgets that show what cmd records and does.", details: "Like the Event Stream. Safe to use; mostly useful when working on cmd or reporting a problem." },
  "notifications.widgets": { title: "Widgets report something", type: "boolean", default: true, description: "When a Magic widget reports news." },
  "notifications.dockBadge": { title: "Badge the Dock icon", type: "boolean", default: true, description: "Show the attention count on the Dock icon." },
  "notifications.when": {
    title: "Show notifications",
    type: "enum",
    default: "background",
    options: ["background", "always", "never"],
    labels: { background: "When I'm not looking at that window", always: "Always", never: "Never" },
    description: "When system notifications show.",
  },
  "notifications.sound": {
    title: "Sound",
    type: "enum",
    default: "default",
    options: ["default", "none", ...SYSTEM_SOUNDS],
    labels: { default: "System default", none: "None" },
    description: "For notifications that need you.",
  },
  "notifications.bounceDock": {
    title: "Bounce the Dock icon",
    type: "enum",
    default: "needsInput",
    options: ["needsInput", "any", "off"],
    labels: { needsInput: "When something needs me", any: "For every notification", off: "Never" },
    description: "Bounce once while cmd is in the background.",
  },
  "notifications.bell": {
    title: "Terminal bell",
    type: "enum",
    default: "mark",
    options: ["mark", "notify", "ignore"],
    labels: { mark: "Mark the window", notify: "Mark and notify", ignore: "Ignore" },
    description: "What a terminal bell does.",
  },
  "notifications.visualBell": { title: "Flash on bell", type: "boolean", default: true, description: "Flash the outline when a terminal rings the bell." },
  "notifications.terminalSequences": {
    title: "Notifications from programs",
    type: "boolean",
    default: true,
    description: "Let programs show notifications.",
  },
  "notifications.longCommand": {
    title: "Long commands",
    unit: "s",
    type: "number",
    default: 30,
    min: 0,
    max: 3600,
    step: 5,
    description: "When a command that ran this long finishes.",
  },

  "search.archiveDirs": {
    title: "Archive folders", placeholder: "~/claude-transcripts-archive", code: true,
    type: "string",
    default: "~/claude-transcripts-archive",
    description: "More transcript folders to index.",
  },

  "remote.enabled": {
    title: "Remote access",
    type: "boolean",
    default: false,
    description: "Use this Mac's Spaces from your phone, end-to-end encrypted.",
  },
  "remote.relay": {
    title: "Relay",
    placeholder: "wss://relay.endtime-instruments.org",
    code: true,
    type: "string",
    default: "wss://relay.endtime-instruments.org",
    description: "Where this Mac connects to.",
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
    description: "Starts Claude Code, e.g. `claude --model opus`.",
  },
  "agents.codex.command": { title: "Codex command", code: true, type: "string", default: "codex", description: "Starts Codex." },
  "agents.qwen.command": { title: "Qwen Code command", code: true, type: "string", default: "qwen", description: "Resumes Qwen Code sessions." },
  "agents.peers": {
    title: "Tell agents about each other (beta)",
    type: "boolean",
    default: false,
    description: "Each new agent hears who else works in its repository.", details: "Who they are, where and on what, and that `cmd send` reaches them. Needs cmd's hook (above).",
  },
  "agents.hooks.auto": {
    title: "Install the hook automatically",
    type: "boolean",
    default: true,
    description: "Add cmd's hook to the agent configs it finds.", details: "Claude Code, Codex and Gemini CLI. Skips files you removed the hook from, and keeps a `.cmd-backup` the first time it changes one.",
  },
  "agents.homes": {
    title: "More agent folders", placeholder: "~/dotfiles/claude", code: true,
    type: "string",
    default: "",
    description: "Agent config folders cmd doesn't find itself.",
  },
  "agents.copilot.command": { title: "Copilot CLI command", code: true, type: "string", default: "copilot", description: "Resumes GitHub Copilot CLI sessions." },

  "ai.provider": {
    title: "Use",
    type: "enum",
    default: "anthropic",
    options: ["anthropic", "openai"],
    labels: { anthropic: "Anthropic", openai: "OpenAI" },
    description: "Used when you've added keys for both.",
  },
  "ai.anthropic.model": {
    title: "Model",
    type: "string",
    control: "model",
    provider: "anthropic",
    tier: "smart",
    default: "auto",
    description: "For the hardest work: building Magic widgets.",
  },
  "ai.anthropic.fastModel": {
    title: "Fast model",
    type: "string",
    control: "model",
    provider: "anthropic",
    tier: "fast",
    default: "auto",
    description: "For quick, cheap tasks like summaries.",
  },
  "ai.openai.model": {
    title: "Model",
    type: "string",
    control: "model",
    provider: "openai",
    tier: "smart",
    default: "auto",
    description: "For the hardest work: building Magic widgets.",
  },
  "ai.openai.fastModel": {
    title: "Fast model",
    type: "string",
    control: "model",
    provider: "openai",
    tier: "fast",
    default: "auto",
    description: "For quick, cheap tasks like summaries.",
  },
  "updates.mode": {
    title: "Updates",
    type: "enum",
    default: "auto",
    options: ["auto", "notify", "off"],
    labels: { auto: "Install automatically", notify: "Notify me", off: "Don't check" },
    description: "How new versions arrive.",
  },
  "data.keepDays": { title: "Keep for", type: "number", default: 365, unit: "days", description: "How long most recorded data is kept.", details: "Agent events, transcripts, pages, files and your actions. Command output goes after 90 days. Git, notes, the journal's days and summaries stay." },
  "data.record.transcripts": { title: "Keep transcripts", type: "boolean", default: true, description: "cmd's own copy of each agent session.", details: "Messages, tool calls and results, as the agent wrote them, so a session outlives the agent's files. Redacted as they're saved." },
  "data.record.output": { title: "Keep command output", type: "boolean", default: true, description: "What commands printed, once they ended.", details: "Up to 256 KB per command, 90 days, redacted. Lets cmd say what a build or test did." },
  "data.record.browsing": { title: "Keep pages and files", type: "boolean", default: true, description: "Pages in cmd's browser windows, files you open in cmd.", details: "Addresses and titles only, never page contents. Not Safari, Chrome or other browsers. Files by their path." },
  "data.exclude": { title: "Never record", type: "string", default: "", code: true, placeholder: "~/private, host:bank.example, cmd:^op ", description: "Folders, hosts and commands cmd never keeps.", details: "Comma-separated. A folder (`~/private`): nothing that happens in it, agents and transcripts included. `host:example.com`: pages on that host. `cmd:<regular expression>`: commands that match. Applies to what's recorded from now on; `cmd data prune --rules` removes what's already kept." },
  "data.record.actions": { title: "Keep your actions", type: "boolean", default: true, description: "What you focused, opened, closed and ran in cmd.", details: "Not what you type: terminals' commands are their own class. This is what lets features know what you were doing, not only what agents did." },
  "diagnostics.crashReports": {
    title: "Send crash reports",
    type: "boolean",
    default: true,
    description: "Send crash details to the developer.", details: "The error, its stack trace, the app and macOS versions, a random id for this Mac (not tied to its hardware) and the last lines of the log. Your home folder is replaced by `~`. Reports are also kept in the logs folder.",
  },
  "diagnostics.usageStats": {
    title: "Send anonymous usage stats",
    type: "boolean",
    default: true,
    description: "Counts of what's used, never what you do.", details: "Once a minute: app launches, windows opened by type, agents started by kind and crashes, with the app and macOS versions, processor type and this Mac's random id (the one crash reports use). Never commands, paths, titles or anything you type, and no location. The totals are public at endtime-instruments.org/cmd/usage.",
  },
  "magic.explore": { title: "Look around this Mac", type: "boolean", default: true, description: "Let the Magic agent look around to answer.", details: "It runs read-only commands and reads files about this Mac. Private files (keys, keychains, browser profiles) stay off limits." },
  "magic.deno": { title: "Deno", code: true, type: "string", default: "", placeholder: "found automatically", description: "Runs widgets' `data.ts`. Empty finds one." },
  "magic.autoFix": { title: "Fix broken widgets automatically", type: "boolean", default: false, description: "Let the Magic agent try once, as if you pressed Fix." },
  "magic.showSteps": { title: "Show commands while building", type: "boolean", default: false, description: "Show the commands, files and URLs it looks at." },
} as const satisfies Record<string, Def>;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;

/** Keys that were renamed: old settings files keep working (old → new). */
export const RENAMED_SETTINGS: Readonly<Record<string, SettingKey>> = {
  "search.enabled": "data.record.transcripts",
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
 * sidebar edge; magic.baseUrl: only Anthropic and OpenAI are providers now;
 * ui.sidebarPadding: the app's to set).
 */
export const REMOVED_SETTINGS: ReadonlySet<string> = new Set(["ui.sidebarWidth", "magic.baseUrl", "ui.sidebarPadding"]);

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
