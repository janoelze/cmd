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
  /**
   * Where it sits in the menu bar: "<menu>/<group>" (main/menu.ts places each group; within
   * one, commands keep this list's order). Every command has one, so its shortcut is a menu item.
   */
  menu: string;
  /** In the menu but not shown: its shortcut still works ("Select Session 3"). */
  hidden?: boolean;
  /**
   * "window": the shortcut belongs to one kind of window (a file browser's ⌘D) and is run by the
   * renderer while that window is selected, not by the menu, so other windows keep the key.
   */
  scope?: "window";
}

const spec = <const T extends CommandSpec[]>(xs: T) => xs;

export const COMMANDS = spec([
  { id: "app.settings", label: "Settings…", keys: ["Cmd+,"], menu: "App/settings" },
  { id: "app.setup", label: "Set Up cmd…", menu: "App/settings" },
  { id: "app.checkUpdates", label: "Check for Updates…", menu: "App/updates" },
  { id: "app.taskManager", label: "Task Manager", menu: "Window/app" },
  { id: "app.restartCore", label: "Restart Core", menu: "Window/app" },
  { id: "app.remoteAccess", label: "Remote Access…", menu: "App/settings" },
  { id: "app.pairDevice", label: "Pair a Device…", menu: "App/settings" },
  { id: "app.disconnectRemote", label: "Disconnect Remote Devices", menu: "App/settings" },

  // ⌘N: one picker for every new window and widget (renderer/src/shell/newItems.ts); the rest skip it.
  { id: "file.new", label: "New…", keys: ["Cmd+N"], menu: "File/new" },
  { id: "file.newTerminal", label: "New Terminal", keys: ["Cmd+T"], menu: "File/agents" },
  { id: "file.newBrowser", label: "New Browser Window", keys: ["Shift+Cmd+B"], menu: "File/windows" },
  { id: "file.newFiles", label: "New File Browser", keys: ["Shift+Cmd+O"], menu: "File/windows" },
  { id: "file.newText", label: "New Text Editor", keys: ["Shift+Cmd+E"], menu: "File/windows" },
  { id: "file.openWorkspace", label: "Open Workspace…", keys: ["Cmd+O"], menu: "File/workspace" },
  { id: "file.newWindow", label: "New Window…", keys: ["Shift+Cmd+N"], menu: "File/workspace" },
  // Widgets (docs/16-widgets.md). Ids keep their old names: keybindings.json uses them.
  { id: "widget.library", label: "Widget Library…", keys: ["Shift+Cmd+L"], menu: "Widgets/library" },
  { id: "file.newMagic", label: "New Widget with Magic…", keys: ["Shift+Cmd+M"], menu: "Widgets/library" },
  { id: "view.magicChange", label: "Change Widget…", keys: ["Cmd+L"], menu: "Widgets/widget" },
  { id: "view.magicStop", label: "Stop Making Widget", keys: ["Cmd+."], menu: "Widgets/widget" },
  { id: "widget.remove", label: "Remove from Board", menu: "Widgets/remove" },
  { id: "file.save", label: "Save", keys: ["Cmd+S"], menu: "File/save" },
  // A file browser's own (windows/files/commands.ts): its keys work only there (scope "window").
  { id: "files.newFolder", label: "New Folder", menu: "File/files", scope: "window" },
  { id: "files.duplicate", label: "Duplicate", keys: ["Cmd+D"], menu: "File/files", scope: "window" },
  { id: "files.trash", label: "Move to Trash", keys: ["Cmd+Backspace"], menu: "File/files", scope: "window" },
  { id: "files.up", label: "Enclosing Folder", keys: ["Cmd+Up"], menu: "File/files", scope: "window" },
  { id: "files.open", label: "Open Selection", keys: ["Cmd+Down"], menu: "File/files", scope: "window" },
  { id: "file.close", label: "Close Window", keys: ["Cmd+W"], menu: "File/close" },
  // A given window (right-click → Close Window/Terminal); ⌘W is file.close: the frontmost thing, this last.
  { id: "window.close", label: "Close This Window", paletteHidden: true, menu: "File/close", hidden: true },
  { id: "file.closeWindow", label: "Close App Window", keys: ["Shift+Cmd+W"], menu: "File/close" },
  { id: "file.reopenClosed", label: "Reopen Closed Window", keys: ["Shift+Cmd+T"], menu: "File/close" },
  { id: "file.openSettingsFile", label: "Open settings.json", menu: "File/settings" },

  { id: "edit.copy", label: "Copy", keys: ["Cmd+C"], menu: "Edit/copy" },
  { id: "edit.selectAll", label: "Select All", keys: ["Cmd+A"], menu: "Edit/select" },
  { id: "edit.find", label: "Find…", keys: ["Cmd+F"], menu: "Edit/find" },
  { id: "edit.findNext", label: "Find Next", keys: ["Cmd+G"], menu: "Edit/find" },
  { id: "edit.findPrev", label: "Find Previous", keys: ["Shift+Cmd+G"], menu: "Edit/find" },
  { id: "edit.findReplace", label: "Find and Replace…", keys: ["Alt+Cmd+F"], menu: "Edit/find" },
  // ⌘E on a Mac, but here ⌘E is Toggle Preview / Edit.
  { id: "edit.findSelection", label: "Use Selection for Find", menu: "Edit/find" },
  // A text window's own (windows/text/commands.ts): its keys work only there (scope "window"), so terminals keep ⌥↑ and the rest.
  { id: "text.goToLine", label: "Go to Line…", keys: ["Ctrl+G"], menu: "Edit/text", scope: "window" },
  { id: "text.toggleComment", label: "Toggle Comment", keys: ["Cmd+/"], menu: "Edit/text", scope: "window" },
  { id: "text.moveLineUp", label: "Move Line Up", keys: ["Alt+Up"], menu: "Edit/lines", scope: "window" },
  { id: "text.moveLineDown", label: "Move Line Down", keys: ["Alt+Down"], menu: "Edit/lines", scope: "window" },
  { id: "text.duplicateLine", label: "Duplicate Line", keys: ["Shift+Alt+Down"], menu: "Edit/lines", scope: "window" },
  { id: "text.deleteLine", label: "Delete Line", keys: ["Shift+Cmd+K"], menu: "Edit/lines", scope: "window" },
  { id: "text.indent", label: "Indent", keys: ["Cmd+]"], menu: "Edit/lines", scope: "window" },
  { id: "text.outdent", label: "Outdent", keys: ["Cmd+["], menu: "Edit/lines", scope: "window" },
  { id: "text.fold", label: "Fold", keys: ["Alt+Cmd+["], menu: "Edit/folding", scope: "window" },
  { id: "text.unfold", label: "Unfold", keys: ["Alt+Cmd+]"], menu: "Edit/folding", scope: "window" },
  { id: "text.foldAll", label: "Fold All", menu: "Edit/folding", scope: "window" },
  { id: "text.unfoldAll", label: "Unfold All", menu: "Edit/folding", scope: "window" },
  { id: "edit.copyLastOutput", label: "Copy Last Command Output", keys: ["Shift+Cmd+A"], menu: "Edit/terminal" },
  // ⌘↑ / ⌘↓ in a terminal (its own keys, so text windows keep theirs: terminals.ts).
  { id: "terminal.prevPrompt", label: "Jump to Previous Prompt", menu: "Edit/terminal" },
  { id: "terminal.nextPrompt", label: "Jump to Next Prompt", menu: "Edit/terminal" },
  { id: "edit.clear", label: "Clear Buffer", keys: ["Alt+Cmd+K"], menu: "Edit/terminal" },

  { id: "view.palette", label: "Command Palette…", keys: ["Cmd+K"], menu: "View/palette" },
  { id: "view.search", label: "Search…", keys: ["Shift+Cmd+F"], menu: "View/palette" },
  { id: "view.focus", label: "Focus", keys: ["Alt+Cmd+1"], checkable: "radio", menu: "View/layout" },
  { id: "view.grid", label: "Grid", keys: ["Alt+Cmd+2"], checkable: "radio", menu: "View/layout" },
  { id: "view.strip", label: "Strip", keys: ["Alt+Cmd+3"], checkable: "radio", menu: "View/layout" },
  { id: "view.canvas", label: "Canvas", keys: ["Alt+Cmd+4"], checkable: "radio", menu: "View/layout" },
  { id: "view.toggleFocus", label: "Toggle Focus", keys: ["Cmd+Enter"], menu: "View/layout" },
  { id: "view.canvasFit", label: "Zoom Canvas to Fit", keys: ["Shift+Cmd+1"], menu: "View/layout" },
  { id: "view.canvasZoomWindow", label: "Zoom Canvas to Window", keys: ["Shift+Cmd+2"], menu: "View/layout" },
  { id: "view.cycleWidth", label: "Cycle Window Width", keys: ["Ctrl+Cmd+R"], menu: "View/layout" },
  { id: "view.widen", label: "Wider Window", keys: ["Alt+Cmd+Plus", "Alt+Cmd+="], menu: "View/layout" },
  { id: "view.narrow", label: "Narrower Window", keys: ["Alt+Cmd+-"], menu: "View/layout" },
  // The selected window's Refresh (a page, a widget's data, a table); the id is from when only widgets had it.
  { id: "view.magicRefresh", label: "Refresh Window", keys: ["Cmd+R"], menu: "View/window" },
  // docs/59: a browser window's DevTools; checked while open.
  { id: "browser.inspector", label: "Show Inspector", keys: ["Alt+Cmd+I"], checkable: "checkbox", menu: "View/browser" },
  { id: "view.toggleEdit", label: "Toggle Preview / Edit", keys: ["Cmd+E"], menu: "View/layout" },
  // Sidebars (docs/21-sidebars.md). view.sidebar keeps its id: keybindings.json uses it.
  { id: "view.sidebar", label: "Show Left Sidebar", keys: ["Ctrl+Cmd+S"], checkable: "checkbox", menu: "View/sidebars" },
  { id: "view.rightSidebar", label: "Show Right Sidebar", checkable: "checkbox", menu: "View/sidebars" },
  { id: "view.sidebars", label: "Show Sidebars", keys: ["Alt+Cmd+S"], checkable: "checkbox", menu: "View/sidebars" },
  { id: "window.dockLeft", label: "Attach as Left Sidebar", menu: "Window/dock" },
  { id: "window.dockRight", label: "Attach as Right Sidebar", menu: "Window/dock" },
  { id: "window.undock", label: "Detach Sidebar", menu: "Window/dock" },
  // A fixed size for consistent screenshots (marketing site).
  { id: "window.screenshotSize", label: "Resize to 1500 × 900", menu: "Window/size" },
  // The editor.wordWrap setting, for every text window.
  { id: "text.wordWrap", label: "Word Wrap", keys: ["Alt+Z"], checkable: "checkbox", menu: "View/editor", scope: "window" },
  { id: "view.zoomIn", label: "Bigger", keys: ["Cmd+Plus", "Cmd+="], menu: "View/zoom" },
  { id: "view.zoomOut", label: "Smaller", keys: ["Cmd+-"], menu: "View/zoom" },
  { id: "view.zoomReset", label: "Actual Size", keys: ["Cmd+0"], menu: "View/zoom" },

  { id: "session.next", label: "Next Session", keys: ["Alt+Cmd+Right", "Shift+Cmd+]"], menu: "Session/move" },
  { id: "session.prev", label: "Previous Session", keys: ["Alt+Cmd+Left", "Shift+Cmd+["], menu: "Session/move" },
  { id: "session.nextAttention", label: "Next Needing Attention", keys: ["Ctrl+Cmd+J"], menu: "Session/move" },
  { id: "session.copyResume", label: "Copy Resume Command", menu: "Session/agent" },
  { id: "session.copyId", label: "Copy Session ID", menu: "Session/agent" },
  { id: "session.rename", label: "Rename Agent…", menu: "Session/agent" },
  { id: "session.summarize", label: "Summarize Session", menu: "Session/agent" },
  { id: "session.reveal", label: "Show Folder in Finder", keys: ["Alt+Cmd+R"], menu: "Session/agent" },
  // Quick Commands (docs/58): the person's own sit above these in Session → Quick Commands (menu-template.ts), as `quick:<id>`.
  { id: "session.newQuickCommand", label: "New Quick Command…", menu: "Session/quick" },
  { id: "session.quickCommands", label: "Edit Quick Commands…", menu: "Session/quick" },
  // Workspace Actions (docs/39).
  { id: "actions.show", label: "Workspace Actions", menu: "Workspace/actions" },
  { id: "actions.rerun", label: "Run Last Action Again", keys: ["Shift+Cmd+R"], menu: "Workspace/actions" },
  { id: "operator.ask", label: "Ask Operator…", keys: ["Cmd+J"], menu: "Workspace/actions" },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    id: `session.select${n}`,
    label: `Select Session ${n}`,
    keys: [`Cmd+${n}`],
    paletteHidden: true,
    menu: "Session/select",
    hidden: true,
  })),

  { id: "workspace.next", label: "Next Workspace", keys: ["Ctrl+Cmd+]"], menu: "Workspace/move" },
  { id: "workspace.prev", label: "Previous Workspace", keys: ["Ctrl+Cmd+["], menu: "Workspace/move" },
  { id: "workspace.last", label: "Last Workspace", menu: "Workspace/move" },
  { id: "workspace.moveWindow", label: "Move Window to Workspace…", menu: "Workspace/edit" },
  { id: "workspace.rename", label: "Rename Workspace…", menu: "Workspace/edit" },
  { id: "workspace.icon", label: "Change Workspace Icon…", menu: "Workspace/edit" },
  { id: "workspace.reveal", label: "Show Workspace Folder in Finder", menu: "Workspace/edit" },
  { id: "workspace.close", label: "Close Workspace…", menu: "Workspace/close" },
  // Ctrl+1–9 like Arc's spaces; ⌘1–9 stay for sessions. The menu shows them under the open
  // workspaces' names (MenuState.lists), hidden where there is none.
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    id: `workspace.select${n}`,
    label: `Switch to Workspace ${n}`,
    keys: [`Ctrl+${n}`],
    checkable: "checkbox" as const,
    paletteHidden: true,
    menu: "Workspace/select",
    hidden: true,
  })),

  { id: "help.docs", label: "cmd Documentation", menu: "Help/help" },
  { id: "help.whatsNew", label: "What's New", menu: "Help/help" },
  { id: "help.feedback", label: "Send Feedback…", menu: "Help/help" },
]);

export type CommandId = (typeof COMMANDS)[number]["id"];

export const COMMAND_BY_ID = new Map<string, CommandSpec>((COMMANDS as readonly CommandSpec[]).map((c) => [c.id, c]));

/** State the renderer reports so menu items can be checked/enabled. */
export interface MenuState {
  checked: Partial<Record<CommandId, boolean>>;
  /** Commands, and the person's Quick Commands (`quick:<id>`). */
  enabled: Partial<Record<CommandId | QuickMenuId, boolean>>;
  /** The menus made of workspaces; main rebuilds the menu bar when they change. */
  lists?: MenuLists;
}

/** The Workspace menu's open workspaces (switcher order, the first nine: ⌃1–9) and File → Open Recent's closed ones. */
export interface MenuLists {
  workspaces: string[];
  recent: { path: string; label: string }[];
  /** Session → Quick Commands, in the file's order, with their shortcuts (docs/58). */
  quick?: { id: QuickMenuId; label: string; keys: string[] }[];
}

/** A Quick Command as a menu item and in the menu's state: never a command id (those have a dot). */
export type QuickMenuId = `quick:${string}`;
export const QUICK_PREFIX = "quick:";

/**
 * A context-menu item sent from renderer to main; `checked` shows a checkmark, `submenu` nests
 * items (its own id is never chosen), `accelerator` shows an app command's shortcut beside it.
 */
export type ContextItem = { id: string; label: string; enabled?: boolean; checked?: boolean; accelerator?: string; submenu?: ContextItem[] } | { separator: true };

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
  // ⌃G and other plain ⌃-letters belong to the shell elsewhere: ⌃⌥ instead.
  if (mods.size === 1 && mods.has("ctrl") && /^[A-Z]$/.test(key)) return `Ctrl+Alt+${key}`;
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
  // the command that has fewest shortcuts (Next Workspace keeps it; Next Session has ⌥→).
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

/** A command id as it is now: before 0.24 the workspace commands were `space.*`. */
const currentId = (id: string): string => (id.startsWith("space.") ? `work${id}` : id);

/**
 * Overlay the user's keybindings.json on the defaults:
 * { "session.next": "Ctrl+Tab" } replaces, ["A", "B"] binds several,
 * null or [] unbinds. A shortcut taken by another command is removed there.
 */
export function resolveKeybindings(user: unknown, defaults: Keybindings = DEFAULT_KEYBINDINGS): { bindings: Keybindings; errors: string[] } {
  const bindings: Keybindings = structuredClone(defaults);
  const errors: string[] = [];
  if (!user || typeof user !== "object" || Array.isArray(user)) return { bindings, errors };
  for (const [key, v] of Object.entries(user as Record<string, unknown>)) {
    const id = currentId(key);
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
  for (const k of Object.keys(out)) if (k !== id && currentId(k) === id) delete out[k];
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
