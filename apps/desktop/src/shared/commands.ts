// App commands: one list for the menu bar (main), the command palette and
// context menus (renderer). Main owns accelerators, so shortcuts are real macOS
// key equivalents and win over the terminal. The renderer implements `run`.

export interface CommandSpec {
  id: string;
  label: string;
  /**
   * Default shortcuts (Electron accelerator syntax). The first is shown in the
   * menu; the rest are bound by hidden items. Users remap in keybindings.json.
   */
  keys?: string[];
  /** Radio/checkbox items whose state the renderer reports. */
  checkable?: "radio" | "checkbox";
  /** Hidden from the command palette (e.g. "Select Session 3"). */
  paletteHidden?: boolean;
}

const spec = <const T extends CommandSpec[]>(xs: T) => xs;

export const COMMANDS = spec([
  { id: "app.settings", label: "Settings…", keys: ["Cmd+,"] },
  { id: "app.setup", label: "Set Up cmd…" },
  { id: "app.checkUpdates", label: "Check for Updates…" },
  { id: "app.taskManager", label: "Task Manager" },
  { id: "app.restartCore", label: "Restart Core" },
  { id: "app.remoteAccess", label: "Remote Access…" },
  { id: "app.pairDevice", label: "Pair a Device…" },
  { id: "app.disconnectRemote", label: "Disconnect Remote Devices" },

  { id: "file.newTerminal", label: "New Terminal", keys: ["Cmd+N", "Cmd+T"] },
  { id: "file.newClaude", label: "New Claude Session", keys: ["Alt+Cmd+N"] },
  { id: "file.newCodex", label: "New Codex Session" },
  { id: "file.newBrowser", label: "New Browser Window", keys: ["Shift+Cmd+B"] },
  { id: "file.newFiles", label: "New File Browser", keys: ["Shift+Cmd+O"] },
  { id: "file.newText", label: "New Text Window", keys: ["Shift+Cmd+E"] },
  { id: "file.openSpace", label: "Open Space…", keys: ["Cmd+O"] },
  // Widgets (docs/16-widgets.md). Ids keep their old names: keybindings.json uses them.
  { id: "widget.library", label: "Widget Library…", keys: ["Shift+Cmd+L"] },
  { id: "file.newMagic", label: "New Widget with Magic…", keys: ["Shift+Cmd+M"] },
  { id: "view.magicChange", label: "Change Widget…", keys: ["Cmd+L"] },
  { id: "view.magicRefresh", label: "Refresh Widget", keys: ["Cmd+R"] },
  { id: "view.magicStop", label: "Stop Making Widget", keys: ["Cmd+."] },
  { id: "widget.remove", label: "Remove from Desk" },
  { id: "file.save", label: "Save", keys: ["Cmd+S"] },
  { id: "file.close", label: "Close Window", keys: ["Cmd+W"] },
  { id: "file.closeWindow", label: "Close App Window", keys: ["Shift+Cmd+W"] },
  { id: "file.openSettingsFile", label: "Open settings.json" },

  { id: "edit.copy", label: "Copy", keys: ["Cmd+C"] },
  { id: "edit.selectAll", label: "Select All", keys: ["Cmd+A"] },
  { id: "edit.clear", label: "Clear Buffer", keys: ["Alt+Cmd+K"] },
  { id: "edit.find", label: "Find…", keys: ["Cmd+F"] },
  { id: "edit.findNext", label: "Find Next", keys: ["Cmd+G"] },
  { id: "edit.findPrev", label: "Find Previous", keys: ["Shift+Cmd+G"] },
  { id: "edit.copyLastOutput", label: "Copy Last Command Output", keys: ["Shift+Cmd+A"] },
  // ⌘↑ / ⌘↓ in a terminal (its own keys, so text windows keep theirs: terminals.ts).
  { id: "terminal.prevPrompt", label: "Jump to Previous Prompt" },
  { id: "terminal.nextPrompt", label: "Jump to Next Prompt" },

  { id: "view.palette", label: "Command Palette…", keys: ["Cmd+K"] },
  { id: "view.search", label: "Search Sessions…", keys: ["Shift+Cmd+F"] },
  { id: "view.focus", label: "Focus", keys: ["Alt+Cmd+1"], checkable: "radio" },
  { id: "view.grid", label: "Grid", keys: ["Alt+Cmd+2"], checkable: "radio" },
  { id: "view.strip", label: "Strip", keys: ["Alt+Cmd+3"], checkable: "radio" },
  { id: "view.canvas", label: "Canvas", keys: ["Alt+Cmd+4"], checkable: "radio" },
  { id: "view.toggleFocus", label: "Toggle Focus", keys: ["Cmd+Enter"] },
  { id: "view.canvasFit", label: "Zoom Canvas to Fit", keys: ["Shift+Cmd+1"] },
  { id: "view.canvasZoomWindow", label: "Zoom Canvas to Window", keys: ["Shift+Cmd+2"] },
  { id: "view.cycleWidth", label: "Cycle Window Width", keys: ["Ctrl+Cmd+R"] },
  { id: "view.toggleEdit", label: "Toggle Preview / Edit", keys: ["Cmd+E"] },
  { id: "view.sidebar", label: "Show Sidebar", keys: ["Ctrl+Cmd+S"], checkable: "checkbox" },
  { id: "view.zoomIn", label: "Bigger", keys: ["Cmd+Plus", "Cmd+="] },
  { id: "view.zoomOut", label: "Smaller", keys: ["Cmd+-"] },
  { id: "view.zoomReset", label: "Actual Size", keys: ["Cmd+0"] },

  { id: "session.next", label: "Next Session", keys: ["Alt+Cmd+Right", "Shift+Cmd+]"] },
  { id: "session.prev", label: "Previous Session", keys: ["Alt+Cmd+Left", "Shift+Cmd+["] },
  { id: "session.nextAttention", label: "Next Needing Attention", keys: ["Ctrl+Cmd+J"] },
  { id: "session.copyResume", label: "Copy Resume Command" },
  { id: "session.copyId", label: "Copy Session ID" },
  { id: "session.reveal", label: "Show Folder in Finder", keys: ["Alt+Cmd+R"] },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    id: `session.select${n}`,
    label: `Select Session ${n}`,
    keys: [`Cmd+${n}`],
    paletteHidden: true,
  })),

  { id: "space.next", label: "Next Space", keys: ["Ctrl+Cmd+]"] },
  { id: "space.prev", label: "Previous Space", keys: ["Ctrl+Cmd+["] },
  { id: "space.last", label: "Last Space" },
  { id: "space.moveWindow", label: "Move Window to Space…" },
  { id: "space.rename", label: "Rename Space…" },
  { id: "space.icon", label: "Change Space Icon…" },
  { id: "space.reveal", label: "Show Space Folder in Finder" },
  { id: "space.close", label: "Close Space…" },
  // Ctrl+1–9 like Arc's spaces; ⌘1–9 stay for sessions.
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    id: `space.select${n}`,
    label: `Switch to Space ${n}`,
    keys: [`Ctrl+${n}`],
    paletteHidden: true,
  })),

  { id: "help.docs", label: "cmd Documentation" },
  { id: "help.whatsNew", label: "What's New" },
  { id: "help.feedback", label: "Send Feedback…" },
]);

export type CommandId = (typeof COMMANDS)[number]["id"];

export const COMMAND_BY_ID = new Map<string, CommandSpec>((COMMANDS as readonly CommandSpec[]).map((c) => [c.id, c]));

/** State the renderer reports so menu items can be checked/enabled. */
export interface MenuState {
  checked: Partial<Record<CommandId, boolean>>;
  enabled: Partial<Record<CommandId, boolean>>;
}

/** Context menu item sent from renderer to main. */
/** A context-menu item; `checked` shows a checkmark, `submenu` nests items (its own id is never chosen). */
export type ContextItem = { id: string; label: string; enabled?: boolean; checked?: boolean; submenu?: ContextItem[] } | { separator: true };

export type Keybindings = Record<string, string[]>;

/** The macOS keymap (⌘ shortcuts) or the one for Windows/Linux. Main: the platform; renderer: the browser's. */
export const MAC_KEYMAP: boolean =
  typeof process !== "undefined" && typeof process.platform === "string" ? process.platform === "darwin" : typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");

/**
 * A default shortcut (written for macOS) on Windows and Linux, the Windows
 * Terminal way: app shortcuts take Ctrl+Shift, so plain Ctrl+letter keeps
 * reaching the shell (Ctrl+C, Ctrl+R…). ⌘X → Ctrl+Shift+X, ⌥⌘X → Ctrl+Alt+X,
 * ⇧⌘X and ⌃⌘X → Ctrl+Alt+Shift+X; ⌘, ⌘= ⌘- ⌘0 → Ctrl+, Ctrl+= … (settings
 * and zoom, as in Windows Terminal). Shortcuts without ⌘ stay as they are.
 */
export function otherPlatformKey(acc: string): string {
  const parts = acc.split("+");
  const key = parts.pop()!;
  const alias: Record<string, string> = { command: "cmd", cmdorctrl: "cmd", option: "alt", control: "ctrl" };
  const mods = new Set(parts.map((m) => alias[m.toLowerCase()] ?? m.toLowerCase()));
  if (!mods.has("cmd")) return acc;
  if (mods.size === 1 && [",", "=", "Plus", "-", "0"].includes(key)) return `Ctrl+${key}`;
  const out = mods.has("shift") || mods.has("ctrl") ? ["Ctrl", "Alt", "Shift"] : mods.has("alt") ? ["Ctrl", "Alt"] : ["Ctrl", "Shift"];
  return [...out, key].join("+");
}

/** Every command's default shortcuts for the macOS keymap or the Windows/Linux one. */
export function platformDefaults(mac: boolean): Keybindings {
  const specs = COMMANDS as readonly CommandSpec[];
  const out: Keybindings = Object.fromEntries(specs.map((c) => [c.id, (c.keys ?? []).map((k) => (mac ? k : otherPlatformKey(k)))]));
  if (mac) return out;
  // Two macOS shortcuts can land on the same one (⇧⌘] and ⌃⌘]): it stays with
  // the command that has fewest shortcuts (Next Space keeps it; Next Session has ⌥→).
  const owners = new Map<string, string[]>();
  for (const c of specs) for (const k of out[c.id]!) owners.set(norm(k), [...(owners.get(norm(k)) ?? []), c.id]);
  for (const [k, ids] of owners) {
    if (ids.length < 2) continue;
    const keep = [...ids].sort((a, b) => out[a]!.length - out[b]!.length)[0];
    for (const id of ids) if (id !== keep) out[id] = out[id]!.filter((x) => norm(x) !== k);
  }
  return out;
}

export const DEFAULT_KEYBINDINGS: Keybindings = platformDefaults(MAC_KEYMAP);

/**
 * Overlay the user's keybindings.json on the defaults:
 * { "session.next": "Ctrl+Tab" } replaces, ["A", "B"] binds several,
 * null or [] unbinds. A shortcut taken by another command is removed there.
 */
export function resolveKeybindings(user: unknown, defaults: Keybindings = DEFAULT_KEYBINDINGS): { bindings: Keybindings; errors: string[] } {
  const bindings: Keybindings = structuredClone(defaults);
  const errors: string[] = [];
  if (!user || typeof user !== "object" || Array.isArray(user)) return { bindings, errors };
  for (const [id, v] of Object.entries(user as Record<string, unknown>)) {
    if (!COMMAND_BY_ID.has(id)) {
      errors.push(`unknown command "${id}"`);
      continue;
    }
    const keys = v === null ? [] : typeof v === "string" ? [v] : Array.isArray(v) && v.every((k) => typeof k === "string") ? v : null;
    if (!keys) {
      errors.push(`${id}: expected a shortcut string, a list of them, or null`);
      continue;
    }
    for (const other of Object.keys(bindings)) {
      if (other !== id) bindings[other] = bindings[other]!.filter((k) => !keys.some((x) => sameKey(x, k)));
    }
    bindings[id] = keys;
  }
  return { bindings, errors };
}

/**
 * keybindings.json's object after the Settings window binds `keys` to `id`
 * (null: back to the defaults). The keys leave other commands' entries, so the
 * file's order can't hand them back; a list equal to the defaults is dropped.
 */
export function editKeybindings(user: unknown, id: string, keys: string[] | null, defaults: Keybindings = DEFAULT_KEYBINDINGS): Record<string, unknown> {
  const out: Record<string, unknown> = user && typeof user === "object" && !Array.isArray(user) ? { ...(user as Record<string, unknown>) } : {};
  delete out[id];
  if (!keys) return out;
  for (const [other, v] of Object.entries(out)) {
    const list = typeof v === "string" ? [v] : Array.isArray(v) ? v : null;
    if (list?.some((k) => typeof k === "string" && keys.some((x) => sameKey(x, k)))) out[other] = list.filter((k) => !keys.some((x) => sameKey(x, k)));
  }
  const def = defaults[id] ?? [];
  if (keys.length !== def.length || keys.some((k, i) => !sameKey(k, def[i]!))) out[id] = keys;
  return out;
}

const sameKey = (a: string, b: string) => norm(a) === norm(b);
/** A shortcut in a comparable form: lowercase, modifiers sorted ("alt+cmd+n"). */
export function norm(k: string): string {
  const parts = k.toLowerCase().replace(/cmdorctrl|command/g, "cmd").replace(/option/g, "alt").replace(/control/g, "ctrl").split("+");
  const key = parts.pop();
  return [...parts.sort(), key].join("+");
}

/** "Alt+Cmd+N" → "⌥⌘N" for display on macOS; "Ctrl+Shift+N" stays as written elsewhere. */
export function prettyAccelerator(acc?: string, mac = MAC_KEYMAP): string | undefined {
  if (!acc) return undefined;
  if (!mac) {
    const words: Record<string, string> = { Cmd: "Ctrl", Command: "Ctrl", CmdOrCtrl: "Ctrl", Control: "Ctrl", Option: "Alt", Plus: "+", Escape: "Esc", Return: "Enter" };
    return acc.split("+").map((p) => words[p] ?? (p.length === 1 ? p.toUpperCase() : p)).join("+");
  }
  const map: Record<string, string> = {
    Cmd: "⌘", Command: "⌘", CmdOrCtrl: "⌘", Ctrl: "⌃", Control: "⌃", Alt: "⌥", Option: "⌥", Shift: "⇧",
    Plus: "+", Left: "←", Right: "→", Up: "↑", Down: "↓", Tab: "⇥", Enter: "↩", Return: "↩", Backspace: "⌫", Escape: "⎋", Space: "Space",
  };
  const parts = acc.split("+");
  const key = parts.pop()!;
  const order = ["⌃", "⌥", "⇧", "⌘"];
  const mods = parts.map((m) => map[m] ?? m).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return mods.join("") + (map[key] ?? key.toUpperCase());
}
