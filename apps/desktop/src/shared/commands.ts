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

  { id: "file.newTerminal", label: "New Terminal", keys: ["Cmd+N", "Cmd+T"] },
  { id: "file.newClaude", label: "New Claude Session", keys: ["Alt+Cmd+N"] },
  { id: "file.newCodex", label: "New Codex Session" },
  { id: "file.newBrowser", label: "New Browser Window", keys: ["Shift+Cmd+B"] },
  { id: "file.newFiles", label: "New File Browser", keys: ["Shift+Cmd+O"] },
  { id: "file.save", label: "Save", keys: ["Cmd+S"] },
  { id: "file.close", label: "Close Window", keys: ["Cmd+W"] },
  { id: "file.closeWindow", label: "Close App Window", keys: ["Shift+Cmd+W"] },
  { id: "file.openSettingsFile", label: "Open settings.json" },

  { id: "edit.copy", label: "Copy", keys: ["Cmd+C"] },
  { id: "edit.selectAll", label: "Select All", keys: ["Cmd+A"] },
  { id: "edit.clear", label: "Clear Buffer", keys: ["Alt+Cmd+K"] },

  { id: "view.palette", label: "Command Palette…", keys: ["Cmd+K"] },
  { id: "view.search", label: "Search Sessions…", keys: ["Shift+Cmd+F"] },
  { id: "view.focus", label: "Focus", keys: ["Alt+Cmd+1"], checkable: "radio" },
  { id: "view.grid", label: "Grid", keys: ["Alt+Cmd+2"], checkable: "radio" },
  { id: "view.strip", label: "Strip", keys: ["Alt+Cmd+3"], checkable: "radio" },
  { id: "view.canvas", label: "Canvas", keys: ["Alt+Cmd+4"], checkable: "radio" },
  { id: "view.cycleWidth", label: "Cycle Window Width", keys: ["Ctrl+Cmd+R"] },
  { id: "view.toggleEdit", label: "Toggle Preview / Edit", keys: ["Cmd+E"] },
  { id: "view.sidebar", label: "Show Sidebar", keys: ["Ctrl+Cmd+S"], checkable: "checkbox" },
  { id: "view.sessions", label: "Sessions", keys: ["Ctrl+Cmd+1"] },
  { id: "view.tools", label: "Tools", keys: ["Ctrl+Cmd+2"] },
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

  { id: "help.docs", label: "cmd Documentation" },
]);

export type CommandId = (typeof COMMANDS)[number]["id"];

export const COMMAND_BY_ID = new Map<string, CommandSpec>((COMMANDS as readonly CommandSpec[]).map((c) => [c.id, c]));

/** State the renderer reports so menu items can be checked/enabled. */
export interface MenuState {
  checked: Partial<Record<CommandId, boolean>>;
  enabled: Partial<Record<CommandId, boolean>>;
}

/** Context menu item sent from renderer to main. */
export type ContextItem = { id: string; label: string; enabled?: boolean } | { separator: true };

export type Keybindings = Record<string, string[]>;

export const DEFAULT_KEYBINDINGS: Keybindings = Object.fromEntries(
  (COMMANDS as readonly CommandSpec[]).map((c) => [c.id, [...(c.keys ?? [])]]),
);

/**
 * Overlay the user's keybindings.json on the defaults:
 * { "session.next": "Ctrl+Tab" } replaces, ["A", "B"] binds several,
 * null or [] unbinds. A shortcut taken by another command is removed there.
 */
export function resolveKeybindings(user: unknown): { bindings: Keybindings; errors: string[] } {
  const bindings: Keybindings = structuredClone(DEFAULT_KEYBINDINGS);
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

const sameKey = (a: string, b: string) => norm(a) === norm(b);
const norm = (k: string) => {
  const parts = k.toLowerCase().replace(/cmdorctrl|command/g, "cmd").replace(/option/g, "alt").replace(/control/g, "ctrl").split("+");
  const key = parts.pop();
  return [...parts.sort(), key].join("+");
};

/** "Alt+Cmd+N" → "⌥⌘N" for display. */
export function prettyAccelerator(acc?: string): string | undefined {
  if (!acc) return undefined;
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
