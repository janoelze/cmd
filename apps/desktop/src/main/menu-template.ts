// The menu bar's template, from the shared command list: each menu is a list of groups, a
// group is its commands (by their `menu` slot, in the list's order) or one of macOS's roles.
// Pure (Electron's types only), so a test can check every command is placed exactly once.

import type { MenuItemConstructorOptions } from "electron";
import { COMMANDS, norm, type CommandSpec, type ContextItem, type Keybindings, type MenuLists } from "../shared/commands.ts";

type Send = (id: string) => void;
type Role = NonNullable<MenuItemConstructorOptions["role"]>;
/** A group of a menu: a command slot ("File/new"), roles and slots in one run, a slot as a submenu, File → Open Recent, or Session → Quick Commands. */
type Part = string | { role: Role } | { submenu: string; slot: string } | { recent: true } | { quick: string };
type Menu = { label?: string; role?: Role; groups: Part[][] };

const r = (role: Role) => ({ role });

/** The menu bar; `mac`: the app-name menu exists, else its items go to File and Help. */
function layout(mac: boolean, appName: string): Menu[] {
  return [
    ...(mac ? [{ label: appName, groups: [[r("about"), "App/updates"], ["App/settings"], [r("services")], [r("hide"), r("hideOthers"), r("unhide")], [r("quit")]] }] : []),
    {
      label: "File",
      groups: [["File/new"], ["File/agents"], ["File/windows"], ["File/workspace", { recent: true }], ["File/save"], ["File/files"], ["File/close"], ["File/settings"], ...(mac ? [] : [["App/settings"], [r("quit")]])],
    },
    { label: "Edit", groups: [[r("undo"), r("redo")], [r("cut"), "Edit/copy", r("paste"), "Edit/select"], ["Edit/find"], ["Edit/text", { submenu: "Lines", slot: "Edit/lines" }, { submenu: "Code Folding", slot: "Edit/folding" }], ["Edit/terminal"]] },
    { label: "View", groups: [["View/layout"], ["View/sidebars"], ["View/palette"], ["View/zoom"], ["View/editor"], ["View/browser"], [r("togglefullscreen")], ["@developer"]] },
    { label: "Session", groups: [["Session/move"], ["Session/select", "Session/agent"], [{ quick: "Session/quick" }]] },
    { label: "Workspace", groups: [["Workspace/move", "Workspace/select"], ["Workspace/edit"], ["Workspace/actions"], ["Workspace/close"]] },
    { label: "Widgets", groups: [["Widgets/library"], ["Widgets/widget"], ["Widgets/remove"]] },
    { role: "windowMenu", groups: [[r("minimize"), r("zoom")], ["Window/dock"], ["Window/size"], ["Window/app"], ...(mac ? [[r("front")]] : [])] },
    { role: "help", groups: [["Help/help"], ...(mac ? [] : [["App/updates"]])] },
  ];
}

/** What the menu bar is built with besides the commands: the lists of workspaces, and opening a recent one. */
export interface MenuOptions {
  mac: boolean;
  appName: string;
  lists?: MenuLists;
  openRecent?: (path: string) => void;
}

/** A command's menu items: the item, and hidden ones for its other shortcuts. */
function items(c: CommandSpec, send: Send, bindings: Keybindings, lists?: MenuLists): MenuItemConstructorOptions[] {
  const [first, ...rest] = bindings[c.id] ?? [];
  // ⌃1–9 show as the open workspaces' names; the rest stay hidden, their keys still bound.
  const n = /^workspace\.select(\d)$/.exec(c.id);
  const name = n && lists?.workspaces[Number(n[1]) - 1];
  if (name) c = { ...c, label: name, hidden: false };
  // A window's own shortcut shows in the menu but is the renderer's to run (CommandSpec.scope).
  const own = c.scope === "window" ? { registerAccelerator: false } : {};
  const main: MenuItemConstructorOptions = { id: c.id, label: c.label, accelerator: first, type: c.checkable, click: () => send(c.id), ...own, ...(c.hidden ? { visible: false, acceleratorWorksWhenHidden: true } : {}) };
  // Extra shortcuts are hidden items that still respond to their key.
  const aliases = rest.map((acc): MenuItemConstructorOptions => ({ label: c.label, accelerator: acc, visible: false, acceleratorWorksWhenHidden: true, click: () => send(c.id), ...own }));
  return [main, ...aliases];
}

/** File → Open Recent: closed workspaces, most recently closed first. */
function recentMenu(o: MenuOptions): MenuItemConstructorOptions {
  const recent = o.lists?.recent ?? [];
  return {
    label: "Open Recent",
    submenu: recent.length ? recent.map((r) => ({ label: r.label, click: () => o.openRecent?.(r.path) })) : [{ label: "No Recent Workspaces", enabled: false }],
  };
}

/**
 * Session → Quick Commands (docs/58): the person's, each with its shortcuts (a shortcut an app
 * command has stays the command's), then the slot's commands (New…, Edit…).
 */
function quickMenu(o: MenuOptions, send: Send, bindings: Keybindings, after: MenuItemConstructorOptions[]): MenuItemConstructorOptions {
  const taken = new Set(Object.values(bindings).flat().map(norm));
  const mine = (o.lists?.quick ?? []).flatMap((q): MenuItemConstructorOptions[] => {
    const keys = q.keys.filter((k) => !taken.has(norm(k)));
    for (const k of keys) taken.add(norm(k));
    const click = () => send(q.id);
    return [{ id: q.id, label: q.label, accelerator: keys[0], click }, ...keys.slice(1).map((acc) => ({ label: q.label, accelerator: acc, visible: false, acceleratorWorksWhenHidden: true, click }))];
  });
  return { label: "Quick Commands", submenu: [...(mine.length ? mine : [{ label: "No Quick Commands", enabled: false }]), { type: "separator" }, ...after] };
}

export function menuTemplate(send: Send, bindings: Keybindings, o: MenuOptions): MenuItemConstructorOptions[] {
  const bySlot = new Map<string, CommandSpec[]>();
  for (const c of COMMANDS as readonly CommandSpec[]) bySlot.set(c.menu, [...(bySlot.get(c.menu) ?? []), c]);
  const part = (p: Part): MenuItemConstructorOptions[] => {
    if (typeof p !== "string" && "quick" in p) return [quickMenu(o, send, bindings, (bySlot.get(p.quick) ?? []).flatMap((c) => items(c, send, bindings)))];
    if (typeof p !== "string") return "recent" in p ? [recentMenu(o)] : "submenu" in p ? [{ label: p.submenu, submenu: (bySlot.get(p.slot) ?? []).flatMap((c) => items(c, send, bindings)) }] : [p];
    // The app's own DevTools: ⌥⌘I is a browser window's (Show Inspector).
    if (p === "@developer") return [{ label: "Developer", submenu: [{ role: "reload" }, { role: "toggleDevTools", accelerator: "Alt+Shift+Cmd+I" }] }];
    return (bySlot.get(p) ?? []).flatMap((c) => items(c, send, bindings, o.lists));
  };
  return layout(o.mac, o.appName).map((m) => {
    const groups = m.groups.map((g) => g.flatMap(part)).filter((g) => g.length);
    const submenu = groups.flatMap((g, i) => (i ? [{ type: "separator" as const }, ...g] : g));
    return { ...(m.label ? { label: m.label } : {}), ...(m.role ? { role: m.role } : {}), submenu };
  });
}

/** Every slot the layout places (for the test: a command in another slot isn't in the menu). */
export function menuSlots(mac: boolean): string[] {
  return layout(mac, "cmd").flatMap((m) => m.groups.flat().flatMap((p) => (typeof p === "string" ? [p] : "slot" in p ? [p.slot] : "quick" in p ? [p.quick] : [])));
}

/** A context menu's template; an entry that is an app command shows its shortcut, which the menu bar runs (not this menu). */
export function contextTemplate(list: ContextItem[], choose: (id: string) => void): MenuItemConstructorOptions[] {
  return list.map((it) =>
    "separator" in it
      ? { type: "separator" as const }
      : it.submenu
        ? { label: it.label, enabled: it.enabled ?? true, submenu: contextTemplate(it.submenu, choose) }
        : {
            label: it.label,
            enabled: it.enabled ?? true,
            ...(it.checked !== undefined ? { type: "checkbox" as const, checked: it.checked } : {}),
            ...(it.accelerator ? { accelerator: it.accelerator, registerAccelerator: false } : {}),
            click: () => choose(it.id),
          },
  );
}
